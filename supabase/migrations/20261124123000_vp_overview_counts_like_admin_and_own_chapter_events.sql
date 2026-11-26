-- BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
-- finding B-55, and the President's "Next on the chapter calendar" (demo walk
-- of Nov 24, 2026; notes).
--
-- The demo's President overview said Alder Falls had 256 members, its
-- membership trend said 255 for 2026, and Admin's Organization & chapters
-- said 246. public.get_vp_overview counted every profile whose home chapter
-- is the chapter, whatever the person's membership; Admin counts the
-- chapter's active memberships held by active members of the organization.
-- The trend grouped the same profiles by member_since and so dropped anyone
-- with no year (or a year after this one) from every point. And the
-- President's upcoming events admitted other chapters' public events,
-- because the event scope check allows them and nothing narrowed the list
-- to the caller's chapter.
--
-- The member count, the members new this year and the trend now count the
-- Admin page's population, and the trend's last point is that count (join
-- years before the first year shown and after this one are counted in the
-- first and last year shown; gate round 1 of #9788). Like
-- the grievance count, they are counted only while the leadership gate is
-- open (they were limited by the same role and MFA checks through
-- private.staff_visible_member_ids). Upcoming events are the caller's
-- chapter's only; the event scope check stays. The grievance count, the
-- attention list, turnout and priorities are unchanged: the grievance count
-- already applies the same per-case scope and identity check the
-- Coordinator's count applies to its own viewer. Nothing else changes, and
-- the function keeps its owner, grants and JSON shape.

begin;

set local lock_timeout = '5s';

-- The re-emitted function must still be the reviewed live body
-- (20261123104000_case_deadline_time_zones.sql).
do $predecessors$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_vp_overview()'::regprocedure)
     is distinct from 'b7322fc71b3528bf31231a154770c659' then
    raise exception 'unreviewed predecessor: public.get_vp_overview()' using errcode = '55000';
  end if;
end;
$predecessors$;

create or replace function public.get_vp_overview()
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $function$
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
  leadership_open boolean := false;
  caller_has_scopes boolean := false;
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
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- The leadership read's caller-constant gates, once for this statement. The
  -- outer reads already require the case organization and chapter to be the
  -- caller's, so the role and staff-factor checks do not vary per case. A
  -- closed gate is zero grievances and an empty attention list.
  leadership_open := private.mfa_satisfied()
    and not private.member_pin_session_restricted()
    and (not private.staff_mfa_required(caller_org) or private.has_second_factor(caller))
    and (
      private.member_has_chapter_role(caller_chapter, array['admin', 'vp'])
      or private.has_organization_role(caller_org, array['admin', 'vp'])
    );
  caller_has_scopes := exists (
    select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope_row
    where scope_row.user_id = caller
  );

  -- #9533: the chapter's members are its active chapter memberships whose
  -- holder is an active member of the organization, the population Admin's
  -- Organization & chapters counts (public.get_admin_org_structure). A
  -- profile whose home chapter is this one without an active membership is
  -- not a member. The figures are counts and name no one; a closed
  -- leadership gate counts none, as it reports no grievances.
  if leadership_open then
    select
      pg_catalog.count(*),
      pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
    into member_count, new_this_year
    from (
      select distinct membership.user_id
      from public.member_chapter_memberships membership
      join public.organization_memberships organization_membership
        on organization_membership.user_id = membership.user_id
       and organization_membership.organization_id = caller_org
       and organization_membership.status = 'active'
      where membership.chapter_id = caller_chapter
        and membership.status = 'active'
    ) m
    left join public.member_profiles p on p.id = m.user_id;
  else
    member_count := 0;
    new_this_year := 0;
  end if;

  if leadership_open then
    select pg_catalog.count(*)
    into active_grievances
    from public.member_cases c
    where c.status = 'active'
      and c.organization_id is not null
      and c.learning_undone_at is null
      and case
        when c.user_id = caller then true
        when not caller_has_scopes
          and not exists (
            select 1 from private.case_identity_privacy privacy
            where privacy.case_id = c.id
          )
          then true
        else private.actor_case_scope_and_identity_allowed(caller, c)
      end
      and c.organization_id = caller_org
      and c.chapter_id = caller_chapter;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'reference', s.reference,
        'title', s.title,
        'step', s.step,
        'deadline', s.deadline,
        'memberName', s.member_name) order by s.deadline, s.id), '[]'::jsonb)
    into attention
    from (
      select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
      from public.member_cases c
      join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
      where c.status = 'active'
        and c.deadline is not null
        and c.deadline < private.local_day(c.time_zone, pg_catalog.now())
        and c.organization_id is not null
        and c.chapter_id is not null
        and c.learning_undone_at is null
        and case
          when c.user_id = caller then true
          when not caller_has_scopes
            and not exists (
              select 1 from private.case_identity_privacy privacy
              where privacy.case_id = c.id
            )
            then true
          else private.actor_case_scope_and_identity_allowed(caller, c)
        end
        and c.organization_id = caller_org
        and c.chapter_id = caller_chapter
      order by c.deadline
      limit 6
    ) s;
  else
    active_grievances := 0;
    attention := '[]'::jsonb;
  end if;

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
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary) order by e.starts_at, e.id), '[]'::jsonb)
  into upcoming
  from (
    select ev.id, ev.title, ev.starts_at, ev.location, ev.summary
    from public.member_events ev
    join public.chapters event_chapter
      on event_chapter.id = ev.chapter_id
     and event_chapter.organization_id = caller_org
    where ev.starts_at >= pg_catalog.now()
      and ev.cancelled_at is null
      -- #9533: "Next on the chapter calendar" is the caller's chapter only;
      -- another chapter's public event is not on it.
      and ev.chapter_id = caller_chapter
      and private.member_event_scope_allows(
        (select private.member_event_caller_scope()),
        ev.chapter_id,
        ev.is_public,
        ev.is_public_across_agencies)
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

  -- #9533: the trend counts the same members, so its last point is the
  -- member count. A member with no year joined, or a year before the first
  -- year shown, counts from the first year shown, and one whose year is after
  -- this one counts in this year, so no member drops out and the trend is
  -- never empty while the count is not.
  if leadership_open then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
    into trend
    from (
      select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
      from (
        select greatest(least(coalesce(p.member_since, pg_catalog.date_part('year', pg_catalog.now())::int - 5),
            pg_catalog.date_part('year', pg_catalog.now())::int),
            pg_catalog.date_part('year', pg_catalog.now())::int - 5) as yr,
          pg_catalog.count(*) as n
        from (
          select distinct membership.user_id
          from public.member_chapter_memberships membership
          join public.organization_memberships organization_membership
            on organization_membership.user_id = membership.user_id
           and organization_membership.organization_id = caller_org
           and organization_membership.status = 'active'
          where membership.chapter_id = caller_chapter
            and membership.status = 'active'
        ) m
        left join public.member_profiles p on p.id = m.user_id
        group by 1
      ) g
    ) y
    where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;
  else
    trend := '[]'::jsonb;
  end if;

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
