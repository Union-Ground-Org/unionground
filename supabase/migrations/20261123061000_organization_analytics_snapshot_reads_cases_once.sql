-- BUG-UG-SAMPLE-ORGANIZATION-ANALYTICS-ALWAYS-TIMES-OUT-20261122 (#9556).
-- On the demo (SAMPLE, Tamarack, 689 cases in the six-month window) the
-- organization analytics snapshot ran 18.9 s as an admin and 16.2 s as a
-- steward before its audit write, past the page's 10 s limit. A read-only
-- timing on SAMPLE put the time in one place:
-- private.chapter_case_staff_readable, called once per case row in each of
-- three reads (cases, series, heatmap), 5.0 to 6.6 s per pass. The engagement
-- and page-view reads take under 0.6 s together.
--
-- 1. private.organization_analytics_readable_cases returns the same rows the
--    wrapper admits, with its caller-only and chapter-only parts read once.
--    Every per-row helper call that remains is guarded by a precomputed
--    condition that helper itself requires, and the shared helper is the
--    fallback, so each branch answers as the wrapper does. It is STABLE, so
--    the precomputed parts and the rows share the calling statement's
--    snapshot. No client role may call it.
-- 2. The snapshot reads that set once (a materialized CTE) for its three case
--    reads. Keys, rows, order, rounding, floors, refusals and the audit row are
--    unchanged; no grant, policy, table or index changes.
-- The preflight refuses to run unless the snapshot is exactly the body
-- 20261102005607 installed.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- pg_get_functiondef qualifies types the same way under this path as under an
-- empty one (pg_catalog is always searched), so the definition hash is stable.
set local search_path = pg_catalog;

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_snapshot()'::regprocedure)) <> '265984a532d255eb610f54066a7f43ba' then
    raise exception 'unreviewed predecessor: public.get_organization_analytics_snapshot()' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.account_lifecycle_trigger_review
    where kind = 'function' and schema_name = 'public' and table_name = ''
      and object_name = 'get_organization_analytics_snapshot()'
      and definition_hash <> '265984a532d255eb610f54066a7f43ba'
  ) then
    raise exception 'stale trigger receipt: public.get_organization_analytics_snapshot()' using errcode = '55000';
  end if;
  if pg_catalog.to_regprocedure('private.organization_analytics_readable_cases(uuid,timestamp with time zone,timestamp with time zone)') is not null then
    raise exception 'private.organization_analytics_readable_cases already exists' using errcode = '55000';
  end if;
end;
$preflight$;

