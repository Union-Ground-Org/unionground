-- Forward-only repair for the already-deployed Voice operations migration.
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
create or replace function private.demo_seed_refresh_voice_page_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
  v_chapter_id text;
  v_organization_id uuid;
  v_knowledge_files bigint;
  v_knowledge_sources bigint;
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;

  for seeded_run in
    select distinct evidence.lane, evidence.run_id
    from inserted_voice_page_evidence evidence
  loop
    v_chapter_id := private.demo_seed_chapter(seeded_run.lane, seeded_run.run_id, 1);
    v_organization_id := private.member_stress_uuid(
      seeded_run.run_id::text
        || case when seeded_run.lane = 'presg'
          then ':presg:organization' else ':ud:organization' end
    );
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

    -- The knowledge activation runs before the aggregate parity wrapper, but
    -- that wrapper rebuilds the shared evidence table. Re-measure the three
    -- already-activated knowledge surfaces in the same statement trigger so
    -- composing this later Voice migration cannot erase Main's newer SAMPLE
    -- activation evidence.
    if exists (
      select 1
      from private.demo_seed_function_evidence evidence
      where evidence.lane = seeded_run.lane
        and evidence.run_id = seeded_run.run_id
        and evidence.function_id = 'CR-073'
        and evidence.status = 'seeded'
    ) then
      select pg_catalog.count(*) into v_knowledge_files
      from public.organization_knowledge_files file
      where file.organization_id = v_organization_id
        and file.review_status = 'approved'
        and file.scan_status = 'clean'
        and file.published_to_catalog
        and file.id in (
          select private.member_stress_uuid(
            seeded_run.run_id::text || ':knowledge:file:' || series.n
          ) from pg_catalog.generate_series(1, 200) series(n)
        );
      select pg_catalog.count(*) into v_knowledge_sources
      from public.organization_knowledge_sources source
      where source.organization_id = v_organization_id
        and source.chunk_count = 2
        and source.id in (
          select private.member_stress_uuid(
            seeded_run.run_id::text || ':knowledge:source:' || series.n
          ) from pg_catalog.generate_series(1, 200) series(n)
        );
      insert into private.demo_seed_page_evidence (
        lane, run_id, surface, actual_rows
      ) values
        (seeded_run.lane, seeded_run.run_id, 'knowledgeStewardLibrary', v_knowledge_files),
        (seeded_run.lane, seeded_run.run_id, 'knowledgeResourceCatalog', v_knowledge_files),
        (seeded_run.lane, seeded_run.run_id, 'knowledgeIngestSources', v_knowledge_sources)
      on conflict (lane, run_id, surface) do update
        set actual_rows = excluded.actual_rows,
            recorded_at = pg_catalog.now();
    end if;
  end loop;
  return null;
end;
$function$;

drop trigger if exists demo_seed_refresh_voice_page_evidence on private.demo_seed_page_evidence;
create trigger demo_seed_refresh_voice_page_evidence
after insert on private.demo_seed_page_evidence
referencing new table as inserted_voice_page_evidence
for each statement execute function private.demo_seed_refresh_voice_page_evidence();

