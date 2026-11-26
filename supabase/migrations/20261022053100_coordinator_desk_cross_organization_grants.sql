-- BUG-UG-COORDINATOR-DESK-OMITS-CROSS-ORGANIZATION-CASE-GRANTS-20261021
--
-- 20261021034151 lets casework_grant_access save a grant to a coordinator who is
-- active in the organization of the member's profile chapter while the case
-- belongs to another organization (the member's chapter moved). That grantee
-- reads the case: private.casework_staff_can_access and the member_cases
-- coordinator SELECT policy both admit it through
-- public.staff_can_see_user(member, 'coordinator') plus the active grant. The
-- coordinator desk still hid it, because all three desk readers bound the set
-- to the caller's current organization AND current chapter before anything
-- else:
--   public.list_coordinator_cases      (20260919011000, invoker + RLS)
--   public.get_coordinator_kpis        (20260918200000, definer)
--   private.casework_dashboard_open_cases (20260917142000, definer)
--
-- Repair. Each reader keeps its tenant bound and adds ONE alternative: a case
-- the caller holds an active (unrevoked) casework_access_grants row for, when
-- public.staff_can_see_user(c.user_id, 'coordinator') admits the caller in
-- their current organization. The case chapter is then not required to be the
-- caller's current chapter. The branch also requires
-- private.casework_staff_can_access(c.id): the grant is saved once, the
-- grantee's staff standing on the case chapter can be removed later, and the
-- queue must then drop the case exactly as the KPIs and tiles do.
-- The queue calls the helper only on this branch; its tenant branch
-- stays invoker + RLS as before. Every other predicate is unchanged and still
-- applies to both branches: status, non-null organization and chapter, focus
-- and keyset (pager), private.casework_staff_can_access (KPIs and tiles), and
-- invoker RLS (pager). A coordinator without such a grant sees exactly the
-- set they saw before. The three bounds stay copies of one another.
--
-- Signatures, security mode, volatility, empty search_path, role gates,
-- result shapes, revokes and grants are unchanged (create or replace keeps
-- the ACL). Each installed body is pinned by md5 before it is replaced.
-- Hosted application needs a separate go-ahead from the maintainers.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  installed text;
begin
  select array[
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
        where p.oid = 'public.list_coordinator_cases(text, date, uuid, integer)'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
        where p.oid = 'public.get_coordinator_kpis()'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
        where p.oid = 'private.casework_dashboard_open_cases()'::regprocedure)
    ]::text into strict installed;
  -- Reviewed predecessors, in order: 20260919011000, 20260918200000 and 20260917142000.
  if installed is distinct from '{71867b0b3713fa376b6618c807ced0b7,bcf7d38d86877895e3aa0f80ab3ca404,878be72b0a4230a598e703056dce3ef1}' then
    raise exception 'unreviewed coordinator desk predecessor: %', installed
      using errcode = '55000';
  end if;
end
$predecessor$;

create or replace function public.list_coordinator_cases(
  p_focus text default 'all',
  p_after_deadline date default null,
  p_after_id uuid default null,
  p_limit integer default 200
)
returns setof public.member_cases
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
begin
  if (select auth.uid()) is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if p_focus not in ('all', 'due', 'arbitration') then
    raise exception 'unknown focus' using errcode = '22023';
  end if;

  -- Tenant bound copied from private.casework_dashboard_open_cases
  -- (20260917142000) / public.get_coordinator_kpis (PR #2171) and MUST stay
  -- in sync with both. Applied before the remaining focus and keyset
  -- predicates so the RLS-visible read visits another chapter's case only
  -- when the caller holds an active grant for it and staff_can_see_user
  -- admits them (20261022053100). Due window is current_date + 6: seven days
  -- inclusive of today.
  return query
  select c.*
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and (
      (c.organization_id = (select private.current_member_organization())
        and c.chapter_id = (select private.current_member_chapter()))
      or (
        c.id in (
          select g.case_id
          from public.casework_access_grants g
          where g.grantee_user_id = (select auth.uid())
            and g.revoked_at is null
        )
        and public.staff_can_see_user(c.user_id, 'coordinator')
        and private.casework_staff_can_access(c.id)
      )
    )
    and (p_focus <> 'due' or (c.deadline is not null
      and c.deadline between current_date and current_date + 6))
    and (p_focus <> 'arbitration' or (c.step ~* 'arb' or c.step = 'Step 4'))
    and (
      p_after_id is null
      or (p_after_deadline is not null and (
        c.deadline > p_after_deadline
        or (c.deadline = p_after_deadline and c.id > p_after_id)
        or c.deadline is null))
      or (p_after_deadline is null and c.deadline is null and c.id > p_after_id)
    )
  order by c.deadline asc nulls last, c.id asc
  limit page_limit;
end;
$$;

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

  -- Bound 1, TENANT: the caller's own organization and chapter, or a case the
  -- caller holds an active grant for while staff_can_see_user admits them
  -- (20261022053100), copied from
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
      and (
        (c.organization_id = (select private.current_member_organization())
          and c.chapter_id = (select private.current_member_chapter()))
        or (
          c.id in (
            select g.case_id
            from public.casework_access_grants g
            where g.grantee_user_id = (select auth.uid())
              and g.revoked_at is null
          )
          and public.staff_can_see_user(c.user_id, 'coordinator')
          and private.casework_staff_can_access(c.id)
        )
      )
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

create or replace function private.casework_dashboard_open_cases()
returns table (
  case_id uuid,
  step_name text,
  steward_id uuid,
  steward_label text,
  coordinator_id uuid,
  coordinator_label text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    c.id,
    c.step,
    c.steward_user_id,
    c.steward_name,
    c.coordinator_user_id,
    c.coordinator_name
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and (
      (c.organization_id = (select private.current_member_organization())
        and c.chapter_id = (select private.current_member_chapter()))
      or (
        c.id in (
          select g.case_id
          from public.casework_access_grants g
          where g.grantee_user_id = (select auth.uid())
            and g.revoked_at is null
        )
        and public.staff_can_see_user(c.user_id, 'coordinator')
        and private.casework_staff_can_access(c.id)
      )
    )
    and private.casework_staff_can_access(c.id);
$function$;

comment on function public.list_coordinator_cases(text, date, uuid, integer) is
  'Keyset-paginated active-case pages for the coordinator desk. Bounded to the caller''s own organization and chapter, or to a case the caller holds an active casework_access_grants row for while public.staff_can_see_user admits them (the same bound public.get_coordinator_kpis and private.casework_dashboard_open_cases use), then filtered by invoker RLS so a restricted case without a grant stays hidden.';

comment on function public.get_coordinator_kpis() is
  'Case-queue KPIs for the grievance coordinator desk. Bounded to the caller''s own organization and chapter, or to a case the caller holds an active casework_access_grants row for while public.staff_can_see_user admits them, and then filtered case by case through private.casework_staff_can_access -- the same two bounds, in the same order, as the PR #2109 dashboard aggregates -- so every count describes exactly the cases the caller may read and a restricted case without an active grant is absent from openCases, dueThisWeek, inArbitration, byStep and byArticle.';

notify pgrst, 'reload schema';

commit;
