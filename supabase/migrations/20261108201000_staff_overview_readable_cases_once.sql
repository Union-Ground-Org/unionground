-- BUG-UG-STAFF-OVERVIEW-RESIDUAL-READ-LATENCY-20261108 (#7577).
-- After #7206 (20261106221000) the member-profile scans in get_advisor_overview
-- and get_vp_overview are already set-wise. The case scans were not. On a
-- disposable database of 1,200 accounts and 600 cases, get_advisor_overview
-- still spent 536 ms of a 557 ms call inside private.chapter_case_staff_readable,
-- once per case in the table, and each call re-entered the staff access,
-- visibility and session helpers. get_vp_overview did the same with
-- private.chapter_case_leadership_readable (120 calls on the caller's chapter
-- in that fixture) and still calls private.member_can_access_event_scope once
-- per event. SAMPLE medians were 688 ms and 985 ms.
--
-- Both overviews now resolve the caller-constant gates once per statement and
-- admit a case with the same boolean the per-case wrapper used:
--   session check, organization and chapter role, staff-factor check, and the
--   ownerless advisor branch (organization_id is null and the caller has no
--   organization) stay outside the per-case work.
--   An organization role is the caller's mobile staff organization, which is
--   the only organization private.has_organization_role can accept.
--   Chapter staff is private.actor_has_chapter_staff_role once per chapter.
--   Coordinator visibility is private.staff_visible_member_ids('coordinator')
--   once, the set form of public.staff_can_see_user(target, 'coordinator').
--   Scope and identity stay on private.actor_case_scope_and_identity_allowed,
--   and SQL CASE calls it only for a caller who holds a chapter scope or a
--   case that carries an identity-privacy row. An unscoped, unmarked case
--   keeps the function's own short-circuit.
--   VP events use private.member_event_scope_allows of one
--   private.member_event_caller_scope InitPlan, the same identity #7500 proved
--   for the RSVP and check-in policies.
-- The shared readable functions, their grants, and the other three readers
-- #7206 rewrote are unchanged. Rows, columns, order and refusals stay.
--
-- The preflight refuses to run unless both overviews are exactly the bodies
-- 20261106221000 installed.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- pg_get_functiondef qualifies types the same way under this path as under an
-- empty one (pg_catalog is always searched), so the definition hash is stable.
set local search_path = pg_catalog;

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_vp_overview()'::regprocedure)) <> '888fe487f43eb79b36b942ca0721843c' then
    raise exception 'unreviewed predecessor: public.get_vp_overview()' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.account_lifecycle_trigger_review
    where kind = 'function' and schema_name = 'public' and table_name = ''
      and object_name = 'get_vp_overview()'
      and definition_hash <> '888fe487f43eb79b36b942ca0721843c'
  ) then
    raise exception 'stale trigger receipt: public.get_vp_overview()' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_advisor_overview()'::regprocedure)) <> '1144090482bf80f2dce63dded2d59019' then
    raise exception 'unreviewed predecessor: public.get_advisor_overview()' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.account_lifecycle_trigger_review
    where kind = 'function' and schema_name = 'public' and table_name = ''
      and object_name = 'get_advisor_overview()'
      and definition_hash <> '1144090482bf80f2dce63dded2d59019'
  ) then
    raise exception 'stale trigger receipt: public.get_advisor_overview()' using errcode = '55000';
  end if;
