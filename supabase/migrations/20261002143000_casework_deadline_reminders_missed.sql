-- BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001 (CR-023)
--
-- Restore-everything campaign,. The staff Deadline center
-- collects "Reminder (optional)" (src/components/CaseworkOperationsPanel.jsx,
-- casework_create_deadline p_reminder_at) into public.casework_deadlines.reminder_at,
-- but nothing ever read it, and nothing ever moved a passed deadline to the
-- 'missed' status the table has carried since 20260828210000. Staff also had no
-- way to record a deadline as met or waived, so an automatic "missed" would have
-- been unanswerable.
--
--   * private.casework_sweep_deadline_reminders(p_limit): a bounded minute sweep.
--       - Reminders: an active or extended deadline whose reminder_at has come
--         notifies the deadline's creator and the case's assigned steward and
--         coordinator once, each re-checked for case access at send time, with
--         case-free copy in the recipient's language (the posture of
--         20260924190100_casework_reminder_delivery.sql). Every processed
--         reminder records its reminder_disposition: 'sent' (at least one
--         notice was created; reminder_sent_at is then the send time and is set
--         for nothing else), 'expired' (it came due more than a day before the
--         sweep saw it, or the deadline had already passed, so nothing floods),
--         'suppressed' (the organization's reminders switch was off until it
--         went stale) or 'no_recipient' (nobody listed could still open the
--         case). Staff see which, so a reminder is never shown as sent when no
--         notice went out.
--       - Missed: an active or extended deadline whose due time has passed by
--         more than the organization's grace hours becomes 'missed', with one
--         casework_audit_events row (deadline_decided, decision 'missed',
--         automatic true) and the case history row-version.
--   * public.casework_set_deadline_status(p_deadline_id, p_status): staff record
--     a deadline met or waived, or reopen it (active), including a deadline the
--     sweep marked missed. Audited as deadline_decided with the decision.
--   * Automatic steward deadline WARNINGS are 's, not built here.
--
-- Settings (W1-SETTINGS registry, category casework). The old app had no flag
-- for either (no reminder_at delivery, no missed marking existed), so both
-- switches start ON per the campaign rule; the grace limit has no old value and
-- starts at 0 (missed at the due time):
--   features.casework.deadline_reminders        true
--   features.casework.mark_missed_deadlines     true
--   limits.casework.deadline_missed_grace_hours 0     bounds 0..168

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  -- No old flag (reminder_at was never delivered); campaign rule: default ON.
  ('features.casework.deadline_reminders', 'boolean', 'Deadline reminders',
   'Send the reminder staff set on a case deadline to the deadline''s creator and the assigned steward and coordinator.',
   'true', null, null, null, 1500, 'casework', false),
  -- No old flag (no missed marking existed); campaign rule: default ON.
  ('features.casework.mark_missed_deadlines', 'boolean', 'Mark passed deadlines missed',
   'Move an active case deadline to Missed once its due time has passed and it was not recorded met or waived.',
   'true', null, null, null, 1510, 'casework', true),
  -- No old value; 0 marks a deadline missed at its due time.
  ('limits.casework.deadline_missed_grace_hours', 'integer', 'Missed deadline grace (hours)',
   'Hours after a deadline''s due time before an unmet deadline is marked missed.',
   '0', 0, 168, null, 1520, 'casework', false)
on conflict (key) do nothing;

alter table public.casework_deadlines
  add column reminder_sent_at timestamptz,
  add column reminder_disposition text,
  add constraint casework_deadlines_reminder_disposition_check check (
    (reminder_disposition is null and reminder_sent_at is null)
    or (reminder_disposition = 'sent' and reminder_sent_at is not null)
    or (reminder_disposition in ('expired', 'suppressed', 'no_recipient') and reminder_sent_at is null)
  );

comment on column public.casework_deadlines.reminder_sent_at is
  'BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001: when private.casework_sweep_deadline_reminders created at least one reminder notice for reminder_at. Null unless reminder_disposition is sent.';
comment on column public.casework_deadlines.reminder_disposition is
  'BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001: what the sweep did with reminder_at: sent, expired (stale or the deadline had passed), suppressed (reminders switched off until stale) or no_recipient (nobody listed could open the case). Null while pending.';

create index casework_deadlines_reminder_due_idx
  on public.casework_deadlines (reminder_at)
  where reminder_at is not null and reminder_disposition is null and status in ('active', 'extended');
