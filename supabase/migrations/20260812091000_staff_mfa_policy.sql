-- UB-IDN-03 (two-step sign-in cannot be mandated) + UB-DESK-04 (MFA is not
-- required to hold a staff hat). One migration, because they are one hole seen
-- from two ends: there is no org control that says "staff must enrol", and the
-- assurance predicate admits a staff account that never enrolled.
--
-- WHAT THE BOUNDARY DOES TODAY, AND WHY IT IS NOT ENOUGH.
-- private.mfa_satisfied() (20260724034000) is "caller is aal2, OR has no
-- verified TOTP factor to prove". That is exactly right for members: nobody is
-- forced to enrol, and nobody who did is admitted without proving it. It is
-- wrong for staff. member_has_role() ANDs the same term (20260724031000), so a
-- steward, coordinator, advisor, admin or president who simply never enrols
-- passes every staff RPC on a password alone. The MFA requirement is opt-in for
-- precisely the accounts that read other people's grievance files.
--
-- The fix is not "flip mfa_satisfied() to require a factor". That would lock
-- every member out of their own data the moment it committed, which is a
-- product decision nobody has taken and an outage this migration refuses to
-- cause. Assurance and enrolment are different questions, so they get different
-- predicates, and the second one is scoped to staff and gated by an org policy
-- that starts ON. Staff keep their ordinary member surface and can enroll from
-- Settings, but a missing or freshly-created singleton never reopens the
-- password-only staff path.
--
-- HOW IT COMPOSES.
--   member_has_role(roles)
--     = mfa_satisfied()                       -- prove the factor you have
--     AND holds one of `roles`
--     AND (NOT staff_mfa_required() OR caller_has_second_factor())
--
-- With the policy ON, the second and third terms together mean: a staff caller
-- must HAVE a verified factor, and because mfa_satisfied() then demands aal2 of
-- anyone who has one, must also have PROVEN it this session. Enrolment and
-- assurance both, which is what UB-DESK-04 asks for.
--
-- WHAT AN UNENROLLED STAFF ACCOUNT LOSES, AND WHAT IT KEEPS. It loses every
-- staff RPC — all of them route through member_has_role. It keeps its member
-- surfaces, because those hang off mfa_satisfied(), which is still true for
-- someone with no factor. That is deliberate and load-bearing: the way out of
-- the restriction is the enrolment screen, which lives inside the member app.
-- A design that locked the whole account would leave the staffer no path back
-- except an admin, and the admin might be them.
--
-- SELF-LOCKOUT AND BYPASS RESISTANCE. Turning the policy ON is refused unless
-- the calling admin has already enrolled. Once it is ON, turning it OFF also
-- requires a currently usable admin hat: an unenrolled password-only admin
-- cannot disable the boundary and recover every staff privilege in one call.
-- A blocked staffer retains the member Settings screen and can enrol there. A
-- lost-factor recovery continues through the existing audited admin reset; the
-- last-admin recovery remains service-role, exactly as it did before this
-- policy existed.
--
-- APP AUTHENTICATORS ONLY. The other half of UB-IDN-03 asks that phone and
-- security-key factors either be honored in the challenge and the predicate, or
-- that the product say plainly that only app authenticators count. This
-- deployment cannot honor them: MfaChallenge verifies TOTP and GoTrue here has
-- no SMS provider, so counting a phone factor would deny a member the app can
-- never challenge — the lockout 20260724034000 already removed once. The scope
-- therefore stays TOTP. The new staff-enrolment checks share a named enum list;
-- the existing member assurance predicate remains separately pinned to the same
-- TOTP-only set by tests/mfa-boundary.test.jsx. The in-product statement is the
-- companion frontend change (MfaSettings + the challenge screen).
--
-- SECURE ON ARRIVAL. require_staff_mfa defaults to true because UB-DESK-04 is a
-- critical assurance boundary, not an optional hardening suggestion. Existing
-- unenrolled staff retain their member surface and enrollment route, but their
-- staff hats remain paused until they enroll. An enrolled, AAL2 admin can make
-- an explicit audited decision to relax the organization policy.
--
-- WHEN THIS IS APPLIED: scripts/db-contract.json needs the new table in
-- policyCoverage (rlsTableCount 79 -> 80, org_security_policy added to
-- noPermissivePolicies) and the four new public functions added to `functions`.
-- The contract describes the LIVE database, so those edits belong with the
-- deploy, not with this file.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. What this deployment can actually ask a member for.
-- ---------------------------------------------------------------------------
-- One definition for the new policy's enrolment checks. IMMUTABLE and
-- argument-free so the planner folds it to a constant and the extra call costs
-- nothing inside the role predicate.
--
-- Not granted to authenticated: every caller is a SECURITY DEFINER body that
-- runs as the owner. A SQL function that is SECURITY DEFINER is never inlined
-- by the planner (inline_function refuses prosecdef), so the inner call cannot
-- leak out into the querying role's context and hit a missing grant.
create or replace function private.challengeable_factor_types()
returns auth.factor_type[]
language sql
immutable
set search_path = ''
as $$
  select array['totp']::auth.factor_type[];
