-- #6694: Pulse trends come from stored weekly snapshots. A weekly job records
-- each completed Eastern week once; the privacy floor is applied when the row
-- is written, so a stored row never holds a small group. No backfill: history
-- starts with the first week the job records.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- chapter_id null is the whole organization (the "local" level). A withheld
-- cell stores no value; people counts are never stored.
create table private.pulse_weekly_snapshots (
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  chapter_id text references public.chapters(id) on update cascade on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  measure text not null check (measure = 'meeting_checkins'),
  value integer check (value is null or value >= 0),
  withheld boolean not null,
  privacy_floor integer not null check (privacy_floor >= 10),
  taken_at timestamptz not null default pg_catalog.now(),
  constraint pulse_weekly_snapshots_withheld_value check (withheld = (value is null)),
  constraint pulse_weekly_snapshots_cell unique nulls not distinct (organization_id, chapter_id, week_start, measure)
);
create index pulse_weekly_snapshots_chapter_idx on private.pulse_weekly_snapshots(chapter_id);
alter table private.pulse_weekly_snapshots enable row level security;
alter table private.pulse_weekly_snapshots force row level security;
revoke all on private.pulse_weekly_snapshots from public, anon, authenticated, service_role;
create policy mfa_assurance on private.pulse_weekly_snapshots as restrictive for all to authenticated
using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.pulse_weekly_snapshots is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; get_pulse_history checks the caller''s hat, organization, chapter and survey gate.';
-- Organization and chapter children join the account case graph.
create trigger a00_case_graph_lock before insert or update or delete on private.pulse_weekly_snapshots
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.pulse_weekly_snapshots
for each row execute function private.lock_case_graph_row_keys('', '');
comment on table private.pulse_weekly_snapshots is '#6694: one row per organization, chapter (null = whole organization), completed Eastern week and measure. Written once by take_pulse_weekly_snapshots and read only through get_pulse_history. Withheld cells carry no value; no person, id or people count is stored.';

insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
 select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
 where schema_name = 'private' and table_name = 'pulse_weekly_snapshots'
 on conflict(kind,schema_name,table_name,object_name) do update set definition_hash = excluded.definition_hash;

-- Meeting check-ins only (a project decision on #6741, 1:05 PM ET Nov 2 2026,
-- option A). Collective-action sign-ups are not stored: get_collective_actions
-- publishes each action's lifetime participantCount, which a weekly series
-- could be subtracted from. Case counts are not stored either: the live case
-- chart is filtered per viewer.
-- The live charts publish calendar months and get_member_event_quorum publishes
-- single meetings, so every nonzero chapter, organization and meeting cell of
-- each week-within-month segment needs the floor, or the whole week is
-- withheld. A week is recorded only once every meeting in it has closed: check-in
-- writers accept a check-in only until four hours after the meeting starts, so
-- the stored count is final. Until then the organization's week waits for a
-- later run; once recorded it is never topped up.
create function private.take_pulse_weekly_snapshots(p_now timestamptz default pg_catalog.now())
returns integer language plpgsql security definer set search_path = '' as $function$
declare
  org uuid; org_floor integer; week_from timestamptz; week_to timestamptz; week date; written integer; added integer;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  written := 0;
  week := (pg_catalog.date_trunc('week', p_now at time zone 'America/New_York') - interval '7 days')::date;
  week_from := week::timestamp at time zone 'America/New_York';
  week_to := (week + 7)::timestamp at time zone 'America/New_York';
  for org in select o.id from public.organizations o where private.organization_is_union(o.id)
    and not exists (select 1 from private.pulse_weekly_snapshots done where done.organization_id = o.id and done.week_start = week)
    and not exists (select 1 from public.member_events open_meeting join public.chapters c on c.id = open_meeting.chapter_id and c.organization_id = o.id
      where open_meeting.event_kind = 'meeting' and open_meeting.cancelled_at is null
        and open_meeting.starts_at >= week_from and open_meeting.starts_at < week_to and open_meeting.starts_at + interval '4 hours' >= p_now)
    order by o.id loop
    org_floor := greatest(10, coalesce(private.organization_limit(org,'limits.analytics.anonymity_floor'),25));
    with source as materialized (
      select 'meeting_checkins'::text as measure, e.chapter_id as chapter, e.id::text as item, ch.user_id,
        pg_catalog.date_trunc('month', e.starts_at at time zone 'America/New_York') as part
      from public.member_event_checkins ch join public.member_events e on e.id = ch.event_id
      join public.chapters c on c.id = e.chapter_id and c.organization_id = org
      where e.event_kind = 'meeting' and e.cancelled_at is null and e.starts_at >= week_from and e.starts_at < week_to
    ), cells as (
      select measure, chapter, grouping(chapter) = 1 as total, grouping(part) = 1 as whole_week, grouping(item) = 0 as single,
        pg_catalog.count(*)::integer as value, pg_catalog.count(distinct user_id) as people
      from source group by grouping sets ((measure, chapter, part), (measure, part), (measure, item, part), (measure, chapter), (measure))
    ), safety as (
      select m.measure, coalesce(pg_catalog.bool_and(cells.people >= org_floor), true) as safe
      from (values ('meeting_checkins')) m(measure)
      left join cells on cells.measure = m.measure
      group by m.measure
    ), targets as (
      select c.id as chapter from public.chapters c where c.organization_id = org
      union all select null::text
    )
    insert into private.pulse_weekly_snapshots(organization_id,chapter_id,week_start,measure,value,withheld,privacy_floor)
    select org, t.chapter, week, s.measure, case when s.safe then coalesce(x.value, 0) end, not s.safe, org_floor
    from targets t cross join safety s
    left join cells x on x.measure = s.measure and x.whole_week and not x.single and x.total = (t.chapter is null) and (t.chapter is null or x.chapter = t.chapter)
    on conflict on constraint pulse_weekly_snapshots_cell do nothing;
    get diagnostics added = row_count;
    written := written + added;
  end loop;
  return written;
