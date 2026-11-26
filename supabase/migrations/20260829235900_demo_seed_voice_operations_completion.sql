-- Ordered after the 20260829044000 knowledge activation merged on Main.
-- SAMPLE-only Voice operating evidence for CR-001/002/006/007/008.
--
-- The member-engagement schema is already installed. This additive phase
-- promotes the five stale catalog gates and composes deterministic quarterly,
-- task, delivery, and review rows into the existing guarded SAMPLE wrappers.
-- It does not run during migration, create identity/tenant data, or enqueue
-- outbound delivery.

set local lock_timeout = '5s';

update private.demo_seed_function_catalog catalog
set coverage = 'seeded',
    evidence_key = evidence.evidence_key,
    gate_relation = null
from (values
  ('CR-001', 'voice-quarterly-surveys'),
  ('CR-002', 'voice-quarterly-completion-gate'),
  ('CR-006', 'voice-survey-ownership-tasks'),
  ('CR-007', 'voice-survey-distribution-operations'),
  ('CR-008', 'voice-survey-response-review-lanes')
) as evidence(function_id, evidence_key)
where catalog.function_id = evidence.function_id;

-- CR-096 remains an open end-to-end product gap, but its backend relation
-- landed before the parity catalog. Relation existence therefore cannot be
-- used as an absent-schema tripwire for unrelated SAMPLE seed runs. Keep the
-- record unseeded and gated while removing only the stale tripwire.
update private.demo_seed_function_catalog
set gate_relation = null
where function_id = 'CR-096'
  and coverage = 'schema-not-yet-landed'
  and evidence_key is null;

-- The shared page recorder rebuilds its evidence set after Voice rows are
-- seeded. Refresh the Voice-owned surface after that bulk insert so its
-- measured current-week depth survives the rebuild and participates in the
-- same two-page covenant as every older surface.
create function private.demo_seed_refresh_voice_page_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
  v_chapter_id text;
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;

  for seeded_run in
    select distinct evidence.lane, evidence.run_id
    from inserted_voice_page_evidence evidence
  loop
    v_chapter_id := private.demo_seed_chapter(seeded_run.lane, seeded_run.run_id, 1);
    insert into private.demo_seed_page_evidence (
      lane, run_id, surface, actual_rows
    ) values (
      seeded_run.lane,
      seeded_run.run_id,
      'memberWeeklyQuestions',
      (select pg_catalog.count(*)
       from public.member_weekly_questions weekly
       where weekly.chapter_id = v_chapter_id
         and weekly.week_start = pg_catalog.date_trunc(
           'week', pg_catalog.now() at time zone 'UTC'
         )::date
         and weekly.editorial_state in ('submitted', 'reserved', 'published'))
    )
    on conflict (lane, run_id, surface) do update
      set actual_rows = excluded.actual_rows,
          recorded_at = pg_catalog.now();
  end loop;
  return null;
end;
$function$;

create trigger demo_seed_refresh_voice_page_evidence
after insert on private.demo_seed_page_evidence
referencing new table as inserted_voice_page_evidence
for each statement execute function private.demo_seed_refresh_voice_page_evidence();

