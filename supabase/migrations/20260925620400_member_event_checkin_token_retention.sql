begin;

-- OPS-UG-EVENT-CHECKIN-TOKENS-NO-RETENTION-20260921: private.member_event
-- _checkin_tokens had no retention rule. Every steward scan left a permanent row
-- pairing member, event, scanner and timestamp, and every abandoned 90-second
-- token that was never re-requested stayed forever, so attendance-adjacent
-- personal data accumulated without bound -- unlike public.public_event_rsvps,
-- which private.purge_expired_public_event_rsvps trims nightly at 90 days
-- (20260826155000), and unlike the other private tables the account-lifecycle
-- manifest covers.
--
-- Window: 30 days past expires_at. A token lives 90 seconds (20260723140000), so
-- 30 days is far past any legitimate read of the row and still past the window in
-- which a member or steward could dispute a door scan. Nothing durable is lost:
-- public.member_event_checkins is the attendance record and carries the
-- scanned_by attribution (20260722023422, 20260723140000), and the scan points
-- branch of private.award_member_points reads that table, never this one.
--
-- Bounded bite per run, mirroring the invitation-limit prune (20260907153000):
-- this table carries the account-lifecycle case-graph gates (a00_case_graph_lock
-- BEFORE STATEMENT and z99_case_graph_keys BEFORE ROW, 20260907150000), and
-- private.lock_case_graph takes the global case-graph advisory lock for the whole
-- transaction, so an unbounded first sweep over a large backlog would serialize
-- every case-graph writer while it ran. A threshold delete is idempotent by
-- shape, so a repeated, missed or partial night converges on its own.
--
-- Eligible rows are not ordered before the limit on purpose: the table's two
-- indexes are (event_id, token_hash) and (user_id, event_id), so ordering by
-- expires_at would sort the whole table every night to choose between rows that
-- are all equally purgeable.
--
-- Monitoring: the job joins the four copies of the monitored set that
-- 20260925000100 holds together (the mirror's jobname allowlist, the
-- organization_job_runs_job_name_check constraint, the
-- public.list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js), so a failed sweep shows on the
-- Background job health desk like mi1-public-rsvp-retention's. The mirror and
-- the catalog are re-emitted from 20260925570600 (which added
-- mi1-analytics-receipt-retention) with only that name added;
-- the lock_case_graph preamble, the incremental window, the status mapping and
-- every authorization read and revoke are unchanged. The purge itself takes
-- private.lock_case_graph first, as the case-graph entry inventory requires of
-- every definer that writes a gated table.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.purge_expired_member_event_checkin_tokens()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare removed integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  delete from private.member_event_checkin_tokens as stale
  where stale.ctid in (
    select candidate.ctid
    from private.member_event_checkin_tokens as candidate
    where candidate.expires_at < pg_catalog.now() - interval '30 days'
    limit 20000
    for update skip locked
  );
  get diagnostics removed = row_count;
  return removed;
end;
$function$;

revoke all on function private.purge_expired_member_event_checkin_tokens()
  from public, anon, authenticated, service_role;

comment on function private.purge_expired_member_event_checkin_tokens() is
  'Internal bounded retention sweep: deletes check-in tokens more than 30 days past expiry; no client role can execute it.';

do $schedule$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.schedule(
      'event-checkin-token-retention',
      '53 4 * * *',
      'select private.purge_expired_member_event_checkin_tokens();'
    );
  end if;
exception when unique_violation then null;
end;
$schedule$;

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
    'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
    'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
    'event-checkin-token-retention',
    'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
    'mi1-analytics-receipt-retention',
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
      'deadline-notices-tick', 'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
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
      'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
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
