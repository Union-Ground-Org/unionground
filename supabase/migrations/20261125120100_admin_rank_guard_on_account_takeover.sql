-- SEC-UG-ADMIN-RANK-GUARD-ON-ACCOUNT-TAKEOVER-20261114
--
-- One administrator could take over another. A chapter administrator could
-- change another administrator's sign-in address
-- (public.begin_member_signin_recovery), reissue their password
-- (public.begin_member_password_reissue) and then reset their second factor
-- (public.authorize_mfa_reset, public.begin_mfa_reset). The tenant checks
-- made sure both people were in the same organization; nothing compared
-- their ranks. On a self-hosted copy, one rogue chapter administrator could
-- take over a senior organizer's account this way.
--
-- THE RULE. Admin rank inside one organization:
--
--   2  organization-wide administrator (public.organization_role_grants
--      role 'admin', with an active organization membership)
--   1  chapter administrator (public.member_role_chapters role 'admin' on an
--      active chapter membership in a chapter of that organization)
--   0  everyone else
--
-- An administrator may run these recovery actions on a target only when the
-- target's rank is 0, or the actor's rank is strictly higher than the
-- target's. Equal rank is refused, so an organization-wide administrator's
-- account is never recovered through the app by another administrator; the
-- operator does that with the service role. Members without an admin rank
-- are unaffected, and so is every self-service path (none of them calls
-- these functions, and each of these functions already refuses a self
-- target).
--
-- Each re-emitted body is the installed definition (20260925965000 for the
-- two recovery routines, 20260924100000 for the MFA pair) with only the rank
-- check added after the existing tenant checks and before any rate-limit
-- charge or write, plus 'adminRank': 'checked' in the returned object. The
-- API endpoints refuse to continue when that marker is missing, so new API
-- code never runs a recovery against a database without this guard.
-- CREATE OR REPLACE keeps each function's existing ACL, so no grant is
-- restated. The two new helpers are private and executable only by their
-- owner; the definer routines above call them.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.admin_rank_in_organization(p_user_id uuid, p_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_user_id is null or p_organization_id is null then 0
    when not exists (
      select 1
      from public.organization_memberships om
      where om.organization_id = p_organization_id
        and om.user_id = p_user_id
        and om.status = 'active'
    ) then 0
    when exists (
      select 1
      from public.organization_role_grants g
      where g.organization_id = p_organization_id
        and g.user_id = p_user_id
        and g.role = 'admin'
    ) then 2
    when exists (
      select 1
      from public.member_role_chapters rc
      join public.member_chapter_memberships m
        on m.user_id = rc.user_id
       and m.chapter_id = rc.chapter_id
       and m.status = 'active'
      join public.chapters c on c.id = rc.chapter_id
      where rc.user_id = p_user_id
        and rc.role = 'admin'
        and c.organization_id = p_organization_id
    ) then 1
    else 0
  end;
$function$;

revoke all on function private.admin_rank_in_organization(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function private.admin_rank_in_organization(uuid, uuid) is
  'Admin rank inside one organization: 2 organization-wide admin, 1 chapter admin, 0 otherwise. Read by private.admin_rank_permits.';

create or replace function private.admin_rank_permits(p_actor uuid, p_target uuid, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_actor is not null
    and p_target is not null
    and p_organization_id is not null
    and (
      private.admin_rank_in_organization(p_target, p_organization_id) = 0
      or private.admin_rank_in_organization(p_actor, p_organization_id)
         > private.admin_rank_in_organization(p_target, p_organization_id)
    );
$function$;

revoke all on function private.admin_rank_permits(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function private.admin_rank_permits(uuid, uuid, uuid) is
  'True when the actor may run an account-recovery action (sign-in address, password reissue, MFA reset) on the target: the target holds no admin rank in the organization, or the actor''s rank is strictly higher.';

create or replace function public.begin_member_signin_recovery(p_target_user uuid, p_new_email_hash text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  target_chapter text;
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_new_email_hash, '')));
  clean_reason text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_reason, '')));
  operation_row private.member_signin_recoveries%rowtype;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_target_user is null or p_target_user = caller then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;
  select p.chapter_id into target_chapter from public.member_profiles p where p.id = p_target_user;
  if caller_chapter is null or target_chapter is distinct from caller_chapter then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  -- Tenant check: the target must be an active member of the caller's
  -- organization and of the shared chapter, not only someone whose selected
  -- chapter happens to match.
  if not exists (
       select 1
       from public.chapters c
       join public.organization_memberships om
         on om.organization_id = c.organization_id
        and om.user_id = p_target_user
        and om.status = 'active'
       where c.id = caller_chapter
         and c.organization_id is not null
         and c.organization_id = private.current_member_organization()
     )
     or not exists (
       select 1 from public.member_chapter_memberships m
       where m.user_id = p_target_user
         and m.chapter_id = caller_chapter
         and m.status = 'active'
     )
     -- A new sign-in address changes the whole account, so an account that
     -- is also an active member of another organization is never recovered
     -- by an organization admin.
     or exists (
       select 1 from public.organization_memberships other
       where other.user_id = p_target_user
         and other.status = 'active'
         and other.organization_id is distinct from private.current_member_organization()
     ) then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  -- Admin rank (20261125120100): an administrator never changes the sign-in
  -- address of an administrator of equal or higher rank in this organization.
  if not private.admin_rank_permits(caller, p_target_user, private.current_member_organization()) then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$'
     or clean_reason not in ('lost_inbox', 'address_retired') then
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  if not private.consume_member_signin_recovery_limit(
    'admin:' || caller::text, 'admin-hour', 5, interval '1 hour'
  ) or not private.consume_member_signin_recovery_limit(
    'target:' || p_target_user::text, 'target-day', 3, interval '1 day'
  ) then
    raise exception 'recovery rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-signin-recovery-target:' || p_target_user::text, 509)
  );
  select * into operation_row
  from private.member_signin_recoveries
  where target_user = p_target_user and status = 'changing'
  for update;

  if found then
    if operation_row.actor = caller
       and operation_row.new_email_hash = clean_hash
       and operation_row.reason = clean_reason then
      update private.member_signin_recoveries
      set attempts = least(attempts + 1, 20), updated_at = clock_timestamp()
      where id = operation_row.id;
      return pg_catalog.jsonb_build_object(
        'accepted', true, 'operationId', operation_row.id, 'retry', true,
        'adminRank', 'checked'
      );
    end if;
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  -- Do not reveal whether the proposed address belongs to an Auth user or a
  -- still-live invitation. The endpoint maps every branch to generic copy.
  if exists (
    select 1 from auth.users u
    where u.email is not null
      and pg_catalog.encode(
        extensions.digest(pg_catalog.lower(pg_catalog.btrim(u.email)), 'sha256'), 'hex'
      ) = clean_hash
  ) or exists (
    select 1 from public.member_invitations i
    where i.status in ('pending', 'accepting')
      and pg_catalog.encode(extensions.digest(i.normalized_email, 'sha256'), 'hex') = clean_hash
  ) then
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  insert into private.member_signin_recoveries
    (actor, target_user, chapter_id, new_email_hash, reason)
  values (caller, p_target_user, caller_chapter, clean_hash, clean_reason)
  returning * into operation_row;

  return pg_catalog.jsonb_build_object(
    'accepted', true, 'operationId', operation_row.id, 'retry', false,
    'adminRank', 'checked'
  );