create function private.demo_seed_voice_operations_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_organization_id uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  v_current_period text := pg_catalog.to_char(current_date, 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', current_date)::integer;
  v_quarterly_count bigint;
  v_current_quarter_count bigint;
  v_current_responses bigint;
  v_prior_responses bigint;
  v_incomplete_examples bigint;
  v_owner_count bigint;
  v_task_count bigint;
  v_task_reason_count bigint;
  v_task_state_count bigint;
  v_delivery_count bigint;
  v_delivery_state_count bigint;
  v_review_count bigint;
  v_review_state_count bigint;
  v_outbound_count bigint;
begin
  if p_lane not in ('presg', 'uniondemo') then
    raise exception 'unknown demo lane';
  end if;

  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where survey.period_key = v_current_period),
         pg_catalog.count(*) filter (where survey.owner_user_id is not null)
  into v_quarterly_count, v_current_quarter_count, v_owner_count
  from public.organization_surveys survey
  where survey.organization_id = v_organization_id
    and survey.id in (
      private.member_stress_uuid(p_run_id::text || ':voice:survey:1'),
      private.member_stress_uuid(p_run_id::text || ':voice:survey:2')
    )
    and survey.cadence = 'quarterly';

  select pg_catalog.count(*) into v_current_responses
  from public.organization_survey_sessions session
  where session.survey_id = private.member_stress_uuid(p_run_id::text || ':voice:survey:1')
    and session.status = 'submitted';

  select pg_catalog.count(*) into v_prior_responses
  from public.organization_survey_sessions session
  where session.survey_id = private.member_stress_uuid(p_run_id::text || ':voice:survey:2')
    and session.status = 'submitted';

  select pg_catalog.count(*) into v_incomplete_examples
  from public.organization_surveys survey
  where survey.id = private.member_stress_uuid(p_run_id::text || ':voice:survey:1')
    and not exists (
      select 1
      from public.organization_survey_sessions session
      where session.survey_id = survey.id
        and session.respondent_user_id = private.demo_seed_user(p_lane, p_run_id, 2)
        and session.status = 'submitted'
    );

  select pg_catalog.count(*),
         pg_catalog.count(distinct task.reason),
         pg_catalog.count(distinct task.status)
  into v_task_count, v_task_reason_count, v_task_state_count
  from public.organization_survey_tasks task
  where task.organization_id = v_organization_id
    and task.survey_id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 16) series(n)
    );

  select pg_catalog.count(*), pg_catalog.count(distinct delivery.state)
  into v_delivery_count, v_delivery_state_count
  from public.organization_survey_deliveries delivery
  where delivery.organization_id = v_organization_id
    and delivery.survey_id in (
      private.member_stress_uuid(p_run_id::text || ':voice:survey:2'),
      private.member_stress_uuid(p_run_id::text || ':voice:survey:3')
    );

  select pg_catalog.count(*), pg_catalog.count(distinct review.state)
  into v_review_count, v_review_state_count
  from public.organization_survey_reviews review
  where review.organization_id = v_organization_id
    and review.session_id in (
      select private.member_stress_uuid(
        p_run_id::text || ':voice:survey:'
          || case when series.n <= 3 then '1' else '2' end
          || ':session:'
          || case when series.n <= 3 then series.n else series.n - 3 end
      )
      from pg_catalog.generate_series(1, 9) series(n)
    );

  select pg_catalog.count(*) into v_outbound_count
  from public.engagement_delivery_outbox outbound
  where outbound.organization_id = v_organization_id
    and outbound.source_kind = 'survey'
    and outbound.source_id in (
      select private.member_stress_uuid(
        p_run_id::text || ':voice:survey:' || series.n
      )::text
      from pg_catalog.generate_series(1, 16) series(n)
    );

  return pg_catalog.jsonb_build_object(
    'ok', v_quarterly_count = 2
      and v_current_quarter_count = 1
      and v_current_responses = 3
      and v_prior_responses = 6
      and v_incomplete_examples = 1
      and v_owner_count = 2
      and v_task_count = 16
      and v_task_reason_count = 4
      and v_task_state_count = 4
      and v_delivery_count = 24
      and v_delivery_state_count = 6
      and v_review_count = 9
      and v_review_state_count = 5
      and v_outbound_count = 0,
    'quarterlySurveys', v_quarterly_count,
    'currentQuarterSurveys', v_current_quarter_count,
    'currentQuarterResponses', v_current_responses,
    'priorQuarterResponses', v_prior_responses,
    'incompleteGateExamples', v_incomplete_examples,
    'ownedQuarterlySurveys', v_owner_count,
    'surveyTasks', v_task_count,
    'taskReasons', v_task_reason_count,
    'taskStates', v_task_state_count,
    'surveyDeliveries', v_delivery_count,
    'deliveryStates', v_delivery_state_count,
    'surveyReviews', v_review_count,
    'reviewStates', v_review_state_count,
    'outboundDeliveries', v_outbound_count
  );
end;
$function$;

