-- BUG-UG-COORDINATOR-KPIS-COUNT-RESTRICTED-CASES-20260917
--
-- public.get_coordinator_kpis (20260723160000_coordinator_case_plane:47) is a
-- SECURITY DEFINER aggregate that predates the casework suite (20260828210000)
-- and the organization scope foundation (20260822010000). Its `base` CTE was
--
--   from public.member_cases c
--   join public.member_profiles p on p.id = c.user_id
--   where caller_chapter is null or p.chapter_id = caller_chapter
--
-- with `caller_chapter` read from the LEGACY public.member_roles table. Two
-- defects, not one:
--
--   1. RESTRICTION. The CTE never consulted public.member_cases.is_restricted or
--      public.casework_access_grants, so a chapter coordinator holding no grant
--      had every restricted case counted in openCases, dueThisWeek,
--      inArbitration, byStep and byArticle -- while the drilldown beside it
--      (public.list_coordinator_cases, security INVOKER) and the five PR #2109
--      dashboard aggregates (20260917142000_case_dashboard_aggregates) hid
--      exactly those cases. Measured during the review of PR #2109: openCases = 4
--      with `Step 4` present in byStep while the dashboards' by-step total was 3.
--   2. SCOPE. Nothing syncs public.member_roles from the modern
--      public.organization_role_grants (the only writer is
--      public.set_member_chapter_role, 20260822010000:1762), so for an
--      organization-granted coordinator -- the shipped shape --
--      `caller_chapter` is NULL and `caller_chapter is null or ...` was
--      unconditionally TRUE. The definer therefore aggregated every
--      public.member_cases row in the database, across chapters AND across
--      tenants. Measured on a disposable stack with a foreign-organization case
--      present: openCases = 3 including the other tenant's `Step 5`.
--
-- PR #2109 also mounts the dashboards as the coordinator's fifth tab and feeds
-- its "05 Dashboards" badge from kpis.openCases, so the badge sat beside tiles
-- computed under a different, correct scope and contradicted them.
--
-- Repair. The CTE is rebuilt as the SAME two bounds, in the same order, that
-- private.casework_dashboard_open_cases uses (20260917142000:110-118) -- copied,
-- not paraphrased, because a paraphrase is how the badge and the tile drifted
-- apart in the first place:
--
--   1. TENANT. organization_id and chapter_id must equal the caller's own
--      private.current_member_organization() / private.current_member_chapter().
--      This is the cheap, index-usable bound that keeps the per-row access
--      helper off every other tenant's and chapter's rows.
--   2. VISIBILITY. private.casework_staff_can_access(case_id) -- the SAME helper
--      the casework suite's RLS policies, the coordinator write helpers and the
--      #2109 tiles already use -- decides case by case. Nothing here
--      re-implements, widens or shortcuts it.
--
-- The member_profiles join, the public.member_roles lookup and the
-- `caller_chapter` variable are removed with the predicate they existed to
-- serve. They cannot be retained as a belt-and-braces narrowing: the KPI bound
-- on the case OWNER's current profile chapter while the tile bounds on the
-- CASE's own frozen chapter_id, and member_cases.chapter_id is immutable after
-- private.mi1_bind_case_owner stamps it while member_profiles.chapter_id moves
-- when a multi-chapter member switches chapters. Keeping both bounds would
-- reintroduce exactly the badge-vs-tile disagreement this record is named after.
--
-- The two bounds are stated as two CTEs rather than one WHERE list so the
-- evaluation order is a property of the plan rather than of a cost estimate:
-- private.casework_staff_can_access is SECURITY DEFINER and therefore never
-- inlined, so it must run over the tenant-bounded set, not over the table.
--
-- COST, measured rather than asserted. The helper costs ~2.6 ms per surviving
-- case and that is inherent to it -- the #2109 tile pays the same rate over the
-- same population. What this migration changes is the SIZE of that population:
-- before, with the vacuous legacy bound, the helper ran over every case row in
-- the database; after, it runs over the caller's own chapter. The proof
-- tests/coordinator-kpis-restriction-gate-db.test.js carries a wall-clock budget
-- case at a seeded scale so a regression is visible in CI, in the shape of
-- tests/steward-desk-scale-latency-db.test.js.
--
-- The function is re-emitted with CREATE OR REPLACE and no ACL statement, so
-- owner, SECURITY DEFINER, STABLE, `set search_path = ''` and the
-- authenticated/service_role EXECUTE grants from 20260723160000 are preserved.
-- The guard, the due window, the arbitration predicate and the returned shape
-- are unchanged; public.list_coordinator_cases still mirrors the last two.
--
-- OPERATING BOUNDARIES, stated rather than discovered later. Three, all of them
-- measured; none of them is a disclosure, and none is repaired here.
--
-- 1. PRE-TENANCY ROWS. Both bounds require the case to carry organization_id and
--    chapter_id, and the tenant bound requires the caller to have a current
--    organization and chapter. A pre-tenancy member_cases row with a NULL tenant
--    column therefore leaves these counts even though the member_cases SELECT
--    policies would still admit it to public.list_coordinator_cases.
--    private.casework_staff_can_access already imposed the same requirement, so
--    the tenant bound adds no exclusion the visibility bound did not already
--    make; it is exactly the scope the #2109 tiles count, and making the badge
--    equal the tile total is the acceptance.
--
-- 2. THE QUEUE BESIDE THE BADGE IS STILL WIDER THAN THE BADGE.
--    public.list_coordinator_cases (20260805120000_coordinator_completeness:32-75)
--    is SECURITY INVOKER and bounded only by the member_cases SELECT policies,
--    which admit a sibling chapter's case to an ORGANIZATION-level coordinator
--    (private.actor_has_chapter_staff_role accepts an organization role grant for
--    every chapter in the organization). This aggregate is now bounded to the
--    caller's own chapter. Both are returned by the same loadCoordinatorDesk call
--    (src/lib/memberApi.js:4104-4112) and rendered on one screen, so in an
--    organization with two chapters, one active case in each and an org-level
--    coordinator grant:
--
--      kpis.openCases                          : 1
--      list_coordinator_cases('all') rows      : 2
--      casework_dashboard_open_cases_by_step() : total 1
--
--    20260805120000:54-56 says the queue's predicates are "copied from
--    get_coordinator_kpis and MUST stay in sync with it". The due-window and
--    arbitration predicates still are; the SCOPE is now divergent, in the
--    narrowing direction (before this migration the badge over-counted the
--    queue; now it under-counts it). This is deliberately NOT repaired here:
--    widening the KPI back would undo the badge/tile acceptance, and putting the
--    same tenant bound on list_coordinator_cases is a behaviour change to a
--    shipped surface. It is registered as
--    BUG-UG-COORDINATOR-QUEUE-AND-KPI-SCOPE-DIVERGE-20260918.
--
-- 3. COST GROWS WITH THE CHAPTER'S LIFETIME HISTORY, NOT ITS ACTIVE CASELOAD.
--    private.casework_staff_can_access is SECURITY DEFINER and therefore never
--    inlined; it costs ~2.6-2.9 ms per surviving row. The #2109 tile pays the
--    same rate but over a SMALLER population: private.casework_dashboard_open_cases
--    filters status = 'active' before the helper, while the tenant CTE below
--    cannot, because `resolved` and resolutionRate are LIFETIME tallies -- there
--    is no time window anywhere in this function, in list_coordinator_cases or
--    in the coordinator view (src/views/CoordinatorView.jsx:426-429,830 render
--    them as an all-time count and an all-time percentage), so no window can be
--    pushed into the tenant CTE without changing the numbers returned.
--    Measured on a disposable stack, three samples, one organization, an
--    organization-level coordinator grant:
--
--      chapter 200 active,    0 resolved, sibling 1800 :   558 ms   (tile 507 ms)
--      chapter 200 active,  300 resolved, sibling 1500 :  1206-1514 ms
--      chapter 200 active, 1300 resolved, sibling  500 :  3808-4270 ms
--      chapter 200 active, 1800 resolved, sibling    0 :  5013-5252 ms (tile 490 ms)
--
--    So the desk's initial load crosses four seconds at roughly 1,400-1,550
--    cases of ANY status in one chapter, and resolved cases are never pruned.
--    What this migration changes is that the population is a CHAPTER rather than
--    the whole table (the same fixtures cost 4,800-5,400 ms with the tenant bound
--    removed, while returning cross-chapter counts). Reducing the per-row rate --
--    a partial index, a statement-scoped visible-id set of the kind
--    private.visible_member_broadcast_ids uses, or a cached resolved tally -- is a
--    separate record, not this one. The proof carries a 4,000 ms budget case over
--    a fixture that includes resolved history so a regression in the bound itself
--    is visible in CI.
--
-- No policy, table, grant, index or other function changes.

