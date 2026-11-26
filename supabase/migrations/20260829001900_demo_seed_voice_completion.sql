-- SAMPLE-only Voice survey parity repair for CR-003/004/005/009/011.
--
-- The survey schema landed after the original 114-function parity phase. This
-- append-only repair removes those five stale schema gates and gives both
-- independently runnable demo lanes deterministic, reversible evidence. It
-- does not execute a seed during migration and never exposes a client mutation
-- path.

set local lock_timeout = '5s';

update private.demo_seed_function_catalog catalog
set coverage = 'seeded',
    evidence_key = evidence.evidence_key,
    gate_relation = null
from (values
  ('CR-003', 'voice-survey-builder'),
  ('CR-004', 'voice-survey-question-types'),
  ('CR-005', 'voice-survey-conditional-sections'),
  ('CR-009', 'voice-survey-privacy-thresholds'),
  ('CR-011', 'voice-weekly-editorial')
) as evidence(function_id, evidence_key)
where catalog.function_id = evidence.function_id;

insert into private.demo_seed_page_contract
  (surface, page_size, minimum_rows, scope, source)
values ('memberWeeklyQuestions', 25, 50, 'featured-chapter',
  'supabase/migrations/20260828220000_mi1_voice_survey_completion.sql:718')
on conflict (surface) do update
set page_size = excluded.page_size,
    minimum_rows = excluded.minimum_rows,
    scope = excluded.scope,
    source = excluded.source;