create or replace function private.demo_seed_voice_operations_status(p_lane text, p_run_id uuid)
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
  v_current_period text := pg_catalog.to_char(
    pg_catalog.now() at time zone 'UTC', 'YYYY'
  ) || '-Q' || pg_catalog.date_part(
    'quarter', pg_catalog.now() at time zone 'UTC'
  )::integer;
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
  v_history_session_count bigint;
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
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 12) series(n)
    )
    and survey.cadence = 'quarterly';

  select pg_catalog.count(*) into v_current_responses
  from public.organization_survey_sessions session
  where session.survey_id = private.member_stress_uuid(p_run_id::text || ':voice:survey:1')
    and session.id in (
      select private.member_stress_uuid(
        p_run_id::text || ':voice:survey:1:session:' || series.n
      ) from pg_catalog.generate_series(1, 3) series(n)
    )
    and session.status = 'submitted';

  select pg_catalog.count(*) into v_prior_responses
  from public.organization_survey_sessions session
  where session.survey_id = private.member_stress_uuid(p_run_id::text || ':voice:survey:2')
    and session.id in (
      select private.member_stress_uuid(
        p_run_id::text || ':voice:survey:2:session:' || series.n
      ) from pg_catalog.generate_series(1, 6) series(n)
    )
    and session.status = 'submitted';

  select pg_catalog.count(*) into v_incomplete_examples
  from public.organization_surveys survey
  where survey.id = private.member_stress_uuid(p_run_id::text || ':voice:survey:1')
    and not exists (
      select 1
      from public.organization_survey_sessions session
      where session.survey_id = survey.id
        and session.respondent_user_id = private.demo_seed_user(p_lane, p_run_id, 70)
        and session.status = 'submitted'
    );

  select pg_catalog.count(*) into v_history_session_count
  from public.organization_survey_sessions session
  where session.id in (
    select private.member_stress_uuid(
      p_run_id::text || ':voice:survey:' || quarter.n || ':session:' || respondent.n
    )
    from pg_catalog.generate_series(1, 12) quarter(n)
    cross join lateral pg_catalog.generate_series(
      1, case when quarter.n = 1 then 3 when quarter.n = 2 then 6 else 1 end
    ) respondent(n)
  ) and session.status = 'submitted';

  select pg_catalog.count(*),
         pg_catalog.count(distinct task.reason),
         pg_catalog.count(distinct task.status)
  into v_task_count, v_task_reason_count, v_task_state_count
  from public.organization_survey_tasks task
  where task.organization_id = v_organization_id
    and task.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:task:' || series.n)
      from pg_catalog.generate_series(1, 16) series(n)
    );

  select pg_catalog.count(*), pg_catalog.count(distinct delivery.state)
  into v_delivery_count, v_delivery_state_count
  from public.organization_survey_deliveries delivery
  where delivery.organization_id = v_organization_id
    and delivery.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:delivery:' || series.n)
      from pg_catalog.generate_series(1, 24) series(n)
    );

  select pg_catalog.count(*), pg_catalog.count(distinct review.state)
  into v_review_count, v_review_state_count
  from public.organization_survey_reviews review
  where review.organization_id = v_organization_id
    and review.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:review:' || series.n)
      from pg_catalog.generate_series(1, 19) series(n)
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
    'ok', v_quarterly_count = 12
      and v_current_quarter_count = 1
      and v_current_responses = 3
      and v_prior_responses = 6
      and v_incomplete_examples = 1
      and v_owner_count = 12
      and v_history_session_count = 19
      and v_task_count = 16
      and v_task_reason_count = 4
      and v_task_state_count = 4
      and v_delivery_count = 24
      and v_delivery_state_count = 6
      and v_review_count = 19
      and v_review_state_count = 5
      and v_outbound_count = 0,
    'quarterlySurveys', v_quarterly_count,
    'currentQuarterSurveys', v_current_quarter_count,
    'currentQuarterResponses', v_current_responses,
    'priorQuarterResponses', v_prior_responses,
    'incompleteGateExamples', v_incomplete_examples,
    'ownedQuarterlySurveys', v_owner_count,
    'historySessions', v_history_session_count,
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

