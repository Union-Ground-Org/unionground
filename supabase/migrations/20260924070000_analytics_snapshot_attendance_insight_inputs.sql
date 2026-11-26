-- CR-037 / CR-049: feed the Insights and Attendance engines real inputs.
--
-- get_organization_analytics_snapshot (last defined in
-- 20260826155000_mi1_append_only_review_repairs.sql) hardcoded the series
-- attendanceRate/engagementMean/usageViews to null and attendanceEvents to an
-- empty array, so the correlation and attendance tabs could never show data.
-- This redefinition keeps that body verbatim (session-derived organization,
-- MFA gate, organization staff-role gate, 25-person floor, audit write) and
-- only replaces those placeholders with aggregates derived from
-- meeting_attendance, organization_engagement_events and member_presence,
-- each scoped to chapters of the caller's selected organization.
--
-- 20260907151000 wrapped the installed body in the case-graph first gate
-- (private.lock_case_graph before any declare initializer runs); this body
-- keeps that exact outer-block wrapper.

begin;

create or replace function public.get_organization_analytics_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  period_end timestamptz := pg_catalog.date_trunc('month', generated);
  period_start timestamptz := pg_catalog.date_trunc('month', generated) - interval '6 months';
  privacy_threshold constant integer := 25;
  attendance_start timestamptz := generated - interval '180 days';
  result jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  result := pg_catalog.jsonb_build_object(
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
        from public.member_cases cs
        where cs.organization_id = org and cs.chapter_id is not null
          and cs.created_at >= period_start and cs.created_at < period_end
        group by cs.chapter_id, cs.status, step_bucket, cs.case_type
        having pg_catalog.count(distinct cs.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    -- organization_page_views contains request totals, not distinct people.
    -- It cannot satisfy a person-cohort floor and is therefore not published.
    'usageViews', '[]'::jsonb,
    'usageWindows', (
      select pg_catalog.jsonb_build_object(
        'organizationId', org,
        -- Nested exact windows permit complement differencing. Publish only a
        -- rounded 30-day distinct-person cohort; retain the shape explicitly.
        'dau', null,
        'wau', null,
        'mau', case when windows.mau >= privacy_threshold
          then (pg_catalog.floor(windows.mau / 5.0) * 5)::integer else null end,
        'suppressed', pg_catalog.jsonb_build_object(
          'dau', true,
          'wau', true,
          'mau', windows.mau < privacy_threshold
        )
      ) from (
        select
          pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '30 days') as mau
        from public.organization_engagement_events where organization_id = org
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
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
            and cs.created_at >= period_start and cs.created_at < period_end
        ) totals
        cross join (
          select coalesce(pg_catalog.min(cell.cell_people), 0) as minimum_cell
          from (
            select pg_catalog.count(distinct cs.user_id) as cell_people
            from public.member_cases cs
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
          from public.member_cases cs
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
  );
  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surface', 'organization_analytics_snapshot'
  ));
  return result;
end;
end;
$function$;

revoke all on function public.get_organization_analytics_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.get_organization_analytics_snapshot() to authenticated;

notify pgrst, 'reload schema';

commit;