-- Forward declaration for the apply phase; the complete verifier replaces it
-- below after every referenced table expression is declared in one place.
create function private.demo_seed_voice_parity_status(p_lane text, p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select '{}'::jsonb;
$function$;

create function private.demo_seed_apply_voice_parity(
  p_lane text,
  p_run_id uuid
)
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
  v_chapter_id text := private.demo_seed_chapter(p_lane, p_run_id, 1);
  v_staff_user uuid := private.demo_seed_user(p_lane, p_run_id, 1);
  v_survey_id uuid;
  v_parent_question_id uuid;
  v_session_id uuid;
  v_weekly_id uuid;
  v_state text;
  v_response_count integer;
  i integer;
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

  -- Sixteen instruments make the staff workspace feel inhabited without
  -- inventing a real organization. Every instrument carries the complete
  -- eight-type taxonomy, three sections, and one conditional follow-up.
  for i in 1..16 loop
    v_survey_id := private.member_stress_uuid(
      p_run_id::text || ':voice:survey:' || i
    );
    insert into public.organization_surveys (
      id, organization_id, chapter_id, title, description, status,
      privacy_min_responses, created_by, cadence, period_key,
      opens_at, closes_at, owner_user_id, operations_state,
      review_due_at, created_at, updated_at
    ) values (
      v_survey_id, v_organization_id, v_chapter_id,
      (array[
        'Scheduling and workload check-in',
        'Health and safety priorities',
        'Training access review',
        'Benefits communication check',
        'Workplace technology needs',
        'Shift handoff experience',
        'Member meeting accessibility',
        'Contract education interests'
      ])[1 + ((i - 1) % 8)] || ' ' || pg_catalog.lpad(i::text, 2, '0'),
      'A confidential member questionnaire about current workplace experience and chapter priorities.',
      case when i = 15 then 'draft' when i = 16 then 'closed' else 'open' end,
      5, v_staff_user, 'one_off', null,
      pg_catalog.now() - interval '30 days',
      pg_catalog.now() + interval '60 days',
      v_staff_user,
      case when i = 15 then 'draft' when i = 16 then 'complete' else 'ready' end,
      pg_catalog.now() + interval '67 days',
      pg_catalog.now() - ((40 - i) || ' days')::interval,
      pg_catalog.now() - ((18 - i) || ' hours')::interval
    )
    on conflict (id) do update set
      organization_id = excluded.organization_id,
      chapter_id = excluded.chapter_id,
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      privacy_min_responses = excluded.privacy_min_responses,
      created_by = excluded.created_by,
      cadence = excluded.cadence,
      period_key = excluded.period_key,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      owner_user_id = excluded.owner_user_id,
      operations_state = excluded.operations_state,
      review_due_at = excluded.review_due_at,
      updated_at = excluded.updated_at;

    v_parent_question_id := private.member_stress_uuid(
      p_run_id::text || ':voice:survey:' || i || ':question:1'
    );

    insert into public.organization_survey_questions (
      id, organization_id, survey_id, sort_index, client_key, question_type,
      label, required, options, section_key, section_title,
      branch_parent_id, branch_value, scale_min_label, scale_max_label,
      max_selections
    ) values
      (v_parent_question_id, v_organization_id, v_survey_id, 0, 'experience-frequency', 'radio',
       'How often has this issue affected your work recently?', true,
       '["Never","Sometimes","Often"]'::jsonb, 'experience', 'Your experience',
       null, null, null, null, null),
      (private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:2'),
       v_organization_id, v_survey_id, 1, 'experience-follow-up', 'paragraph',
       'Please describe what happened and what would improve the situation.', false,
       '[]'::jsonb, 'experience', 'Your experience',
       v_parent_question_id, 'Often', null, null, null),
      (private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:3'),
       v_organization_id, v_survey_id, 2, 'location-note', 'text',
       'Which worksite or program is most relevant?', false,
       '[]'::jsonb, 'details', 'Workplace details',
       null, null, null, null, null),
      (private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:4'),
       v_organization_id, v_survey_id, 3, 'priority-areas', 'checkbox',
       'Which areas should the chapter prioritize?', true,
       '["Scheduling","Workload","Safety","Training"]'::jsonb, 'details', 'Workplace details',
       null, null, null, null, 2),
      (private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:5'),
       v_organization_id, v_survey_id, 4, 'preferred-channel', 'dropdown',
       'How would you prefer to receive follow-up?', true,
       '["Email","Phone","Chapter meeting"]'::jsonb, 'preferences', 'Follow-up preferences',
       null, null, null, null, null),
      (private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:6'),
       v_organization_id, v_survey_id, 5, 'support-confidence', 'scale',
       'How confident are you that the issue can improve?', true,
       '[]'::jsonb, 'preferences', 'Follow-up preferences',
       null, null, 'Not confident', 'Very confident', null),
      (private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:7'),
       v_organization_id, v_survey_id, 6, 'chapter-rating', 'rating',
       'How useful has chapter support been?', true,
       '[]'::jsonb, 'preferences', 'Follow-up preferences',
       null, null, 'Needs improvement', 'Very useful', null),
      (private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:8'),
       v_organization_id, v_survey_id, 7, 'contact-consent', 'yes_no',
       'May a steward contact you about your response?', true,
       '[]'::jsonb, 'preferences', 'Follow-up preferences',
       null, null, null, null, null)
    on conflict (id) do update set
      organization_id = excluded.organization_id,
      survey_id = excluded.survey_id,
      sort_index = excluded.sort_index,
      client_key = excluded.client_key,
      question_type = excluded.question_type,
      label = excluded.label,
      required = excluded.required,
      options = excluded.options,
      section_key = excluded.section_key,
      section_title = excluded.section_title,
      branch_parent_id = excluded.branch_parent_id,
      branch_value = excluded.branch_value,
      scale_min_label = excluded.scale_min_label,
      scale_max_label = excluded.scale_max_label,
      max_selections = excluded.max_selections;
  end loop;

  -- One cohort remains below the five-response floor while the next crosses
  -- it. Both use complete valid responses, so the seeded report and export
  -- paths demonstrate withheld and available states against the real tables.
  for i in 1..2 loop
    v_survey_id := private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i);
    v_response_count := case when i = 1 then 3 else 6 end;
    for respondent in 1..v_response_count loop
      v_session_id := private.member_stress_uuid(
        p_run_id::text || ':voice:survey:' || i || ':session:' || respondent
      );
      insert into public.organization_survey_sessions (
        id, organization_id, survey_id, respondent_user_id, status,
        created_at, updated_at, submitted_at
      ) values (
        v_session_id, v_organization_id, v_survey_id,
        private.demo_seed_user(p_lane, p_run_id, 10 + respondent),
        'submitted',
        pg_catalog.now() - ((14 - respondent) || ' days')::interval,
        pg_catalog.now() - ((14 - respondent) || ' days')::interval,
        pg_catalog.now() - ((14 - respondent) || ' days')::interval
      )
      on conflict (id) do update set
        organization_id = excluded.organization_id,
        survey_id = excluded.survey_id,
        respondent_user_id = excluded.respondent_user_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        submitted_at = excluded.submitted_at;

      insert into public.organization_survey_answers
        (organization_id, session_id, question_id, value, updated_at)
      values
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:1'),
         '"Often"'::jsonb, pg_catalog.now()),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:2'),
         pg_catalog.to_jsonb('The workload changed faster than the team could adjust.'::text), pg_catalog.now()),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:3'),
         pg_catalog.to_jsonb(('Program ' || respondent)::text), pg_catalog.now()),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:4'),
         '["Scheduling","Workload"]'::jsonb, pg_catalog.now()),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:5'),
         '"Email"'::jsonb, pg_catalog.now()),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:6'),
         '4'::jsonb, pg_catalog.now()),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:7'),
         '5'::jsonb, pg_catalog.now()),
        (v_organization_id, v_session_id,
         private.member_stress_uuid(p_run_id::text || ':voice:survey:' || i || ':question:8'),
         '"yes"'::jsonb, pg_catalog.now())
      on conflict (session_id, question_id) do update
      set value = excluded.value, updated_at = excluded.updated_at;
    end loop;
  end loop;

  -- Fifty active rows match two complete 25-row member pages. Two archived
  -- rows make the full staff editorial lifecycle visible without reducing the
  -- active member pool below the depth contract.
  for i in 1..52 loop
    v_weekly_id := private.member_stress_uuid(p_run_id::text || ':voice:weekly:' || i);
    v_state := case
      when i > 50 then 'archived'
      when i % 3 = 0 then 'published'
      when i % 3 = 1 then 'submitted'
      else 'reserved'
    end;
    insert into public.member_weekly_questions (
      id, chapter_id, user_id, week_start, body, options,
      editorial_state, editor_note, published_survey_id,
      created_at, updated_at
    ) values (
      v_weekly_id, v_chapter_id,
      private.demo_seed_user(p_lane, p_run_id, 2 + i),
      pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date,
      (array[
        'Which scheduling topic should members discuss next?',
        'Which training topic would help most this month?',
        'Which workplace improvement should be prioritized?',
        'Which contract topic needs a short explainer?'
      ])[1 + ((i - 1) % 4)] || ' ' || pg_catalog.lpad(i::text, 2, '0'),
      '["Scheduling","Safety","Training","Benefits"]'::jsonb,
      v_state,
      case when v_state = 'reserved' then 'Held for the next chapter bulletin.'
           when v_state = 'archived' then 'Archived after the editorial cycle.'
           else null end,
      case when v_state = 'published' then private.member_stress_uuid(
        p_run_id::text || ':voice:survey:' || (1 + ((i - 1) % 16))
      ) else null end,
      pg_catalog.now() - (i || ' minutes')::interval,
      pg_catalog.now() - (i || ' minutes')::interval
    )
    on conflict (id) do update set
      chapter_id = excluded.chapter_id,
      user_id = excluded.user_id,
      week_start = excluded.week_start,
      body = excluded.body,
      options = excluded.options,
      editorial_state = excluded.editorial_state,
      editor_note = excluded.editor_note,
      published_survey_id = excluded.published_survey_id,
      updated_at = excluded.updated_at;

    insert into public.member_weekly_question_supports (question_id, user_id)
    values
      (v_weekly_id, private.demo_seed_user(p_lane, p_run_id, 10 + ((i * 2) % 60))),
      (v_weekly_id, private.demo_seed_user(p_lane, p_run_id, 11 + ((i * 2) % 60)))
    on conflict (question_id, user_id) do nothing;
  end loop;

  insert into private.demo_seed_page_evidence
    (lane, run_id, surface, actual_rows)
  values (
    p_lane, p_run_id, 'memberWeeklyQuestions',
    (select pg_catalog.count(*)
     from public.member_weekly_questions weekly
     where weekly.chapter_id = v_chapter_id
       and weekly.week_start = pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date
       and weekly.editorial_state in ('submitted', 'reserved', 'published'))
  )
  on conflict (lane, run_id, surface) do update
  set actual_rows = excluded.actual_rows,
      recorded_at = pg_catalog.now();

  return private.demo_seed_voice_parity_status(p_lane, p_run_id);