create or replace function private.demo_seed_apply_voice_operations(p_lane text, p_run_id uuid)
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
  v_quarter_anchor timestamptz := pg_catalog.date_trunc(
    'quarter', pg_catalog.now(), 'UTC'
  );
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_event_cap timestamptz := pg_catalog.date_trunc('day', pg_catalog.now(), 'UTC');
  v_event_at timestamptz;
  v_response_count integer;
  v_review_ordinal integer := 0;
  i integer;
  quarter_index integer;
  respondent integer;
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

  -- A reseed is a bounded SAMPLE fixture reset. Remove mutable rows created by
  -- real Configure, Distribute, Remind, and response flows before rebuilding
  -- the exact run-owned operating history.
  delete from public.organization_survey_sessions session
  where session.organization_id = v_organization_id
    and session.survey_id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 12) series(n)
    );
  delete from public.organization_survey_deliveries delivery
  where delivery.organization_id = v_organization_id
    and delivery.survey_id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 16) series(n)
    );
  delete from public.organization_survey_tasks task
  where task.organization_id = v_organization_id
    and task.survey_id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 16) series(n)
    );

  if exists (
    select 1
    from public.organization_surveys survey
    where survey.organization_id = v_organization_id
      and survey.cadence = 'quarterly'
      and survey.period_key in (
        select pg_catalog.to_char(
          v_quarter_anchor - ((series.n * 3) || ' months')::interval,
          'YYYY'
        ) || '-Q' || pg_catalog.date_part(
          'quarter', v_quarter_anchor - ((series.n * 3) || ' months')::interval
        )::integer
        from pg_catalog.generate_series(0, 11) series(n)
      )
      and survey.id not in (
        select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
        from pg_catalog.generate_series(1, 12) series(n)
      )
  ) then
    raise exception 'a non-seed quarterly survey already owns a rolling-history period';
  end if;

  update public.organization_surveys survey
  set cadence = 'one_off', period_key = null, updated_at = pg_catalog.now()
  where survey.organization_id = v_organization_id
    and survey.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 12) series(n)
    );

  for quarter_index in 0..11 loop
    i := quarter_index + 1;
    v_survey_id := private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i);
    v_period_start := v_quarter_anchor - ((quarter_index * 3) || ' months')::interval;
    v_period_end := v_period_start + interval '3 months' - interval '1 second';

    update public.organization_surveys survey
    set title = 'Quarterly member experience — '
          || pg_catalog.to_char(v_period_start at time zone 'UTC', 'YYYY')
          || ' Q' || pg_catalog.date_part('quarter', v_period_start at time zone 'UTC')::integer,
        cadence = 'quarterly',
        period_key = pg_catalog.to_char(v_period_start at time zone 'UTC', 'YYYY')
          || '-Q' || pg_catalog.date_part('quarter', v_period_start at time zone 'UTC')::integer,
        status = case when quarter_index = 0 then 'open' else 'closed' end,
        opens_at = v_period_start,
        closes_at = v_period_end,
        owner_user_id = v_staff_user,
        operations_state = case when quarter_index = 0 then 'reviewing' else 'complete' end,
        review_due_at = v_period_end + interval '7 days',
        updated_at = pg_catalog.now()
    where survey.organization_id = v_organization_id and survey.id = v_survey_id;
  end loop;

  -- Rebuild deterministic submitted history through the real in-progress to
  -- submitted transition. The current quarter stays below the five-response
  -- privacy floor, the prior quarter clears it, and every older quarter keeps
  -- one valid long-form response in the rolling history.
  for quarter_index in 0..11 loop
    i := quarter_index + 1;
    v_survey_id := private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i);
    v_period_start := v_quarter_anchor - ((quarter_index * 3) || ' months')::interval;
    v_response_count := case when i = 1 then 3 when i = 2 then 6 else 1 end;
    for respondent in 1..v_response_count loop
      v_session_id := private.member_stress_uuid(
        p_run_id::text || ':voice:survey:' || i || ':session:' || respondent
      );
      v_event_at := least(
        v_period_start + interval '21 days' + ((respondent - 1) || ' days')::interval,
        v_event_cap
      );
      insert into public.organization_survey_sessions (
        id, organization_id, survey_id, respondent_user_id, status,
        created_at, updated_at, submitted_at
      ) values (
        v_session_id, v_organization_id, v_survey_id,
        private.demo_seed_user(p_lane, p_run_id, 10 + respondent),
        'in_progress', v_event_at, v_event_at, null
      );

      insert into public.organization_survey_answers
        (organization_id, session_id, question_id, value, updated_at)
      values
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:1'),
         '"Often"'::jsonb, v_event_at),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:2'),
         pg_catalog.to_jsonb('Workload changes made scheduling less predictable.'::text), v_event_at),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:3'),
         pg_catalog.to_jsonb(('Program ' || respondent)::text), v_event_at),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:4'),
         '["Scheduling","Workload"]'::jsonb, v_event_at),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:5'),
         '"Email"'::jsonb, v_event_at),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:6'),
         '4'::jsonb, v_event_at),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:7'),
         pg_catalog.to_jsonb(least(respondent, 5)), v_event_at),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:8'),
         '"yes"'::jsonb, v_event_at);

      update public.organization_survey_sessions session
      set status = 'submitted',
          submitted_at = least(v_event_at + interval '2 hours', v_event_cap),
          updated_at = least(v_event_at + interval '2 hours', v_event_cap)
      where session.id = v_session_id and session.status = 'in_progress';
    end loop;
  end loop;

  -- The status transition intentionally exercises the production trigger.
  -- Replace trigger-created mutable rows with the exact historical fixture.
  delete from public.organization_survey_reviews review
  where review.organization_id = v_organization_id
    and review.survey_id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 12) series(n)
    );
  delete from public.organization_survey_deliveries delivery
  where delivery.organization_id = v_organization_id
    and delivery.survey_id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 12) series(n)
    );

  for i in 1..16 loop
    v_survey_id := private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i);
    v_event_at := case when i <= 12 then least(
      v_quarter_anchor - (((i - 1) * 3) || ' months')::interval + interval '42 days',
      v_event_cap
    ) else v_event_cap - ((i - 12) || ' days')::interval end;
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
      v_event_at + interval '7 days',
      v_staff_user,
      v_event_at - interval '7 days',
      v_event_at
    )
    on conflict (survey_id, reason) do update set
      status = excluded.status,
      assigned_to = excluded.assigned_to,
      due_at = excluded.due_at,
      updated_at = excluded.updated_at;
  end loop;

  for i in 1..24 loop
    v_survey_id := private.member_stress_uuid(
      p_run_id::text || ':voice:survey:' || (1 + ((i - 1) % 12))
    );
    v_period_start := v_quarter_anchor
      - ((((i - 1) % 12) * 3) || ' months')::interval;
    v_event_at := least(
      v_period_start + interval '35 days' + (((i - 1) / 12) || ' days')::interval,
      v_event_cap
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
      case when v_state in ('queued', 'suppressed') then null else v_event_at end,
      case when v_state in ('sent', 'engaged') then v_event_at else null end,
      case when v_state = 'engaged' then least(v_event_at + interval '1 hour', v_event_cap) else null end,
      case when v_state = 'failed' then 'reminder_due' when v_state = 'engaged' then 'resolved' else 'none' end,
      case when v_state = 'failed' then 'sample-transient' else null end,
      v_event_at - interval '2 days',
      least(
        v_event_at + case when v_state = 'engaged' then interval '1 hour' else interval '0 hours' end,
        v_event_cap
      )
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

  for quarter_index in 0..11 loop
    i := quarter_index + 1;
    v_survey_id := private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i);
    v_period_start := v_quarter_anchor - ((quarter_index * 3) || ' months')::interval;
    v_response_count := case when i = 1 then 3 when i = 2 then 6 else 1 end;
    for respondent in 1..v_response_count loop
      v_review_ordinal := v_review_ordinal + 1;
      v_session_id := private.member_stress_uuid(
        p_run_id::text || ':voice:survey:' || i || ':session:' || respondent
      );
      v_state := (array['unreviewed', 'assigned', 'follow_up', 'resolved', 'dismissed'])[
        1 + ((v_review_ordinal - 1) % 5)
      ];
      v_event_at := least(
        v_period_start + interval '24 days' + ((respondent - 1) || ' days')::interval,
        v_event_cap
      );
      insert into public.organization_survey_reviews (
        id, organization_id, survey_id, session_id, state, assigned_to,
        disposition, follow_up_due_at, created_at, updated_at
      ) values (
        private.member_stress_uuid(p_run_id::text || ':voice:review:' || v_review_ordinal),
        v_organization_id, v_survey_id, v_session_id, v_state,
        case when v_state = 'unreviewed' then null else v_staff_user end,
        case
          when v_state = 'follow_up' then 'Member requested a steward conversation.'
          when v_state = 'resolved' then 'Follow-up completed and documented.'
          when v_state = 'dismissed' then 'No staff action required after review.'
          else null
        end,
        case when v_state = 'follow_up' then v_event_at + interval '5 days' else null end,
        v_event_at, v_event_at
      );
    end loop;
  end loop;

  return private.demo_seed_voice_operations_status(p_lane, p_run_id);
