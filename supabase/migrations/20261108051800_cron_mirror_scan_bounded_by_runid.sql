-- BUG-UG-CRON-MIRROR-READS-WHOLE-CRON-HISTORY-EVERY-MINUTE-20261108 (#7513)
--
-- The every-minute job-health mirror filters cron.job_run_details on
-- start_time, which has no index, so every tick read the whole retained
-- history to find about 870 rows from the last two hours: about 607,000 rows
-- (176 MB) on SAMPLE and 641,000 (246 MB) on Production, growing about 10,500
-- rows a day. That scan was 97% of SAMPLE's disk reads since Nov 1 and 45% of
-- Production's, and on SAMPLE's Micro instance it reached 86.7 s at 4:33 AM ET
-- on Nov 8 and 90.5 s during the Nov 7 morning load.
--
-- The scan is now bounded below by the run id of the newest mirrored run that
-- started more than six hours before the window, so the runid primary key
-- serves it. The candidates are the same rows as before: same allowlist,
-- window, open runs, 2,000-run batch, ordering, conflict guard, outcome
-- mapping, gate position, security-definer boundary and privileges. No cron
-- history is deleted, and nothing in the cron schema changes.
--
-- The bound is dropped, and the whole history read as before, unless the
-- history still holds that exact anchor run and pg_cron's run-id sequence has
-- reached the highest run id in the history. In normal running the two are
-- equal. A sequence restarted anywhere below retained history hands new runs
-- ids among or under the retained ones, and it stays below the retained
-- maximum until it has passed every retained id, so every tick until then
-- reads everything. private.cron_run_id_high_water() reads the sequence (the
-- function owner may SELECT it on both hosts) and returns null when it
-- cannot, which also drops the bound.
--
-- No sequence check sees a restart that climbed past every retained id before
-- the next tick. So the routine also reads the whole history at least once an
-- hour: when private.cron_job_health_mirror_state shows no drained full read
-- in the last 60 minutes, the bound is dropped. The read is recorded only
-- once it leaves fewer than the 2,000-run batch pending, so a backlog keeps
-- every tick reading everything until it is gone. A run the bound missed is
-- still inside the two-hour look-back then, so it is mirrored late but never
-- lost, and full reads fall to about one tick in sixty.

begin;

-- The last run id pg_cron's sequence handed out, or null when the sequence is
-- missing, unread since a restart, or not readable by the caller.
create or replace function private.cron_run_id_high_water()
returns bigint
language sql
stable
set search_path = ''
as $function$
  select s.last_value
  from pg_catalog.pg_sequences s
  where s.schemaname = 'cron' and s.sequencename = 'runid_seq'
$function$;

revoke all on function private.cron_run_id_high_water()
  from public, anon, authenticated, service_role;

-- One row: when the job-health mirror last read the whole cron history.
create table private.cron_job_health_mirror_state (
  singleton boolean not null default true,
  last_full_read_at timestamptz not null,
  constraint cron_job_health_mirror_state_pkey primary key (singleton),
  constraint cron_job_health_mirror_state_singleton_check check (singleton)
);

comment on table private.cron_job_health_mirror_state is
  'When private.sync_organization_job_runs_from_cron_history last read the whole cron history; it reads everything again once this is an hour old. Written and read only by that routine.';

alter table private.cron_job_health_mirror_state enable row level security;
alter table private.cron_job_health_mirror_state force row level security;
revoke all on table private.cron_job_health_mirror_state from public, anon, authenticated, service_role;

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
  pending_rows jsonb;
  runid_floor bigint;
  floor_started_at timestamptz;
  full_read_at timestamptz;
begin
  -- Everything up to the upsert only reads: the mirror's own watermark, the
  -- extension-owned cron history and the matching mirror rows. Those reads
  -- take no tuple lock, so they run before the lifecycle gate. The one write
  -- before it is the hourly full-read marker, a private row outside the case
  -- graph that only this routine touches. The scan of
  -- cron.job_run_details costs seconds once the retained history is large;
  -- holding the global gate through it cancelled every gated writer that
  -- arrived meanwhile (other cron ticks, and GoTrue's auth.mfa_factors
  -- challenge and verify statements through a00_case_graph_lock, at the
  -- 3 s lock_timeout the gate forces).

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

  -- The history is filtered on start_time, which cron.job_run_details does not
  -- index; its only index is the runid primary key, and the table belongs to
  -- the extension owner. pg_cron takes a run's id when it launches the run and
  -- records start_time once the run's connection is up, seconds later, so run
  -- ids follow start order to within seconds. The newest mirrored run that
  -- started more than six hours before the window therefore has a lower id
  -- than every run that started inside the window, and bounding the scan by it
  -- lets the primary key serve the window instead of reading every retained
  -- page. The bound counts only while the history still holds that exact run
  -- (same id, same start) and the run-id sequence has reached the highest run
  -- id in the history (one primary key lookup): if the history was emptied or
  -- purged past the anchor, or the sequence was restarted below any retained
  -- run (new runs then take ids among or under the retained ones, possibly
  -- under the anchor), there is no bound and the scan reads everything, as
  -- before. Open runs stay re-read whatever their id. A restart that climbed
  -- past every retained id before this tick is invisible to those checks, so
  -- the bound is also dropped once the last full read is an hour old; the
  -- runs it missed are still inside the look-back and are mirrored then. The upper bound below is
  -- the bigint ceiling and removes nothing; with both ends a cached generic
  -- plan also estimates the run id range as narrow and keeps the index scan.
  select pg_catalog.substr(anchor.run_id, 6)::bigint, anchor.started_at
    into runid_floor, floor_started_at
  from public.organization_job_runs anchor
  where anchor.organization_id is null
    and anchor.run_id like 'cron:%'
    and anchor.started_at < window_start - interval '6 hours'
  order by anchor.started_at desc
  limit 1;

  select state.last_full_read_at
    into full_read_at
  from private.cron_job_health_mirror_state state
  where state.singleton;

  if runid_floor is null or not exists (
    select 1 from cron.job_run_details floor_run
    where floor_run.runid = runid_floor and floor_run.start_time = floor_started_at
  ) or coalesce(private.cron_run_id_high_water(), 0) < (
    select coalesce(pg_catalog.max(newest.runid), 0) from cron.job_run_details newest
  ) or full_read_at is null or full_read_at < pg_catalog.now() - interval '60 minutes' then
    runid_floor := 0;
  end if;

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
    where j.jobname in ('analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'learning-period-end-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick') and ((d.runid > runid_floor and d.runid <= 9223372036854775807 and d.start_time >= window_start)
      or d.runid = any(open_runs))
  ), pending as (
    select c.*
    from candidate c
    left join lateral (
      -- The unique (job_name, run_id, organization_id) identity admits at
      -- most one row. Keep this a candidate lookup: a merge/hash join may read
      -- the entire retained mirror on every tick.
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
  select coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.started_at, p.cron_runid),
      '[]'::jsonb)
    into pending_rows
  from pending p;

  -- Record a full read only once it drained: fewer than the 2,000-run batch
  -- left to mirror. A capped full read leaves the hourly read due, so the next
  -- tick reads everything again until the backlog is gone; otherwise the
  -- bound would return while runs under it were still pending, and they could
  -- leave the look-back unmirrored. It commits only with the rest of the tick.
  if runid_floor = 0 and pg_catalog.jsonb_array_length(pending_rows) < 2000 then
    insert into private.cron_job_health_mirror_state as state (singleton, last_full_read_at)
    values (true, pg_catalog.now())
    on conflict (singleton) do update set last_full_read_at = excluded.last_full_read_at;
  end if;

  -- An idle tick never touches the gate.
  if pg_catalog.jsonb_array_length(pending_rows) = 0 then
    return 0;
  end if;

  -- The reviewed lock-order preamble still precedes the first statement that
  -- can lock a mirror tuple. The upsert re-checks every staged row against
  -- the row it would change, so a run mirrored by a concurrent tick between
  -- the read and the gate changes nothing.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, p.job_name, p.run_id, p.status, p.started_at, p.finished_at,
    p.failure_code, p.redacted_summary
  from pg_catalog.jsonb_to_recordset(pending_rows) as p(
    job_name text, run_id text, status text, started_at timestamptz,
    finished_at timestamptz, failure_code text, redacted_summary text)
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

commit;
