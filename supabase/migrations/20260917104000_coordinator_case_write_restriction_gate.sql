-- SEC-UG-COORDINATOR-CASE-WRITE-RESTRICTION-GATE-20260917
--
-- A grant-less in-scope coordinator could still mutate a RESTRICTED case
-- PostgREST had already hidden from them. public.member_cases.is_restricted
-- plus public.casework_access_grants (20260828210000, predicate settled by
-- 20260829001850) admit that coordinator to the case row only when they are
-- the case's own coordinator, hold an organization advisor/admin/vp hat, or
-- hold an active casework_access_grants row. The write helpers never consulted
-- that SELECT surface:
--
--   1. private.coordinator_case_for_update (20260810200000), behind
--      public.coordinator_update_case, public.coordinator_add_case_note,
--      public.coordinator_log_case_contact and
--      public.coordinator_record_case_outcome, selected the case on
--      staff_can_see_user alone. SECURITY DEFINER exempts it from the
--      member_cases policies, so the same coordinator could update status,
--      step and deadline, append notes, log contacts and record the outcome.
--      Every such write was also audited under the restricted case in
--      public.coordinator_case_audit.
--   2. private.can_write_member_case_object and
--      private.can_delete_member_case_object (20260905005500), behind the
--      case-files storage.objects insert and delete policies, authorized on
--      the same bare owner-or-staff_can_see_user disjunction over
--      public.member_case_files.
--
-- 20260917010000 (PR #2113) repaired the READ side and recorded these three
-- helpers as a separate finding. This migration is that finding. It composes
-- with #2113 in either merge order: it does not create, replace or drop
-- private.member_case_restriction_cleared or any policy #2113 emits.
--
-- Repair. PostgreSQL refuses SET role inside a SECURITY DEFINER function
-- ("cannot set parameter role within security-definer function"), so the
-- write helpers cannot evaluate member_cases under RLS the way #2113's
-- invoker policies do with EXISTS. They share one definer predicate whose
-- bypass list is the union of the three member_cases SELECT policies'
-- restriction branches — the same shape as #2113's
-- private.member_case_restriction_cleared, under a distinct name so this
-- file neither depends on nor redefines #2113. Each helper's existing
-- staff_can_see_user (or owner) conjunct is retained on purpose: the
-- predicate alone would be a widening.
--
-- private.coordinator_case_for_update is re-emitted from the live catalog
-- shape (pg_get_functiondef of the 20260907151000-wrapped body) as a constant
-- CREATE OR REPLACE so the lock wrapper stays the first statement and the
-- migration stays statically analyzable. Visibility failure raises 42501
-- before any DML or audit insert. The four public coordinator writers are
-- unchanged; they still go through this one helper.

begin;
set local lock_timeout = '5s';

-- Visibility probe for SECURITY DEFINER writers that cannot delegate to RLS.
-- The bypass list is the union of the three member_cases SELECT policies'
-- restriction branches (own, assigned steward, case coordinator, organization
-- advisor/admin/vp, active grant, or the case is not restricted). No client
-- EXECUTE: the only callers are sibling definer helpers.
create or replace function private.member_case_visible_to_caller(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_cases c
    where c.id = p_case_id
      and (
        not c.is_restricted
        or c.user_id = (select auth.uid())
        or c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or private.casework_actor_has_active_grant(c.id)
      )
  );
$function$;

comment on function private.member_case_visible_to_caller(uuid) is
  'Whether the JWT caller clears public.member_cases.is_restricted for this case. SECURITY DEFINER writers cannot SET role to evaluate the member_cases SELECT policies, so this predicate is the union of those policies'' restriction branches under a distinct name from the sibling read-side helper.';

revoke all on function private.member_case_visible_to_caller(uuid)
  from public, anon, authenticated, service_role;

-- Live body after 20260907151000: the case-graph lock is the first statement,
-- then the original 20260810200000 declarations. Visibility is required both
-- before the row lock (42501, no audit) and in the locked SELECT (narrowing
-- conjunct; never a substitute for staff_can_see_user).
create or replace function private.coordinator_case_for_update(p_case_id uuid)
returns public.member_cases
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare found public.member_cases%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if not private.member_case_visible_to_caller(p_case_id) then
    raise exception 'case unavailable' using errcode = '42501';
  end if;
  select c.* into found from public.member_cases c
  where c.id = p_case_id and public.staff_can_see_user(c.user_id, 'coordinator')
    and private.member_case_visible_to_caller(c.id)
  for update of c;
  if found.id is null then raise exception 'case unavailable' using errcode = '22023'; end if;
  return found;
end;
end;
$function$;

comment on function private.coordinator_case_for_update(uuid) is
  'Locks and returns a case the caller may mutate as a grievance coordinator. Requires MFA, the coordinator hat, chapter scope via staff_can_see_user, and that the case row itself is visible under the live member_cases SELECT policies, so a restricted case needs the case''s own coordinator, an organization advisor/admin/vp hat, or an active casework_access_grants row.';

revoke all on function private.coordinator_case_for_update(uuid)
  from public, anon, authenticated, service_role;

-- Attachment write/delete. Owner branch and the two-phase upload guards from
-- 20260905005500 are preserved; only the coordinator branch gains the parent
-- visibility requirement.
create or replace function private.can_write_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and ((f.confirmed_at is null and f.uploaded_by = (select auth.uid()))
        or f.confirmed_at is not null)
      and (f.confirmed_at is not null or f.cleanup_requested_at is null)
      and f.removal_requested_at is null
      and (
        f.user_id = (select auth.uid())
        or (public.staff_can_see_user(f.user_id, 'coordinator')
          and private.member_case_visible_to_caller(f.case_id))
      )
  );
$function$;

create or replace function private.can_delete_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and f.confirmed_at is not null
      and f.removal_requested_at is null
      and (
        f.user_id = (select auth.uid())
        or (public.staff_can_see_user(f.user_id, 'coordinator')
          and private.member_case_visible_to_caller(f.case_id))
      )
  );
$function$;

comment on function private.can_write_member_case_object(text, text) is
  'Authorizes a case-files Storage insert. The case owner keeps the existing confirmed/pending path; a chapter-scoped grievance coordinator additionally needs the parent case row to be visible under the live member_cases SELECT policies.';

comment on function private.can_delete_member_case_object(text, text) is
  'Authorizes a case-files Storage delete of a confirmed, untombstoned object. The case owner keeps the existing path; a chapter-scoped grievance coordinator additionally needs the parent case row to be visible under the live member_cases SELECT policies.';

revoke all on function private.can_write_member_case_object(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_write_member_case_object(text, text)
  to authenticated;
revoke all on function private.can_delete_member_case_object(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_delete_member_case_object(text, text)
  to authenticated;

commit;