end;
$function$;
revoke all on function private.take_pulse_weekly_snapshots(timestamptz) from public, anon, authenticated, service_role;

-- One read for every hat, scoped as the live chart reads (#6692): the current
-- chapter needs an active membership or the hat held at organization level,
-- and the whole-organization row needs that organization-level hat. The survey
-- gate locks every series, as it does the live aggregate charts. Meeting
-- check-ins are returned only for the caller's own chapter, and only when the
-- live event scope would show the caller a private meeting of that chapter
-- (the strictest case), so every counted meeting is one they may see. A week stored
-- under a lower floor than the organization's current one is withheld.
-- A week's value is shown only once each calendar month it touches has closed
-- and every week touching those months is stored and published. Otherwise a
-- live monthly figure minus the shown weeks would isolate a withheld, partly
-- recorded or still-open stretch of days.
create function public.get_pulse_history(p_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid; chapter text; local_level boolean; meetings_visible boolean; weeks date[]; first_week date; series jsonb; current_floor integer; open_month date;
begin
  perform private.lock_case_graph_read();
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.pulse_chart_context(p_hat);
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object('locked',true,'weeks','[]'::jsonb,'series','[]'::jsonb);
  end if;
  current_floor := greatest(10,coalesce(private.organization_limit(org,'limits.analytics.anonymity_floor'),25));
  open_month := pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'America/New_York')::date;
  chapter := private.current_member_chapter();
  local_level := p_hat <> 'member' and private.has_organization_role(org,array[p_hat]);
  if chapter is null or not exists (select 1 from public.chapters c where c.id = chapter and c.organization_id = org)
    or not (local_level or exists (select 1 from public.member_chapter_memberships m
      where m.user_id = auth.uid() and m.chapter_id = chapter and m.status = 'active')) then
    raise exception 'history unavailable' using errcode = '42501';
  end if;
  meetings_visible := coalesce(private.member_can_access_event_scope(chapter, false, false), false);
  select pg_catalog.array_agg(w.week_start order by w.week_start) into weeks from (
    select distinct s.week_start from private.pulse_weekly_snapshots s where s.organization_id = org
    order by s.week_start desc limit 12) w;
  select pg_catalog.min(s.week_start) into first_week from private.pulse_weekly_snapshots s where s.organization_id = org;
  with levels as (
    select chapter as chapter_id, 'chapter'::text as level
    union all select null::text, 'local' where local_level
  ), shown as (
    -- The organization row stands for the cube: a withheld week is withheld
    -- for every chapter of that organization and measure.
    select m.measure, w.week, not exists (
      select 1 from pg_catalog.generate_series(
          pg_catalog.date_trunc('month', w.week::timestamp), pg_catalog.date_trunc('month', (w.week + 6)::timestamp), interval '1 month') month(start)
      where month.start::date >= open_month or exists (
        select 1 from pg_catalog.generate_series(pg_catalog.date_trunc('week', month.start),
            month.start + interval '1 month' - interval '1 day', interval '7 days') touching(start)
        where not exists (select 1 from private.pulse_weekly_snapshots t where t.organization_id = org and t.chapter_id is null
          and t.measure = m.measure and t.week_start = touching.start::date and not t.withheld and t.privacy_floor >= current_floor))) as ready
    from pg_catalog.unnest(array['meeting_checkins']) m(measure) cross join pg_catalog.unnest(weeks) w(week)
  ), points as (
    select l.level, m.measure, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'week',pg_catalog.to_char(w.week,'YYYY-MM-DD'),
        'value',case when r.ready and s.privacy_floor >= current_floor then s.value end,
        'withheld',coalesce(s.withheld or s.privacy_floor < current_floor,false),
        'pending',s.week_start is not null and not s.withheld and s.privacy_floor >= current_floor and not r.ready,
        'recorded',s.week_start is not null) order by w.week) as points
    from levels l cross join pg_catalog.unnest(array['meeting_checkins']) m(measure) cross join pg_catalog.unnest(weeks) w(week)
    join shown r on r.measure = m.measure and r.week = w.week
    left join private.pulse_weekly_snapshots s on s.organization_id = org and s.chapter_id is not distinct from l.chapter_id
      and s.week_start = w.week and s.measure = m.measure
    where m.measure <> 'meeting_checkins' or (l.level = 'chapter' and meetings_visible)
    group by l.level, m.measure
  )
  -- Direction compares the last two shown weeks only when they are adjacent.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('level',p.level,'measure',p.measure,'points',p.points,
      'direction',(select case when pg_catalog.count(*) < 2 or pg_catalog.max(x.week) - pg_catalog.min(x.week) <> 7 then null
          when pg_catalog.max(x.value) filter (where x.n = 1) > pg_catalog.max(x.value) filter (where x.n = 2) then 'up'
          when pg_catalog.max(x.value) filter (where x.n = 1) < pg_catalog.max(x.value) filter (where x.n = 2) then 'down' else 'flat' end
        from (select (e->>'week')::date as week, (e->>'value')::integer as value,
            pg_catalog.row_number() over (order by e->>'week' desc) as n
          from pg_catalog.jsonb_array_elements(p.points) e where pg_catalog.jsonb_typeof(e->'value') = 'number') x where x.n <= 2))
      order by p.level, p.measure),'[]'::jsonb)
  into series from points p;
  return pg_catalog.jsonb_build_object('locked',false,
    'privacyFloor',current_floor,
    'since',pg_catalog.to_char(first_week,'YYYY-MM-DD'),'complete',coalesce(pg_catalog.array_length(weeks,1),0) >= 12,
    'weeks',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_char(w,'YYYY-MM-DD') order by w) from pg_catalog.unnest(weeks) w),'[]'::jsonb),
    'series',series);