end;
$function$;

-- Keep the persistent SAMPLE tour's quarterly gate aligned with the current
-- UTC quarter after the one-time deployment seed. The worker is inert unless
-- a function-parity evidence row proves that an authorized SAMPLE run is
-- installed, and it never creates identities, tenants, delivery rows, or
-- outbox work.
create or replace function private.demo_seed_refresh_voice_quarterly_windows()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
  v_organization_id uuid;
  v_chapter_id text;
  v_quarter_anchor timestamptz := pg_catalog.date_trunc(
    'quarter', pg_catalog.now(), 'UTC'
  );
  v_period_start timestamptz;
  v_refreshed integer := 0;
  quarter_index integer;
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

    if exists (
      select 1 from public.organization_surveys survey
      where survey.organization_id = v_organization_id
        and survey.cadence = 'quarterly'
        and survey.period_key in (
          select pg_catalog.to_char(
            v_quarter_anchor - ((series.n * 3) || ' months')::interval, 'YYYY'
          ) || '-Q' || pg_catalog.date_part(
            'quarter', v_quarter_anchor - ((series.n * 3) || ' months')::interval
          )::integer
          from pg_catalog.generate_series(0, 11) series(n)
        )
        and survey.id not in (
          select private.member_stress_uuid(
            seeded_run.run_id::text || ':voice:survey:' || series.n
          ) from pg_catalog.generate_series(1, 12) series(n)
        )
    ) then
      continue;
    end if;

    -- Free every run-owned period before assigning the new twelve-quarter
    -- window. This is idempotent and safe across both forward and backward
    -- clock changes.
    update public.organization_surveys survey
    set cadence = 'one_off',
        period_key = null,
        updated_at = pg_catalog.now()
    where survey.organization_id = v_organization_id
      and survey.id in (
        select private.member_stress_uuid(
          seeded_run.run_id::text || ':voice:survey:' || series.n
        ) from pg_catalog.generate_series(1, 12) series(n)
      );

    for quarter_index in 0..11 loop
      v_period_start := v_quarter_anchor - ((quarter_index * 3) || ' months')::interval;
      update public.organization_surveys survey
      set title = 'Quarterly member experience — '
            || pg_catalog.to_char(v_period_start at time zone 'UTC', 'YYYY')
            || ' Q' || pg_catalog.date_part('quarter', v_period_start at time zone 'UTC')::integer,
          cadence = 'quarterly',
          period_key = pg_catalog.to_char(v_period_start at time zone 'UTC', 'YYYY')
            || '-Q' || pg_catalog.date_part('quarter', v_period_start at time zone 'UTC')::integer,
          status = case when quarter_index = 0 then 'open' else 'closed' end,
          opens_at = v_period_start,
          closes_at = v_period_start + interval '3 months' - interval '1 second',
          operations_state = case when quarter_index = 0 then 'reviewing' else 'complete' end,
          review_due_at = v_period_start + interval '3 months 7 days',
          updated_at = pg_catalog.now()
      where survey.organization_id = v_organization_id
        and survey.id = private.member_stress_uuid(
          seeded_run.run_id::text || ':voice:survey:' || (quarter_index + 1)
        );
    end loop;

    -- The same persistent refresh keeps the member weekly surface on the
    -- current UTC week without creating any new rows.
    v_chapter_id := private.demo_seed_chapter(seeded_run.lane, seeded_run.run_id, 1);
    delete from public.member_weekly_questions intruder
    where intruder.week_start = pg_catalog.date_trunc(
          'week', pg_catalog.now() at time zone 'UTC'
        )::date
      and intruder.id not in (
        select private.member_stress_uuid(
          seeded_run.run_id::text || ':voice:weekly:' || series.n
        ) from pg_catalog.generate_series(1, 52) series(n)
      )
      and intruder.user_id in (
        select weekly.user_id
        from public.member_weekly_questions weekly
        where weekly.id in (
          select private.member_stress_uuid(
            seeded_run.run_id::text || ':voice:weekly:' || series.n
          ) from pg_catalog.generate_series(1, 52) series(n)
        )
      );
    update public.member_weekly_questions weekly
    set week_start = pg_catalog.date_trunc(
          'week', pg_catalog.now() at time zone 'UTC'
        )::date,
        updated_at = pg_catalog.now()
    where weekly.chapter_id = v_chapter_id
      and weekly.id in (
        select private.member_stress_uuid(
          seeded_run.run_id::text || ':voice:weekly:' || series.n
        ) from pg_catalog.generate_series(1, 52) series(n)
      );
    insert into private.demo_seed_page_evidence (lane, run_id, surface, actual_rows)
    values (
      seeded_run.lane, seeded_run.run_id, 'memberWeeklyQuestions',
      (select pg_catalog.count(*) from public.member_weekly_questions weekly
       where weekly.chapter_id = v_chapter_id
         and weekly.week_start = pg_catalog.date_trunc(
           'week', pg_catalog.now() at time zone 'UTC'
         )::date
         and weekly.editorial_state in ('submitted', 'reserved', 'published'))
    ) on conflict (lane, run_id, surface) do update
      set actual_rows = excluded.actual_rows, recorded_at = pg_catalog.now();

    v_refreshed := v_refreshed + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'refreshedRuns', v_refreshed,
    'currentPeriod', pg_catalog.to_char(v_quarter_anchor at time zone 'UTC', 'YYYY')
      || '-Q' || pg_catalog.date_part('quarter', v_quarter_anchor at time zone 'UTC')::integer,
    'quarters', 12
  );
