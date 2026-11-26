-- SEC-UG-CHAPTER-SCOPED-ROLE-GRANTS-RECEIVE-ORGANIZATION-WIDE-MFA-RESET-AUTHORITY-20260921
--
-- public.member_has_role(array['admin']) answers for the CALLER's home chapter
-- or an organization-wide grant. Combined with the organization-only target
-- check that 20260917130000 / 20260918090000 installed, a chapter-scoped
-- administrator could reach every member of every chapter in the organization.
--
-- THE REPAIR. One new migration re-emits every MFA-reset authority that still
-- carries that pair (authorize, begin, record, notify, queue, drain). The
-- first gate stays public.member_has_role, which ANDs private.mfa_satisfied()
-- and still raises 'admin role required'. The target lookup still resolves
-- the member inside private.current_member_organization(), then applies the
-- sibling account-recovery predicate used by
-- public.grant_member_chapter_membership and public.set_member_chapter_role
-- against every active chapter membership, the same surface
-- public.get_admin_member_directory uses:
--
--   private.has_organization_role(c.organization_id, array['admin'])
--   or private.member_has_chapter_role(m.chapter_id, array['admin'])
--
-- member_profiles.chapter_id is only the currently selected chapter. A
-- multi-chapter member who last selected B remains recoverable by an
-- administrator of A whenever an active member_chapter_memberships row for
-- A exists. An organization-wide admin grant keeps organization-wide reach.
-- A chapter-scoped admin grant reaches only the chapters that grant covers.
-- Main's tenant check is kept as an independent conjunct: the member's
-- selected chapter must still be in the caller's organization, so an active
-- membership row alone (which a chapter administrator can create through
-- public.grant_member_chapter_membership) never pulls a member of another
-- organization into reset scope. The repair only narrows Main's reach.
-- Out-of-scope, unknown, and cross-organization targets share the existing
-- unknown-member refusal, so the RPC is not a membership oracle. Self-reset,
-- MFA assurance, and every other refusal stay byte-identical.
--
-- No shipped migration is edited. CREATE OR REPLACE keeps each function's
-- existing ACL; EXECUTE is restated exactly as its own lineage issued it.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- A. Authorization-only gate the product endpoint calls first.
-- ---------------------------------------------------------------------------
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
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'authorized', true);
end;
$$;

revoke all on function public.authorize_mfa_reset(uuid) from public, anon, authenticated, service_role;
grant execute on function public.authorize_mfa_reset(uuid) to authenticated;

comment on function public.authorize_mfa_reset(uuid) is
  'MFA-gated, self-denying authorization for an administrator-assisted second-factor reset. Organization-wide administrators reach the organization; chapter-scoped administrators reach members with an active membership in a chapter their grants cover.';

-- ---------------------------------------------------------------------------
-- B. Durable reset boundary. Copied from 20260917130000 except the target
--    lookup now applies the sibling chapter-scope predicate.
-- ---------------------------------------------------------------------------
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
    'abandonedClaimsInvalidated', abandoned_claims,
    'recoveryLockReleased', recovery_locks_released = 1,
    'pushSubscriptionsRemoved', web_push_removed + native_push_removed,
    'nativePushInstallationsRemoved', native_push_removed,
    'serverCleanupComplete', true);
end;
end;
$function$;

