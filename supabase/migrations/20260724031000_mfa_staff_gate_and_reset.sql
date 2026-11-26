-- Two things the table-level assurance boundary does not reach.
--
-- (1) SECURITY DEFINER RPCs bypass RLS entirely, so the restrictive policy added
--     in 20260724030000 does nothing for them. 25 of this project's caller-
--     invocable definer functions gate on public.member_has_role() — every staff
--     surface: grant_member_role, triage_steward_request, send_steward_reply,
--     get_staff_roster, admin_search_members, scan_event_checkin, the form
--     approval chain, the coordinator/advisor/VP overviews. Without the check
--     below, someone holding a steward's password reads the whole steward scope
--     at aal1 while the member-facing tables sit correctly locked.
--
--     Putting the check inside member_has_role covers all 25 at one point rather
--     than editing 25 bodies and missing one. Staff who never enrol are
--     unaffected: mfa_satisfied() is true when there is no verified factor.
--
-- (2) Enrolling in MFA is currently a one-way door. Proven against the live auth
--     service: DELETE /auth/v1/factors/<id> with an aal1 token answers
--     422 "AAL2 required to unenroll verified factor". A member who loses their
--     phone cannot unenrol, and password recovery does not help because a
--     recovery session is also aal1. GoTrue has no backup codes. Their only way
--     back in is somebody with the service-role key.
--
--     So the way back in becomes a real, audited surface instead of a DM to
--     whoever has database access.

-- ---------------------------------------------------------------------------
-- 1. Staff privilege now requires a satisfied assurance level.
-- ---------------------------------------------------------------------------
-- Body is otherwise identical to 20260722001108. Kept SQL/stable/definer so the
-- planner can still inline it in the policies that call it.
create or replace function public.member_has_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.mfa_satisfied())
     and exists (
       select 1
       from public.member_roles
       where user_id = (select auth.uid())
         and role = any(p_roles)
     );
$$;

comment on function public.member_has_role(text[]) is
  'True when the caller holds one of the roles AND has satisfied MFA. The MFA '
  'term is what extends the assurance boundary over every security-definer '
  'staff RPC, which bypass RLS and would otherwise ignore it.';

-- ---------------------------------------------------------------------------
-- 2. Audited admin-assisted MFA reset.
-- ---------------------------------------------------------------------------
alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa'));

-- Authorization only — no side effects, so a caller who abandons the flow
-- leaves no trace suggesting a reset happened.
--
-- SELF-RESET IS REFUSED, and that is the security-critical line here. Deleting
-- your own factors needs only an aal1 session, so an admin who could reset
-- themselves would hand any thief of an admin password a one-call MFA bypass —
-- the endpoint would become the very hole MFA is meant to close. An admin who
-- loses their own device is reset by another admin; the last admin standing
-- needs service-role SQL, which is the same escape hatch already documented for
-- minting the first admin.
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
  if not exists (select 1 from public.member_profiles where id = p_user_id) then
    raise exception 'unknown member' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'authorized', true);
end;
$$;

revoke all on function public.authorize_mfa_reset(uuid) from public, anon;
grant execute on function public.authorize_mfa_reset(uuid) to authenticated;

-- Written AFTER the factors are actually gone, so the trail records what
-- happened rather than what was attempted. Re-checks authorization rather than
-- trusting that the caller already passed it.
create or replace function public.record_mfa_reset(p_user_id uuid, p_factors integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = caller then
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
$$;

revoke all on function public.record_mfa_reset(uuid, integer) from public, anon;
grant execute on function public.record_mfa_reset(uuid, integer) to authenticated;