$$;

comment on function private.challengeable_factor_types() is
  'Factor types this deployment can challenge, and therefore the only ones the '
  'staff enrolment predicate may count. TOTP only: MfaChallenge verifies TOTP and '
  'GoTrue here has no SMS provider, so counting a phone or WebAuthn factor '
  'would deny a member the app can never elevate (the lockout removed by '
  '20260724034000). The product says so in-product; see MfaSettings.';

-- Does this specific member hold a factor the app could challenge? Distinct
-- from mfa_satisfied(), which asks whether they have PROVEN one.
create or replace function private.has_second_factor(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.mfa_factors f
    where f.user_id = p_user
      and f.status = 'verified'
      and f.factor_type = any (private.challengeable_factor_types())
  );
$$;

comment on function private.has_second_factor(uuid) is
  'True when the member holds a verified factor of a challengeable type. '
  'ENROLMENT, not assurance — see private.mfa_satisfied() for the latter. '
  'security definer because authenticated cannot read auth.mfa_factors.';

revoke all on function private.challengeable_factor_types() from public, anon, authenticated;
revoke all on function private.has_second_factor(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. The org-level policy (UB-IDN-03).
-- ---------------------------------------------------------------------------
-- Singleton by construction: `id boolean primary key check (id)` admits exactly
-- one row, so "which settings row is authoritative" is not a question anyone
-- can get wrong later. A settings table that can hold two rows eventually does.
create table if not exists public.org_security_policy (
  id boolean primary key default true check (id),
  require_staff_mfa boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.org_security_policy (id) values (true)
on conflict (id) do nothing;

alter table public.org_security_policy enable row level security;

-- No permissive policy at all. Reads and writes both go through the definer
-- RPCs below, which is what lets get_staff_mfa_standing() answer a staffer the
-- policy has just shut out of every role-gated read. A permissive select policy
-- would ALSO have to survive the restrictive mfa_assurance clause below, so a
-- member owing a code could not read the row that explains why.
--
-- The restrictive clause is added by hand because 20260724030000 applied it
-- with a DO loop over the tables that existed THEN; a table created by a later
-- migration silently lacks it, and only the live catalog sweep in
-- scripts/db-contract.json can see that. Belt and braces on a table with no
-- permissive policy, and correct the moment somebody adds one.
drop policy if exists mfa_assurance on public.org_security_policy;
create policy mfa_assurance on public.org_security_policy
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.org_security_policy from public, anon, authenticated;

comment on table public.org_security_policy is
  'Single-row organization security policy. Written only through '
  'public.set_staff_mfa_policy(); no table grant to any API role.';

create or replace function private.staff_mfa_required()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.require_staff_mfa from public.org_security_policy p limit 1), true);
$$;

comment on function private.staff_mfa_required() is
  'Org policy: staff hats require an enrolled second factor. Coalesced to '
  'true so a missing settings row cannot reopen password-only staff access; '
  'ordinary member access and the enrollment route remain available.';

revoke all on function private.staff_mfa_required() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The role predicate (UB-DESK-04).
-- ---------------------------------------------------------------------------
-- CASE, not AND, and the order is load-bearing in two ways.
--
-- Correctness: it fixes evaluation order. The existing assurance check runs
-- first, the role grant second, and private.staff_mfa_required() — which reads a
-- table — is never evaluated for a caller who does not hold the role.
-- member_has_role runs inside RLS policies on dozens of tables; adding an
-- unconditional settings read to every member query would be a regression.
--
-- Honesty: a caller who holds no role gets `false` from the first branch, with
-- no clue in the result about whether a policy exists. Role membership is not
-- disclosed to non-holders here, exactly as before.
create or replace function public.member_has_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not (select private.mfa_satisfied()) then false
    when not exists (
      select 1
      from public.member_roles
      where user_id = (select auth.uid())
        and role = any(p_roles)
    ) then false
    when not (select private.staff_mfa_required()) then true
    else (select private.has_second_factor((select auth.uid())))
  end;
$$;

comment on function public.member_has_role(text[]) is
  'True when the caller holds one of the roles, has satisfied MFA, and — when '
  'the org policy requires staff two-step sign-in — holds a verified second '
  'factor of a challengeable type. The MFA terms are what extend the assurance '
  'boundary over every security-definer staff RPC, which bypass RLS and would '
  'otherwise ignore it.';

revoke all on function public.member_has_role(text[]) from public, anon;
grant execute on function public.member_has_role(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Reading and writing the policy (admin), and reading your own standing.
-- ---------------------------------------------------------------------------
alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa',
                    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
                    'set_staff_mfa_policy'));

-- Admin read. Carries the enrolment counts the toggle needs to be honest about
-- what turning it on would do: "3 of 7 staff would lose their hat" is the
-- difference between a policy change and an accident.
create or replace function public.get_staff_mfa_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  staff_total integer;
  staff_enrolled integer;