end;
end;
$function$;

create or replace function public.begin_member_password_reissue(p_target_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  operation private.member_password_reissues%rowtype;
  live_operation_found boolean := false;
begin
  if caller is null or not private.mfa_satisfied()
     or not private.member_has_chapter_role(chapter, array['admin'])
     or p_target_user is null or p_target_user = caller
     or not exists (
       select 1 from public.member_chapter_memberships m
       where m.user_id = p_target_user and m.chapter_id = chapter and m.status = 'active'
     )
     -- Tenant check: the target is an active member of this chapter's
     -- organization, and any chapter they have selected is inside it.
     or not exists (
       select 1
       from public.chapters cc
       join public.organization_memberships om
         on om.organization_id = cc.organization_id
        and om.user_id = p_target_user
        and om.status = 'active'
       join public.member_profiles tp on tp.id = p_target_user
       left join public.chapters tc on tc.id = tp.chapter_id
       where cc.id = chapter
         and cc.organization_id is not null
         and (tp.chapter_id is null or tc.organization_id = cc.organization_id)
     )
     -- A new password changes the whole account, so a member of another
     -- organization as well is never reissued from here.
     or exists (
       select 1
       from public.organization_memberships other
       join public.chapters cc on cc.id = chapter
       where other.user_id = p_target_user
         and other.status = 'active'
         and other.organization_id is distinct from cc.organization_id
     ) then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;

  -- Admin rank (20261125120100): an administrator never reissues the password
  -- of an administrator of equal or higher rank in this organization.
  if not private.admin_rank_permits(caller, p_target_user,
       (select c.organization_id from public.chapters c where c.id = chapter)) then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-password-reissue:' || p_target_user::text, 509));
  select * into operation from private.member_password_reissues
  where target_user = p_target_user and status = 'delivering' for update;
  live_operation_found := found;

  if live_operation_found and operation.chapter_id <> chapter then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;

  if live_operation_found
     and operation.updated_at > pg_catalog.clock_timestamp() - interval '15 minutes' then
    raise exception 'password reissue already in progress' using errcode = 'P0001';
  end if;

  if not private.consume_member_signin_recovery_limit(
    'admin:' || caller::text, 'admin-hour', 5, interval '1 hour'
  ) then
    raise exception 'password reissue rate limited' using errcode = 'P0001';
  end if;

  -- A stale operation already consumed the target's daily allowance when it
  -- was created. Taking over that lease must not consume another target slot,
  -- or three provider failures could prevent the required recovery attempt.
  if not live_operation_found and not private.consume_member_signin_recovery_limit(
    'target:' || p_target_user::text, 'target-day', 3, interval '1 day'
  ) then
    raise exception 'password reissue rate limited' using errcode = 'P0001';
  end if;

  if live_operation_found then
    update private.member_password_reissues
    set actor = caller, attempts = least(attempts + 1, 20), updated_at = pg_catalog.clock_timestamp()
    where id = operation.id;
    return pg_catalog.jsonb_build_object('accepted', true, 'operationId', operation.id, 'retry', true, 'adminRank', 'checked');
  end if;

  insert into private.member_password_reissues (actor, target_user, chapter_id)
  values (caller, p_target_user, chapter) returning * into operation;
  return pg_catalog.jsonb_build_object('accepted', true, 'operationId', operation.id, 'retry', false, 'adminRank', 'checked');
end;
end;
$function$;

create or replace function public.authorize_mfa_reset(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'target required' using errcode = '22023';
  end if;
  if p_user_id = caller then
    raise exception 'an admin cannot reset their own second factor' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_profiles p
    where p.id = p_user_id
      and exists (
        select 1
        from public.chapters pc
        where pc.id = p.chapter_id
          and pc.organization_id = private.current_member_organization()
      )
      and exists (
        select 1
        from public.member_chapter_memberships m
        join public.chapters c on c.id = m.chapter_id
        where m.user_id = p.id
          and m.status = 'active'
          and c.organization_id = private.current_member_organization()
          and (
            private.has_organization_role(c.organization_id, array['admin'])
            or private.member_has_chapter_role(m.chapter_id, array['admin'])
          )
      )
  ) then
    raise exception 'unknown member' using errcode = '22023';
  end if;
  -- Admin rank (20261125120100): an administrator never resets the second
  -- factor of an administrator of equal or higher rank in this organization.
  if not private.admin_rank_permits(caller, p_user_id, private.current_member_organization()) then
    raise exception 'admin rank insufficient' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'authorized', true, 'adminRank', 'checked');