end;
$function$;

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
  where session.survey_id = private.member_stress_uuid(p_run_id::text || ':voice:survey:1')
    and session.status = 'submitted';
  select pg_catalog.count(*) into v_available_count
  from public.organization_survey_sessions session
  where session.survey_id = private.member_stress_uuid(p_run_id::text || ':voice:survey:2')
    and session.status = 'submitted';

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
      and coalesce((private.demo_seed_voice_parity_status(p_lane, p_run_id) ->> 'ok')::boolean, false),
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
begin
  auth_result := private.demo_seed_apply_auth_operations(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  base_result := private.demo_seed_apply_function_parity(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  voice_result := private.demo_seed_apply_voice_parity('presg', p_run_id);
  if not coalesce((voice_result ->> 'ok')::boolean, false) then
    raise exception 'Voice survey parity verification failed: %', voice_result;
  end if;
  return base_result || pg_catalog.jsonb_build_object(
    'ok', (base_result ->> 'ok')::boolean
      and (auth_result ->> 'ok')::boolean
      and (voice_result ->> 'ok')::boolean,
    'authOperations', auth_result,
    'voice', voice_result
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
begin
  auth_result := private.demo_seed_apply_auth_operations(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  base_result := private.demo_seed_apply_function_parity(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  voice_result := private.demo_seed_apply_voice_parity('uniondemo', p_run_id);
  if not coalesce((voice_result ->> 'ok')::boolean, false) then
    raise exception 'Voice survey parity verification failed: %', voice_result;
  end if;
  return base_result || pg_catalog.jsonb_build_object(
    'ok', (base_result ->> 'ok')::boolean
      and (auth_result ->> 'ok')::boolean
      and (voice_result ->> 'ok')::boolean,
    'authOperations', auth_result,
    'voice', voice_result
  );
end;
$function$;

create function private.demo_seed_remove_voice_parity(p_lane text, p_run_id uuid)
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

  delete from public.member_weekly_question_supports support
  where support.question_id in (
    select private.member_stress_uuid(p_run_id::text || ':voice:weekly:' || series.n)
    from pg_catalog.generate_series(1, 52) series(n)
  );
  delete from public.member_weekly_questions weekly
  where weekly.id in (
    select private.member_stress_uuid(p_run_id::text || ':voice:weekly:' || series.n)
    from pg_catalog.generate_series(1, 52) series(n)
  );
  delete from public.organization_surveys survey
  where survey.organization_id = v_organization_id
    and survey.id in (
      select private.member_stress_uuid(p_run_id::text || ':voice:survey:' || series.n)
      from pg_catalog.generate_series(1, 16) series(n)
    );

  return pg_catalog.jsonb_build_object(
    'removed', true,
    'lane', p_lane,
    'runId', p_run_id,
    'voice', true
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
  voice_result jsonb;
  base_result jsonb;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_auth_operations('presg', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('presg', p_run_id);
  base_result := private.demo_seed_remove_function_parity('presg', p_run_id);
  return base_result || pg_catalog.jsonb_build_object('voice', voice_result);
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
  voice_result jsonb;
  base_result jsonb;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_auth_operations('uniondemo', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('uniondemo', p_run_id);
  base_result := private.demo_seed_remove_function_parity('uniondemo', p_run_id);
  return base_result || pg_catalog.jsonb_build_object('voice', voice_result);
end;
$function$;

revoke all on function private.demo_seed_apply_voice_parity(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_voice_parity_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_voice_parity(text, uuid)
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