create function private.demo_seed_apply_voice_operations(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $function$
declare
  v_organization_id uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  v_staff_user uuid := private.demo_seed_user(p_lane, p_run_id, 1);
  v_survey_id uuid;
  v_session_id uuid;
  v_state text;
  v_current_period text := pg_catalog.to_char(current_date, 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', current_date)::integer;
  v_prior_period text := pg_catalog.to_char(current_date - interval '3 months', 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', current_date - interval '3 months')::integer;
  i integer;
begin
  if p_lane not in ('presg', 'uniondemo') then
    raise exception 'unknown demo lane';
  end if;
  if not exists (
    select 1 from public.organizations organization
    where organization.id = v_organization_id and organization.status = 'active'
  ) then
    raise exception 'demo organization is missing';
  end if;
  if not exists (
    select 1 from public.organization_surveys survey
    where survey.organization_id = v_organization_id
      and survey.id = private.member_stress_uuid(p_run_id::text || ':voice:survey:16')
  ) then
    raise exception 'Voice survey parity phase must run before Voice operations';
  end if;

  -- A SAMPLE staff persona can exercise the real distribution/reminder RPCs
  -- between reseeds. Those RPCs intentionally write the production outbox,
  -- but SAMPLE has no outbound dispatcher. Reset every run-owned survey key
  -- before rebuilding deterministic evidence so no queued residue survives or
  -- escapes the zero-egress status check.
  delete from public.engagement_delivery_outbox outbound
  where outbound.organization_id = v_organization_id
    and outbound.source_kind = 'survey'
    and outbound.source_id in (
      select private.member_stress_uuid(
        p_run_id::text || ':voice:survey:' || series.n
      )::text
      from pg_catalog.generate_series(1, 16) series(n)
    );

  update public.organization_surveys survey
  set cadence = 'quarterly',
      period_key = v_current_period,
      status = 'open',
      opens_at = current_date - interval '30 days',
      closes_at = current_date + interval '30 days',
      owner_user_id = v_staff_user,
      operations_state = 'reviewing',
      review_due_at = current_date + interval '37 days',
      updated_at = pg_catalog.now()
  where survey.organization_id = v_organization_id
    and survey.id = private.member_stress_uuid(p_run_id::text || ':voice:survey:1');

  update public.organization_surveys survey
  set cadence = 'quarterly',
      period_key = v_prior_period,
      status = 'closed',
      opens_at = current_date - interval '120 days',
      closes_at = current_date - interval '60 days',
      owner_user_id = v_staff_user,
      operations_state = 'complete',
      review_due_at = current_date - interval '53 days',
      updated_at = pg_catalog.now()
  where survey.organization_id = v_organization_id
    and survey.id = private.member_stress_uuid(p_run_id::text || ':voice:survey:2');

  for i in 1..16 loop
    v_survey_id := private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i);
    insert into public.organization_survey_tasks (
      id, organization_id, survey_id, reason, status,
      assigned_to, due_at, created_by, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':voice:task:' || i),
      v_organization_id,
      v_survey_id,
      (array['readiness', 'distribution', 'response_review', 'closeout'])[1 + ((i - 1) % 4)],
      (array['open', 'in_progress', 'done', 'dismissed'])[1 + ((i - 1) % 4)],
      v_staff_user,
      pg_catalog.now() + ((i + 3) || ' days')::interval,
      v_staff_user,
      pg_catalog.now() - ((20 - i) || ' days')::interval,
      pg_catalog.now() - ((16 - i) || ' hours')::interval
    )
    on conflict (survey_id, reason) do update set
      status = excluded.status,
      assigned_to = excluded.assigned_to,
      due_at = excluded.due_at,
      updated_at = excluded.updated_at;
  end loop;

  for i in 1..24 loop
    v_survey_id := private.member_stress_uuid(
      p_run_id::text || ':voice:survey:' || case when i <= 12 then 2 else 3 end
    );
    v_state := (array['queued', 'leased', 'sent', 'failed', 'engaged', 'suppressed'])[1 + ((i - 1) % 6)];
    insert into public.organization_survey_deliveries (
      id, organization_id, survey_id, recipient_user_id, state,
      attempt_count, last_attempt_at, sent_at, engaged_at,
      escalation_state, last_error_code, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':voice:delivery:' || i),
      v_organization_id,
      v_survey_id,
      private.demo_seed_user(p_lane, p_run_id, 10 + i),
      v_state,
      case when v_state in ('queued', 'suppressed') then 0 when v_state = 'failed' then 2 else 1 end,
      case when v_state in ('queued', 'suppressed') then null else pg_catalog.now() - (i || ' hours')::interval end,
      case when v_state in ('sent', 'engaged') then pg_catalog.now() - (i || ' hours')::interval else null end,
      case when v_state = 'engaged' then pg_catalog.now() - ((i - 1) || ' hours')::interval else null end,
      case when v_state = 'failed' then 'reminder_due' when v_state = 'engaged' then 'resolved' else 'none' end,
      case when v_state = 'failed' then 'sample-transient' else null end,
      pg_catalog.now() - ((30 - i) || ' days')::interval,
      pg_catalog.now() - (i || ' hours')::interval
    )
    on conflict (survey_id, recipient_user_id) do update set
      state = excluded.state,
      attempt_count = excluded.attempt_count,
      last_attempt_at = excluded.last_attempt_at,
      sent_at = excluded.sent_at,
      engaged_at = excluded.engaged_at,
      escalation_state = excluded.escalation_state,
      last_error_code = excluded.last_error_code,
      updated_at = excluded.updated_at;
  end loop;

  for i in 1..9 loop
    v_survey_id := private.member_stress_uuid(
      p_run_id::text || ':voice:survey:' || case when i <= 3 then 1 else 2 end
    );
    v_session_id := private.member_stress_uuid(
      p_run_id::text || ':voice:survey:' || case when i <= 3 then 1 else 2 end
        || ':session:' || case when i <= 3 then i else i - 3 end
    );
    v_state := (array['unreviewed', 'assigned', 'follow_up', 'resolved', 'dismissed'])[1 + ((i - 1) % 5)];
    insert into public.organization_survey_reviews (
      id, organization_id, survey_id, session_id, state, assigned_to,
      disposition, follow_up_due_at, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':voice:review:' || i),
      v_organization_id,
      v_survey_id,
      v_session_id,
      v_state,
      case when v_state = 'unreviewed' then null else v_staff_user end,
      case
        when v_state = 'follow_up' then 'Member requested a steward conversation.'
        when v_state = 'resolved' then 'Follow-up completed and documented.'
        when v_state = 'dismissed' then 'No staff action required after review.'
        else null
      end,
      case when v_state = 'follow_up' then pg_catalog.now() + interval '5 days' else null end,
      pg_catalog.now() - ((12 - i) || ' days')::interval,
      pg_catalog.now() - (i || ' hours')::interval
    )
    on conflict (session_id) do update set
      state = excluded.state,
      assigned_to = excluded.assigned_to,
      disposition = excluded.disposition,
      follow_up_due_at = excluded.follow_up_due_at,
      updated_at = excluded.updated_at;
  end loop;

  return private.demo_seed_voice_operations_status(p_lane, p_run_id);
