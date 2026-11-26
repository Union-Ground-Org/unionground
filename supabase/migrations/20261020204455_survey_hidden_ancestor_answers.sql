-- BUG-UG-SURVEY-HIDDEN-ANCESTOR-SUBMISSION-20261020
-- Authoring requires each branch parent to precede its child (at most 60 questions).
-- Resolve ancestor visibility separately from raw answers so stale hidden answers
-- cannot activate descendants or make their required fields block submission.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.mi1_w2_upsert_survey_session(
  p_survey_id uuid,
  p_answers jsonb,
  p_submit boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_w2_selected_organization();
  survey public.organization_surveys%rowtype;
  session_row public.organization_survey_sessions%rowtype;
  question public.organization_survey_questions%rowtype;
  answer jsonb;
  parent_answer jsonb;
  answer_text text;
  visible boolean;
  visible_question_ids uuid[] := array[]::uuid[];
  valid_option boolean;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_answers, '{}'::jsonb)) <> 'object' then
    raise exception 'answers must be an object' using errcode = '22023';
  end if;

  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org and status = 'open';
  if not found
     or (survey.chapter_id is not null and survey.chapter_id is distinct from private.current_member_chapter())
     or not ((survey.opens_at is null or survey.opens_at <= pg_catalog.now())
         and (survey.closes_at is null or survey.closes_at > pg_catalog.now())) then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  select * into session_row
  from public.organization_survey_sessions
  where organization_id = org and survey_id = survey.id
    and respondent_user_id = (select auth.uid())
  for update;
  if found and session_row.status = 'submitted' then
    raise exception 'survey session already submitted' using errcode = 'P0001';
  end if;
  if not found then
    insert into public.organization_survey_sessions (
      organization_id, survey_id, respondent_user_id, status
    ) values (org, survey.id, (select auth.uid()), 'in_progress')
    returning * into session_row;
  end if;

  for question in
    select * from public.organization_survey_questions q
    where q.survey_id = survey.id and q.organization_id = org
    order by q.sort_index
  loop
    visible := true;
    if question.branch_parent_id is not null then
      parent_answer := p_answers -> question.branch_parent_id::text;
      visible := question.branch_parent_id = any(visible_question_ids) and case
        when pg_catalog.jsonb_typeof(parent_answer) = 'array'
          then parent_answer ? question.branch_value
        when pg_catalog.jsonb_typeof(parent_answer) in ('string', 'number', 'boolean')
          then parent_answer #>> '{}' = question.branch_value
        else false
      end;
    end if;

    if visible then
      visible_question_ids := pg_catalog.array_append(visible_question_ids, question.id);
    end if;

    answer := p_answers -> question.id::text;
    if not visible or answer is null or answer = 'null'::jsonb then
      delete from public.organization_survey_answers
      where session_id = session_row.id and question_id = question.id;
      if visible and question.required and p_submit then
        raise exception 'required survey questions are missing' using errcode = '22023';
      end if;
      continue;
    end if;

    if question.question_type in ('text', 'paragraph') then
      if pg_catalog.jsonb_typeof(answer) <> 'string' then
        raise exception 'text answer required' using errcode = '22023';
      end if;
      answer_text := answer #>> '{}';
      if (question.required and p_submit and pg_catalog.btrim(answer_text) = '')
         or (question.question_type = 'text' and pg_catalog.char_length(answer_text) > 500)
         or (question.question_type = 'paragraph' and pg_catalog.char_length(answer_text) > 4000) then
        raise exception 'invalid text answer' using errcode = '22023';
      end if;
    elsif question.question_type in ('radio', 'dropdown', 'yes_no', 'scale', 'rating') then
      if pg_catalog.jsonb_typeof(answer) not in ('string', 'number') then
        raise exception 'single answer required' using errcode = '22023';
      end if;
      answer_text := answer #>> '{}';
      if question.question_type = 'yes_no' and pg_catalog.jsonb_array_length(question.options) = 0 then
        valid_option := answer_text in ('yes', 'no');
      elsif question.question_type in ('scale', 'rating') and pg_catalog.jsonb_array_length(question.options) = 0 then
        valid_option := answer_text in ('1', '2', '3', '4', '5');
      else
        select exists (
          select 1 from pg_catalog.jsonb_array_elements(question.options) option_item
          where case pg_catalog.jsonb_typeof(option_item)
            when 'object' then coalesce(option_item ->> 'value', option_item ->> 'label')
            else option_item #>> '{}'
          end = answer_text
        ) into valid_option;
      end if;
      if not valid_option then raise exception 'answer is not an available option' using errcode = '22023'; end if;
    elsif question.question_type = 'checkbox' then
      if pg_catalog.jsonb_typeof(answer) <> 'array' then
        raise exception 'invalid multiple-choice answer' using errcode = '22023';
      end if;
      if (question.max_selections is not null and pg_catalog.jsonb_array_length(answer) > question.max_selections)
         or pg_catalog.jsonb_array_length(answer) <> (
           select pg_catalog.count(distinct selected #>> '{}')::integer
           from pg_catalog.jsonb_array_elements(answer) selected
         )
         or exists (
           select 1 from pg_catalog.jsonb_array_elements(answer) selected
           where not exists (
             select 1 from pg_catalog.jsonb_array_elements(question.options) option_item
             where case pg_catalog.jsonb_typeof(option_item)
               when 'object' then coalesce(option_item ->> 'value', option_item ->> 'label')
               else option_item #>> '{}'
             end = selected #>> '{}'
           )
         ) then
        raise exception 'invalid multiple-choice answer' using errcode = '22023';
      end if;
      if question.required and p_submit and pg_catalog.jsonb_array_length(answer) = 0 then
        raise exception 'required survey questions are missing' using errcode = '22023';
      end if;
    end if;

    insert into public.organization_survey_answers (organization_id, session_id, question_id, value)
    values (org, session_row.id, question.id, answer)
    on conflict (session_id, question_id) do update
      set value = excluded.value, updated_at = pg_catalog.now();
  end loop;

  if p_submit then
    update public.organization_survey_sessions
    set status = 'submitted', submitted_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = session_row.id;
    perform private.mi1_w2_write_audit(org, 'survey_session_submitted', pg_catalog.jsonb_build_object(
      'organizationId', org, 'surveyId', survey.id, 'sessionId', session_row.id, 'status', 'submitted'
    ));
  else
    update public.organization_survey_sessions
    set updated_at = pg_catalog.now()
    where id = session_row.id;
    perform private.mi1_w2_write_audit(org, 'survey_session_saved', pg_catalog.jsonb_build_object(
      'organizationId', org, 'surveyId', survey.id, 'sessionId', session_row.id, 'status', 'in_progress'
    ));
  end if;
  return pg_catalog.jsonb_build_object(
    'id', session_row.id,
    'organizationId', org,
    'surveyId', survey.id,
    'status', case when p_submit then 'submitted' else 'in_progress' end
  );
end;
end;
$function$;

revoke all on function private.mi1_w2_upsert_survey_session(uuid, jsonb, boolean)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
