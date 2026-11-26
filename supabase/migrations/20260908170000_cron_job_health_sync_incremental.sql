begin;

-- BUG-UG-CRON-JOB-HEALTH-SYNC-LOCK-STALL-20260908: the per-minute
-- `mi1-job-health-sync` job re-upserted every cron.job_run_details row of the
-- last fourteen days (about 40,000 rows on SAMPLE) into
-- public.organization_job_runs on every tick. That was cheap only while the
-- table had no row trigger. 20260907150000 installed the case-graph
-- statement and row lock triggers on organization_job_runs, so each tick now
-- runs the row trigger tens of thousands of times while holding the global
-- advisory transaction lock, and every auth.users write (GoTrue magic-link
-- issuance included) waits behind it for nine seconds or more.
--
-- The mirror becomes incremental: it resumes from the newest mirrored cron
-- start with a fixed two-hour look-back so a run that was still in progress at
-- the previous tick settles, never scanning further back than the historical
-- fourteen-day floor (first run, or resumption after an outage). Runs the
-- mirror still shows as in progress are always re-read, so a late completion
-- lands even after its start has left the window. Candidates whose mirrored
-- outcome already matches are filtered out before the insert, so the BEFORE
-- INSERT row trigger fires only for new or changed runs and a repeated tick
-- performs no row work at all; the ON CONFLICT guard stays for a concurrent
-- tick.
--
-- Unchanged on purpose: the lock_case_graph preamble that 20260907151000
-- pinned in front of the body (the lock order is the reviewed deadlock
-- contract), the thirteen-job allowlist, the status mapping, the conflict
-- target and the security-definer boundary. The db-contract pins for this
-- routine keep matching. The body only names cron.* relations, which plpgsql
-- resolves at execution time, so a shadow database without pg_cron still
-- applies this statement; only the pg_cron schedule ever invokes it.

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
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
  with candidate as (
    select j.jobname as job_name,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in (
      'integration-webhooks-dispatch-tick',
      'notifications-dispatch-tick', 'notifications-expiry-sweep',
      'deadline-notices-tick', 'ballot-notices-tick', 'event-notices-tick',
      'appointment-reminders-tick', 'member-messaging-dispatch',
      'workload-reminders-tick', 'ballot-choices-mix',
      'ballot-choices-mix-recent', 'task-files-reconcile-tick',
      'task-maintenance-daily'
    ) and (d.start_time >= window_start or d.runid = any(open_runs))
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, c.job_name, c.run_id, c.status, c.started_at, c.finished_at,
    c.failure_code, c.redacted_summary
  from candidate c
  left join public.organization_job_runs mirrored
    on mirrored.job_name = c.job_name
   and mirrored.run_id = c.run_id
   and mirrored.organization_id is null
  where mirrored.id is null
     or mirrored.status is distinct from c.status
     or mirrored.finished_at is distinct from c.finished_at
     or mirrored.failure_code is distinct from c.failure_code
     or mirrored.redacted_summary is distinct from c.redacted_summary
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