begin;

set local lock_timeout = '5s';

create or replace function public.get_coordinator_kpis()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  open_cases integer;
  due_week integer;
  in_arb integer;
  resolved_cases integer;
  by_step jsonb;
  by_article jsonb;
begin
  if caller is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;

  -- Bound 1, TENANT: the caller's own organization and chapter, copied from
  -- private.casework_dashboard_open_cases (20260917142000) minus its
  -- status = 'active' filter, because `resolved` and resolutionRate need the
  -- resolved half of the same scope.
  -- Bound 2, VISIBILITY: the casework suite's own per-case helper, run over the
  -- tenant-bounded set only.
  -- The CTEs are materialized so both run once per call and the count filters
  -- plus the two grouped tallies read the same set, instead of three
  -- independent scans. Due window is current_date + 6: seven days inclusive of
  -- today (public.list_coordinator_cases mirrors it exactly).
  with tenant as materialized (
    select c.id, c.status, c.step, c.articles, c.deadline
    from public.member_cases c
    where c.organization_id is not null
      and c.chapter_id is not null
      and c.organization_id = (select private.current_member_organization())
      and c.chapter_id = (select private.current_member_chapter())
  ),
  base as materialized (
    select t.status, t.step, t.articles, t.deadline
    from tenant t
    where private.casework_staff_can_access(t.id)
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline between current_date and current_date + 6),
    pg_catalog.count(*) filter (where b.status = 'active'
      and (b.step ~* 'arb' or b.step = 'Step 4')),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('step', s.step, 'count', s.n) order by s.n desc, s.step), '[]'::jsonb)
     from (
       select step, pg_catalog.count(*) as n
       from base
       where status = 'active'
       group by step
     ) s),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('articles', a.articles, 'count', a.n) order by a.n desc, a.articles), '[]'::jsonb)
     from (
       select articles, pg_catalog.count(*) as n
       from base
       where status = 'active' and articles <> ''
       group by articles
     ) a)
  into open_cases, due_week, in_arb, resolved_cases, by_step, by_article
  from base b;

  return pg_catalog.jsonb_build_object(
    'openCases', open_cases,
    'dueThisWeek', due_week,
    'inArbitration', in_arb,
    'resolved', resolved_cases,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'byStep', by_step,
    'byArticle', by_article);
end;
$$;

comment on function public.get_coordinator_kpis() is
  'Case-queue KPIs for the grievance coordinator desk. Bounded to the caller''s own organization and chapter and then filtered case by case through private.casework_staff_can_access -- the same two bounds, in the same order, as the PR #2109 dashboard aggregates -- so every count describes exactly the cases the caller may read, the "05 Dashboards" badge equals the by-step tile total for the same caller, and a restricted case without an active casework_access_grants row is absent from openCases, dueThisWeek, inArbitration, byStep and byArticle.';

notify pgrst, 'reload schema';

commit;
