-- REQ-UG-ORG-ADMIN-REINVITE-FORMER-MEMBER-20260926
--
-- An organization admin can re-add a former member by invitation.
--
-- A chapter grant no longer brings anyone into an organization (20260925965000
-- made it a chapter-within-organization action), but its former-member branch
-- still re-activated a revoked organization membership from a chapter admin's
-- desk, and the invitation acceptance path always creates a new account, so a
-- former member who still has an account could not be re-invited. This
-- migration:
--
--   * gives public.member_invitations a `kind` ('provision' or 'reactivation');
--     a reactivation invitation names no new account and no starting role;
--   * adds public.create_former_member_invitation: ORGANIZATION-admin-only
--     (private.has_organization_role, which carries the MFA step-up like every
--     other admin membership write, plus an explicit private.mfa_satisfied()
--     check), issued from the admin's own chapter desk like every other
--     invitation write (private.require_member_invitation_admin_chapter, so the
--     same caller can record delivery, resend and revoke it; the target chapter
--     is the caller's chapter), re-authorized after the organization-role and
--     member locks are taken so a queued request cannot spend revoked
--     authority, rate limited through the same persisted throttle as the ordinary
--     invitation, and eligible only for an address whose account is a REVOKED
--     member of the chapter's organization and active in no organization. An
--     ineligible address returns the same accepted/no-send shape as a duplicate
--     ordinary invitation, so the RPC is not an address oracle. The audit row
--     ('reinvite_requested') is content-free: chapter, organization, the prior
--     revocation timestamp and the delivery version; never a name, address or
--     free text;
--   * adds public.accept_former_member_invitation (service role, called by
--     api/accept-invitation.js instead of creating an account): re-resolves
--     the account by the invitation's address, re-checks every eligibility
--     conjunct under the organization-role -> member-chapter lock order the
--     grant uses, re-activates the organization membership, adds the invited
--     chapter, marks the invitation accepted and writes the content-free
--     'reinvite_accepted' audit row naming the prior revocation. Any mismatch
--     is 'invitation unavailable' (22023) and nothing changes;
--   * re-emits public.grant_member_chapter_membership WITHOUT its former-member
--     branch: the grant admits only an ACTIVE member of the chapter's
--     organization. A revoked former member re-enters only through the
--     organization admin's invitation; a chapter admin, a steward or a grant
--     can never bring anyone into an organization;
--   * re-emits public.resend_member_invitation so a replacement carries the
--     original's kind (a resent reactivation stays a reactivation and never
--     enters the account-provisioning branch);
--   * adds public.get_former_member_invitation_outcome (service role): after an
--     uncertain acceptance response the endpoint asks whether the reactivation
--     already committed, so a lost or malformed reply is reported as the
--     success it was instead of a retry that can never find the spent token;
--   * re-emits public.claim_member_invitation to return the kind, and
--     public.get_member_invitations / public.list_member_invitation_audit so
--     the admin desk and the audit reader see the new kind and actions.
--
-- Each re-emitted body is the installed definition (case-graph lock first, and
-- the message-lifecycle lock on the grant) with only the conjuncts described
-- above changed. No shipped migration is edited. CREATE OR REPLACE keeps each
-- existing function's ACL; the two new functions state theirs.
--
-- Hosted application: SAMPLE first, then production, in a later hosted window.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_invitations
  add column kind text not null default 'provision'
    constraint member_invitations_kind_check check (kind in ('provision', 'reactivation'));

alter table public.member_invitations
  add constraint member_invitations_reactivation_role_check
    check (kind = 'provision' or initial_role is null);

comment on column public.member_invitations.kind is
  'provision: acceptance creates a new account. reactivation: acceptance re-activates the revoked organization membership of the account that already owns the address; no account or starting role is created.';

alter table public.member_invitation_audit
  drop constraint member_invitation_audit_action_check;