-- The organization's case rows that private.chapter_case_staff_readable admits
-- for the caller, in one pass. Same rows as
--   select c.* from public.member_cases c
--   where c.organization_id = p_organization and c.chapter_id is not null
--     and c.created_at >= p_from and c.created_at < p_to
--     and private.chapter_case_staff_readable(c)
-- with every caller-only or chapter-only part of that wrapper read once. Each
-- per-row helper call that remains sits behind a precomputed condition the
-- helper itself requires, and the shared helper stays the fallback, so every
-- branch returns exactly what the wrapper returns. STABLE: all reads share the
-- calling statement's snapshot.
CREATE FUNCTION private.organization_analytics_readable_cases(p_organization uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS SETOF public.member_cases
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  org_is_caller_org boolean;
  org_reader boolean;
  caller_has_scopes boolean;
  coordinator_capable boolean;
  grievance_mfa_ok boolean := false;
  local_breadth boolean := false;
  case_chapters text[];
  staff_chapters text[];
  unassigned_chapters text[];
  scope_null_chapters text[];
  steward_possible text[];
  coordinator_possible text[];
  advisor_possible text[];
  admin_possible text[];
  vp_possible text[];
  grievance_open_chapters text[] := '{}'::text[];
  grievance_cover_chapters text[] := '{}'::text[];
begin
  -- chapter_case_staff_readable requires private.mfa_satisfied(), which is
  -- false without a caller.
  if caller is null or not coalesce(private.mfa_satisfied(), false) then
    return;
  end if;
  caller_org := private.current_member_organization();
  org_is_caller_org := coalesce(p_organization = caller_org, false);
  -- has_organization_role(c.organization_id, ...) with c.organization_id = p_organization.
  org_reader := coalesce(private.has_organization_role(p_organization, array['advisor', 'admin', 'vp']), false);
  -- The scope test private.actor_case_scope_and_identity_allowed makes, verbatim.
  caller_has_scopes := exists(select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) s where s.user_id=caller);

  select coalesce(pg_catalog.array_agg(distinct c.chapter_id), '{}'::text[])
    into case_chapters
  from public.member_cases c
  where c.organization_id = p_organization and c.chapter_id is not null
    and c.created_at >= p_from and c.created_at < p_to;

  -- Per chapter, the same helper calls the wrapper makes for every case there.
  select coalesce(pg_catalog.array_agg(x.id) filter (where private.actor_has_chapter_staff_role(caller, x.id)), '{}'::text[]),
    coalesce(pg_catalog.array_agg(x.id) filter (where private.organization_steward_unassigned(caller, x.id)), '{}'::text[]),
    coalesce(pg_catalog.array_agg(x.id) filter (where
      private.actor_role_covers_member(caller, x.id, 'steward', null, true)
      or private.actor_role_covers_member(caller, x.id, 'coordinator', null, true)
      or private.actor_role_covers_member(caller, x.id, 'advisor', null, true)
      or private.actor_role_covers_member(caller, x.id, 'admin', null, true)
      or private.actor_role_covers_member(caller, x.id, 'vp', null, true)), '{}'::text[])
    into staff_chapters, unassigned_chapters, scope_null_chapters
  from pg_catalog.unnest(case_chapters) x(id);

  -- private.actor_role_covers_member(caller, chapter, role, ...) is false
  -- unless the chapter exists and the caller holds the role there by an
  -- organization grant or a chapter role row. Only those chapters call it.
  select coalesce(pg_catalog.array_agg(ch.id) filter (where possible.steward), '{}'::text[]),
    coalesce(pg_catalog.array_agg(ch.id) filter (where possible.coordinator), '{}'::text[]),
    coalesce(pg_catalog.array_agg(ch.id) filter (where possible.advisor), '{}'::text[]),
    coalesce(pg_catalog.array_agg(ch.id) filter (where possible.admin), '{}'::text[]),
    coalesce(pg_catalog.array_agg(ch.id) filter (where possible.vp), '{}'::text[])
    into steward_possible, coordinator_possible, advisor_possible, admin_possible, vp_possible
  from public.chapters ch
  cross join lateral (
    select
      pg_catalog.bool_or(held.role = 'steward') as steward,
      pg_catalog.bool_or(held.role = 'coordinator') as coordinator,
      pg_catalog.bool_or(held.role = 'advisor') as advisor,
      pg_catalog.bool_or(held.role = 'admin') as admin,
      pg_catalog.bool_or(held.role = 'vp') as vp
    from (
      select g.role from public.organization_role_grants g
      where g.organization_id = ch.organization_id and g.user_id = caller
      union all
      select r.role from public.member_role_chapters r
      where r.chapter_id = ch.id and r.user_id = caller
    ) held
  ) possible
  where ch.id = any (case_chapters);

  -- public.staff_can_see_user(target, 'coordinator') needs, for a caller with
  -- an organization, a coordinator role reaching a chapter of that
  -- organization or a coordinator assignment scope.
  coordinator_capable := caller_org is null
    or exists(select 1 from public.chapters ch
      where ch.organization_id = caller_org
        and (private.chapter_organization_role_allowed(ch.id, array['coordinator'])
          or private.member_has_chapter_role(ch.id, array['coordinator'])))
    or exists(select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope
      where scope.user_id = caller and scope.role = 'coordinator');

  -- private.chapter_grievance_steward_scope: the caller-only and chapter-only
  -- parts. Its chapter must belong to the caller's organization.
  if caller_org is not null then
    grievance_mfa_ok := coalesce(not private.staff_mfa_required(caller_org) or private.has_second_factor(caller), false);
    local_breadth := exists(select 1 from public.member_role_chapters r
      join public.chapters source on source.id=r.chapter_id and source.organization_id=caller_org
      join public.member_chapter_memberships m on m.chapter_id=r.chapter_id and m.user_id=r.user_id and m.status='active'
      join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
      where r.user_id=caller and r.role='steward'
        and private.member_has_chapter_role(r.chapter_id,array['steward']));
    select coalesce(pg_catalog.array_agg(ch.id) filter (where open_chapter.allowed), '{}'::text[]),
      coalesce(pg_catalog.array_agg(ch.id) filter (where not open_chapter.allowed and ch.id = any (steward_possible)), '{}'::text[])
      into grievance_open_chapters, grievance_cover_chapters
    from public.chapters ch
    cross join lateral (
      select coalesce(private.chapter_organization_role_allowed(ch.id, array['steward'])
        or private.member_has_chapter_role(ch.id, array['steward'])
        or local_breadth, false) as allowed
    ) open_chapter
    where ch.id = any (case_chapters) and ch.organization_id = caller_org;
  end if;

  return query
  select c.*
  from public.member_cases c
  where c.organization_id = p_organization and c.chapter_id is not null
    and c.created_at >= p_from and c.created_at < p_to
    and c.learning_undone_at is null
    and case
      when c.user_id = caller then true
      -- private.case_scope_and_identity_allowed(c): casework_staff_can_access
      -- and, for an unrestricted case, member_case_row_visible both require it.
      when not (case
        when c.chapter_id = any (unassigned_chapters)
          and not exists(select 1 from public.casework_access_grants access_grant
            where access_grant.case_id=c.id and access_grant.grantee_user_id=caller and access_grant.revoked_at is null)
          then false
        when not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=c.id) then (case
          when not caller_has_scopes then true
          when c.chapter_id = any (scope_null_chapters) then true
          when c.chapter_id = any (steward_possible) and private.actor_role_covers_member(caller,c.chapter_id,'steward',c.user_id,true) then true
          when c.chapter_id = any (coordinator_possible) and private.actor_role_covers_member(caller,c.chapter_id,'coordinator',c.user_id,true) then true
          when c.chapter_id = any (advisor_possible) and private.actor_role_covers_member(caller,c.chapter_id,'advisor',c.user_id,true) then true
          when c.chapter_id = any (admin_possible) and private.actor_role_covers_member(caller,c.chapter_id,'admin',c.user_id,true) then true
          when c.chapter_id = any (vp_possible) and private.actor_role_covers_member(caller,c.chapter_id,'vp',c.user_id,true) then true
          else false
        end)
        else private.actor_case_scope_and_identity_allowed(caller, c)
      end) then false
      -- private.casework_staff_can_access, first branch.
      when c.chapter_id = any (staff_chapters)
        and (case
          when c.steward_user_id = caller or c.coordinator_user_id = caller or org_reader then true
          when coordinator_capable then public.staff_can_see_user(c.user_id, 'coordinator')
          else false
        end)
        and (not c.is_restricted or c.steward_user_id = caller or c.coordinator_user_id = caller
          or org_reader or private.casework_actor_has_active_grant(c.id))
        then true
      -- private.casework_staff_can_access, second branch.
      when org_is_caller_org
        and c.chapter_id = any (coordinator_possible)
        and private.actor_role_covers_member(caller, c.chapter_id, 'coordinator', c.user_id, true)
        and (not c.is_restricted or c.coordinator_user_id = caller or private.casework_actor_has_active_grant(c.id))
        then true
      -- private.casework_staff_can_read, grievance branch, with
      -- private.chapter_grievance_steward_scope(c.chapter_id, c.user_id).
      when c.user_id <> caller
        and not c.is_restricted
        and org_is_caller_org
        and coalesce((select policy.steward_grievances from private.chapter_access_policies policy where policy.chapter_id = c.chapter_id), true)
        and grievance_mfa_ok
        and (c.chapter_id = any (grievance_open_chapters)
          or (c.chapter_id = any (grievance_cover_chapters)
            and private.actor_role_covers_member(caller, c.chapter_id, 'steward', c.user_id, true)))
        and exists(select 1 from public.organization_memberships om
          where om.organization_id = caller_org and om.user_id = c.user_id and om.status = 'active')
        and exists(select 1 from public.member_chapter_memberships cm
          where cm.chapter_id = c.chapter_id and cm.user_id = c.user_id and cm.status = 'active')
        then true
      else false
    end;