end;
$function$;

-- Keep the persistent SAMPLE tour's quarterly gate aligned with the current
-- UTC quarter after the one-time deployment seed. The worker is inert unless
-- a function-parity evidence row proves that an authorized SAMPLE run is
-- installed, and it never creates identities, tenants, delivery rows, or
-- outbox work.
create function private.demo_seed_refresh_voice_quarterly_windows()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
  v_organization_id uuid;
  v_current_period text := pg_catalog.to_char(
    pg_catalog.now() at time zone 'UTC', 'YYYY'
  ) || '-Q' || pg_catalog.date_part(
    'quarter', pg_catalog.now() at time zone 'UTC'
  )::integer;
  v_prior_period text := pg_catalog.to_char(
    (pg_catalog.now() at time zone 'UTC') - interval '3 months', 'YYYY'
  ) || '-Q' || pg_catalog.date_part(
    'quarter', (pg_catalog.now() at time zone 'UTC') - interval '3 months'
  )::integer;
  v_refreshed integer := 0;
begin
  for seeded_run in
    select evidence.lane, evidence.run_id
    from private.demo_seed_function_evidence evidence
    where evidence.function_id = 'CR-001'
      and evidence.status = 'seeded'
      and evidence.lane in ('presg', 'uniondemo')
    group by evidence.lane, evidence.run_id
  loop
    v_organization_id := private.member_stress_uuid(
      seeded_run.run_id::text
        || case when seeded_run.lane = 'presg'
          then ':presg:organization' else ':ud:organization' end
    );

    -- Free the prior-period unique slot before advancing the current row. This
    -- also makes a clock rollback safe instead of relying on forward-only time.
    update public.organization_surveys survey
    set cadence = 'one_off',
        period_key = null,
        updated_at = pg_catalog.now()
    where survey.organization_id = v_organization_id
      and survey.id = private.member_stress_uuid(
        seeded_run.run_id::text || ':voice:survey:2'
      );

    update public.organization_surveys survey
    set cadence = 'quarterly',
        period_key = v_current_period,
        status = 'open',
        opens_at = pg_catalog.now() - interval '30 days',
        closes_at = pg_catalog.now() + interval '30 days',
        operations_state = 'reviewing',
        review_due_at = pg_catalog.now() + interval '37 days',
        updated_at = pg_catalog.now()
    where survey.organization_id = v_organization_id
      and survey.id = private.member_stress_uuid(
        seeded_run.run_id::text || ':voice:survey:1'
      );

    update public.organization_surveys survey
    set cadence = 'quarterly',
        period_key = v_prior_period,
        status = 'closed',
        opens_at = pg_catalog.now() - interval '120 days',
        closes_at = pg_catalog.now() - interval '60 days',
        operations_state = 'complete',
        review_due_at = pg_catalog.now() - interval '53 days',
        updated_at = pg_catalog.now()
    where survey.organization_id = v_organization_id
      and survey.id = private.member_stress_uuid(
        seeded_run.run_id::text || ':voice:survey:2'
      );

    v_refreshed := v_refreshed + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'refreshedRuns', v_refreshed,
    'currentPeriod', v_current_period,
    'priorPeriod', v_prior_period
  );
