-- BUG-UG-CRON-MIRROR-HOURLY-FULL-READ-REPEATS-WHOLE-HISTORY-COST-20261108 (#7562)
--
-- #7521 bounded the every-minute job-health mirror by run id and, to lose no
-- run after a run-id sequence restart that no check can see, read the whole
-- retained cron history once an hour. That hourly read cost what the old
-- per-minute scan did and grew with the history: 7,751 then 10,100 ms on
-- Production, 1,006 then 5,517 ms on SAMPLE (Nov 8, 11:26 AM to 12:30 PM ET).
--
-- A restarted sequence can only log runs at ids no retained run holds:
-- pg_cron cannot log a run at an id already in the history. The mirror state
-- now lists those free ids between the oldest retained run and a checked
-- watermark (free_runids, a multirange; Production has 2 such ranges in
-- 646,228 ids); a run logged under the oldest retained id moves the oldest id,
-- which the reconciliation compares. A run already in the history is taken off
-- the list only once it is mirrored or started before the window (the old
-- routine could never mirror it then, as the window only moves forward).
-- Every other run there stays listed (one logged but not started yet, since pg_cron sets the start
-- later, or one started inside the window but not mirrored, such as a run of
-- a job a later migration adds to the list), and the probe flags a listed run
-- once it has started inside the window. The hourly
-- reconciliation probes only those ranges through the run-id primary key and
-- extends the list over the ids it newly passes, so it reads no history rows
-- in normal running and its cost does not grow with the retained history.
-- Anything found there, any deleted history (the table's delete count or its
-- oldest run id changed, or statistics are off), a missing or mismatched
-- anchor, or a sequence below the newest run id still makes the tick read
-- everything, and that stays due until a read drains below one 2,000-run
-- batch. The bound, window, batch, ordering, conflict guard, outcome mapping,
-- gate position, security-definer boundary and privileges are unchanged. No
-- cron history is deleted, and nothing in the cron schema changes.

begin;

alter table private.cron_job_health_mirror_state
  add column checked_through bigint,
  add column free_runids pg_catalog.int8multirange not null default '{}'::pg_catalog.int8multirange,
  add column reconciled_at timestamptz,
  add column deleted_baseline bigint,
  add column lowest_baseline bigint;

comment on table private.cron_job_health_mirror_state is
  'The cron-history accounting of private.sync_organization_job_runs_from_cron_history: when it last drained a full read, the run ids up to checked_through that no run held when last checked (free_runids), when it last reconciled, and the delete count and oldest run id it last saw. Written and read only by that routine.';

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
  mirror_state private.cron_job_health_mirror_state%rowtype;
  full_read boolean;
  reconcile boolean;
  lower_runid bigint;
  next_checked bigint;
  next_free pg_catalog.int8multirange;
  deleted_now bigint;
  lowest_now bigint;
begin
  -- Everything up to the upsert only reads: the mirror's own watermark, the
  -- extension-owned cron history and the matching mirror rows. Those reads
  -- take no tuple lock, so they run before the lifecycle gate. The one write
  -- before it is the mirror's own accounting row, a private row outside the
  -- case graph that only this routine touches. The scan of
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
  -- before. Open runs stay re-read whatever their id. The upper bound below is
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

  select state.* into mirror_state
  from private.cron_job_health_mirror_state state
  where state.singleton;

  -- Two cheap signs of deleted history: the cumulative delete count of the
  -- table (null when statistics are off) and its oldest run id (one primary
  -- key lookup).
  deleted_now := case when pg_catalog.current_setting('track_counts') = 'on'
    then pg_catalog.pg_stat_get_tuples_deleted('cron.job_run_details'::pg_catalog.regclass) end;
  select pg_catalog.min(oldest.runid) into lowest_now from cron.job_run_details oldest;

  full_read := runid_floor is null or not exists (
    select 1 from cron.job_run_details floor_run
    where floor_run.runid = runid_floor and floor_run.start_time = floor_started_at
  ) or coalesce(private.cron_run_id_high_water(), 0) < (
    select coalesce(pg_catalog.max(newest.runid), 0) from cron.job_run_details newest
  ) or mirror_state.checked_through is null;

  -- The hourly reconciliation. A restart that climbed past every retained id
  -- before a tick can only have logged runs at ids no run held, so the state
  -- keeps every such id up to checked_through in free_runids; ids above it
  -- are read by the bound below. A run already in the history leaves the
  -- list only once it is mirrored or started before the window, which only
  -- moves forward (the old routine could never mirror it then). A run without
  -- a start yet
  -- (pg_cron logs a run first and sets its start later), or started inside
  -- the window but not mirrored, stays listed. The probe reads only rows that
  -- now sit in those free ranges, one primary key range probe per free range
  -- (lateral, so no plan can turn it into a scan), and flags only runs that
  -- started inside the window; there are none in normal running. Such runs,
  -- or any deleted history (which frees ids the state does not list), make
  -- this a full read, and the reconciliation stays due until a full read
  -- drains.
  reconcile := not full_read and (mirror_state.reconciled_at is null
    or mirror_state.reconciled_at < pg_catalog.now() - interval '60 minutes');
  if reconcile and (
    deleted_now is null
    or deleted_now is distinct from mirror_state.deleted_baseline
    or lowest_now is distinct from mirror_state.lowest_baseline
    or exists (
      select 1
      from pg_catalog.unnest(mirror_state.free_runids) as free(ids)
      cross join lateral (
        select 1 from cron.job_run_details refilled
        where refilled.runid >= pg_catalog.lower(free.ids) and refilled.runid < pg_catalog.upper(free.ids)
          and refilled.start_time >= window_start
        limit 1
      ) hit
    )
  ) then
    full_read := true;
  end if;

  if full_read then
    lower_runid := 0;
  else
    -- Ids between the watermark and the bound are read this tick; a clean
    -- reconciliation then records which of them no run holds, before the
    -- read, so a run logged there later is found by the next probe.
    lower_runid := least(runid_floor, mirror_state.checked_through);
    next_checked := mirror_state.checked_through;
    next_free := mirror_state.free_runids;
    -- Ids under the oldest retained run are left out: a run logged there
    -- moves the oldest id, which the reconciliation compares. Only runs that
    -- started before the window (no mirror lookup then) or are mirrored come
    -- off the list.
    if reconcile and runid_floor > mirror_state.checked_through then
      select next_free + (
          pg_catalog.int8multirange(pg_catalog.int8range(
            greatest(mirror_state.checked_through, lowest_now - 1), runid_floor, '(]'))
          - coalesce(pg_catalog.range_agg(pg_catalog.int8range(held.runid, held.runid, '[]'))
              filter (where held.start_time < window_start or exists (
                select 1 from public.organization_job_runs held_mirror
                where held_mirror.job_name = held_job.jobname
                  and held_mirror.run_id = 'cron:' || held.runid::text
                  and held_mirror.organization_id is null)),
              '{}'::pg_catalog.int8multirange))
        into next_free
      from cron.job_run_details held
      left join cron.job held_job on held_job.jobid = held.jobid
      where held.runid > greatest(mirror_state.checked_through, lowest_now - 1) and held.runid <= runid_floor;
      next_checked := runid_floor;
    end if;
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
    where j.jobname in ('analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'learning-period-end-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick') and ((d.runid > lower_runid and d.runid <= 9223372036854775807 and d.start_time >= window_start)
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

  -- The state moves only when this tick drained: fewer than the 2,000-run
  -- batch left to mirror. A capped tick leaves everything as it was, so the
  -- next tick reads the same ids again (and a due reconciliation stays due)
  -- until the backlog is gone. A drained full read starts the accounting
  -- over with nothing listed: the next tick reconciles, reading everything
  -- once more while it lists the free ids up to the bound. These are the
  -- only writes before the gate, to a private row outside the case graph,
  -- and they commit only with the rest of the tick.
  if pg_catalog.jsonb_array_length(pending_rows) < 2000 then
    if full_read then
      insert into private.cron_job_health_mirror_state as state (
        singleton, last_full_read_at, checked_through, free_runids, reconciled_at, deleted_baseline, lowest_baseline)
      values (true, pg_catalog.now(), 0, '{}'::pg_catalog.int8multirange, null, deleted_now, lowest_now)
      on conflict (singleton) do update set
        last_full_read_at = excluded.last_full_read_at, checked_through = excluded.checked_through,
        free_runids = excluded.free_runids, reconciled_at = excluded.reconciled_at,
        deleted_baseline = excluded.deleted_baseline, lowest_baseline = excluded.lowest_baseline;
    elsif reconcile then
      update private.cron_job_health_mirror_state state
        set checked_through = next_checked, free_runids = next_free, reconciled_at = pg_catalog.now()
      where state.singleton;
    end if;
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
