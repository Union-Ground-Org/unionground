-- BUG-UG-SELF-SERVICE-RESET-LEAVES-NO-AUDIT-ROW-FOR-SUSPENDED-ORGANIZATION-MEMBER-20261112
-- (#8552). public.record_self_service_password_reset writes one
-- member_admin_audit row (action 'self_service_password_reset', the member as
-- actor and target, detail {twoStepEnrolled: <boolean>}) after a self-service
-- account reset has set the new secret and ended every session. The trigger
-- private.assign_member_admin_audit_organization derives the row's
-- organization from the actor and raised 42501 'active audit organization
-- required' when the actor's selected organization is suspended or the
-- membership ended. api/password-reset.js catches that refusal and answers
-- 200 with audited false, so the reset completed and left no trace: for a
-- suspended or departed member, the case an administrator most needs to see.
--
-- The trigger now also lets exactly this row through unscoped (no
-- organization), in the branch #8491 added for a member's own recovery-code
-- use: action 'self_service_password_reset', the member as actor and target,
-- a detail that is exactly {"twoStepEnrolled": true} or {"twoStepEnrolled":
-- false}, no organization supplied, under the service role that
-- record_self_service_password_reset requires. Every other row keeps the
-- active-organization rule, and a member of an active organization still
-- gets that organization on the row. The body is the live definition
-- (20261113112500, md5-pinned below) with only that branch widened; its
-- account lifecycle review row is refreshed below.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.assign_member_admin_audit_organization()'))) is distinct from 'abd5acc6c54143ed31be0a399dcc910b' then
    raise exception 'unreviewed predecessor: private.assign_member_admin_audit_organization' using errcode = '55000';
  end if;
end;
$predecessor$;

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
    -- #8552: likewise a member's own completed self-service reset, with its
    -- one boolean detail, so the reset of a suspended or departed member's
    -- account leaves a trace.
    if new.target_user = new.actor
       and new.organization_id is null
       and (select auth.role()) = 'service_role'
       and ((new.action = 'mfa_recovery_code_used'
             and new.detail = '{}'::jsonb)
         or (new.action = 'self_service_password_reset'
             and new.detail in ('{"twoStepEnrolled": true}'::jsonb, '{"twoStepEnrolled": false}'::jsonb))) then
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
