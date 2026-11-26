-- BUG-UG-CRON-START-BURST-EXHAUSTS-SAMPLE-MEMORY-20261109
-- Six per-minute connections become one. Each task is a separate top-level
-- statement AND transaction: PostgreSQL arms statement_timeout per statement,
-- not when set_config is called inside a running function. Catch task failures
-- inside its own subtransaction, then commit before the next task to release
-- lifecycle locks. Keep the inactive job definitions for historical joins and
-- retain their reviewed commands, including all four messaging dispatch steps.
-- Vendor table definitions, platform settings and retention are unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.record_minute_cron_task(
  p_job_name text, p_run_id text, p_started_at timestamptz,
  p_status text, p_failure_code text
) returns void
language plpgsql
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  ) values (
    null, p_job_name, p_run_id, p_status, p_started_at, pg_catalog.clock_timestamp(),
    p_failure_code, case when p_status = 'failed' then 'Scheduled command failed.' end
  );
end;
$function$;
revoke all on function private.record_minute_cron_task(text, text, timestamptz, text, text)
  from public, anon, authenticated, service_role;

create or replace function private.run_minute_cron_task(p_job_name text)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  started_at timestamptz := pg_catalog.clock_timestamp();
  run_id text := 'minute:' || extensions.gen_random_uuid()::text;
  outcome text := 'completed';
  failure text;
begin
  if p_job_name not in (
    'member-messaging-dispatch', 'casework-alert-escalation-tick',
    'casework-reminder-delivery-tick', 'live-poll-schedule-tick',
    'casework-deadline-reminder-tick', 'mi1-job-health-sync'
  ) or p_job_name is null then
    raise exception 'unknown minute task' using errcode = '22023';
  end if;
  begin
    case p_job_name
      when 'member-messaging-dispatch' then
        perform private.dispatch_due_member_messaging();
        perform private.dispatch_due_workflow_reminders(200);
        perform private.run_welcome_automation(50);
        perform private.dispatch_due_here_reminders(200);
      when 'casework-alert-escalation-tick' then
        perform private.casework_escalate_due_alerts(200);
      when 'casework-reminder-delivery-tick' then
        perform private.casework_fire_due_reminders(200);
      when 'live-poll-schedule-tick' then
        perform private.run_due_live_poll_transitions(200);
      when 'casework-deadline-reminder-tick' then
        perform private.casework_sweep_deadline_reminders(200);
      when 'mi1-job-health-sync' then
        perform private.sync_organization_job_runs_from_cron_history();
    end case;
  exception
    when query_canceled then
      outcome := 'failed'; failure := 'cron_timeout';
    when others then
      outcome := 'failed'; failure := 'cron_failed';
  end;
  -- Log after the task so reads still precede the lifecycle gate. Raw errors,
  -- payloads and return messages must never enter the member-visible mirror.
  begin
    perform private.record_minute_cron_task(p_job_name, run_id, started_at, outcome, failure);
  exception when query_canceled or others then
    -- A broken health writer must not prevent later tasks from being tried.
    -- No success is invented: the missing task run becomes stale as before.
    raise warning 'Minute task health write failed for % [%]', p_job_name, sqlstate;
  end;
end;
$function$;
revoke all on function private.run_minute_cron_task(text)
  from public, anon, authenticated, service_role;

alter table public.organization_job_runs drop constraint organization_job_runs_job_name_check;
alter table public.organization_job_runs add constraint organization_job_runs_job_name_check
  check (job_name in (
    'account-deletion-reconcile-tick',
    'analytics-usage-digest',
    'appointment-reminders-tick',
    'ballot-choices-mix',
    'ballot-choices-mix-recent',
    'ballot-notices-tick',
    'casework-alert-escalation-tick',
    'casework-deadline-reminder-tick',
    'casework-reminder-delivery-tick',
    'casework-retaliation-timing-tick',
    'casework-ulp-deadline-tick',
    'chapter-leadership-claims-tick',
    'deadline-notices-tick',
    'dues-reminders-dispatch-tick',
    'dues-stripe-reconcile-tick',
    'event-checkin-token-retention',
    'event-notices-tick',
    'integration-webhooks-dispatch-tick',
    'issue-intelligence-weekly-digest',
    'knowledge-source-health-tick',
    'learning-period-end-tick',
    'live-poll-schedule-tick',
    'member-messaging-dispatch',
    'mesh-agency-usage-aggregate-tick',
    'mi1-analytics-receipt-retention',
    'mi1-job-health-sync',
    'mi1-public-rsvp-retention',
    'minutes-pre-event-notices-tick',
    'notifications-dispatch-tick',
    'notifications-expiry-sweep',
    'organization-automation-tick',
    'organization-claim-retention',
    'pulse-weekly-snapshots',
    'sso-identity-link-sweep',
    'survey-operations-sweep',
    'task-files-reconcile-tick',
    'task-maintenance-daily',
    'union-ground-organization-retention',
    'weekly-question-selection-tick',
    'workload-reminders-tick'
  ));

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
    from (select pg_catalog.unnest(array['account-deletion-reconcile-tick', 'analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'learning-period-end-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mi1-job-health-sync', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick']) as job_name) catalog
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