end;
$function$;

create function private.demo_seed_ensure_voice_operations_refresh()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if pg_catalog.to_regclass('cron.job') is null then
    return false;
  end if;

  perform cron.unschedule(job.jobid)
  from cron.job job
  where job.jobname = 'demo-seed-voice-quarterly-refresh';

  perform cron.schedule(
    'demo-seed-voice-quarterly-refresh',
    '19 6 * * *',
    $job$select private.demo_seed_refresh_voice_quarterly_windows();$job$
  );
  return true;
end;
$function$;

create function private.demo_seed_remove_voice_operations(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_organization_id uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
begin
  if p_lane not in ('presg', 'uniondemo') then
    raise exception 'unknown demo lane';
  end if;

  delete from public.engagement_delivery_outbox outbound
  where outbound.organization_id = v_organization_id
    and outbound.source_kind = 'survey'
    and outbound.source_id in (
      select private.member_stress_uuid(
        p_run_id::text || ':voice:survey:' || series.n
      )::text
      from pg_catalog.generate_series(1, 16) series(n)
    );

  delete from public.organization_survey_reviews review
  where review.organization_id = v_organization_id
    and review.session_id in (
      select private.member_stress_uuid(
        p_run_id::text || ':voice:survey:'
          || case when series.n <= 3 then '1' else '2' end
          || ':session:'
          || case when series.n <= 3 then series.n else series.n - 3 end
      )
      from pg_catalog.generate_series(1, 9) series(n)
    );

  delete from public.organization_survey_deliveries delivery
  where delivery.organization_id = v_organization_id
    and delivery.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:delivery:' || series.n)
      from pg_catalog.generate_series(1, 24) series(n)
    );

  delete from public.organization_survey_tasks task
  where task.organization_id = v_organization_id
    and task.survey_id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 16) series(n)
    );

  return pg_catalog.jsonb_build_object(
    'removed', true,
    'lane', p_lane,
    'runId', p_run_id,
    'voiceOperations', true
  );
end;
$function$;

create or replace function private.demo_seed_function_parity_status(p_lane text, p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'ok',
      (select pg_catalog.count(*) = 114
       from private.demo_seed_function_evidence
       where lane = p_lane and run_id = p_run_id)
      and not exists (
        select 1 from private.demo_seed_page_evidence evidence
        join private.demo_seed_page_contract contract on contract.surface = evidence.surface
          where evidence.lane = p_lane and evidence.run_id = p_run_id
            and evidence.actual_rows < contract.minimum_rows
      )
      and coalesce((private.demo_seed_voice_parity_status(p_lane, p_run_id) ->> 'ok')::boolean, false)
      and coalesce((private.demo_seed_voice_operations_status(p_lane, p_run_id) ->> 'ok')::boolean, false),
    'functions', (select pg_catalog.count(*)
      from private.demo_seed_function_evidence where lane = p_lane and run_id = p_run_id),
    'seededFunctions', (select pg_catalog.count(*)
      from private.demo_seed_function_evidence
      where lane = p_lane and run_id = p_run_id and status = 'seeded'),
    'schemaGates', (select pg_catalog.count(*)
      from private.demo_seed_function_evidence
      where lane = p_lane and run_id = p_run_id and status = 'schema-not-yet-landed'),
    'pageDepth', (select pg_catalog.jsonb_object_agg(
      evidence.surface,
      pg_catalog.jsonb_build_object(
        'actual', evidence.actual_rows,
        'minimum', contract.minimum_rows,
        'pageSize', contract.page_size,
        'ok', evidence.actual_rows >= contract.minimum_rows
      )
    )
      from private.demo_seed_page_evidence evidence
      join private.demo_seed_page_contract contract on contract.surface = evidence.surface
        where evidence.lane = p_lane and evidence.run_id = p_run_id),
    'voice', private.demo_seed_voice_parity_status(p_lane, p_run_id)
      || pg_catalog.jsonb_build_object(
        'operations', private.demo_seed_voice_operations_status(p_lane, p_run_id)
      )
  );
