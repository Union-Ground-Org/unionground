-- SEC-UG-RECOVERY-CODE-USE-WRITES-NO-AUDIT-ROW-OR-NOTICE-20261112
-- (#8491). Using an account recovery code (api/mfa-recovery.js) removed the
-- member's authenticator and signed out every session, but wrote no
-- member_admin_audit row and sent no notice, so a stolen code could be used
-- without anyone learning of it (account recovery full drill, November 11,
-- 2026). The administrator reset and the password reset each write an audit
-- row; the administrator reset also sends a notice.
--
-- finalize_mfa_recovery_code, the step that consumes the claimed code, now
-- writes, in the same transaction and only when it consumes the code:
-- * one member_admin_audit row, action 'mfa_recovery_code_used', with the
--   member as actor and target and an empty detail (no code, hash, address
--   or device), readable by whoever reads the self-service password reset
--   rows;
-- * one in-app notice to the member in their saved language (English or
--   Spanish). The notification queue does not email 'general' notices, so
--   api/mfa-recovery.js emails the account address itself.
-- A refused, expired or reused code returns false before that point and
-- writes neither. The body is the live definition on a stack built from
-- Main with only this addition, so no later rewrite is undone.
--
-- private.assign_member_admin_audit_organization, the trigger that derives
-- an audit row's organization from its actor, refused any row whose actor's
-- selected organization is not active (suspended, or the membership ended).
-- For a member of a suspended organization that aborted the finalize after
-- the route had removed the authenticator and signed out every session,
-- leaving the code unused and the recovery lock in place (#8535 round 1).
-- The trigger now lets exactly this row through unscoped (no organization):
-- action 'mfa_recovery_code_used', the member as actor and target, an empty
-- detail, no organization supplied, under the service role that finalize
-- requires. Every other row keeps the active-organization rule, and a member
-- of an active organization still gets that organization on the row. The
-- trigger body is its live definition with only that branch added; its
-- account lifecycle review row is refreshed below.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

CREATE OR REPLACE FUNCTION private.assign_member_admin_audit_organization()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  selected_org uuid;
  active_org uuid;
begin
  if new.actor is null then
    if new.organization_id is not null then
      raise exception 'audit organization requires an actor' using errcode = '42501';
    end if;
    return new;
  end if;

  select c.organization_id into selected_org
  from public.member_profiles p
  left join public.chapters c on c.id = p.chapter_id
  where p.id = new.actor;

  if selected_org is null then
    if new.organization_id is not null then
      raise exception 'orphan audit rows cannot name an organization' using errcode = '42501';
    end if;
    new.organization_id := null;
    return new;
  end if;

  select c.organization_id into active_org
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  join public.organizations o
    on o.id = c.organization_id
   and o.status = 'active'
  join public.member_chapter_memberships cm
    on cm.user_id = p.id and cm.chapter_id = c.id and cm.status = 'active'
  join public.organization_memberships om
    on om.user_id = p.id
   and om.organization_id = c.organization_id
   and om.status = 'active'
  where p.id = new.actor
    and c.organization_id = selected_org;

  if active_org is null then
    -- #8491: a member's own recovery-code use is recorded even when their
    -- selected organization is not active, unscoped, so the code's
    -- consumption is never rolled back after the factor was removed.
    if new.action = 'mfa_recovery_code_used'
       and new.target_user = new.actor
       and new.organization_id is null
       and new.detail = '{}'::jsonb
       and (select auth.role()) = 'service_role' then
      return new;
    end if;
    raise exception 'active audit organization required' using errcode = '42501';
  end if;
  if new.organization_id is not null
     and new.organization_id is distinct from active_org then
    raise exception 'audit organization is derived from actor' using errcode = '42501';
  end if;

  new.organization_id := active_org;
  return new;
end;
$function$;

alter table public.member_admin_audit drop constraint member_admin_audit_action_check;
alter table public.member_admin_audit add constraint member_admin_audit_action_check check(action in (
  'grant_role','revoke_role','create_event','update_event','cancel_event','restore_event','delete_event','reset_mfa','claim_reward','grant_reward',
  'revoke_reward','fulfill_reward','set_staff_mfa_policy','set_compass_ai_enabled','set_compass_ai_role_limit','attest_compass_ai_provider',
  'create_campaign','update_campaign_draft','publish_campaign','close_campaign','recover_signin_address','recover_signin_address_failed',
  'review_email_intake','create_chapter','update_chapter','grant_chapter_membership','revoke_chapter_membership','event_checkin_lockout',
  'set_chapter_display_title','self_service_password_reset','committee_updated','access_membership_updated','access_policy_updated',
  'role_capability_updated','role_scope_updated','grievance_identity_visibility_updated','case_row_topic_policy_updated','case_row_topic_updated',
  'mfa_recovery_code_used'
));

CREATE OR REPLACE FUNCTION public.finalize_mfa_recovery_code(p_user_id uuid, p_claim_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  clean_claim_token text := pg_catalog.btrim(coalesce(p_claim_token, ''));
  expected_claim_hash text;
  recovery_code_id uuid;
  changed integer := 0;
  released integer := 0;
  member_lang text;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or clean_claim_token !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  expected_claim_hash := pg_catalog.encode(
    extensions.digest(clean_claim_token, 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || p_user_id::text));

  select c.id into recovery_code_id
  from public.mfa_recovery_codes c
  where c.user_id = p_user_id
    and c.used_at is null
    and c.claim_expires_at > pg_catalog.now()
    and c.claim_token_hash = expected_claim_hash
  for update;
  if recovery_code_id is null or not exists (
    select 1
    from private.member_mfa_recovery_locks l
    where l.user_id = p_user_id
      and l.claim_token_hash = expected_claim_hash
  ) then
    return false;
  end if;

  update public.mfa_recovery_codes c
  set used_at = pg_catalog.now()
  where c.id = recovery_code_id
    and c.used_at is null;
  get diagnostics changed = row_count;
  if changed <> 1 then
    return false;
  end if;

  delete from private.member_mfa_recovery_locks l
  where l.user_id = p_user_id
    and l.claim_token_hash = expected_claim_hash;
  get diagnostics released = row_count;
  if released <> 1 then
    return false;
  end if;

  -- #8491: a used code leaves one audit row and one notice to the
  -- member. Neither carries the code, its hash, an address or a device.
  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (p_user_id, 'mfa_recovery_code_used', p_user_id, '{}'::jsonb);

  select coalesce(p.language, 'en') into member_lang
  from public.member_profiles p
  where p.id = p_user_id;
  if member_lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (p_user_id, 'Se usó un código de recuperación en tu cuenta',
      'Se usó uno de tus códigos de recuperación: se quitó la verificación en dos pasos de tu cuenta y se cerraron todas tus sesiones. Vuelve a configurarla desde Ajustes. Si no fuiste tú, cambia tu contraseña y contacta a tu oficina local de inmediato.',
      'general');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (p_user_id, 'A recovery code was used on your account',
      'One of your recovery codes was used: two-step sign-in was removed from your account and every session was signed out. Set it up again from Settings. If this was not you, change your password and contact your local office immediately.',
      'general');
  end if;
  return true;
end;
end;
$function$;

-- Reviewed trigger surface (account lifecycle inventory): the redefined
-- audit organization trigger function.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private' and object_name = 'assign_member_admin_audit_organization()'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';

commit;
