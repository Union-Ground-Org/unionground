-- SEC-UG-MFA-RESET-TENANT-SCOPE-20260917
--
-- Close the cross-tenant hole in the two administrator MFA-reset authorities
-- that are reachable directly over PostgREST.
--
-- THE DEFECT (proven live on a disposable stack; PR #2106 review finding 2).
-- public.begin_mfa_reset(uuid) (20260905005500) checked only that the target
-- exists -- `perform 1 from public.member_profiles where id = p_user_id for key
-- share` -- and public.record_mfa_reset(uuid, integer) (20260724031000) carried
-- no target check at all. `public.member_has_role(array['admin'])` answers for
-- the CALLER's own chapters, never for the target, so an organization-A
-- administrator at aal2 could call either RPC against an organization-B member:
-- begin_mfa_reset wrote a private.member_mfa_reset_boundaries row with
-- reset_by = adminA and closed that member's sessions, web push and native push
-- installations; record_mfa_reset wrote a `reset_mfa` member_admin_audit row
-- naming a foreign member. On Main api/admin-mfa-reset.js calls no
-- authorize_mfa_reset at all -- begin_mfa_reset IS its first gate -- so the
-- product endpoint was cross-tenant too, not only the direct RPC path. (Main's
-- public.authorize_mfa_reset checks bare existence and has no caller; PR #2106
-- re-declares it tenant-scoped and wires it in front of begin_mfa_reset.)
--
-- THE REPAIR. Each function's target check becomes the tenant-scoped existence
-- check (the one PR #2106's public.authorize_mfa_reset re-declaration uses),
-- taking the row lock on the profile alias so the pre-existing `for key share`
-- acquisition is preserved:
--
--   perform 1
--   from public.member_profiles p
--   join public.chapters c on c.id = p.chapter_id
--   where p.id = p_user_id
--     and c.organization_id = private.current_member_organization()
--   for key share of p;
--
-- `=` is the repo-wide chapter tenant predicate (129 occurrences, no
-- `is not distinct from` spelling anywhere), so a caller whose own chapter
-- carries no organization resolves NULL and is refused -- fail-closed.
--
-- DIFFED AGAINST THE CURRENT DEFINITIONS. Both bodies below are the INSTALLED
-- definitions (pg_get_functiondef on a stack with every migration applied),
-- which means they carry the case-graph wrapper preamble that
-- 20260907151000's $case_graph_writers$ block added to both functions:
-- `perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);`
-- ahead of the original `declare` block. Reproducing the installed wrapper on a
-- re-declaration is the same thing 20260912002000 did for
-- public.claim_mfa_recovery_code and the other enrolled writers; dropping it
-- would strip the transaction entry that
-- scripts/account-case-graph-inventory.mjs requires of every graph writer.
-- Apart from the target check, exactly ONE other line moves: the refusal that
-- follows it raises 42501 rather than begin_mfa_reset's previous 22023, so the
-- flat "not permitted" code covers "not an admin", "yourself" and "not in your
-- organization" alike and the RPC is not a cross-tenant membership oracle. That
-- is the same choice PR #2106 made for notify_member_mfa_reset. Every remaining
-- line, comment and blank line is byte-identical.
--
-- The 20260907151000 review ledger is NOT edited: it pins each function's
-- PRE-wrapper source bytes as written in 20260905005500 / 20260724031000, those
-- files are untouched, and the ledger's DO block runs before this migration on
-- a fresh apply. EXECUTE is restated exactly as it stands today rather than
-- retightened, so this migration changes no grant.
--
-- Conventions kept: SECURITY DEFINER, `set search_path = ''`, every call
-- pg_catalog/schema-qualified, EXECUTE revoked from PUBLIC and anon, and the
-- exact role grant re-issued. Each REVOKE below is the one its own lineage
-- issued -- begin_mfa_reset names service_role (20260901153738) and
-- record_mfa_reset does not (20260724031000) -- so the effective grants stay
-- exactly `authenticated` and `authenticated,service_role` respectively, which
-- is what scripts/db-contract.json already records. CREATE OR REPLACE keeps an
-- existing function's ACL, so neither RPC's reachable role set moves here.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- Administrator-assisted reset is the tightly controlled liveness path for a
-- self-service recovery that stopped after installing its durable account
-- lock. Establish the reset boundary first, then invalidate the abandoned
-- claim and release the recovery lock atomically. Existing sessions remain
-- denied even when provider factor deletion or logout later fails.
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
  join public.chapters c on c.id = p.chapter_id
  where p.id = p_user_id
    and c.organization_id = private.current_member_organization()
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
  'MFA-gated administrator reset boundary and fail-closed reconciliation for stranded self-recovery, session push cleanup, and subsequent provider factor removal. The target must be in the caller''s organization.';

-- ---------------------------------------------------------------------------
-- Written AFTER the factors are actually gone, so the trail records what
-- happened rather than what was attempted. Re-checks authorization rather than
-- trusting that the caller already passed it.
--
-- member_admin_audit.target_user references auth.users only, so nothing in the
-- schema stopped this writer from naming a member of another organization; the
-- tenant-scoped existence check below is what does.
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
  join public.chapters c on c.id = p.chapter_id
  where p.id = p_user_id
    and c.organization_id = private.current_member_organization()
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
  'MFA-gated administrator audit writer for a completed second-factor reset. The target must be in the caller''s organization.';

commit;
