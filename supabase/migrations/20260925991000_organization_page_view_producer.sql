-- OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921:
-- the analytics read side shipped, but nothing in production wrote
-- organization_page_views or organization_engagement_events, so the Usage
-- tiles (Views / Daily actors / Weekly actors) could only ever show a dash.
-- (PLAN.md section 13), AUTHENTICATED PAGE-VIEW
-- PRODUCER: an authenticated, rate-limited RPC (one call per page view,
-- bounded per user per minute, organization-scoped, no PII beyond the acting
-- user id and the page key) writes organization_engagement_events so the
-- Views / DAU / WAU tiles show real numbers; the web client calls it on
-- workspace page changes, the native app on screen focus.
--
--   1. organization_engagement_events admits the event type 'page_view'.
--      The per-member engagement score joins its weights table and so never
--      counts it; the engagementCounts aggregate excludes it explicitly.
--   2. public.record_workspace_page_view(p_page, p_hat, p_organization_id):
--      session-derived organization (an explicit different organization is
--      refused), active membership, page key bounded to 100 URL characters,
--      the hat recorded only when the caller holds that organization role,
--      one page_view event per (person, path, UTC minute) as the idempotency
--      key, at most 30 recorded page views per person per minute (the excess
--      returns recorded=false, refusal='rate-limited'), and one
--      organization_page_views increment per recorded event.
--   3. public.get_organization_analytics_snapshot is rebuilt on its
--      20260925160000 body (digest-guarded below, case-graph gate kept first)
--      so usageViews publishes floor-safe (path, hat, day) totals and
--      usageWindows publishes dau / wau / mau with a complement rule.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_organization_analytics_snapshot()'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '1b0cbbebdd6612892dfca222e12b6a44dd40b34d2e348d9178a75822ea1b351c' then
    raise exception 'unreviewed get_organization_analytics_snapshot predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

-- ------------------------------------------------- 1. the page_view event type

alter table public.organization_engagement_events
  drop constraint organization_engagement_events_event_type_check;
alter table public.organization_engagement_events
  add constraint organization_engagement_events_event_type_check check (event_type in (
    'meeting_check_in', 'qa_contribution', 'poll_vote', 'survey_response',
    'event_rsvp', 'authorized_contact', 'page_view'
  ));

-- The per-person minute bound reads one person's recent page views.
create index organization_engagement_events_page_view_rate_idx
  on public.organization_engagement_events (user_id, occurred_at)
  where event_type = 'page_view';

-- ------------------------------------------------- 2. the producer

create function public.record_workspace_page_view(
  p_page text,
  p_hat text default 'member',
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid := private.engagement_selected_organization();
  moment timestamptz := pg_catalog.now();
  page_key text := pg_catalog.btrim(coalesce(p_page, ''));
  recorded_hat text := 'member';
  minute_key text := pg_catalog.to_char(moment at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  recent integer;
  inserted boolean := false;
begin
  if caller is null or org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_organization_id is not null and p_organization_id is distinct from org then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(page_key) < 1 or pg_catalog.char_length(page_key) > 100
     or page_key !~ '^/[A-Za-z0-9/_.:-]*$' then
    raise exception 'invalid page key' using errcode = '22023';
  end if;
  if p_hat in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     and private.has_organization_role(org, array[p_hat]) then
    recorded_hat := p_hat;
  end if;

  select pg_catalog.count(*) into recent
  from public.organization_engagement_events e
  where e.user_id = caller and e.event_type = 'page_view'
    and e.occurred_at >= moment - interval '1 minute';
  if recent >= 30 then
    return pg_catalog.jsonb_build_object('recorded', false, 'refusal', 'rate-limited');
  end if;

  insert into public.organization_engagement_events
    (organization_id, user_id, chapter_id, event_type, source_id, occurred_at)
  values (org, caller, private.current_member_chapter(), 'page_view', page_key || '|' || minute_key, moment)
  on conflict (organization_id, user_id, event_type, source_id) do nothing;
  inserted := found;
  if inserted then
    insert into public.organization_page_views (organization_id, path, hat, day, view_count)
    values (org, page_key, recorded_hat, (moment at time zone 'UTC')::date, 1)
    on conflict (organization_id, path, hat, day) do update
      set view_count = public.organization_page_views.view_count + 1;
  end if;
  return pg_catalog.jsonb_build_object('recorded', inserted);
end;
end;
$function$;

revoke all on function public.record_workspace_page_view(text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_workspace_page_view(text, text, uuid) to authenticated;

comment on function public.record_workspace_page_view(text, text, uuid) is
  'Authenticated page-view producer: session-derived organization, active membership, bounded page key, hat recorded only when held, one page_view engagement event per person/path/UTC minute, at most 30 recorded per person per minute, one organization_page_views increment per recorded event.';

-- ------------------------------------------------- 3. the reader

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
  snapshot_id uuid := extensions.gen_random_uuid();
  published_rows integer;
  withheld_rows integer;
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
    -- OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
    -- ( AUTHENTICATED PAGE-VIEW PRODUCER):
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
  );
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
$function$;

revoke all on function public.get_organization_analytics_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.get_organization_analytics_snapshot() to authenticated;

notify pgrst, 'reload schema';

commit;