alter table public.member_invitation_audit
  add constraint member_invitation_audit_action_check check (action in (
    'invite_requested', 'invite_sent', 'invite_delivery_failed',
    'invite_resent', 'invite_revoked', 'invite_claimed', 'invite_accepted',
    'invite_expired', 'reinvite_requested', 'reinvite_accepted'
  ));

create or replace function public.create_former_member_invitation(p_email text, p_chapter_id text, p_locale text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  -- The same desk gate as every other invitation write: a chapter admin of the
  -- selected chapter, resolved under the organization-role -> member lock
  -- order. The helper raises for anyone else, so whoever can issue this
  -- invitation can also record its delivery, resend it and revoke it.
  caller_chapter text := private.require_member_invitation_admin_chapter();
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  target_org uuid;
  locked_org uuid;
  target_user uuid;
  prior_revoked_at timestamptz;
  profile_row public.member_profiles%rowtype;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
begin
  -- Organization admin only, with the second factor every admin membership
  -- write demands. private.has_organization_role already carries the MFA
  -- step-up; the explicit check keeps the refusal the same when it is absent.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null or not private.has_organization_role(target_org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;
  -- The invited chapter is the desk's own chapter, as for the ordinary
  -- invitation: the list, delivery record, resend and revoke RPCs are all
  -- scoped to it, so a row elsewhere would be one nobody could administer.
  if caller_chapter is null or p_chapter_id is distinct from caller_chapter then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- Count before the eligibility branches: an ineligible address must not be a
  -- free unbounded probing endpoint. Same persisted buckets as the ordinary
  -- invitation, so one admin's budget is one budget.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', 10, interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || p_chapter_id, 'chapter-day', 50, interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  -- Re-derive and re-authorize under the tenant lock, as the grant and
  -- set_member_organization_role do: a request that queued behind a role
  -- revocation must not expire or issue invitations with the authority it had
  -- before the lock was granted.
  select c.organization_id into locked_org
  from public.chapters c
  where c.id = p_chapter_id;
  if locked_org is distinct from target_org
     or not private.mfa_satisfied()
     or not private.has_organization_role(target_org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  -- Eligibility: exactly one live account owns the address, it has a profile,
  -- its membership in THIS organization is revoked, and it is active in no
  -- organization. Anything else (no account, never a member here, active
  -- here or elsewhere, a live invitation already out) returns the uniform
  -- accepted/no-send outcome and writes nothing.
  select u.id into target_user
  from auth.users u
  where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
  order by u.created_at
  limit 1;
  if target_user is null then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || target_user::text, 0));
  select * into profile_row from public.member_profiles p where p.id = target_user;
  select om.revoked_at into prior_revoked_at
  from public.organization_memberships om
  where om.organization_id = target_org
    and om.user_id = target_user
    and om.status = 'revoked';
  if not found
     or profile_row.id is null
     or exists (
       select 1 from public.organization_memberships other
       where other.user_id = target_user and other.status = 'active'
     )
     or exists (
       select 1 from public.member_invitations i
       where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
     ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, kind)
  values
    (clean_email, profile_row.full_name, profile_row.first_name, profile_row.initials, p_chapter_id,
     null, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes', 'reactivation')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, p_chapter_id, caller, 'reinvite_requested',
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id,
      'organizationId', target_org, 'priorRevokedAt', prior_revoked_at,
      'locale', clean_locale, 'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at
  );
end;
end;
$function$;
revoke all on function public.create_former_member_invitation(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_former_member_invitation(text, text, text, text)
  to authenticated;
comment on function public.create_former_member_invitation(text, text, text, text) is
  'Organization admin + MFA, from the admin''s own chapter desk: invite a former member (revoked in this organization, active nowhere, account still exists) back into that chapter. Re-authorized under the organization-role lock. Digest-only, 15-minute, no starting role; ineligible addresses return the same accepted/no-send shape as a duplicate. Audit is content-free and names the prior revocation.';

create or replace function public.accept_former_member_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  invitation_row public.member_invitations%rowtype;
  target_org uuid;
  target_user uuid;
  prior_revoked_at timestamptz;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id
    and status = 'accepting'
    and kind = 'reactivation'
  for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;

  select c.organization_id into target_org
  from public.chapters c
  join public.organizations o on o.id = c.organization_id and o.status = 'active'
  where c.id = invitation_row.chapter_id;
  if target_org is null then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;

  -- Same lock order as the grant: organization role, then the member.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));
  select u.id into target_user
  from auth.users u
  where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = invitation_row.normalized_email
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
  order by u.created_at
  limit 1;
  if target_user is null then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || target_user::text, 0));

  -- Re-check every eligibility conjunct under the locks: the account still
  -- has a profile, is revoked here and active nowhere. A membership that
  -- changed since the invitation was issued fails closed.
  select om.revoked_at into prior_revoked_at
  from public.organization_memberships om
  where om.organization_id = target_org
    and om.user_id = target_user
    and om.status = 'revoked';
  if not found
     or not exists (select 1 from public.member_profiles p where p.id = target_user)
     or exists (
       select 1 from public.organization_memberships other
       where other.user_id = target_user and other.status = 'active'
     ) then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;

  update public.organization_memberships
  set status = 'active', revoked_at = null
  where organization_id = target_org and user_id = target_user;

  insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at)
  values (target_user, invitation_row.chapter_id, 'active', pg_catalog.now())
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null, last_selected_at = pg_catalog.now();

  update public.member_profiles p
  set chapter_id = invitation_row.chapter_id
  where p.id = target_user
    and (p.chapter_id is null or not exists (
      select 1 from public.member_chapter_memberships m
      where m.user_id = target_user and m.chapter_id = p.chapter_id and m.status = 'active'
    ));

  update public.member_invitations
  set status = 'accepted', token_hash = null, auth_user_id = target_user,
      accepted_at = pg_catalog.clock_timestamp(), failure_code = null
  where id = invitation_row.id;

  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, null, 'reinvite_accepted',
    pg_catalog.jsonb_build_object(
      'chapterId', invitation_row.chapter_id,
      'organizationId', target_org,
      'priorRevokedAt', prior_revoked_at,
      'deliveryVersion', invitation_row.delivery_version
    )
  );
  return pg_catalog.jsonb_build_object('accepted', true, 'reactivated', true, 'userId', target_user);
