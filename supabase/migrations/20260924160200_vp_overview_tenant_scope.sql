-- SEC-UG-VP-OVERVIEW-TENANT-SCOPE-20260920
--
-- public.get_vp_overview (last definition 20260808235000_ballot_secrecy_hardening
-- :211) is SECURITY DEFINER with an empty search_path, so table RLS never
-- bounds it. Three of its reads carried no tenant predicate at all
-- (upcomingEvents, turnout, priorities) and the other four were bounded by a
-- `caller_chapter` read from the LEGACY public.member_roles table with the
-- fallback `caller_chapter is null or ...`. Nothing syncs member_roles from
-- public.organization_role_grants, so for an organization-granted VP or admin
-- -- the supported grant shape -- caller_chapter was NULL and the member,
-- grievance, attention and trend reads scanned every tenant in the database.
--
-- Repair, one bound per read, every one of them fail-closed:
--
--   * TENANT. The caller's selected organization and chapter come from
--     private.current_member_organization() / private.current_member_chapter(),
--     the same pair the coordinator KPI and queue repairs use
--     (20260918200000, 20260919011000). If either is unresolved the function
--     refuses with 42501 instead of widening. The legacy member_roles lookup
--     and the `caller_chapter is null or` fallback are removed.
--   * MEMBERS / TREND. Profiles in the caller's chapter (a chapter belongs to
--     exactly one organization, so the chapter bound is also the tenant bound).
--   * GRIEVANCES / ATTENTION. The case's own organization_id and chapter_id
--     must equal the caller's -- the tenant bound copied from
--     private.casework_dashboard_open_cases / public.get_coordinator_kpis.
--   * UPCOMING EVENTS. Pre-bounded to chapters of the caller's organization,
--     then filtered by private.member_can_access_event_scope -- the predicate
--     the member_events SELECT policy uses -- and cancelled events are
--     excluded (cancelled_at postdates the previous definition).
--   * TURNOUT / PRIORITIES. The member_ballots / member_surveys eligibility
--     rule the read policies enforce: published (campaign_state <> 'draft')
--     and union-wide (chapter_id is null) or the caller's own chapter.
--
-- Signature, SECURITY DEFINER, STABLE, empty search_path, the role gate, the
-- returned shape and the anonymous member_ballot_choices tally are unchanged.
-- No grant, policy, table or index statement: owner and EXECUTE grants from
-- 20260723161000 are preserved.

begin;

set local lock_timeout = '5s';

create or replace function public.get_vp_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
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

  -- Fail closed: no selected organization or chapter means no tenant to
  -- report on, never a database-wide scan.
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  if caller_org is null or caller_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from public.member_profiles p
  where p.chapter_id = caller_chapter;

  select pg_catalog.count(*)
  into active_grievances
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and c.organization_id = caller_org
    and c.chapter_id = caller_chapter;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.campaign_state <> 'draft'
    and (b.chapter_id is null or b.chapter_id = caller_chapter)
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'reference', s.reference,
      'title', s.title,
      'step', s.step,
      'deadline', s.deadline,
      'memberName', s.member_name)), '[]'::jsonb)
  into attention
  from (
    select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
      and c.organization_id is not null
      and c.chapter_id is not null
      and c.organization_id = caller_org
      and c.chapter_id = caller_chapter
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
    select ev.id, ev.title, ev.starts_at, ev.location, ev.summary
    from public.member_events ev
    join public.chapters event_chapter
      on event_chapter.id = ev.chapter_id
     and event_chapter.organization_id = caller_org
    where ev.starts_at >= pg_catalog.now()
      and ev.cancelled_at is null
      and private.member_can_access_event_scope(ev.chapter_id, ev.is_public, ev.is_public_across_agencies)
    order by ev.starts_at
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
      and campaign_state <> 'draft'
      and (chapter_id is null or chapter_id = caller_chapter)
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
      and campaign_state <> 'draft'
      and (chapter_id is null or chapter_id = caller_chapter)
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
      where p.chapter_id = caller_chapter
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

comment on function public.get_vp_overview() is
  'Leadership desk overview. Refuses unless the caller holds vp/admin AND has a selected organization and chapter; every read is bounded to that tenant: members, trend, grievances and attention to the caller''s chapter (cases by their own organization_id/chapter_id), upcoming events to the caller''s organization under private.member_can_access_event_scope with cancelled events excluded, turnout and priorities to published union-wide or caller-chapter campaigns.';

notify pgrst, 'reload schema';

commit;