end;
$function$
;

revoke all on function private.organization_analytics_readable_cases(uuid, timestamp with time zone, timestamp with time zone)
  from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_organization_analytics_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
  if not private.organization_is_union(private.mi1_require_selected_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  period_end timestamptz := pg_catalog.date_trunc('month', generated);
  period_start timestamptz := pg_catalog.date_trunc('month', generated) - interval '6 months';
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  attendance_start timestamptz := generated - interval '180 days';
  result jsonb;
  snapshot_id uuid := extensions.gen_random_uuid();
  published_rows integer;
  withheld_rows integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- The caller's readable cases in the window, read once (#9556). The four
  -- case reads below keep their own filters over this set.
  with readable as materialized (
    select r.* from private.organization_analytics_readable_cases(org, period_start, period_end) r
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'label', c.name,
        'memberCount', case when member_totals.value >= privacy_threshold
          then (pg_catalog.floor(member_totals.value / 5.0) * 5)::integer else null end,
        'memberCountSuppressed', member_totals.value < privacy_threshold,
        'stewardCount', case when steward_totals.value >= privacy_threshold
          and member_totals.value - steward_totals.value >= privacy_threshold
          then (pg_catalog.floor(steward_totals.value / 5.0) * 5)::integer else null end,
        'stewardCountSuppressed', steward_totals.value < privacy_threshold
          or member_totals.value - steward_totals.value < privacy_threshold
      ) order by c.name, c.id)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*) as value from public.member_chapter_memberships m
        where m.chapter_id = c.id and m.status = 'active'
      ) member_totals
      cross join lateral (
        select pg_catalog.count(distinct rc.user_id) as value
        from public.member_role_chapters rc
        join public.member_chapter_memberships m
          on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
        where rc.chapter_id = c.id and rc.role = 'steward'
      ) steward_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'chapterId', counted.chapter_id, 'status', counted.status,
        'step', counted.step_bucket, 'workplaceKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.status, counted.case_type, counted.step_bucket)
      from (
        select cs.chapter_id, cs.status,
          case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket,
          cs.case_type, pg_catalog.count(distinct cs.user_id) as person_count
        from readable cs
        where cs.organization_id = org and cs.chapter_id is not null
          and cs.created_at >= period_start and cs.created_at < period_end
        group by cs.chapter_id, cs.status, step_bucket, cs.case_type
        having pg_catalog.count(distinct cs.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    -- OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
    -- (project decision 2026-09-25, AUTHENTICATED PAGE-VIEW PRODUCER):
    -- public.record_workspace_page_view fills organization_page_views and
    -- writes one page_view engagement event per (person, path, minute). A
    -- (path, hat, day) total is published, rounded down to 5, only when it is
    -- itself at least privacy_threshold and at least privacy_threshold
    -- distinct people viewed that path that day (the page_view events carry
    -- the path before '|'), so a request total never stands in for a small
    -- person cohort.
    'usageViews', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'path', v.path, 'hat', v.hat, 'day', v.day,
        'count', (pg_catalog.floor(v.view_count / 5.0) * 5)::integer
      ) order by v.day, v.path, v.hat)
      from public.organization_page_views v
      where v.organization_id = org
        and v.day > ((generated - interval '30 days') at time zone 'UTC')::date
        and v.day <= (generated at time zone 'UTC')::date
        and v.view_count >= privacy_threshold
        and (
          select pg_catalog.count(distinct e.user_id)
          from public.organization_engagement_events e
          where e.organization_id = org and e.event_type = 'page_view'
            and e.occurred_at >= (v.day::timestamp at time zone 'UTC')
            and e.occurred_at < ((v.day + 1)::timestamp at time zone 'UTC')
            and pg_catalog.split_part(e.source_id, '|', 1) = v.path
        ) >= privacy_threshold
    ), '[]'::jsonb),
    'usageWindows', (
      select pg_catalog.jsonb_build_object(
        'organizationId', org,
        -- Distinct people with any engagement event (page views included) in
        -- the last day / 7 days / 30 days, rounded down to 5. Nested windows
        -- permit complement differencing, so an outer window is published only
        -- when the people it adds over the nearest published inner window also
        -- clear the floor.
        'dau', case when windows.dau_ok then (pg_catalog.floor(windows.dau / 5.0) * 5)::integer else null end,
        'wau', case when windows.wau_ok then (pg_catalog.floor(windows.wau / 5.0) * 5)::integer else null end,
        'mau', case when windows.mau_ok then (pg_catalog.floor(windows.mau / 5.0) * 5)::integer else null end,
        'suppressed', pg_catalog.jsonb_build_object(
          'dau', not windows.dau_ok,
          'wau', not windows.wau_ok,
          'mau', not windows.mau_ok
        )
      ) from (
        select gated.dau, gated.wau, gated.mau, gated.dau_ok, gated.wau_ok,
          gated.mau >= privacy_threshold
            and case
              when gated.wau_ok then gated.mau - gated.wau >= privacy_threshold
              when gated.dau_ok then gated.mau - gated.dau >= privacy_threshold
              else true
            end as mau_ok
        from (
          select counted.dau, counted.wau, counted.mau,
            counted.dau >= privacy_threshold as dau_ok,
            counted.wau >= privacy_threshold
              and (counted.dau < privacy_threshold or counted.wau - counted.dau >= privacy_threshold) as wau_ok
          from (
            select
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '1 day') as dau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '7 days') as wau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '30 days') as mau
            from public.organization_engagement_events where organization_id = org
          ) counted
        ) gated
      ) windows
    ),
    'series', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', c.id,
        'openCases', case when case_totals.value >= privacy_threshold and case_totals.minimum_cell >= privacy_threshold
          then (pg_catalog.floor(case_totals.value / 5.0) * 5)::integer else null end,
        'openCasesSuppressed', case_totals.value < privacy_threshold or case_totals.minimum_cell < privacy_threshold,
        -- Share of recorded roster slots marked present over 180 days; guests
        -- are not on the roster. Published only when both the attending and
        -- the non-attending cohorts clear the person floor, so the rate cannot
        -- disclose a small absent cohort by complement.
        'attendanceRate', case when attendance_totals.present_people >= privacy_threshold
          and attendance_totals.missed_people >= privacy_threshold
          and attendance_totals.roster_rows > 0
          then pg_catalog.round(100.0 * attendance_totals.present_rows / attendance_totals.roster_rows, 0)
          else null end,
        -- Mean per-member engagement score (the client taxonomy's caps and
        -- weights, 180 days) over the chapter's active members.
        'engagementMean', case when engagement_totals.members >= privacy_threshold
          then pg_catalog.round(engagement_totals.mean_score, 1) else null end,
        -- Page-view totals are not person-level, so chapter portal use is the
        -- rounded 30-day distinct-person cohort of active members seen online.
        'usageViews', case when usage_totals.value >= privacy_threshold
          then (pg_catalog.floor(usage_totals.value / 5.0) * 5)::integer else null end
      ) order by c.id)
      from public.chapters c
      cross join lateral (
        select totals.value, minima.minimum_cell
        from (
          select pg_catalog.count(distinct cs.user_id) as value
          from readable cs
          where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
            and cs.created_at >= period_start and cs.created_at < period_end
        ) totals
        cross join (
          select coalesce(pg_catalog.min(cell.cell_people), 0) as minimum_cell
          from (
            select pg_catalog.count(distinct cs.user_id) as cell_people
            from readable cs
            where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
              and cs.created_at >= period_start and cs.created_at < period_end
            group by cs.case_type, case when cs.step in ('Intake', 'intake') then 0 else 2 end
          ) cell
        ) minima
      ) case_totals
      cross join lateral (
        select
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status <> 'present') as missed_people,
          pg_catalog.count(*) as roster_rows,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_rows
        from public.meeting_attendance ma
        join public.chapter_records r on r.id = ma.record_id and r.chapter_id = ma.chapter_id
        where ma.chapter_id = c.id
          and ma.attendance_status in ('present', 'absent', 'excused')
          and r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
      ) attendance_totals
      cross join lateral (
        select pg_catalog.count(*) as members,
          coalesce(pg_catalog.avg(coalesce(scored.score, 0)), 0) as mean_score
        from public.member_chapter_memberships m
        left join (
          select per_type.user_id,
            least(100, pg_catalog.sum(least(per_type.event_count::numeric / weights.cap, 1) * weights.weight)) as score
          from (
            select e.user_id, e.event_type, pg_catalog.count(*) as event_count
            from public.organization_engagement_events e
            where e.organization_id = org and e.chapter_id = c.id
              and e.occurred_at >= generated - interval '180 days'
            group by e.user_id, e.event_type
          ) per_type
          join (values
            ('meeting_check_in', 10, 30),
            ('qa_contribution', 15, 25),
            ('poll_vote', 5, 10),
            ('survey_response', 3, 10),
            ('event_rsvp', 8, 15),
            ('authorized_contact', 5, 10)
          ) as weights(event_type, cap, weight) on weights.event_type = per_type.event_type
          group by per_type.user_id
        ) scored on scored.user_id = m.user_id
        where m.chapter_id = c.id and m.status = 'active'
      ) engagement_totals
      cross join lateral (
        select pg_catalog.count(distinct p.user_id) as value
        from public.member_presence p
        join public.member_chapter_memberships m
          on m.user_id = p.user_id and m.chapter_id = c.id and m.status = 'active'
        where p.organization_id = org and p.last_seen_at >= generated - interval '30 days'
      ) usage_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'heatmapPoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'kind', 'grievance', 'rowKey', counted.chapter_id,
        'colKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.case_type)
      from (
        with scoped as (
          select cs.user_id, cs.chapter_id, cs.case_type, cs.status,
            case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket
          from readable cs
          where cs.organization_id = org and cs.chapter_id is not null
            and cs.created_at >= period_start and cs.created_at < period_end
        ), totals as (
          select scoped.chapter_id, scoped.case_type,
            pg_catalog.count(distinct scoped.user_id) as person_count
          from scoped group by scoped.chapter_id, scoped.case_type
        ), minima as (
          select cells.chapter_id, cells.case_type, pg_catalog.min(cells.cell_people) as minimum_cell
          from (
            select scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket,
              pg_catalog.count(distinct scoped.user_id) as cell_people
            from scoped
            group by scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket
          ) cells
          group by cells.chapter_id, cells.case_type
        )
        select totals.chapter_id, totals.case_type, totals.person_count
        from totals join minima using (chapter_id, case_type)
        where totals.person_count >= privacy_threshold and minima.minimum_cell >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementCounts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', counted.chapter_id,
        'eventType', counted.event_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.event_type)
      from (
        select e.chapter_id, e.event_type, pg_catalog.count(distinct e.user_id) as person_count
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
        group by e.chapter_id, e.event_type
        having pg_catalog.count(distinct e.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementHistogram', pg_catalog.jsonb_build_object(
      'organizationId', org, 'privacyThreshold', privacy_threshold
    ),
    -- One row per recorded meeting in the last 180 days (newest 200). Counts
    -- are distinct people (one attendance row per record and member), rounded
    -- down to 5 and withheld below the person floor. The roster (rsvpGoing) is
    -- published only when the non-attending cohort also clears the floor, so
    -- rsvpGoing minus checkIns cannot disclose a small absent cohort.
    'attendanceEvents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'id', counted.record_id, 'chapterId', counted.chapter_id,
        'startsAt', counted.occurred_at,
        'checkIns', case when counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.present_people / 5.0) * 5)::integer else null end,
        'rsvpGoing', case when counted.present_people >= privacy_threshold
          and counted.roster_people - counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.roster_people / 5.0) * 5)::integer else null end
      ) order by counted.occurred_at desc, counted.record_id)
      from (
        select r.id as record_id, r.chapter_id, r.occurred_at,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(*) filter (where ma.attendance_status in ('present', 'absent', 'excused')) as roster_people
        from public.chapter_records r
        join public.chapters c on c.id = r.chapter_id and c.organization_id = org
        join public.meeting_attendance ma on ma.record_id = r.id and ma.chapter_id = r.chapter_id
        where r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
        group by r.id, r.chapter_id, r.occurred_at
        order by r.occurred_at desc, r.id
        limit 200
      ) counted
    ), '[]'::jsonb),
    'attendanceCohorts', pg_catalog.jsonb_build_object(
      'organizationId', org, 'firstTime', null, 'repeat', null, 'suppressed', true
    )
  ) into result;
  -- Server-derived export counts for this issued snapshot: every published
  -- row, and the rows that carry at least one withheld (null) measure.
  select pg_catalog.count(*)::integer,
    (pg_catalog.count(*) filter (where exists (
      select 1 from pg_catalog.jsonb_each(published.value) field
      where field.value = 'null'::jsonb
    )))::integer
  into published_rows, withheld_rows
  from pg_catalog.jsonb_array_elements(
    (result -> 'chapters') || (result -> 'cases') || (result -> 'series')
      || (result -> 'heatmapPoints') || (result -> 'engagementCounts')
      || (result -> 'attendanceEvents')
  ) published;
  result := result || pg_catalog.jsonb_build_object('snapshotId', snapshot_id);
  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surface', 'organization_analytics_snapshot',
    'entityId', snapshot_id, 'rowCount', published_rows, 'suppressedCount', withheld_rows
  ));
  return result;
end;
end;
$function$
;

-- Grants are unchanged by create or replace. A function the account-lifecycle
-- trigger surface reaches keeps a current receipt; absent receipts stay absent.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid = 'public.get_organization_analytics_snapshot()'::regprocedure
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';

commit;