do $scheduler$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  perform cron.alter_job(j.jobid, active := false) from cron.job j where j.jobname = 'member-messaging-dispatch';
  perform cron.alter_job(j.jobid, active := false) from cron.job j where j.jobname = 'casework-alert-escalation-tick';
  perform cron.alter_job(j.jobid, active := false) from cron.job j where j.jobname = 'casework-reminder-delivery-tick';
  perform cron.alter_job(j.jobid, active := false) from cron.job j where j.jobname = 'live-poll-schedule-tick';
  perform cron.alter_job(j.jobid, active := false) from cron.job j where j.jobname = 'casework-deadline-reminder-tick';
  perform cron.alter_job(j.jobid, command := $dispatch$
begin; set local statement_timeout = '8s'; set local lock_timeout = '3s';
select private.run_minute_cron_task('member-messaging-dispatch'); commit;
begin; set local statement_timeout = '8s'; set local lock_timeout = '3s';
select private.run_minute_cron_task('casework-alert-escalation-tick'); commit;
begin; set local statement_timeout = '8s'; set local lock_timeout = '3s';
select private.run_minute_cron_task('casework-reminder-delivery-tick'); commit;
begin; set local statement_timeout = '8s'; set local lock_timeout = '3s';
select private.run_minute_cron_task('live-poll-schedule-tick'); commit;
begin; set local statement_timeout = '8s'; set local lock_timeout = '3s';
select private.run_minute_cron_task('casework-deadline-reminder-tick'); commit;
begin; set local statement_timeout = '8s'; set local lock_timeout = '3s';
select private.run_minute_cron_task('mi1-job-health-sync'); commit;
$dispatch$, active := true) from cron.job j where j.jobname = 'mi1-job-health-sync';
  perform cron.alter_job(j.jobid, schedule := '1-56/5 * * * *') from cron.job j where j.jobname = 'notifications-dispatch-tick';
  perform cron.alter_job(j.jobid, schedule := '2-57/5 * * * *') from cron.job j where j.jobname = 'integration-webhooks-dispatch-tick';
  perform cron.alter_job(j.jobid, schedule := '3-58/5 * * * *') from cron.job j where j.jobname = 'ballot-choices-mix-recent';
  perform cron.alter_job(j.jobid, schedule := '4-54/10 * * * *') from cron.job j where j.jobname = 'appointment-reminders-tick';
  perform cron.alter_job(j.jobid, schedule := '9-59/10 * * * *') from cron.job j where j.jobname = 'workload-reminders-tick';
  perform cron.alter_job(j.jobid, schedule := '6-56/10 * * * *') from cron.job j where j.jobname = 'sso-identity-link-sweep';
  perform cron.alter_job(j.jobid, schedule := '8-58/10 13-23 * * 1') from cron.job j where j.jobname = 'issue-intelligence-weekly-digest';
  perform cron.alter_job(j.jobid, schedule := '4-49/15 * * * *') from cron.job j where j.jobname = 'ballot-notices-tick';
  perform cron.alter_job(j.jobid, schedule := '5-50/15 * * * *') from cron.job j where j.jobname = 'event-notices-tick';
  perform cron.alter_job(j.jobid, schedule := '10-55/15 * * * *') from cron.job j where j.jobname = 'chapter-leadership-claims-tick';
  perform cron.alter_job(j.jobid, schedule := '7-47/20 13-23 * * *') from cron.job j where j.jobname = 'analytics-usage-digest';
  perform cron.alter_job(j.jobid, schedule := '18 * * * *') from cron.job j where j.jobname = 'weekly-question-selection-tick';
  perform cron.alter_job(j.jobid, schedule := '42 * * * *') from cron.job j where j.jobname = 'survey-operations-sweep';
end;
$scheduler$;

commit;
