-- DEBT-UG-MEMBER-CASE-VISIBILITY-PREDICATE-SINGLE-SOURCE-20260917
-- (controller decision 2026-09-26, the NARROW variant from):
--
-- The member_cases restriction predicate ("does this caller clear
-- is_restricted for this row") was restated by hand in the coordinator SELECT
-- policy (20260829001850) and in two byte-identical by-id SECURITY DEFINER
-- helpers, private.member_case_restriction_cleared (20260917103000) and
-- private.member_case_visible_to_caller (20260917104000, re-emitted verbatim by
-- 20260917105000). Nothing tied the three together but db-contract needles.
--
-- This migration installs ONE row-typed predicate,
-- private.member_case_row_visible(public.member_cases), and makes the three
-- per-row gates consume it: the coordinator policy's restriction branch calls
-- it on the candidate row, and both by-id helpers become thin wrappers that
-- look the row up and delegate. The predicate takes the row and selects
-- nothing from public.member_cases itself, so it is safe inside that table's
-- own policies (no 42P17 recursion). It states exactly the union of the three
-- member_cases SELECT policies' restriction branches: the case is not
-- restricted, or the caller is the owner, the assigned steward wearing the
-- steward hat (public.member_has_role, as member_cases_select_steward
-- requires, so a revoked steward hat loses the bypass here too), the case's
-- own coordinator, an organization advisor/admin/vp, or the holder of an
-- active casework access grant.
--
-- The set-based hot-path mirrors (public.search_member_cases,
-- public.list_contract_clause_grievance_counts, the procedures reader and
-- reminder delivery) stay inline by decision and are tied to this helper by
-- the live equivalence proof in
-- tests/member-case-visibility-single-source-db.test.js.

begin;
set local lock_timeout = '5s';

-- Both by-id helpers carry the same 20260917104000/20260917105000 body today;
-- that body is the only predecessor this migration may wrap.
do $predecessor$
declare
  helper text;
  source text;
  digest text;
begin
  foreach helper in array array[
    'private.member_case_visible_to_caller(uuid)',
    'private.member_case_restriction_cleared(uuid)'
  ] loop
    select p.prosrc into strict source
      from pg_catalog.pg_proc p
     where p.oid = helper::regprocedure;
    digest := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
      'hex'
    );
    if digest is distinct from 'd886c380c04e2cc8b4f55a2b71658cc9f4ab0a5e4a881feb64b8b9f0e5abff1d' then
      raise exception 'unreviewed % predecessor: %', helper, digest
        using errcode = '55000';
    end if;
  end loop;
end;
$predecessor$;

-- 1. The single restriction predicate. Row-typed, no self-select, STABLE.
--    SECURITY DEFINER like the sibling policy predicates it composes
--    (private.has_organization_role, private.casework_actor_has_active_grant,
--    public.member_has_role); EXECUTE for authenticated only, because a policy
--    evaluates it as the querying role.
create or replace function private.member_case_row_visible(p_case public.member_cases)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    not p_case.is_restricted
    or p_case.user_id = (select auth.uid())
    or (p_case.steward_user_id = (select auth.uid()) and public.member_has_role(array['steward']))
    or p_case.coordinator_user_id = (select auth.uid())
    or private.has_organization_role(p_case.organization_id, array['advisor','admin','vp'])
    or private.casework_actor_has_active_grant(p_case.id);
$function$;

comment on function private.member_case_row_visible(public.member_cases) is
  'The single member_cases restriction predicate: whether the JWT caller clears is_restricted for this row (not restricted, owner, assigned steward wearing the steward hat, case coordinator, organization advisor/admin/vp, or an active casework access grant). Row-typed and free of any member_cases read so the member_cases policies can call it without recursion; the by-id helpers and the coordinator SELECT policy consume it.';

revoke all on function private.member_case_row_visible(public.member_cases)
  from public, anon, authenticated, service_role;
grant execute on function private.member_case_row_visible(public.member_cases)
  to authenticated;

-- 2. The by-id helpers become thin wrappers. Same names, signatures, security
--    and (absent) client EXECUTE; every caller (Storage byte reads, the
--    coordinator write gate, the attachment lifecycle RPCs, the audit reader)
--    is unchanged.
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
      and private.member_case_row_visible(c)
  );
$function$;

comment on function private.member_case_visible_to_caller(uuid) is
  'Whether the JWT caller clears public.member_cases.is_restricted for this case: a by-id wrapper over private.member_case_row_visible for SECURITY DEFINER writers that cannot SET role to evaluate the member_cases SELECT policies. No client EXECUTE.';

revoke all on function private.member_case_visible_to_caller(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.member_case_restriction_cleared(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.member_case_visible_to_caller(p_case_id);
$function$;

comment on function private.member_case_restriction_cleared(uuid) is
  'RLS predicate for SECURITY DEFINER readers that cannot delegate to the member_cases policies: the same by-id wrapper over private.member_case_row_visible under the read-side name 20260917103000 introduced. No client EXECUTE.';

revoke all on function private.member_case_restriction_cleared(uuid)
  from public, anon, authenticated, service_role;

-- 3. The coordinator SELECT policy calls the predicate for its restriction
--    branch. The scope conjunct is unchanged. The owner and hat-wearing
--    steward branches the predicate adds are already admitted by
--    member_cases_select_own and member_cases_select_steward, so the visible
--    set is the same set.
drop policy if exists member_cases_select_coordinator on public.member_cases;
create policy member_cases_select_coordinator on public.member_cases
  for select to authenticated using (
    public.staff_can_see_user(user_id, 'coordinator')
    and private.member_case_row_visible(member_cases)
  );

comment on policy member_cases_select_coordinator on public.member_cases is
  'A chapter-scoped coordinator reads a case only while private.member_case_row_visible clears its restriction for them; the predicate is the single source the by-id definer helpers also consume (DEBT-UG-MEMBER-CASE-VISIBILITY-PREDICATE-SINGLE-SOURCE-20260917).';

do $installed$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'member_cases'
      and policyname = 'member_cases_select_coordinator'
      and qual like '%private.member_case_row_visible(member_cases.*)%'
  ) then
    raise exception 'member_cases_select_coordinator does not call private.member_case_row_visible'
      using errcode = '55000';
  end if;
end;
$installed$;

commit;