end;
$function$;
revoke all on function public.get_pulse_history(text) from public, anon, authenticated, service_role;
grant execute on function public.get_pulse_history(text) to authenticated;

-- Carry the new schedule into every job-health registry (the constraint, the
-- cron mirror and the admin catalogue), re-emitted from 20261010130000 with
-- only pulse-weekly-snapshots added.
alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in ('account-deletion-reconcile-tick', 'analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick'));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
-- Generic plans overestimate the moving cron window; compiling that estimate
-- costs more than the indexed work. This setting is local to this routine.
set jit = off
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  --
  -- One tick mirrors at most 2,000 pending runs, oldest start first (ties by
  -- run id), so a cold or lagging mirror catches up across ticks instead of
  -- writing fourteen days of history in one transaction under the lifecycle
  -- gate. Taking the oldest first keeps the newest-start watermark honest:
  -- this tick's newest mirrored start is no later than any run it left
  -- pending, so every left-over run stays inside the next tick's window. Open
  -- runs are re-read whatever their start, so late completions still land.
  -- Each tick is one transaction and one batch; nothing loops here.
  with candidate as (
    select j.jobname as job_name,
      d.runid as cron_runid,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in ('analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick') and (d.start_time >= window_start or d.runid = any(open_runs))
  ), pending as (
    select c.*
    from candidate c
    left join lateral (
      -- The unique (job_name, run_id, organization_id) identity admits at
      -- most one row. Keep this a candidate lookup: a merge/hash join may read
      -- the entire retained mirror while the lifecycle gate is held.
      select existing.*
      from public.organization_job_runs existing
      where existing.job_name = c.job_name
        and existing.run_id = c.run_id
        and existing.organization_id is null
      limit 1
    ) mirrored on true
    where mirrored.id is null
       or mirrored.status is distinct from c.status
       or mirrored.finished_at is distinct from c.finished_at
       or mirrored.failure_code is distinct from c.failure_code
       or mirrored.redacted_summary is distinct from c.redacted_summary
    order by c.started_at, c.cron_runid
    limit 2000
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, p.job_name, p.run_id, p.status, p.started_at, p.finished_at,
    p.failure_code, p.redacted_summary
  from pending p
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array['account-deletion-reconcile-tick', 'analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick']) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

-- Daily so a missed Monday is recovered within the week; each run records only
-- the last completed week, and a recorded week is never rewritten.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'pulse-weekly-snapshots';
  perform cron.schedule('pulse-weekly-snapshots', '23 10 * * *', 'select private.take_pulse_weekly_snapshots(pg_catalog.now())');
end;
$block$;

notify pgrst, 'reload schema';
commit;
