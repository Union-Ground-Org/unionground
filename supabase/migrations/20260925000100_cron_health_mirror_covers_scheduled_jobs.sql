begin;

-- OPS-UG-CRON-HEALTH-MIRROR-OMITS-SIX-JOBS-20260921: the Background job
-- health desk only ever saw the thirteen jobs 20260908170000 listed. Six
-- production jobs were scheduled after that list was last touched, so when any
-- of them failed the page stayed green:
--
--   casework-alert-escalation-tick        every minute, moves overdue
--                                         unacknowledged grievance alerts into
--                                         the restricted staff queue
--   weekly-question-selection-tick        hourly bounded weekly-question
--                                         scheduler
--   organization-automation-tick          hourly bounded automation dispatcher
--   mi1-public-rsvp-retention             daily public RSVP contact purge
--   union-ground-organization-retention   daily retention engine; it deletes
--                                         member data
--   mesh-agency-usage-aggregate-tick      weekly mesh usage aggregation
--
-- casework-reminder-delivery-tick (every minute, 20260924190100) was scheduled
-- on Main while this change was open and is mirrored with the six.
--
-- All four hand-written copies of the monitored set move together, because a
-- mirrored run that the CHECK constraint rejects is not recorded at all:
-- the mirror's jobname allowlist (twenty names), the
-- organization_job_runs_job_name_check constraint and the
-- public.list_organization_job_health() catalog (twenty-three names each: the
-- twenty mirrored pg_cron jobs plus the three platform jobs that report
-- themselves through record_* routines rather than through pg_cron). The
-- fourth copy, PRODUCT_JOBS, moves in src/features/operations/jobRegistry.js,
-- and tests/cron-job-health-sync-migration.test.js now derives the scheduled
-- set from the migrations and holds all four to it.
--
-- One baseline job stays out of the mirror, and the test pins the reason:
-- mi1-job-health-sync IS the mirror. A tick that fails writes nothing, so it
-- cannot report its own health; its liveness shows up instead as every other
-- job going stale at once. The two demo-seed-* jobnames are not baseline at
-- all -- a demo seed schedules them at runtime and drops them with the seed --
-- so they are outside the derived set rather than excluded from it.
--
-- Unchanged on purpose: the lock_case_graph preamble 20260907151000 pinned in
-- front of the mirror body, its incremental window, the status mapping, the
-- conflict target, and every authorization read and revoke of both routines.
-- The db-contract pins for both keep matching.

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
    'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
    'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
    'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
    'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
    'notifications-expiry-sweep', 'organization-automation-tick',
    'task-files-reconcile-tick', 'task-maintenance-daily',
    'union-ground-organization-retention', 'weekly-question-selection-tick',
    'workload-reminders-tick'
  ));

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
      'appointment-reminders-tick', 'ballot-choices-mix',
      'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep', 'organization-automation-tick',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
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
    from (select pg_catalog.unnest(array[
      'account-deletion-reconcile-tick', 'appointment-reminders-tick',
      'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
      'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep', 'organization-automation-tick',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
    ]) as job_name) catalog
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

commit;