end;
end;
$function$;
revoke all on function public.accept_former_member_invitation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_former_member_invitation(uuid)
  to service_role;
comment on function public.accept_former_member_invitation(uuid) is
  'Service role: complete a reactivation invitation. Re-resolves the account by the invited address, re-checks revoked-here/active-nowhere under the organization-role then member locks, re-activates the organization membership, adds the invited chapter, marks the invitation accepted and audits content-free. Creates no account and grants no role.';

-- The resend: the installed 20260822010000 body with one change — the
-- replacement row carries the original's kind. Without it the column default
-- turned a resent reactivation into a provisioning invitation, whose
-- acceptance would try to create an account for an address that has one.
create or replace function public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Installed Main carries this routine wrapped by the reviewed case-graph
  -- entry block of 20260907151000 (gate before declaration initializers);
  -- re-emitting it keeps that outer gate.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'resend-hour', 20, interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  select * into old_row
  from public.member_invitations
  where id = p_invitation_id and chapter_id = caller_chapter
  for update;
  if not found or old_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  if not private.consume_member_invitation_admin_limit(
    'invitation:' || old_row.id::text, 'invitation-resend-hour', 3, interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  update public.member_invitations
  set status = 'superseded', token_hash = null, failure_code = null
  where id = old_row.id;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     replaces_id, expires_at, kind)
  values
    (old_row.normalized_email, old_row.full_name, old_row.first_name,
     old_row.initials, old_row.chapter_id, old_row.initial_role, old_row.locale,
     clean_hash, 'pending', old_row.delivery_version + 1, caller, old_row.id,
     clock_timestamp() + interval '15 minutes', old_row.kind)
  returning * into new_row;

  perform private.audit_member_invitation(
    new_row.id, new_row.chapter_id, caller, 'invite_resent',
    pg_catalog.jsonb_build_object('chapterId', new_row.chapter_id,
      'deliveryVersion', new_row.delivery_version,
      'replacesInvitationId', old_row.id)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', new_row.id,
    'deliveryVersion', new_row.delivery_version,
    'expiresAt', new_row.expires_at,
    'normalizedEmail', new_row.normalized_email,
    'fullName', new_row.full_name,
    'locale', new_row.locale
  );