end;
$$;

create or replace function public.begin_mfa_reset(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  boundary_at timestamptz;
  abandoned_claims integer := 0;
  recovery_locks_released integer := 0;
  web_push_removed integer := 0;
  native_push_removed integer := 0;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'target required' using errcode = '22023';
  end if;
  if p_user_id = caller then
    raise exception 'an admin cannot reset their own second factor' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || p_user_id::text));
  perform 1
  from public.member_profiles p
  where p.id = p_user_id
    and exists (
      select 1
      from public.chapters pc
      where pc.id = p.chapter_id
        and pc.organization_id = private.current_member_organization()
    )
    and exists (
      select 1
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id
      where m.user_id = p.id
        and m.status = 'active'
        and c.organization_id = private.current_member_organization()
        and (
          private.has_organization_role(c.organization_id, array['admin'])
          or private.member_has_chapter_role(m.chapter_id, array['admin'])
        )
    )
  for key share of p;
  if not found then
    raise exception 'unknown member' using errcode = '42501';
  end if;

  -- Admin rank (20261125120100): same rule as public.authorize_mfa_reset.
  if not private.admin_rank_permits(caller, p_user_id, private.current_member_organization()) then
    raise exception 'admin rank insufficient' using errcode = '42501';
  end if;

  boundary_at := pg_catalog.clock_timestamp();
  insert into private.member_mfa_reset_boundaries
    (user_id, invalid_before, reset_by)
  values (p_user_id, boundary_at, caller)
  on conflict (user_id) do update
    set invalid_before = greatest(
          private.member_mfa_reset_boundaries.invalid_before,
          excluded.invalid_before
        ),
        reset_by = excluded.reset_by,
        created_at = pg_catalog.clock_timestamp();

  update public.mfa_recovery_codes
  set claimed_at = null,
      claim_expires_at = null,
      claim_token_hash = null,
      claim_session_handle = null
  where user_id = p_user_id
    and used_at is null
    and claim_token_hash is not null;
  get diagnostics abandoned_claims = row_count;

  delete from private.member_mfa_recovery_locks
  where user_id = p_user_id;
  get diagnostics recovery_locks_released = row_count;

  insert into private.member_session_closing_barriers
    (user_id, session_handle, scope)
  select p_user_id, private.member_session_handle(s.id), 'global'
  from auth.sessions s
  where s.user_id = p_user_id
  on conflict (user_id, session_handle) do update
    set scope = 'global',
        closed_at = pg_catalog.now();

  delete from public.member_push_subscriptions
  where user_id = p_user_id;
  get diagnostics web_push_removed = row_count;
  delete from public.member_native_push_installations
  where user_id = p_user_id;
  get diagnostics native_push_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id,
    'authorized', true,
    'staleSessionsBlocked', true,
    'adminRank', 'checked',
    'abandonedClaimsInvalidated', abandoned_claims,
    'recoveryLockReleased', recovery_locks_released = 1,
    'pushSubscriptionsRemoved', web_push_removed + native_push_removed,
    'nativePushInstallationsRemoved', native_push_removed,
    'serverCleanupComplete', true);
end;
end;
$function$;

notify pgrst, 'reload schema';

commit;