begin
  -- private.mfa_satisfied() is named explicitly rather than left implicit
  -- inside role_before_staff_policy: this is a public definer RPC, and the
  -- mfaCoverage sweep in scripts/db-contract.json reads bodies for that needle.
  if caller is null
     or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer,
         pg_catalog.count(*) filter (where private.has_second_factor(r.user_id))::integer
    into staff_total, staff_enrolled
    from (select distinct user_id from public.member_roles) r;

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', private.staff_mfa_required(),
    'staffTotal', coalesce(staff_total, 0),
    'staffEnrolled', coalesce(staff_enrolled, 0),
    -- Whether the admin standing here could turn it on. The client disables the
    -- control on this rather than guessing from the roster, so the button and
    -- the server agree about what will happen when it is pressed.
    'callerEnrolled', private.has_second_factor(caller),
    'updatedAt', (select p.updated_at from public.org_security_policy p limit 1));
end;
$$;

revoke all on function public.get_staff_mfa_policy() from public, anon;
grant execute on function public.get_staff_mfa_policy() to authenticated;

comment on function public.get_staff_mfa_policy() is
  'Admin-gated read of the org staff-MFA policy plus the staff enrolment '
  'counts that make turning it on an informed act.';

create or replace function public.set_staff_mfa_policy(p_required boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_value boolean;
begin
  if p_required is null then
    raise exception 'required flag missing' using errcode = '22023';
  end if;

  -- The same live role predicate protects both directions. In particular, an
  -- unenrolled password-only admin blocked by an enabled policy cannot turn it
  -- off and recover every staff privilege in one call.
  if caller is null
     or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  -- Repair a missing singleton first, then lock the row before reading the old
  -- value. Without the lock, two opposite toggles can both read the same old
  -- value and the second write can change the policy without writing its audit
  -- row. The insert uses the secure default, not p_required: the decision and
  -- its audit happen together after the lock.
  insert into public.org_security_policy (id, require_staff_mfa)
  values (true, true)
  on conflict (id) do nothing;

  select p.require_staff_mfa
    into current_value
    from public.org_security_policy p
   where p.id
   for update;

  -- Re-authorize AFTER the lock. An unenrolled admin can pass the first check
  -- while the policy is off, wait behind another transaction that turns it on,
  -- and otherwise disable it using that stale authorization. The second check
  -- observes the locked current value and closes that race.
  if caller is null
     or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  -- Refusing to let an admin fence themselves out. Enabling costs one enrolment
  -- and they are the person who should have done it first anyway; without this
  -- guard, the enabling call is the last successful admin call they make.
  if p_required and not private.has_second_factor(caller) then
    raise exception 'turn on your own two-step sign-in before requiring it of staff'
      using errcode = '42501';
  end if;

  if current_value is distinct from p_required then
    update public.org_security_policy
       set require_staff_mfa = p_required,
           updated_at = now(),
           updated_by = caller
     where id;
  end if;

  -- No-op writes are not audited: a compliance trail whose rows mostly say
  -- "set it to what it already was" is a trail nobody reads.
  if current_value is distinct from p_required then
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'set_staff_mfa_policy', null,
            pg_catalog.jsonb_build_object('requireStaffMfa', p_required));
  end if;

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', p_required,
    'changed', current_value is distinct from p_required);
end;
$$;

revoke all on function public.set_staff_mfa_policy(boolean) from public, anon;
grant execute on function public.set_staff_mfa_policy(boolean) to authenticated;

comment on function public.set_staff_mfa_policy(boolean) is
  'Admin-gated org policy write, audited. Both directions require a currently '
  'usable admin hat; enabling also refuses an admin who has not enrolled.';

-- Self-scoped, role-free ON PURPOSE. A staffer the policy has just shut out
-- fails member_has_role on every staff RPC, so no admin surface can tell them
-- why — this is the one call that still answers them, and it discloses nothing
-- but their own account's state.
create or replace function public.get_staff_mfa_standing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  holds_role boolean;
  enrolled boolean;
  required boolean;
begin
  if caller is null then
    raise exception 'sign in required' using errcode = '42501';
  end if;

  required := private.staff_mfa_required();
  enrolled := private.has_second_factor(caller);
  holds_role := exists (select 1 from public.member_roles where user_id = caller);

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', required,
    'holdsStaffRole', holds_role,
    'enrolled', enrolled,
    -- The caller's own assurance level, which is also the mfaCoverage needle
    -- for this function: it takes no step-up guard because a member who owes a
    -- code is exactly who needs to read it, and it returns nothing they could
    -- not already see about themselves.
    'assured', private.mfa_satisfied(),
    'blocked', required and holds_role and not enrolled);
end;
$$;

revoke all on function public.get_staff_mfa_standing() from public, anon;
grant execute on function public.get_staff_mfa_standing() to authenticated;

comment on function public.get_staff_mfa_standing() is
  'Self-scoped: does the org require staff two-step sign-in, does the caller '
  'hold a staff role, has the caller enrolled, and is the caller therefore '
  'shut out of their hats. Ungated by role because the blocked caller holds no '
  'usable role by definition.';

notify pgrst, 'reload schema';