end;
end;
$function$;

-- After an uncertain acceptance response (transport failure, timeout or a
-- malformed reply) the endpoint asks whether the reactivation already
-- committed. The claim cannot answer that later: acceptance clears the token
-- digest for every kind, so a retry with the same link finds nothing. This
-- reader is service-role only and returns one boolean.
create or replace function public.get_former_member_invitation_outcome(p_invitation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and kind = 'reactivation';
  if not found then
    return pg_catalog.jsonb_build_object('accepted', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'accepted', invitation_row.status = 'accepted' and invitation_row.auth_user_id is not null
  );
end;
$function$;
revoke all on function public.get_former_member_invitation_outcome(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_former_member_invitation_outcome(uuid)
  to service_role;
comment on function public.get_former_member_invitation_outcome(uuid) is
  'Service role: whether a reactivation invitation has already been accepted (membership re-activated). Read by api/accept-invitation.js after an uncertain acceptance response; returns only a boolean.';

-- The chapter grant: the installed 20260925965000 body with the former-member
-- branch removed. Only an ACTIVE member of the chapter's organization can be
-- given another chapter here; a revoked former member re-enters solely
-- through public.create_former_member_invitation and its acceptance.
create or replace function public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  locked_org uuid;
  target_org uuid;
  org_admin boolean;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select c.organization_id into locked_org
  from public.chapters c
  where c.id = p_chapter_id;
  if locked_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Cheap plausibility check: ordinary members must not be able to queue on
  -- the tenant lock. The identical checks are repeated authoritatively below.
  org_admin := private.has_organization_role(locked_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));

  -- Re-resolve and authorize only after taking the same tenant→member lock
  -- order as revocation. A queued grant cannot reuse stale caller authority.
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is distinct from locked_org then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  -- Tenant check: the grant adds a chapter inside the caller's organization
  -- for someone who is already an ACTIVE member of that organization. It
  -- never admits a person from outside it and never re-activates a revoked
  -- membership; organization entry and re-entry happen only through an
  -- accepted invitation or the organization's own creation. Unknown,
  -- outside, revoked and inactive targets share one refusal.
  if not exists (select 1 from public.member_profiles p where p.id = p_user_id)
     or not exists (select 1 from public.chapters c where c.id = p_chapter_id)
     or not exists (
       select 1 from public.organization_memberships om
       where om.organization_id = target_org
         and om.user_id = p_user_id
         and om.status = 'active'
     ) then
    raise exception 'membership target unavailable' using errcode = '22023';
  end if;

  insert into public.member_chapter_memberships (user_id, chapter_id, status)
  values (p_user_id, p_chapter_id, 'active')
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null;

  update public.member_profiles
  set chapter_id = p_chapter_id
  where id = p_user_id and chapter_id is null;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'grant_chapter_membership', p_user_id,
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id));
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'chapterId', p_chapter_id, 'active', true);
end;
end;
end;
$function$;