end;
$function$;

create or replace function private.demo_seed_ensure_voice_operations_refresh()
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
exception when others then
  return false;
end;
$function$;

create function private.demo_seed_drop_voice_operations_refresh()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1 from private.demo_seed_function_evidence evidence
    where evidence.function_id = 'CR-001'
      and evidence.status = 'seeded'
      and evidence.lane in ('presg', 'uniondemo')
  ) or pg_catalog.to_regclass('cron.job') is null then
    return false;
  end if;

  perform cron.unschedule(job.jobid)
  from cron.job job
  where job.jobname = 'demo-seed-voice-quarterly-refresh';
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function private.demo_seed_remove_voice_operations(p_lane text, p_run_id uuid)
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
    and review.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:review:' || series.n)
      from pg_catalog.generate_series(1, 19) series(n)
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

-- Keep the already-merged Voice authoring verifier stable after a SAMPLE
-- member submits an additional response through the real product. Only the
-- deterministic fixture ids establish seed parity; mutable interaction is not
-- an error condition.
create or replace function private.demo_seed_voice_parity_status(p_lane text, p_run_id uuid)
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
  v_chapter_id text := private.demo_seed_chapter(p_lane, p_run_id, 1);
  v_survey_count bigint;
  v_question_type_count bigint;
  v_conditional_count bigint;
  v_withheld_count bigint;
  v_available_count bigint;
  v_weekly_count bigint;
  v_weekly_visible bigint;
  v_weekly_state_count bigint;