revoke all on function public.begin_mfa_reset(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_mfa_reset(uuid) to authenticated;

comment on function public.begin_mfa_reset(uuid) is
  'MFA-gated administrator reset boundary and fail-closed reconciliation for stranded self-recovery, session push cleanup, and subsequent provider factor removal. Organization-wide administrators reach the organization; chapter-scoped administrators reach members with an active membership in a chapter their grants cover.';

-- ---------------------------------------------------------------------------
-- C. Audit writer. Copied from 20260917130000 except the target lookup.
-- ---------------------------------------------------------------------------
create or replace function public.record_mfa_reset(p_user_id uuid, p_factors integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = caller then
    raise exception 'invalid target' using errcode = '42501';
  end if;
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
    raise exception 'invalid target' using errcode = '42501';
  end if;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'reset_mfa', p_user_id,
          -- greatest/coalesce are grammar constructs, NOT pg_catalog functions:
          -- qualifying them raises 42883 even though every neighbouring call
          -- here is correctly qualified for search_path = ''.
          pg_catalog.jsonb_build_object('factorsRemoved', greatest(coalesce(p_factors, 0), 0)));

  return pg_catalog.jsonb_build_object('userId', p_user_id, 'recorded', true);
end;
end;
$function$;

revoke all on function public.record_mfa_reset(uuid, integer) from public, anon;
grant execute on function public.record_mfa_reset(uuid, integer) to authenticated;

comment on function public.record_mfa_reset(uuid, integer) is
  'MFA-gated administrator audit writer for a completed second-factor reset. Organization-wide administrators reach the organization; chapter-scoped administrators reach members with an active membership in a chapter their grants cover.';

-- ---------------------------------------------------------------------------
-- D. Member notice. Copied from 20260917120000 except the tenant lookup.
-- ---------------------------------------------------------------------------
create or replace function public.notify_member_mfa_reset(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  recorded_at timestamptz;
  member_lang text;
  notice_title text;
  notice_body text;
  inserted integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = caller then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  select max(a.created_at) into recorded_at
  from public.member_admin_audit a
  where a.actor = caller
    and a.target_user = p_user_id
    and a.action = 'reset_mfa'
    and a.created_at > pg_catalog.now() - interval '15 minutes';
  if recorded_at is null then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  select coalesce(p.language, 'en') into member_lang
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
    );
  if member_lang is null then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  if member_lang = 'es' then
    notice_title := 'Un administrador restableció la verificación en dos pasos';
    notice_body := 'Un administrador quitó el autenticador de tu cuenta y cerró tus sesiones abiertas. Vuelve a configurar la verificación en dos pasos desde Ajustes. Si no lo pediste, contacta a tu oficina local de inmediato.';
  else
    notice_title := 'Two-step sign-in was reset by an administrator';
    notice_body := 'An administrator removed the authenticator from your account and signed out your open sessions. Set up two-step sign-in again from Settings. If you did not ask for this, contact your local office immediately.';
  end if;

  if exists (
    select 1 from public.member_notifications n
    where n.user_id = p_user_id
      and n.created_at >= recorded_at
      and n.title in ('Two-step sign-in was reset by an administrator',
                      'Un administrador restableció la verificación en dos pasos')
  ) then
    return pg_catalog.jsonb_build_object('userId', p_user_id, 'notified', false, 'duplicate', true);
  end if;

  insert into public.member_notifications (user_id, title, body, kind)
  values (p_user_id, notice_title, notice_body, 'general');
  get diagnostics inserted = row_count;

  return pg_catalog.jsonb_build_object('userId', p_user_id, 'notified', inserted = 1);
end;
$function$;

revoke all on function public.notify_member_mfa_reset(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.notify_member_mfa_reset(uuid) to authenticated;

comment on function public.notify_member_mfa_reset(uuid) is
  'Admin-gated, self-target refused: writes the member''s localized out-of-band notice for an admin-assisted MFA reset that record_mfa_reset already audited, exactly once per recorded reset. Organization-wide administrators reach the organization; chapter-scoped administrators reach members with an active membership in a chapter their grants cover.';

-- ---------------------------------------------------------------------------
-- E. Queue / drain from 20260918090000, with the same chapter-scope conjunct
--    inside the existing locked member lookup.
-- ---------------------------------------------------------------------------
create or replace function public.queue_member_mfa_reset_notice(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  owed_at timestamptz;
  sent_at timestamptz;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = caller then
    raise exception 'invalid target' using errcode = '42501';
  end if;
  if not exists (
    select 1
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
  ) then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  select b.invalid_before, b.notice_sent_at into owed_at, sent_at
  from private.member_mfa_reset_boundaries b
  where b.user_id = p_user_id
    and b.reset_by = caller
  for update;
  if not found then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  update private.member_mfa_reset_boundaries
  set notice_owed_at = owed_at
  where user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id,
    'resetAt', owed_at,
    'pending', sent_at is null or sent_at < owed_at);
end;
$function$;

revoke all on function public.queue_member_mfa_reset_notice(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.queue_member_mfa_reset_notice(uuid) to authenticated;

comment on function public.queue_member_mfa_reset_notice(uuid) is
  'Admin-gated, tenant-scoped, self-target refused: durably records that the member is owed an MFA-reset notice for the reset this administrator began, without sending anything. Organization-wide administrators reach the organization; chapter-scoped administrators reach members with an active membership in a chapter their grants cover.';

create or replace function public.drain_member_mfa_reset_notice(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  owed_at timestamptz;
  sent_at timestamptz;
  member_lang text;
  notice_title text;
  notice_body text;
  inserted integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = caller then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  select coalesce(p.language, 'en') into member_lang
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
    );
  if member_lang is null then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  select b.notice_owed_at, b.notice_sent_at into owed_at, sent_at
  from private.member_mfa_reset_boundaries b
  where b.user_id = p_user_id
  for update;
  if not found or owed_at is null or (sent_at is not null and sent_at >= owed_at) then
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id, 'drained', false, 'notified', false, 'pending', false);
  end if;

  if member_lang = 'es' then
    notice_title := 'Un administrador restableció la verificación en dos pasos';
    notice_body := 'Un administrador quitó el autenticador de tu cuenta y cerró tus sesiones abiertas. Vuelve a configurar la verificación en dos pasos desde Ajustes. Si no lo pediste, contacta a tu oficina local de inmediato.';
  else
    notice_title := 'Two-step sign-in was reset by an administrator';
    notice_body := 'An administrator removed the authenticator from your account and signed out your open sessions. Set up two-step sign-in again from Settings. If you did not ask for this, contact your local office immediately.';
  end if;

  if exists (
    select 1 from public.member_notifications n
    where n.user_id = p_user_id
      and n.created_at >= owed_at
      and n.title in ('Two-step sign-in was reset by an administrator',
                      'Un administrador restableció la verificación en dos pasos')
  ) then
    update private.member_mfa_reset_boundaries
    set notice_sent_at = pg_catalog.clock_timestamp()
    where user_id = p_user_id;
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id, 'drained', true, 'notified', false,
      'duplicate', true, 'pending', false);
  end if;

  insert into public.member_notifications (user_id, title, body, kind)
  values (p_user_id, notice_title, notice_body, 'general');
  get diagnostics inserted = row_count;

  update private.member_mfa_reset_boundaries
  set notice_sent_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'drained', true, 'notified', inserted = 1, 'pending', false);
end;
$function$;

revoke all on function public.drain_member_mfa_reset_notice(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.drain_member_mfa_reset_notice(uuid) to authenticated;

comment on function public.drain_member_mfa_reset_notice(uuid) is
  'Admin-gated, tenant-scoped, self-target refused: delivers the member''s owed MFA-reset notice once, keeping the one-notice-per-reset guard, and settles the pending row whether it wrote the notice or found it already written. Organization-wide administrators reach the organization; chapter-scoped administrators reach members with an active membership in a chapter their grants cover.';

notify pgrst, 'reload schema';

commit;