-- The claim now tells the acceptance endpoint which kind it holds.
create or replace function public.claim_member_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  invitation_row public.member_invitations%rowtype;
  recovery boolean := false;
  retry_after integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('available', false);
  end if;

  select * into invitation_row
  from public.member_invitations
  where token_hash = clean_hash
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  if invitation_row.status = 'pending'
     and invitation_row.expires_at <= clock_timestamp() then
    update public.member_invitations
    set status = 'expired', token_hash = null
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  if invitation_row.status = 'accepting' then
    if invitation_row.accept_attempts >= 3 then
      return pg_catalog.jsonb_build_object('available', false);
    end if;
    if invitation_row.accepting_at + interval '2 minutes' > clock_timestamp() then
      retry_after := greatest(
        1,
        least(
          120,
          pg_catalog.ceil(extract(epoch from (
            invitation_row.accepting_at + interval '2 minutes' - clock_timestamp()
          )))::integer
        )
      );
      return pg_catalog.jsonb_build_object(
        'available', false,
        'cause', 'acceptance-in-progress',
        'retryAfterSeconds', retry_after
      );
    end if;
    recovery := true;
  elsif invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('available', false);
  end if;

  update public.member_invitations
  set status = 'accepting', accepting_at = clock_timestamp(),
      accept_attempts = accept_attempts + 1
  where id = invitation_row.id
  returning * into invitation_row;

  if not recovery then
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_claimed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'available', true,
    'recovery', recovery,
    'kind', invitation_row.kind,
    'invitationId', invitation_row.id,
    'normalizedEmail', invitation_row.normalized_email,
    'fullName', invitation_row.full_name,
    'firstName', invitation_row.first_name,
    'initials', invitation_row.initials,
    'chapterId', invitation_row.chapter_id,
    'initialRole', invitation_row.initial_role,
    'locale', invitation_row.locale
  );
end;
end;
$function$;

-- The chapter admin's list carries the kind so the desk can label a
-- reactivation row; everything else is the installed definition.
create or replace function public.get_member_invitations(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  cap integer := greatest(1, least(coalesce(p_limit, 50), 100));
  chapter_name text;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id, c.name into caller_chapter, chapter_name
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'chapter', pg_catalog.jsonb_build_object('id', caller_chapter, 'name', chapter_name),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'kind', s.kind,
        'normalizedEmail', s.normalized_email,
        'fullName', s.full_name,
        'chapterId', s.chapter_id,
        'initialRole', s.initial_role,
        'locale', s.locale,
        'status', case when s.status = 'pending' and s.expires_at <= clock_timestamp()
                  then 'expired' else s.status end,
        'deliveryVersion', s.delivery_version,
        'expiresAt', s.expires_at,
        'createdAt', s.created_at
      ) order by s.created_at desc, s.id)
      from (
        select i.*
        from public.member_invitations i
        where i.chapter_id = caller_chapter and i.status <> 'superseded'
        order by i.created_at desc, i.id
        limit cap
      ) s
    ), '[]'::jsonb)
  );
end;
end;
$function$;

-- The organization-admin audit reader accepts the two new kinds.
create or replace function public.list_member_invitation_audit(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_kind text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (array[
       'invite_requested', 'invite_sent', 'invite_delivery_failed', 'invite_resent',
       'invite_revoked', 'invite_claimed', 'invite_accepted', 'invite_expired',
       'reinvite_requested', 'reinvite_accepted'
     ]) then
    raise exception 'unknown member invitation audit kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);
  -- This table has no SELECT policy: invitation evidence is admin-only, which
  -- is the same gate its create/resend/revoke RPCs enforce.
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'member_invitation_audit',
          'organizationId', ch.organization_id,
          'chapterId', a.chapter_id,
          'kind', a.action,
          'entityId', a.invitation_id,
          'actorUserId', a.actor,
          'createdAt', a.created_at
        ) as item
      from public.member_invitation_audit a
      join public.chapters ch on ch.id = a.chapter_id
      where ch.organization_id = org
        and (p_chapter_id is null or a.chapter_id = p_chapter_id)
        and (p_kind is null or a.action = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$;

notify pgrst, 'reload schema';

commit;
