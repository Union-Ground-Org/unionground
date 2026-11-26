begin;

-- BUG-UG-CRON-HEALTH-MIRROR-LIFECYCLE-LOCK-HOLD-20261007, a measured
-- mitigation within BUG-UG-PRODUCTION-FAILS-UNDER-25-CONCURRENT-SESSIONS-20261006.
-- Reduce work under the existing lifecycle lock without changing that lock,
-- the job allowlist, historical outcome semantics or any execution privilege.
-- These indexes belong to the application relation; no extension-owned cron
-- table, cron setting or scheduler ownership is changed.

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
    where j.jobname in ('appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick') and (d.start_time >= window_start or d.runid = any(open_runs))
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

-- ROLLOUT. A repository migration is one transaction, so these builds cannot
-- be CONCURRENTLY. An ordinary CREATE INDEX holds SHARE on the mirror until
-- commit. A per-minute tick that has already taken the lifecycle gate then
-- waits at its INSERT, so every lifecycle writer waits out the rest of the
-- lock. The function is replaced first, so SHARE is taken last. The explicit
-- lock and both builds run as one statement, so a single statement_timeout
-- caps the whole SHARE wait plus hold. lock_timeout separately caps the
-- queued SHARE request, which would otherwise make later writers queue behind
-- it. Commit follows immediately. A slow or blocked apply rolls back cleanly
-- instead of stretching the lifecycle wait toward the 8 s authenticated
-- statement timeout. Apply in a quiet window.
set local lock_timeout = '1s';
set local statement_timeout = '3s';

do $$
begin
  lock table public.organization_job_runs in share mode;

  create index organization_job_runs_cron_latest_idx
    on public.organization_job_runs (started_at desc)
    where organization_id is null and run_id like 'cron:%';

  create index organization_job_runs_cron_open_idx
    on public.organization_job_runs (run_id)
    where organization_id is null and status = 'in_progress' and run_id like 'cron:%';
end
$$;

commit;
