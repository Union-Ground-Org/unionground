-- BUG-UG-VP-TURNOUT-QUORUM-NONSENSE-20261003
--
-- A new organization's President desk showed turnout "37930 of 12000 needed
-- for quorum" on an empty workspace (Harrow Bay pilot, October 3, 2026).
-- public.get_vp_overview is SECURITY DEFINER, so table RLS never bounds it.
-- 20260924160200 bounded its turnout and priorities reads by chapter only:
-- "published and union-wide (chapter_id is null) or the caller's chapter".
-- 20260924160000 had just given member_ballots and member_surveys an
-- organization_id, where NULL marks a quarantined legacy organization-wide
-- row that no member or staff member can read. The chapter-only rule still
-- admits every organization-wide row of every tenant, quarantined or not, so
-- the newest closed legacy ballot became every President's turnout.
--
-- Repair: the turnout ballot and the priority ballots and surveys must also
-- belong to the caller's selected organization (b.organization_id =
-- caller_org). A quarantined row has no owner and so never matches. With no
-- closed ballot of its own an organization's turnout is NULL, which the
-- President desk already renders as "No closed vote yet".
--
-- The body is the installed definition read with pg_get_functiondef from a
-- disposable stack at Main 20261005061000; only the three organization
-- predicate lines are added. Signature, SECURITY DEFINER, STABLE, empty
-- search_path, the role gate, the tenant refusal, the returned shape and the
-- anonymous member_ballot_choices tally are unchanged. No grant, policy,
-- table or index statement: owner and EXECUTE grants are preserved by
-- create or replace.

begin;

set local lock_timeout = '5s';

-- Refuse to replace anything but the reviewed predecessor body
-- (20260924160200_vp_overview_tenant_scope.sql).
do $predecessor$
declare
  installed text;
begin
  select pg_catalog.md5(p.prosrc) into strict installed
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_vp_overview()'::regprocedure;
  if installed is distinct from '6df60cc1d4e7d8b84482d5b6bfeaae63' then
    raise exception 'unreviewed get_vp_overview predecessor: %', installed
      using errcode = '55000';
  end if;
end;
$predecessor$;

CREATE OR REPLACE FUNCTION public.get_vp_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    and b.organization_id = caller_org
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
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
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
$function$;

commit;
