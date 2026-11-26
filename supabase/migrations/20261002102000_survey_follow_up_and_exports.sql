-- REQ-UG-SURVEY-ESCALATION-AND-FOLLOWUP-TASKS-20261001 (clean-room parity
-- CR-006/CR-007) and REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001
-- (CR-010 + CR-112), restore-everything VOICE.
--
-- 1. Survey follow-up and coverage escalation. The old app (git ref
--    de7df4b57c^) derived survey attention for staff:
--      lib/surveys/coverage-escalation.ts   coverage escalation: unassigned
--        after a grace period (2 days), an open owner task idle 3 days, an
--        in-progress task idle 7 days, review hand-off once results reach
--        the privacy floor; urgent / elevated / monitor levels;
--      app/dashboard/surveys/survey-layer.ts:636-700   low-response follow-up
--        at or below survey_followup_low_response_threshold (3; 0 turns it
--        off), with a reminder cadence of 1 day before a first response and
--        3 days after;
--      supabase/migrations/0515, 0520   the thresholds as settings.
--    Today escalation_state = 'escalated' exists only in a CHECK, reminders
--    are a manual button, and the response_review / closeout task reasons are
--    never generated. private.survey_operations_state() now computes the same
--    attention for one survey from organization limits;
--    public.get_survey_operations_attention() shows it to staff, and the
--    hourly private.run_survey_operations_sweep() turns it into work:
--      response_review task once a survey reaches its privacy floor,
--      closeout task once a survey is closed or past its close time,
--      low_response task once the first-response window has passed with
--        responses at or below the threshold,
--      coverage_escalation task for an elevated or urgent escalation,
--      delivery escalation_state reminder_due on the cadence, then escalated
--        when a due reminder is still unanswered after the progress window.
--    A task staff already completed or dismissed is never reopened (the old
--    "never escalate it back open" rule). Switch
--    features.engagement_voice.survey_follow_up_automation (default ON; the
--    old app always derived these). Scheduled reminder SENDING is new: the old
--    app scheduled reminders for staff to send and never sent them itself.
--    (2026-10-01) sets
--    features.engagement_voice.survey_scheduled_reminders to default ON, so
--    the sweep queues the reminder for every due recipient through the same
--    outbox the manual button uses; an admin can turn it off.
--
-- 2. Survey report exports. Real organizations could download only JSON; CSV,
--    XLSX and a date filter existed only in the SAMPLE studio. The old results
--    page (app/dashboard/surveys/[id]/results/results-client.tsx:38-89,
--    306-360) exported CSV and XLSX for an optional submitted-date range and
--    refused any view, filtered or not, below the privacy threshold.
--    public.get_organization_survey_report_window() and
--    public.export_organization_survey_window() take that range; the privacy
--    floor applies to the responses INSIDE the range, so narrowing a date
--    window can never expose a group smaller than the floor: the report is
--    withheld and the export refused (22023 'privacy floor not met'). The
--    files are built in the browser from these rows. Switch
--    features.engagement_voice.survey_report_exports (default ON).
--
-- 3. Filtered organization exports gain 'xlsx'. The server returns the same
--    bounded rows; the browser writes the workbook. Switch
--    features.analytics.filtered_export_xlsx (default ON, the old export
--    family offered CSV and XLSX: app/api/export/xlsx/route.ts).
--
-- Boundaries kept: staff authorization and the selected organization on every
-- read; the 10000-row bound, 30-per-hour request bound, idempotency and
-- receipts of the filtered export are unchanged; every writer takes the
-- case-graph entry lock first; the sweep is private and revoked from every
-- client role. Production stays empty: the only rows written are platform
-- setting definitions.

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old app derived escalations and follow-ups on every survey page load
  -- (coverage-escalation.ts, survey-layer.ts:636): no flag => ON.
  ('features.engagement_voice.survey_follow_up_automation', 'boolean', 'Survey follow-up automation',
   'Hourly check that opens review, closeout, low-response and coverage-escalation tasks for surveys and marks reminders due.',
   'true', null, null, null, 40, 'engagement_voice', false),
  -- New behavior: the old app never sent reminders by itself; default ON by
  -- (2026-10-01).
  ('features.engagement_voice.survey_scheduled_reminders', 'boolean', 'Send survey reminders on schedule',
   'Automatically queue the survey reminder to members whose reminder is due, instead of waiting for staff to press Remind.',
   'true', null, null, null, 50, 'engagement_voice', false),
  -- 0515_survey_followup_low_response_setting.sql / 0520: '3'.
  ('limits.engagement_voice.survey_low_response_threshold', 'integer', 'Low-response follow-up threshold',
   'Open surveys at or below this many responses get a low-response follow-up task. 0 turns low-response follow-up off.',
   '3', 0, 1000, null, 60, 'engagement_voice', false),
  -- 0520 survey_coverage_escalation_uncovered_grace_days '2'.
  ('limits.engagement_voice.survey_coverage_uncovered_grace_days', 'integer', 'Unowned survey grace (days)',
   'Days before an open survey with no owner is escalated.', '2', 0, 90, null, 70, 'engagement_voice', false),
  -- 0520 survey_coverage_escalation_open_stale_days '3'.
  ('limits.engagement_voice.survey_coverage_open_stale_days', 'integer', 'Idle open survey task (days)',
   'Days an owner''s open survey task may sit unchanged before it is escalated.', '3', 1, 90, null, 80, 'engagement_voice', false),
  -- 0520 survey_coverage_escalation_progress_stale_days '7'.
  ('limits.engagement_voice.survey_coverage_progress_stale_days', 'integer', 'Idle in-progress survey task (days)',
   'Days an in-progress survey task or a due reminder may sit before it is escalated.', '7', 1, 90, null, 90, 'engagement_voice', false),
  -- survey-layer.ts:667 FIRST_RESPONSE_REMINDER_DAYS = 1.
  ('limits.engagement_voice.survey_first_reminder_days', 'integer', 'First reminder after (days)',
   'Days after distribution before a survey with no responses is due a reminder.', '1', 0, 30, null, 100, 'engagement_voice', false),
  -- survey-layer.ts:668 LOW_RESPONSE_REMINDER_DAYS = 3.
  ('limits.engagement_voice.survey_reminder_interval_days', 'integer', 'Low-response reminder after (days)',
   'Days after distribution before a survey that has some responses is due a reminder.', '3', 1, 30, null, 110, 'engagement_voice', false),
  -- results-client.tsx:306-360 exported CSV and XLSX with a date filter: no flag => ON.
  ('features.engagement_voice.survey_report_exports', 'boolean', 'Survey CSV and XLSX exports',
   'Staff can download survey reports and responses as CSV or XLSX for a date range. The privacy floor applies inside the range.',
   'true', null, null, null, 120, 'engagement_voice', true),
  -- app/api/export/xlsx/route.ts: the export family offered XLSX: no flag => ON.
  ('features.analytics.filtered_export_xlsx', 'boolean', 'XLSX organization exports',
   'Administrators can download filtered organization exports as XLSX workbooks as well as CSV and JSON.',
   'true', null, null, null, 50, 'analytics', true)