end;
$preflight$;

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
    select 1 from private.chapter_role_scopes scope_row
    where scope_row.user_id = caller
  );

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter;

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
        and c.deadline < current_date
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

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_advisor_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid := private.current_member_organization();
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
  mfa_ok boolean := false;
  mobile_org uuid;
  elevated_org uuid;
  caller_has_scopes boolean := false;
  staff_chapters text[] := '{}'::text[];
  coordinator_ids uuid[] := '{}'::uuid[];
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;
  -- A legacy advisor on an ownerless chapter resolves no organization; only a
  -- platform caller is refused, and only platform-owned rows leave the totals.
  if private.organization_is_platform(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role in ('advisor', 'admin')
  order by case r.role when 'advisor' then 0 else 1 end
  limit 1;

  -- Caller-constant half of the staff case read. SQL CASE below stops before
  -- the coordinator and grievance branches when an elevated organization role
  -- already admits the row, which is the desk that was paying once per case.
  mfa_ok := private.mfa_satisfied();
  mobile_org := private.current_mobile_staff_organization();
  if mobile_org is not null
    and private.has_organization_role(mobile_org, array['advisor', 'admin', 'vp']) then
    elevated_org := mobile_org;
  end if;
  caller_has_scopes := exists (
    select 1 from private.chapter_role_scopes scope_row
    where scope_row.user_id = caller
  );
  select coalesce(pg_catalog.array_agg(chapter.id), '{}'::text[])
    into staff_chapters
  from public.chapters chapter
  where private.actor_has_chapter_staff_role(caller, chapter.id);
  select coalesce(pg_catalog.array_agg(visible.id), '{}'::uuid[])
    into coordinator_ids
  from private.staff_visible_member_ids('coordinator') visible(id);

  select pg_catalog.count(*)
  into members_covered
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where (caller_chapter is null or p.chapter_id = caller_chapter)
    and not private.chapter_belongs_to_platform(p.chapter_id);

  with base as materialized (
    select c.status, c.deadline
    from public.member_cases c
    join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
    where (caller_chapter is null or p.chapter_id = caller_chapter)
      and not private.organization_is_platform(c.organization_id)
      and (
        (c.organization_id is null and caller_org is null)
        or (
          c.learning_undone_at is null
          and mfa_ok
          and case
            when c.user_id = caller then true
            when c.organization_id is not null
              and c.chapter_id is not null
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
              and case
                when c.chapter_id = any (staff_chapters)
                  and (
                    c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or c.user_id = any (coordinator_ids)
                  )
                  and (
                    not c.is_restricted
                    or c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                when c.organization_id = caller_org
                  and private.actor_role_covers_member(caller, c.chapter_id, 'coordinator', c.user_id, true)
                  and (
                    not c.is_restricted
                    or c.coordinator_user_id = caller
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                else false
              end
              then true
            when c.user_id <> caller
              and not c.is_restricted
              and c.organization_id = caller_org
              and coalesce((select policy.steward_grievances from private.chapter_access_policies policy where policy.chapter_id = c.chapter_id), true)
              and private.chapter_grievance_steward_scope(c.chapter_id, c.user_id)
              and private.member_case_row_visible(c)
              then true
            else false
          end
        )
      )
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
  -- counts toward any caller's scope. A role on an ownerless chapter has no
  -- organization to place it, so only union-owned and org-wide rows are
  -- placed by membership.
  select pg_catalog.count(distinct r.user_id)
  into steward_count
  from public.member_roles r
  where r.role = 'steward'
    and not private.chapter_belongs_to_platform(r.chapter_id)
    and (exists (select 1 from public.chapters c
        where c.id = r.chapter_id and c.organization_id is null)
      or exists (select 1 from public.organization_memberships m
        where m.user_id = r.user_id and m.status = 'active' and private.organization_is_union(m.organization_id))
      or not exists (select 1 from public.organization_memberships m
        where m.user_id = r.user_id and m.status = 'active' and private.organization_is_platform(m.organization_id)))
    and (caller_chapter is null or r.chapter_id is null or r.chapter_id = caller_chapter);

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
    and not private.organization_is_platform(b.organization_id)
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
$function$
;

-- Grants are unchanged by create or replace. A function the account-lifecycle
-- trigger surface reaches keeps a current receipt; absent receipts stay absent.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid = any (array[
    'public.get_vp_overview()',
    'public.get_advisor_overview()'
   ]::regprocedure[])
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';

commit;