begin
  select pg_catalog.count(*) into v_survey_count
  from public.organization_surveys survey
  where survey.organization_id = v_organization_id
    and survey.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 16) series(n)
    );

  select pg_catalog.count(distinct question.question_type),
         pg_catalog.count(*) filter (where question.branch_parent_id is not null)
  into v_question_type_count, v_conditional_count
  from public.organization_survey_questions question
  where question.organization_id = v_organization_id
    and question.survey_id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 16) series(n)
    );

  select pg_catalog.count(*) into v_withheld_count
  from public.organization_survey_sessions session
  where session.id in (
    select private.member_stress_uuid(
      p_run_id::text || ':voice:survey:1:session:' || series.n
    ) from pg_catalog.generate_series(1, 3) series(n)
  ) and session.status = 'submitted';
  select pg_catalog.count(*) into v_available_count
  from public.organization_survey_sessions session
  where session.id in (
    select private.member_stress_uuid(
      p_run_id::text || ':voice:survey:2:session:' || series.n
    ) from pg_catalog.generate_series(1, 6) series(n)
  ) and session.status = 'submitted';

  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where weekly.editorial_state in ('submitted', 'reserved', 'published')),
         pg_catalog.count(distinct weekly.editorial_state)
  into v_weekly_count, v_weekly_visible, v_weekly_state_count
  from public.member_weekly_questions weekly
  where weekly.chapter_id = v_chapter_id
    and weekly.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:weekly:' || series.n)
      from pg_catalog.generate_series(1, 52) series(n)
    );

  return pg_catalog.jsonb_build_object(
    'ok', v_survey_count = 16
      and v_question_type_count = 8
      and v_conditional_count = 16
      and v_withheld_count = 3
      and v_available_count = 6
      and v_weekly_count = 52
      and v_weekly_visible = 50
      and v_weekly_state_count = 4,
    'surveys', v_survey_count,
    'questionTypes', v_question_type_count,
    'conditionalQuestions', v_conditional_count,
    'withheldResponses', v_withheld_count,
    'availableResponses', v_available_count,
    'weeklyQuestions', v_weekly_count,
    'weeklyVisible', v_weekly_visible,
    'weeklyEditorialStates', v_weekly_state_count,
    'outboundDeliveries', 0
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
  refresh_removed boolean;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_auth_operations('presg', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('presg', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('presg', p_run_id);
  base_result := private.demo_seed_remove_function_parity('presg', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object(
    'voiceRefreshRemoved', refresh_removed,
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
  refresh_removed boolean;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_auth_operations('uniondemo', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('uniondemo', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('uniondemo', p_run_id);
  base_result := private.demo_seed_remove_function_parity('uniondemo', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object(
    'voiceRefreshRemoved', refresh_removed,
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
revoke all on function private.demo_seed_drop_voice_operations_refresh()
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