create index casework_deadlines_open_due_idx
  on public.casework_deadlines (due_at)
  where status in ('active', 'extended');

insert into private.notification_copy (key, lang, title, body) values
  ('casework.deadline.reminder', 'en', 'A case deadline reminder is due',
   'Open Casework to review the deadline on your case list.'),
  ('casework.deadline.reminder', 'es', 'Tienes un recordatorio de plazo de caso',
   'Abre Casos para revisar el plazo en tu lista de casos.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

create function private.casework_sweep_deadline_reminders(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer;
  v_now timestamptz;
  v_count integer;
  v_deadline public.casework_deadlines%rowtype;
  v_case public.member_cases%rowtype;
  v_recipient uuid;
  v_sent integer;
  v_disposition text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  v_limit := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_now := pg_catalog.now();
  v_count := 0;

  -- 1. reminder_at delivery, once per deadline. A reminder of an organization
  -- that switched reminders off stays pending (it is honored if they are
  -- switched back on while it is fresh) and is recorded suppressed once it
  -- goes stale. Every processed reminder records its disposition, and only a
  -- created notice records reminder_sent_at.
  for v_deadline in
    select d.* from public.casework_deadlines d
    where d.reminder_at is not null
      and d.reminder_disposition is null
      and d.status in ('active', 'extended')
      and d.reminder_at <= v_now
      and (d.reminder_at <= v_now - interval '1 day'
        or private.organization_feature_enabled(d.organization_id, 'features.casework.deadline_reminders'))
    order by d.reminder_at, d.id
    for update of d skip locked
    limit v_limit
  loop
    v_sent := 0;
    if v_deadline.reminder_at <= v_now - interval '1 day' then
      v_disposition := case
        when private.organization_feature_enabled(v_deadline.organization_id, 'features.casework.deadline_reminders')
          then 'expired' else 'suppressed' end;
    elsif v_deadline.due_at <= v_now then
      v_disposition := 'expired';
    else
      select * into v_case from public.member_cases where id = v_deadline.case_id;
      for v_recipient in
        select distinct u from unnest(array[v_deadline.created_by, v_case.steward_user_id, v_case.coordinator_user_id]) u
        where u is not null
      loop
        if private.casework_reminder_owner_can_read(v_recipient, v_deadline.case_id) then
          perform private.notify_member(v_recipient, 'casework.deadline.reminder', '{}'::jsonb, 'deadlines');
          v_sent := v_sent + 1;
        end if;
      end loop;
      v_disposition := case when v_sent > 0 then 'sent' else 'no_recipient' end;
    end if;
    v_count := v_count + v_sent;
    update public.casework_deadlines
      set reminder_disposition = v_disposition,
          reminder_sent_at = case when v_disposition = 'sent' then v_now end
      where id = v_deadline.id;
  end loop;

  -- 2. Passed, unmet deadlines become missed, once the organization's grace
  -- hours have run.
  for v_deadline in
    select d.* from public.casework_deadlines d
    where d.status in ('active', 'extended')
      and d.due_at < v_now
      and private.organization_feature_enabled(d.organization_id, 'features.casework.mark_missed_deadlines')
      and d.due_at + pg_catalog.make_interval(hours =>
        private.organization_limit(d.organization_id, 'limits.casework.deadline_missed_grace_hours')) <= v_now
    order by d.due_at, d.id
    for update of d skip locked
    limit v_limit
  loop
    update public.casework_deadlines set status = 'missed', updated_at = v_now where id = v_deadline.id;
    insert into public.casework_audit_events
      (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, null,
      'deadline_decided', 'deadline', v_deadline.id,
      pg_catalog.jsonb_build_object('decision', 'missed', 'automatic', true, 'kind', v_deadline.kind));
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

create function public.casework_set_deadline_status(p_deadline_id uuid, p_status text)
returns public.casework_deadlines
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deadline public.casework_deadlines%rowtype;
  v_previous text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  select * into v_deadline from public.casework_deadlines where id = p_deadline_id;
  if not found or not private.casework_staff_can_access(v_deadline.case_id) then
    raise exception 'deadline not found' using errcode = 'P0002';
  end if;
  if p_status is null or p_status not in ('met', 'waived', 'active') then
    raise exception 'invalid deadline status' using errcode = '22023';
  end if;
  select * into strict v_deadline from public.casework_deadlines where id = p_deadline_id for update;
  v_previous := v_deadline.status;
  if v_previous = p_status then
    return v_deadline;
  end if;
  update public.casework_deadlines set status = p_status, updated_at = pg_catalog.now()
    where id = v_deadline.id returning * into v_deadline;
  insert into public.casework_audit_events
    (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()),
    'deadline_decided', 'deadline', v_deadline.id,
    pg_catalog.jsonb_build_object('decision', p_status, 'previousStatus', v_previous));
  return v_deadline;
end;
$function$;

revoke all on function private.casework_sweep_deadline_reminders(integer) from public, anon, authenticated, service_role;
revoke all on function public.casework_set_deadline_status(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.casework_set_deadline_status(uuid, text) to authenticated;

comment on function private.casework_sweep_deadline_reminders(integer) is
  'BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001: bounded minute sweep; delivers each deadline reminder_at once with case-free copy to the creator and assigned staff (access re-checked), and marks passed unmet deadlines missed with an audit row.';
comment on function public.casework_set_deadline_status(uuid, text) is
  'Staff record a case deadline met or waived, or reopen it; audited as deadline_decided.';

-- Case dashboards tile 3 (20260917142000) counted only active and extended
-- deadlines as overdue, so the sweep's automatic 'missed' would have removed
-- the most overdue work from the tile at the moment it was marked. A missed
-- deadline stays overdue until staff record it met or waived. Same signature,
-- grants and staff gate; only the status list changes.
create or replace function public.casework_dashboard_overdue_deadlines()
returns table (kind text, deadline_count bigint, case_count bigint, oldest_due_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  select
    deadline.kind,
    pg_catalog.count(*),
    pg_catalog.count(distinct deadline.case_id),
    pg_catalog.min(deadline.due_at)
  from public.casework_deadlines deadline
  join private.casework_dashboard_open_cases() visible
    on visible.case_id = deadline.case_id
  where deadline.status in ('active', 'extended', 'missed')
    and deadline.due_at < pg_catalog.now()
  group by deadline.kind
  order by pg_catalog.count(*) desc, deadline.kind asc;
end;
$function$;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'casework-deadline-reminder-tick';
  perform cron.schedule('casework-deadline-reminder-tick', '* * * * *', 'select private.casework_sweep_deadline_reminders(200)');
end;
$block$;

-- ---------------------------------------------------------------------------
-- Job health: casework-deadline-reminder-tick joins the four copies of the monitored set (the
-- job-name CHECK, the mirror's jobname allow-list, the
-- list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js). The three database copies are
-- re-emitted from 20261002141000 with only that name added (BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001).
-- These are also the last copies before issue-intelligence-weekly-digest,
-- which 20261002151000 (REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001)
-- schedules without re-emitting them, so that name is listed here as well and
-- the weekly digest is monitored from the moment it is scheduled.
-- ---------------------------------------------------------------------------

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent',
    'ballot-notices-tick', 'casework-alert-escalation-tick',
    'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick',
    'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick',
    'deadline-notices-tick', 'dues-reminders-dispatch-tick',
    'dues-stripe-reconcile-tick', 'event-checkin-token-retention',
    'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'issue-intelligence-weekly-digest',
    'live-poll-schedule-tick', 'member-messaging-dispatch',
    'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention',
    'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
    'notifications-expiry-sweep', 'organization-automation-tick',
    'organization-claim-retention', 'survey-operations-sweep',
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
      'casework-alert-escalation-tick', 'casework-deadline-reminder-tick',
      'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick',
      'casework-ulp-deadline-tick', 'deadline-notices-tick',
      'event-checkin-token-retention', 'event-notices-tick',
      'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest',
      'live-poll-schedule-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention',
      'notifications-dispatch-tick', 'notifications-expiry-sweep',
      'organization-automation-tick', 'organization-claim-retention',
      'survey-operations-sweep', 'task-files-reconcile-tick',
      'task-maintenance-daily', 'union-ground-organization-retention',
      'weekly-question-selection-tick', 'workload-reminders-tick'
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
      'ballot-choices-mix', 'ballot-choices-mix-recent',
      'ballot-notices-tick', 'casework-alert-escalation-tick',
      'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick',
      'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick',
      'deadline-notices-tick', 'dues-reminders-dispatch-tick',
      'dues-stripe-reconcile-tick', 'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'issue-intelligence-weekly-digest',
      'live-poll-schedule-tick', 'member-messaging-dispatch',
      'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep', 'organization-automation-tick',
      'organization-claim-retention', 'survey-operations-sweep',
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

notify pgrst, 'reload schema';

commit;
