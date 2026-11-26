-- REQ-UG-FULL-DEPTH-20260723 PR4b: advisor overview.
-- The advisor plane is read-only analytics: chapter-level counts, steward
-- coverage, the latest closed-vote turnout, and honest at-risk signals.
-- SECURITY DEFINER because the caller cannot see cross-member rows under
-- member RLS (the get_workload_stats precedent); every value is an aggregate,
-- never a rank-and-file row. Chapter-scoped exactly like the coordinator and
-- VP aggregates: the caller's advisor (or admin) role row picks the chapter,
-- NULL chapter_id = org-wide. The case counts run in ONE materialized pass
-- (the PR4a lesson: three independent scans of the ~400k-row join are
-- multi-second at live scale).
create function public.get_advisor_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role in ('advisor', 'admin')
  order by case r.role when 'advisor' then 0 else 1 end
  limit 1;

  select pg_catalog.count(*)
  into members_covered
  from public.member_profiles p
  where caller_chapter is null or p.chapter_id = caller_chapter;

  with base as materialized (
    select c.status, c.deadline
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where caller_chapter is null or p.chapter_id = caller_chapter
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < current_date)
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- An org-wide steward (NULL chapter role row) covers every chapter, so it
  -- counts toward any caller's scope.
  select pg_catalog.count(distinct r.user_id)
  into steward_count
  from public.member_roles r
  where r.role = 'steward'
    and (caller_chapter is null or r.chapter_id is null or r.chapter_id = caller_chapter);

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

  return pg_catalog.jsonb_build_object(
    'membersCovered', members_covered,
    'openGrievances', open_cases,
    'resolvedGrievances', resolved_cases,
    'stewardCount', steward_count,
    'coverageRatio', case when steward_count = 0 then null
      else pg_catalog.round(members_covered::numeric / steward_count) end,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'turnout', turnout,
    'atRisk', pg_catalog.jsonb_build_object(
      'overdueCases', overdue_cases,
      'unstaffed', steward_count = 0));
end;
$$;

revoke all on function public.get_advisor_overview() from public, anon;
grant execute on function public.get_advisor_overview() to authenticated;