$function$;

create or replace function public.presg_demo_seed_function_parity(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  base_result jsonb;
  voice_result jsonb;
  operations_result jsonb;
  refresh_scheduled boolean;
begin
  auth_result := private.demo_seed_apply_auth_operations(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  voice_result := private.demo_seed_apply_voice_parity('presg', p_run_id);
  operations_result := private.demo_seed_apply_voice_operations('presg', p_run_id);
  base_result := private.demo_seed_apply_function_parity(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  if not coalesce((voice_result ->> 'ok')::boolean, false)
     or not coalesce((operations_result ->> 'ok')::boolean, false) then
    raise exception 'Voice survey parity verification failed: %',
      voice_result || pg_catalog.jsonb_build_object('operations', operations_result);
  end if;
  refresh_scheduled := private.demo_seed_ensure_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object(
    'ok', (base_result ->> 'ok')::boolean
      and (auth_result ->> 'ok')::boolean
      and (voice_result ->> 'ok')::boolean
      and (operations_result ->> 'ok')::boolean,
    'authOperations', auth_result,
    'voiceRefreshScheduled', refresh_scheduled,
    'voice', voice_result || pg_catalog.jsonb_build_object('operations', operations_result)
  );
end;
$function$;

create or replace function public.uniondemo_seed_function_parity(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  base_result jsonb;
  voice_result jsonb;
  operations_result jsonb;
  refresh_scheduled boolean;
begin
  auth_result := private.demo_seed_apply_auth_operations(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  voice_result := private.demo_seed_apply_voice_parity('uniondemo', p_run_id);
  operations_result := private.demo_seed_apply_voice_operations('uniondemo', p_run_id);
  base_result := private.demo_seed_apply_function_parity(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  if not coalesce((voice_result ->> 'ok')::boolean, false)
     or not coalesce((operations_result ->> 'ok')::boolean, false) then
    raise exception 'Voice survey parity verification failed: %',
      voice_result || pg_catalog.jsonb_build_object('operations', operations_result);
  end if;
  refresh_scheduled := private.demo_seed_ensure_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object(
    'ok', (base_result ->> 'ok')::boolean
      and (auth_result ->> 'ok')::boolean
      and (voice_result ->> 'ok')::boolean
      and (operations_result ->> 'ok')::boolean,
    'authOperations', auth_result,
    'voiceRefreshScheduled', refresh_scheduled,
    'voice', voice_result || pg_catalog.jsonb_build_object('operations', operations_result)
  );
end;
$function$;

create or replace function public.presg_demo_remove_function_parity(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operations_result jsonb;
  voice_result jsonb;
  base_result jsonb;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_auth_operations('presg', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('presg', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('presg', p_run_id);
  base_result := private.demo_seed_remove_function_parity('presg', p_run_id);
  return base_result || pg_catalog.jsonb_build_object(
    'voice', voice_result || pg_catalog.jsonb_build_object('operations', operations_result)
  );
end;
$function$;

create or replace function public.uniondemo_remove_function_parity(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operations_result jsonb;
  voice_result jsonb;
  base_result jsonb;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_auth_operations('uniondemo', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('uniondemo', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('uniondemo', p_run_id);
  base_result := private.demo_seed_remove_function_parity('uniondemo', p_run_id);
  return base_result || pg_catalog.jsonb_build_object(
    'voice', voice_result || pg_catalog.jsonb_build_object('operations', operations_result)
  );
end;
$function$;

revoke all on function private.demo_seed_apply_voice_operations(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_voice_operations_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_voice_operations(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_refresh_voice_page_evidence()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_refresh_voice_quarterly_windows()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_ensure_voice_operations_refresh()
  from public, anon, authenticated, service_role;

revoke all on function public.presg_demo_seed_function_parity(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.uniondemo_seed_function_parity(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.presg_demo_remove_function_parity(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.uniondemo_remove_function_parity(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.presg_demo_seed_function_parity(uuid, text, text)
  to service_role;
grant execute on function public.uniondemo_seed_function_parity(uuid, text, text)
  to service_role;
grant execute on function public.presg_demo_remove_function_parity(uuid, text, text)
  to service_role;
grant execute on function public.uniondemo_remove_function_parity(uuid, text, text)
  to service_role;