on conflict (key) do nothing;

alter table public.organization_survey_tasks
  drop constraint organization_survey_tasks_reason_check;
alter table public.organization_survey_tasks
  add constraint organization_survey_tasks_reason_check check (reason in (
    'readiness', 'distribution', 'response_review', 'closeout', 'low_response', 'coverage_escalation'
  ));

create index if not exists organization_surveys_operations_sweep_idx
  on public.organization_surveys (status, updated_at)
  where status in ('open', 'closed');

-- ---------------------------------------------------------------------------
-- Derived survey attention (one survey)
-- ---------------------------------------------------------------------------

create function private.survey_operations_state(p_survey_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  survey public.organization_surveys%rowtype;
  responses integer;
  started_at timestamptz;
  age_days double precision;
  review_ready boolean;
  low_threshold integer;
  grace_days integer;
  open_stale integer;
  progress_stale integer;
  first_days integer;
  interval_days integer;
  owner_task public.organization_survey_tasks%rowtype;
  owner_status text;
  owner_idle_days double precision;
  escalation_reason text;
  escalation_level text;
  escalation_action text;
  low_state text;
  reminder_days integer;
  reminder_due_at timestamptz;
begin
  select * into survey from public.organization_surveys where id = p_survey_id;
  if not found then return null; end if;
  low_threshold := private.organization_limit(survey.organization_id, 'limits.engagement_voice.survey_low_response_threshold');
  grace_days := private.organization_limit(survey.organization_id, 'limits.engagement_voice.survey_coverage_uncovered_grace_days');
  open_stale := private.organization_limit(survey.organization_id, 'limits.engagement_voice.survey_coverage_open_stale_days');
  progress_stale := private.organization_limit(survey.organization_id, 'limits.engagement_voice.survey_coverage_progress_stale_days');
  first_days := private.organization_limit(survey.organization_id, 'limits.engagement_voice.survey_first_reminder_days');
  interval_days := private.organization_limit(survey.organization_id, 'limits.engagement_voice.survey_reminder_interval_days');

  select pg_catalog.count(*)::integer into responses
  from public.organization_survey_sessions session
  where session.survey_id = survey.id and session.organization_id = survey.organization_id
    and session.status = 'submitted';
  select coalesce(survey.opens_at, pg_catalog.min(delivery.created_at), survey.created_at) into started_at
  from public.organization_survey_deliveries delivery
  where delivery.survey_id = survey.id;
  age_days := greatest(0, extract(epoch from pg_catalog.now() - started_at) / 86400.0);
  review_ready := responses >= survey.privacy_min_responses;

  -- The coverage owner task is the distribution task, else the readiness task.
  select * into owner_task from public.organization_survey_tasks task
  where task.survey_id = survey.id and task.reason in ('distribution', 'readiness')
  order by case task.reason when 'distribution' then 0 else 1 end
  limit 1;
  owner_status := case
    when survey.owner_user_id is null or owner_task.id is null then 'missing'
    when owner_task.status in ('done', 'dismissed') then 'done'
    else owner_task.status
  end;
  owner_idle_days := case when owner_task.id is null then null
    else greatest(0, extract(epoch from pg_catalog.now() - owner_task.updated_at) / 86400.0) end;

  if survey.status = 'open' and owner_status <> 'done' then
    if owner_status = 'missing' then
      if review_ready or age_days >= grace_days then
        escalation_reason := 'coverage_unassigned';
        escalation_level := case when review_ready then 'urgent' else 'elevated' end;
        escalation_action := 'claim_coverage';
      end if;
    elsif owner_status = 'open' then
      if owner_idle_days >= open_stale then
        escalation_reason := 'coverage_open_stale';
        escalation_level := case when review_ready then 'urgent' else 'elevated' end;
        escalation_action := 'open_task';
      elsif review_ready then
        escalation_reason := 'review_handoff_overdue';
        escalation_level := 'elevated';
        escalation_action := 'review_results';
      end if;
    else
      if owner_idle_days >= progress_stale then
        escalation_reason := 'coverage_stalled';
        escalation_level := case when review_ready then 'elevated' else 'monitor' end;
        escalation_action := 'open_task';
      elsif review_ready then
        escalation_reason := 'review_handoff_overdue';
        escalation_level := 'monitor';
        escalation_action := 'review_results';
      end if;
    end if;
  end if;

  if survey.status = 'open' and low_threshold > 0 and responses <= low_threshold then
    low_state := case when responses = 0 then 'no_responses' else 'below_threshold' end;
  end if;
  reminder_days := case when responses = 0 then first_days else interval_days end;
  reminder_due_at := started_at + pg_catalog.make_interval(days => reminder_days);

  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'organizationId', survey.organization_id,
    'status', survey.status,
    'ownerUserId', survey.owner_user_id,
    'reviewReady', review_ready,
    'ageDays', pg_catalog.floor(age_days)::integer,
    'closeoutDue', survey.status = 'closed'
      or (survey.status = 'open' and survey.closes_at is not null and survey.closes_at <= pg_catalog.now()),
    'escalation', case when escalation_reason is null then null else pg_catalog.jsonb_build_object(
      'level', escalation_level, 'reason', escalation_reason, 'recommendedAction', escalation_action,
      'ownerStatus', owner_status,
      'thresholdDays', case escalation_reason
        when 'coverage_unassigned' then grace_days
        when 'coverage_open_stale' then open_stale
        when 'coverage_stalled' then progress_stale
        else null end
    ) end,
    'lowResponse', case when low_state is null then null else pg_catalog.jsonb_build_object(
      'state', low_state, 'threshold', low_threshold,
      'due', age_days >= first_days
    ) end,
    'reminder', case when survey.status <> 'open' then null else pg_catalog.jsonb_build_object(
      'dueAt', reminder_due_at,
      'due', reminder_due_at <= pg_catalog.now(),
      'cadenceDays', reminder_days,
      'scheduledSending', private.organization_feature_enabled(survey.organization_id, 'features.engagement_voice.survey_scheduled_reminders')
    ) end,
    'progressStaleDays', progress_stale
  );
