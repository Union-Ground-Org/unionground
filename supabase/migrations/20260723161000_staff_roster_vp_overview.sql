-- REQ-UG-FULL-DEPTH-20260723 PR4a: staff roster + VP/president overview.
-- The 'vp' role slug already exists in the member_roles CHECK (widened by the
-- PR1 chapter migration), so this PR adds no table or constraint changes —
-- only two read-only role-gated SECURITY DEFINER aggregates. Definer because
-- the callers cannot see the underlying cross-member rows under member RLS
-- (the get_workload_stats precedent); every count the VP sees is an
-- aggregate, never a rank-and-file row. Roles stay service-side-provisioned:
-- no client write path on member_roles is added here or anywhere.

-- 1. Staff roster: everyone holding ANY staff role, with their roles.
--    Visible to every staff plane (leadership is semi-public inside the
--    chapter); never returns rank-and-file members.
create function public.get_staff_roster()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin', 'coordinator', 'advisor', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', p.id,
      'fullName', p.full_name,
      'initials', p.initials,
      'memberSince', p.member_since,
      'roles', r.roles) order by p.full_name)
    from (
      -- Deterministic page if staff ever exceeds the cap: without an ORDER BY
      -- the LIMIT would return a plan-dependent 200.
      select user_id, pg_catalog.jsonb_agg(role order by role) as roles
      from public.member_roles
      group by user_id
      order by user_id
      limit 200
    ) r
    join public.member_profiles p on p.id = r.user_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_staff_roster() from public, anon;
grant execute on function public.get_staff_roster() to authenticated;

-- 2. VP / president overview. Chapter-scoped by the caller's vp (or admin)
--    role row exactly like the coordinator KPIs: NULL chapter_id = org-wide.
--    Honest replacements for the demo cards with no backing: no dues, no
--    campaign percentages, no monthly churn — member_since is a join YEAR,
--    so the trend is cumulative members by year; "needs exec attention" is
--    the real list of active cases past their contractual deadline
--    (reference/title/step/deadline only — no narratives).
create function public.get_vp_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  member_count integer;
  new_this_year integer;
  active_grievances integer;
  turnout jsonb;
  attention jsonb;
  upcoming jsonb;
  priorities jsonb;
  trend jsonb;
begin
  if caller is null or not public.member_has_role(array['vp', 'admin']) then
    raise exception 'vp role required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role in ('vp', 'admin')
  order by case r.role when 'vp' then 0 else 1 end
  limit 1;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from public.member_profiles p
  where caller_chapter is null or p.chapter_id = caller_chapter;

  select pg_catalog.count(*)
  into active_grievances
  from public.member_cases c
  join public.member_profiles p on p.id = c.user_id
  where c.status = 'active'
    and (caller_chapter is null or p.chapter_id = caller_chapter);

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_votes
    where ballot_id = b.id
  ) v on true
  where b.active = false or b.closes_at < pg_catalog.now()
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'reference', s.reference,
      'title', s.title,
      'step', s.step,
      'deadline', s.deadline)), '[]'::jsonb)
  into attention
  from (
    select c.id, c.reference, c.title, c.step, c.deadline
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
      and (caller_chapter is null or p.chapter_id = caller_chapter)
    order by c.deadline
    limit 6
  ) s;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary)), '[]'::jsonb)
  into upcoming
  from (
    select id, title, starts_at, location, summary
    from public.member_events
    where starts_at >= pg_catalog.now()
    order by starts_at
    limit 5
  ) e;

  -- The aggregate-level ORDER BY is the guarantee; the subquery's ORDER BY
  -- only picks WHICH 8 survive the limit.
  select coalesce(pg_catalog.jsonb_agg(x.obj order by x.order_index), '[]'::jsonb)
  into priorities
  from (
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'ballot') as obj, order_index
    from public.member_ballots
    where active = true
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
    order by order_index
    limit 8
  ) x;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from public.member_profiles p
      where caller_chapter is null or p.chapter_id = caller_chapter
      group by p.member_since
    ) g
  ) y
  where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;

  return pg_catalog.jsonb_build_object(
    'memberCount', member_count,
    'newThisYear', new_this_year,
    'activeGrievances', active_grievances,
    'turnout', turnout,
    'attention', attention,
    'upcomingEvents', upcoming,
    'priorities', priorities,
    'membershipTrend', trend);
end;
$$;

revoke all on function public.get_vp_overview() from public, anon;
grant execute on function public.get_vp_overview() to authenticated;