end;
$function$;

revoke all on function private.survey_operations_state(uuid)
  from public, anon, authenticated, service_role;

create function public.get_survey_operations_attention()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
begin
  perform private.engagement_require_staff(org);
  return pg_catalog.jsonb_build_object(
    'automation', private.organization_feature_enabled(org, 'features.engagement_voice.survey_follow_up_automation'),
    'scheduledReminders', private.organization_feature_enabled(org, 'features.engagement_voice.survey_scheduled_reminders'),
    'exports', private.organization_feature_enabled(org, 'features.engagement_voice.survey_report_exports'),
    'surveys', coalesce((
      select pg_catalog.jsonb_agg(state.value - 'organizationId' - 'ownerUserId' - 'ageDays' order by survey.updated_at desc, survey.id)
      from public.organization_surveys survey
      cross join lateral (select private.survey_operations_state(survey.id) as value) state
      where survey.organization_id = org and survey.status in ('open', 'closed')
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_survey_operations_attention() from public, anon, authenticated, service_role;
grant execute on function public.get_survey_operations_attention() to authenticated;

-- ---------------------------------------------------------------------------
-- Hourly sweep
-- ---------------------------------------------------------------------------

create function private.open_survey_follow_up_task(
  p_survey public.organization_surveys,
  p_reason text,
  p_due_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  created_id uuid;
  actor uuid := coalesce(p_survey.owner_user_id, p_survey.created_by);
begin
  insert into public.organization_survey_tasks (
    organization_id, survey_id, reason, status, assigned_to, due_at, created_by
  ) values (
    p_survey.organization_id, p_survey.id, p_reason, 'open', p_survey.owner_user_id, p_due_at, null
  )
  on conflict (survey_id, reason) do nothing
  returning id into created_id;
  if created_id is null then return false; end if;
  if actor is not null then
    insert into public.organization_audit_events (
      organization_id, event_type, actor_user_id, idempotency_key, metadata
    ) values (
      p_survey.organization_id, 'survey_task_updated', actor, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', p_survey.organization_id, 'surveyId', p_survey.id, 'taskId', created_id,
        'status', 'open', 'reason', p_reason, 'reasonCode', 'scheduled'
      )
    );
  end if;
  return true;
end;
end;
$function$;

revoke all on function private.open_survey_follow_up_task(public.organization_surveys, text, timestamptz)
  from public, anon, authenticated, service_role;

create function private.run_survey_operations_sweep(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  cap integer := coalesce(p_limit, 100);
  survey public.organization_surveys%rowtype;
  attention jsonb;
  created integer := 0;
  marked integer := 0;
  escalated integer := 0;
  reminders integer := 0;
  step integer;
  actor uuid;
begin
  if cap not between 1 and 500 then
    raise exception 'invalid survey sweep limit' using errcode = '22023';
  end if;
  for survey in
    select candidate.*
    from public.organization_surveys candidate
    where candidate.status = 'open'
       or (candidate.status = 'closed' and candidate.operations_state <> 'complete')
    order by candidate.updated_at, candidate.id
    for update skip locked
    limit cap
  loop
    if not private.organization_feature_enabled(survey.organization_id, 'features.engagement_voice.survey_follow_up_automation') then
      continue;
    end if;
    attention := private.survey_operations_state(survey.id);

    if (attention ->> 'reviewReady')::boolean then
      if private.open_survey_follow_up_task(survey, 'response_review', null) then created := created + 1; end if;
    end if;
    if (attention ->> 'closeoutDue')::boolean then
      if private.open_survey_follow_up_task(survey, 'closeout', null) then created := created + 1; end if;
    end if;
    if (attention #>> '{lowResponse,due}')::boolean then
      if private.open_survey_follow_up_task(survey, 'low_response', null) then created := created + 1; end if;
    end if;
    if attention #>> '{escalation,level}' in ('elevated', 'urgent') then
      if private.open_survey_follow_up_task(survey, 'coverage_escalation', pg_catalog.now()) then created := created + 1; end if;
    end if;

    if survey.status = 'open' then
      -- Reminder cadence: unanswered deliveries become reminder_due once the
      -- survey's reminder date passes, then escalated when a due reminder is
      -- still unanswered after the progress window.
      if (attention #>> '{reminder,due}')::boolean then
        update public.organization_survey_deliveries delivery
        set escalation_state = 'reminder_due', updated_at = pg_catalog.now()
        where delivery.survey_id = survey.id and delivery.engaged_at is null
          and delivery.state in ('queued', 'sent', 'failed') and delivery.escalation_state = 'none';
        get diagnostics step = row_count;
        marked := marked + step;
      end if;
      update public.organization_survey_deliveries delivery
      set escalation_state = 'escalated', updated_at = pg_catalog.now()
      where delivery.survey_id = survey.id and delivery.engaged_at is null
        and delivery.escalation_state = 'reminder_due'
        and delivery.updated_at <= pg_catalog.now() - pg_catalog.make_interval(days => (attention ->> 'progressStaleDays')::integer);
      get diagnostics step = row_count;
      escalated := escalated + step;

      if private.organization_feature_enabled(survey.organization_id, 'features.engagement_voice.survey_scheduled_reminders') then
        with candidates as (
          select delivery.recipient_user_id
          from public.organization_survey_deliveries delivery
          where delivery.survey_id = survey.id and delivery.engaged_at is null
            and delivery.state in ('queued', 'sent', 'failed')
            and delivery.escalation_state in ('reminder_due', 'escalated')
            -- Same producer-side opt-out as the manual Remind button
            -- (20261002021000); the lease-time payload check stays the backstop.
            and not private.engagement_email_opted_out(delivery.recipient_user_id, 'survey_reminder')
            and not exists (
              select 1 from public.engagement_delivery_outbox outbox
              where outbox.delivery_kind = 'survey_reminder' and outbox.source_id = survey.id::text
                and outbox.recipient_user_id = delivery.recipient_user_id
            )
        ), inserted as (
          insert into public.engagement_delivery_outbox (
            organization_id, recipient_user_id, delivery_kind, source_kind, source_id
          )
          select survey.organization_id, candidates.recipient_user_id, 'survey_reminder', 'survey', survey.id::text
          from candidates
          on conflict (delivery_kind, source_id, recipient_user_id) do nothing
          returning recipient_user_id
        )
        select pg_catalog.count(*)::integer into step from inserted;
        if step > 0 then
          reminders := reminders + step;
          actor := coalesce(survey.owner_user_id, survey.created_by);
          if actor is not null then
            insert into public.organization_audit_events (
              organization_id, event_type, actor_user_id, idempotency_key, metadata
            ) values (
              survey.organization_id, 'survey_reminders_queued', actor, extensions.gen_random_uuid(),
              pg_catalog.jsonb_build_object(
                'organizationId', survey.organization_id, 'surveyId', survey.id,
                'userId', actor, 'count', step, 'reasonCode', 'scheduled'
              )
            );
          end if;
        end if;
      end if;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'tasksCreated', created, 'remindersDue', marked, 'escalated', escalated, 'remindersQueued', reminders
  );
end;
end;
$function$;

revoke all on function private.run_survey_operations_sweep(integer)
  from public, anon, authenticated, service_role;

comment on function private.run_survey_operations_sweep(integer) is
  'Hourly pg_cron target (CR-006/CR-007): opens response_review, closeout, low_response and coverage_escalation tasks (never reopening a completed one), marks survey deliveries reminder_due on the cadence and escalated after the progress window, and queues due reminders when features.engagement_voice.survey_scheduled_reminders is on.';

do $scheduler$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'survey-operations-sweep';
    perform cron.schedule(
      'survey-operations-sweep',
      '41 * * * *',
      $job$select private.run_survey_operations_sweep(100);$job$
    );
  end if;
end;
$scheduler$;

-- ---------------------------------------------------------------------------
-- Survey report and export for a submitted-date window
-- ---------------------------------------------------------------------------

create function private.survey_window_sessions(
  p_organization_id uuid,
  p_survey_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select session.id
  from public.organization_survey_sessions session
  where session.organization_id = p_organization_id
    and session.survey_id = p_survey_id
    and session.status = 'submitted'
    and (p_from is null or session.submitted_at >= p_from)
    and (p_to is null or session.submitted_at <= p_to)
$function$;

revoke all on function private.survey_window_sessions(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

create function public.get_organization_survey_report_window(
  p_survey_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  responses integer;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_feature_enabled(org, 'features.engagement_voice.survey_report_exports') then
    raise exception 'survey report exports are turned off' using errcode = '55000';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'invalid report window' using errcode = '22023';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select pg_catalog.count(*)::integer into responses
  from private.survey_window_sessions(org, survey.id, p_from, p_to);
  -- The privacy floor applies to the responses inside the window: a narrow
  -- window can never release a group smaller than the floor.
  if responses < survey.privacy_min_responses then
    return pg_catalog.jsonb_build_object(
      'surveyId', survey.id, 'title', survey.title,
      'from', p_from, 'to', p_to,
      'responseCount', responses,
      'privacyMinResponses', survey.privacy_min_responses,
      'available', false,
      'questions', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'title', survey.title,
    'from', p_from, 'to', p_to,
    'responseCount', responses,
    'privacyMinResponses', survey.privacy_min_responses,
    'available', true,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', question.id,
        'label', question.label,
        'type', question.question_type,
        'answered', (
          select pg_catalog.count(*)
          from public.organization_survey_answers answer
          where answer.question_id = question.id
            and answer.session_id in (select private.survey_window_sessions(org, survey.id, p_from, p_to))
        ),
        'distribution', case
          when question.question_type in ('radio', 'dropdown', 'yes_no', 'scale', 'rating') then (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
            from (
              select answer.value, pg_catalog.count(*)::integer as count
              from public.organization_survey_answers answer
              where answer.question_id = question.id
                and answer.session_id in (select private.survey_window_sessions(org, survey.id, p_from, p_to))
              group by answer.value
            ) bucket
          )
          else '[]'::jsonb
        end
      ) order by question.sort_index)
      from public.organization_survey_questions question
      where question.survey_id = survey.id and question.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_organization_survey_report_window(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.get_organization_survey_report_window(uuid, timestamptz, timestamptz)
  to authenticated;

create function public.export_organization_survey_window(
  p_survey_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_format text default 'csv'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  report jsonb;
  responses jsonb;
begin
  perform private.engagement_require_staff(org);
  if p_format is null or p_format not in ('csv', 'xlsx', 'json') then
    raise exception 'invalid export format' using errcode = '22023';
  end if;
  report := public.get_organization_survey_report_window(p_survey_id, p_from, p_to);
  if not coalesce((report ->> 'available')::boolean, false) then
    raise exception 'privacy floor not met' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'responseId', session.id,
    'submittedAt', session.submitted_at,
    'answers', coalesce((
      select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
      from public.organization_survey_answers answer
      where answer.session_id = session.id and answer.organization_id = org
    ), '{}'::jsonb)
  ) order by session.submitted_at, session.id), '[]'::jsonb)
  into responses
  from public.organization_survey_sessions session
  where session.id in (select private.survey_window_sessions(org, p_survey_id, p_from, p_to));
  perform private.mi1_w2_write_audit(org, 'organization_export_completed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', p_survey_id, 'userId', (select auth.uid()),
    'exportType', 'survey', 'exportFormat', p_format,
    'rowCount', pg_catalog.jsonb_array_length(responses), 'status', 'completed'
  ));
  return report || pg_catalog.jsonb_build_object(
    'format', p_format,
    'generatedAt', pg_catalog.now(),
    'responses', responses
  );
end;
end;
$function$;

revoke all on function public.export_organization_survey_window(uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.export_organization_survey_window(uuid, timestamptz, timestamptz, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Filtered organization export: XLSX
-- ---------------------------------------------------------------------------

alter table public.organization_data_export_runs
  drop constraint organization_data_export_runs_format_check;
alter table public.organization_data_export_runs
  add constraint organization_data_export_runs_format_check check (format in ('csv', 'json', 'xlsx'));

create or replace function public.request_filtered_organization_export(p_domains text[], p_format text default 'csv'::text, p_from timestamp with time zone default null::timestamp with time zone, p_to timestamp with time zone default null::timestamp with time zone, p_idempotency_key uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  clean_domains text[];
  rows jsonb;
  total integer;
  receipt uuid;
  expires timestamptz := pg_catalog.now() + interval '15 minutes';
  prior public.organization_data_export_runs%rowtype;
  recent_requests integer;
begin
  select * into ctx from private.institutional_context(true);
  if not private.has_organization_role(ctx.organization_id, array['admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  delete from public.organization_data_export_runs
  where organization_id = ctx.organization_id and expires_at <= pg_catalog.now();
  select pg_catalog.array_agg(domain order by domain) into clean_domains
  from (
    select distinct pg_catalog.btrim(value) as domain
    from pg_catalog.unnest(coalesce(p_domains, '{}'::text[])) value
  ) selected
  where domain = any(array['members','cases','tasks','minutes','timeline','contacts']::text[]);
  if p_format not in ('csv','json','xlsx')
     or (p_format = 'xlsx' and not private.organization_feature_enabled(ctx.organization_id, 'features.analytics.filtered_export_xlsx'))
     or pg_catalog.cardinality(clean_domains) not between 1 and 6
     or pg_catalog.cardinality(clean_domains) <> pg_catalog.cardinality(p_domains)
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'invalid export request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('filtered-export:' || ctx.organization_id::text, 509)
  );
  if p_idempotency_key is not null then
    select * into prior from public.organization_data_export_runs r
    where r.organization_id = ctx.organization_id and r.requested_by = ctx.caller_id
      and r.idempotency_key = p_idempotency_key and r.expires_at > pg_catalog.now();
    if prior.id is not null and (
      prior.format <> p_format or prior.domains <> clean_domains
      or prior.filters <> pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to))
    ) then
      raise exception 'invalid export request' using errcode = '22023';
    end if;
  end if;
  if prior.id is null then
    select pg_catalog.count(*)::integer into recent_requests
    from public.organization_audit_events e
    where e.organization_id = ctx.organization_id
      and e.event_type = 'organization_export_completed'
      and e.metadata->>'exportType' = 'filtered'
      and e.created_at > pg_catalog.now() - interval '1 hour';
    -- 30 filtered export requests per organization per rolling hour.
    if recent_requests >= 30 then
      raise exception 'export request limit reached: 30 per hour' using errcode = '54000';
    end if;
  end if;

  with export_rows as (
    select 'members'::text as domain, p.created_at as occurred_at,
      pg_catalog.jsonb_build_object(
        'memberId', p.id, 'name', p.full_name, 'memberSince', p.member_since,
        'chapterId', membership.chapter_id
      ) as values
    from public.member_profiles p
    join lateral (
      select cm.chapter_id
      from public.member_chapter_memberships cm
      join public.chapters c on c.id = cm.chapter_id
      where cm.user_id = p.id and cm.status = 'active' and c.organization_id = ctx.organization_id
      order by cm.chapter_id
      limit 1
    ) membership on true
    where 'members' = any(clean_domains)
    union all
    select 'cases', c.updated_at,
      pg_catalog.jsonb_build_object(
        'caseId', c.id, 'reference', c.reference, 'title', c.title, 'type', c.case_type,
        'step', c.step, 'status', c.status, 'deadline', c.deadline, 'memberId', c.user_id,
        'chapterId', p.chapter_id
      )
    from public.member_cases c join public.member_profiles p on p.id = c.user_id
    join public.chapters ch on ch.id = p.chapter_id
    where 'cases' = any(clean_domains) and ch.organization_id = ctx.organization_id
    union all
    select 'tasks', t.updated_at,
      pg_catalog.jsonb_build_object(
        'taskId', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
        'workstream', t.workstream, 'dueDate', t.due_date, 'progress', t.progress,
        'blocked', t.blocked, 'chapterId', t.chapter_id
      )
    from public.chapter_tasks t join public.chapters ch on ch.id = t.chapter_id
    where 'tasks' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and t.deleted_at is null
    union all
    select 'minutes', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'title', r.title, 'occurredAt', r.occurred_at,
        'status', r.lifecycle_status, 'visibility', r.visibility, 'version', r.version,
        'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'minutes' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type = 'minutes' and r.archived_at is null
    union all
    select 'timeline', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'type', r.record_type, 'title', r.title, 'body', r.body,
        'occurredAt', r.occurred_at, 'status', r.lifecycle_status,
        'visibility', r.visibility, 'version', r.version, 'pinned', r.pinned_at is not null,
        'gapNote', r.gap_note, 'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'timeline' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type in ('decision','milestone') and r.archived_at is null
    union all
    select 'contacts', l.occurred_at,
      pg_catalog.jsonb_build_object(
        'contactId', l.id, 'kind', l.contact_kind, 'channel', l.channel,
        'purpose', l.purpose, 'summary', l.summary, 'outcome', l.outcome,
        'occurredAt', l.occurred_at, 'followUpAt', l.follow_up_at,
        'subjectMemberId', l.subject_user_id, 'caseId', l.case_id, 'taskId', l.task_id,
        'chapterId', l.chapter_id
      )
    from public.chapter_contact_log l
    where 'contacts' = any(clean_domains) and l.organization_id = ctx.organization_id and l.archived_at is null
  ), bounded as (
    select * from export_rows
    where (p_from is null or occurred_at >= p_from)
      and (p_to is null or occurred_at <= p_to)
    order by occurred_at desc, domain, values::text
    limit 10001
  )
  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('domain', domain, 'occurredAt', occurred_at, 'values', values) order by occurred_at desc, domain), '[]'::jsonb)
  into total, rows from bounded;

  if total > 10000 then
    raise exception 'export exceeds 10000 rows; narrow the date range or domains' using errcode = '54000';
  end if;

  if prior.id is not null then
    receipt := prior.id;
    expires := prior.expires_at;
  else
  insert into public.organization_data_export_runs (
    organization_id, requested_by, format, domains, filters, row_count, expires_at, idempotency_key
  ) values (
    ctx.organization_id, ctx.caller_id, p_format, clean_domains,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to)),
    total, expires, p_idempotency_key
  ) returning id into receipt;

  perform private.mi1_w2_write_audit(
    ctx.organization_id,
    'organization_export_completed',
    pg_catalog.jsonb_build_object(
      'exportType', 'filtered',
      'exportFormat', p_format,
      'rowCount', total,
      'status', 'completed'
    )
  );
  end if;

  return pg_catalog.jsonb_build_object(
    'receiptId', receipt, 'format', p_format, 'domains', clean_domains,
    'rowCount', total, 'expiresAt', expires, 'rows', rows
  );
end;
end;
$function$;

-- Monitoring: survey-operations-sweep joins the four copies of the monitored
-- set (the job-name CHECK, the mirror's jobname allow-list, the
-- list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js). The three database copies are
-- re-emitted from 20260930040000 with live-poll-schedule-tick (scheduled by
-- 20261002101000, which re-emitted them first) and this name added, so
-- neither job drops out of monitoring.

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
    'live-poll-schedule-tick',
    'survey-operations-sweep',
    'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
    'mi1-analytics-receipt-retention',
    'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
    'notifications-expiry-sweep',
    'organization-claim-retention',
    'organization-automation-tick',
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
    'live-poll-schedule-tick',
    'survey-operations-sweep',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep',
      'organization-claim-retention',
      'organization-automation-tick',
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
    'live-poll-schedule-tick',
    'survey-operations-sweep',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep',
      'organization-claim-retention',
      'organization-automation-tick',
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
