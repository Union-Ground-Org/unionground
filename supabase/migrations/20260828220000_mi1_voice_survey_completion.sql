-- MI1 Voice survey completion: CR-003, CR-004, CR-005, CR-009, CR-011.
--
-- Approved donor baseline: donor-baseline-20260721.
-- This append-only migration adapts the donor's ordered builder, question
-- taxonomy, conditional sections, privacy floor, and weekly editorial flow to
-- the current organization-scoped survey engine. It intentionally rejects the
-- donor's tenant assumptions, identifiers, credentials, direct table access,
-- dependencies, and migration history.

-- Stable client keys let a draft describe same-survey branch relationships
-- without accepting caller-owned database UUIDs.
alter table public.organization_survey_questions
  add column client_key text;

update public.organization_survey_questions
set client_key = 'question-' || sort_index::text
where client_key is null;

alter table public.organization_survey_questions
  alter column client_key set default extensions.gen_random_uuid()::text,
  alter column client_key set not null,
  add constraint organization_survey_questions_client_key_bounded
    check (
      pg_catalog.char_length(client_key) between 1 and 120
      and client_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  add constraint organization_survey_questions_survey_client_key_unique
    unique (survey_id, client_key),
  add constraint organization_survey_questions_identity_scope_unique
    unique (id, organization_id, survey_id),
  add constraint organization_survey_questions_branch_same_survey_fk
    foreign key (branch_parent_id, organization_id, survey_id)
    references public.organization_survey_questions (id, organization_id, survey_id)
    deferrable initially deferred;

create or replace function private.mi1_w2_replace_survey_questions(
  p_org uuid,
  p_survey uuid,
  p_questions jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item jsonb;
  option_item jsonb;
  idx integer := 0;
  question_type text;
  label text;
  current_client_key text;
  current_branch_key text;
  branch_value text;
  question_options jsonb;
  normalized_options jsonb;
  option_value text;
  option_values text[];
  max_selections integer;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_questions, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) not between 1 and 60 then
    raise exception 'survey requires 1 to 60 questions' using errcode = '22023';
  end if;

  delete from public.organization_survey_questions q
  where q.survey_id = p_survey and q.organization_id = p_org;

  for item in select value from pg_catalog.jsonb_array_elements(p_questions)
  loop
    question_type := coalesce(item ->> 'type', item ->> 'questionType', '');
    if question_type = 'textarea' then question_type := 'paragraph'; end if;
    if question_type = 'slider-10' then question_type := 'scale'; end if;
    if question_type = 'yes/no' then question_type := 'yes_no'; end if;
    if question_type in ('single-select', 'radio-branch') then question_type := 'radio'; end if;

    label := pg_catalog.btrim(coalesce(item ->> 'label', item ->> 'text', ''));
    current_client_key := pg_catalog.btrim(coalesce(item ->> 'clientKey', 'question-' || idx::text));
    question_options := coalesce(item -> 'options', '[]'::jsonb);
    normalized_options := '[]'::jsonb;
    option_values := array[]::text[];
    max_selections := nullif(item ->> 'maxSelections', '')::integer;

    if question_type not in ('text', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'rating', 'yes_no')
       or pg_catalog.char_length(label) not between 1 and 400
       or current_client_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
       or pg_catalog.jsonb_typeof(question_options) <> 'array'
       or pg_catalog.jsonb_array_length(question_options) > 20 then
      raise exception 'invalid survey question' using errcode = '22023';
    end if;

    if question_type in ('radio', 'checkbox', 'dropdown')
       and pg_catalog.jsonb_array_length(question_options) not between 2 and 20 then
      raise exception 'choice questions require 2 to 20 options' using errcode = '22023';
    end if;
    if question_type in ('text', 'paragraph')
       and pg_catalog.jsonb_array_length(question_options) <> 0 then
      raise exception 'text questions do not accept options' using errcode = '22023';
    end if;
    if question_type = 'yes_no'
       and pg_catalog.jsonb_array_length(question_options) not in (0, 2) then
      raise exception 'yes/no questions use the standard choices or two labels' using errcode = '22023';
    end if;
    if max_selections is not null and (
      question_type <> 'checkbox'
      or max_selections < 1
      or max_selections > pg_catalog.jsonb_array_length(question_options)
    ) then
      raise exception 'invalid multiple-choice selection limit' using errcode = '22023';
    end if;

    for option_item in select value from pg_catalog.jsonb_array_elements(question_options)
    loop
      option_value := case pg_catalog.jsonb_typeof(option_item)
        when 'string' then option_item #>> '{}'
        when 'number' then option_item #>> '{}'
        when 'object' then coalesce(option_item ->> 'value', option_item ->> 'label')
        else null
      end;
      option_value := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(option_value, ''), '[[:cntrl:]]', ' ', 'g'));
      if pg_catalog.char_length(option_value) not between 1 and 160 then
        raise exception 'invalid survey option' using errcode = '22023';
      end if;
      if option_value = any(option_values) then
        raise exception 'survey option values must be unique' using errcode = '22023';
      end if;
      option_values := pg_catalog.array_append(option_values, option_value);
      normalized_options := normalized_options || pg_catalog.jsonb_build_array(option_value);
    end loop;

    insert into public.organization_survey_questions (
      organization_id, survey_id, sort_index, client_key, question_type, label,
      required, options, section_key, section_title,
      branch_value, scale_min_label, scale_max_label, max_selections
    ) values (
      p_org, p_survey, idx, current_client_key, question_type, label,
      coalesce((item ->> 'required')::boolean, false), normalized_options,
      coalesce(nullif(pg_catalog.btrim(item ->> 'sectionKey'), ''), 'section-1'),
      nullif(pg_catalog.btrim(item ->> 'sectionTitle'), ''),
      nullif(pg_catalog.btrim(item ->> 'branchValue'), ''),
      nullif(pg_catalog.btrim(item ->> 'scaleMinLabel'), ''),
      nullif(pg_catalog.btrim(item ->> 'scaleMaxLabel'), ''),
      max_selections
    );
    idx := idx + 1;
  end loop;

  -- Resolve branch keys only after every server-owned question ID exists.
  idx := 0;
  for item in select value from pg_catalog.jsonb_array_elements(p_questions)
  loop
    current_client_key := pg_catalog.btrim(coalesce(item ->> 'clientKey', 'question-' || idx::text));
    current_branch_key := nullif(pg_catalog.btrim(coalesce(item ->> 'branchParentKey', '')), '');
    branch_value := nullif(pg_catalog.btrim(coalesce(item ->> 'branchValue', '')), '');
    if current_branch_key is not null then
      if branch_value is null then
        raise exception 'conditional questions require a comparison value' using errcode = '22023';
      end if;
      update public.organization_survey_questions child
      set branch_parent_id = parent.id
      from public.organization_survey_questions parent
      where child.organization_id = p_org
        and child.survey_id = p_survey
        and child.client_key = current_client_key
        and parent.organization_id = p_org
        and parent.survey_id = p_survey
        and parent.client_key = current_branch_key
        and parent.sort_index < child.sort_index
        and parent.question_type in ('radio', 'checkbox', 'dropdown', 'scale', 'rating', 'yes_no');
      if not found then
        raise exception 'branch parent must be an earlier selectable question' using errcode = '22023';
      end if;
    elsif branch_value is not null then
      raise exception 'branch value requires a parent question' using errcode = '22023';
    end if;
    idx := idx + 1;
  end loop;
end;
$function$;

revoke all on function private.mi1_w2_replace_survey_questions(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.mi1_w2_project_survey(p_survey_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', s.id,
    'organizationId', s.organization_id,
    'chapterId', s.chapter_id,
    'title', s.title,
    'description', s.description,
    'status', s.status,
    'privacyMinResponses', s.privacy_min_responses,
    'createdAt', s.created_at,
    'updatedAt', s.updated_at,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', q.id,
        'clientKey', q.client_key,
        'type', q.question_type,
        'label', q.label,
        'required', q.required,
        'options', q.options,
        'sectionKey', q.section_key,
        'sectionTitle', q.section_title,
        'branchParentId', q.branch_parent_id,
        'branchParentKey', parent.client_key,
        'branchValue', q.branch_value,
        'scaleMinLabel', q.scale_min_label,
        'scaleMaxLabel', q.scale_max_label,
        'maxSelections', q.max_selections,
        'sortIndex', q.sort_index
      ) order by q.sort_index, q.id)
      from public.organization_survey_questions q
      left join public.organization_survey_questions parent on parent.id = q.branch_parent_id
      where q.survey_id = s.id
    ), '[]'::jsonb)
  )
  from public.organization_surveys s
  where s.id = p_survey_id
$function$;

revoke all on function private.mi1_w2_project_survey(uuid)
  from public, anon, authenticated, service_role;

create function public.get_organization_survey_draft(p_survey_id uuid)
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
  if not exists (
    select 1 from public.organization_surveys s
    where s.id = p_survey_id and s.organization_id = org
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return private.mi1_w2_project_survey(p_survey_id);
end;
$function$;

revoke all on function public.get_organization_survey_draft(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_organization_survey_draft(uuid) to authenticated;

create or replace function public.save_organization_survey_draft(p_draft jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  existing public.organization_surveys%rowtype;
  saved_survey_id uuid;
  next_title text := pg_catalog.btrim(coalesce(p_draft ->> 'title', ''));
  next_description text := pg_catalog.btrim(coalesce(p_draft ->> 'description', ''));
  chapter text := nullif(pg_catalog.btrim(coalesce(p_draft ->> 'chapterId', '')), '');
  privacy integer := coalesce(nullif(p_draft ->> 'privacyMinResponses', '')::integer, 3);
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(next_title) not between 3 and 200
     or pg_catalog.char_length(next_description) > 4000 then
    raise exception 'A draft needs valid title and description copy.' using errcode = '22023';
  end if;
  if privacy not between 3 and 50 then
    raise exception 'privacy floor must be between 3 and 50' using errcode = '22023';
  end if;
  if chapter is not null and not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter is not in the selected organization' using errcode = '42501';
  end if;
  if coalesce(p_draft ? 'organizationId', false)
     and nullif(p_draft ->> 'organizationId', '') is distinct from org::text then
    raise exception 'organization is derived from the session' using errcode = '42501';
  end if;

  if nullif(p_draft ->> 'id', '') is not null then
    select * into existing
    from public.organization_surveys
    where id = (p_draft ->> 'id')::uuid
    for update;
    if not found or existing.organization_id is distinct from org then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    if existing.status <> 'draft' then
      raise exception 'Published surveys cannot return to free-form draft editing.' using errcode = 'P0001';
    end if;
    saved_survey_id := existing.id;
    update public.organization_surveys
    set title = next_title,
        description = next_description,
        chapter_id = chapter,
        privacy_min_responses = privacy,
        updated_at = pg_catalog.now()
    where id = saved_survey_id and organization_id = org;
  else
    insert into public.organization_surveys (
      organization_id, chapter_id, title, description, privacy_min_responses, created_by
    ) values (
      org, chapter, next_title, next_description, privacy, (select auth.uid())
    ) returning id into saved_survey_id;
  end if;

  perform private.mi1_w2_replace_survey_questions(org, saved_survey_id, p_draft -> 'questions');
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'surveyId', saved_survey_id,
    'status', 'draft', 'privacyMinResponses', privacy
  ));
  return private.mi1_w2_project_survey(saved_survey_id);
end;
$function$;

revoke all on function public.save_organization_survey_draft(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_organization_survey_draft(jsonb) to authenticated;

create or replace function public.set_organization_survey_privacy_floor(
  p_survey_id uuid,
  p_privacy_min_responses integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  survey public.organization_surveys%rowtype;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_privacy_min_responses not between 3 and 50 then
    raise exception 'privacy floor must be between 3 and 50' using errcode = '22023';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  update public.organization_surveys
  set privacy_min_responses = p_privacy_min_responses, updated_at = pg_catalog.now()
  where id = survey.id and organization_id = org;
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', survey.id, 'status', survey.status,
    'privacyMinResponses', p_privacy_min_responses
  ));
  return private.mi1_w2_project_survey(survey.id);
end;
$function$;

revoke all on function public.set_organization_survey_privacy_floor(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.set_organization_survey_privacy_floor(uuid, integer) to authenticated;

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
declare
  org uuid := private.mi1_w2_selected_organization();
  survey public.organization_surveys%rowtype;
  session_row public.organization_survey_sessions%rowtype;
  question public.organization_survey_questions%rowtype;
  answer jsonb;
  parent_answer jsonb;
  answer_text text;
  visible boolean;
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
     or (survey.chapter_id is not null and survey.chapter_id is distinct from private.current_member_chapter()) then
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
      visible := case
        when pg_catalog.jsonb_typeof(parent_answer) = 'array'
          then parent_answer ? question.branch_value
        when pg_catalog.jsonb_typeof(parent_answer) in ('string', 'number', 'boolean')
          then parent_answer #>> '{}' = question.branch_value
        else false
      end;
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
$function$;

revoke all on function private.mi1_w2_upsert_survey_session(uuid, jsonb, boolean)
  from public, anon, authenticated, service_role;

-- Raw exports obey the same survey-level privacy floor as the on-screen report.
create or replace function public.export_organization_survey_results(p_survey_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  report jsonb;
begin
  perform private.engagement_require_staff(org);
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  report := public.get_organization_survey_report(survey.id);
  if not coalesce((report ->> 'available')::boolean, false) then
    return report || pg_catalog.jsonb_build_object(
      'title', survey.title,
      'generatedAt', pg_catalog.now(),
      'responses', '[]'::jsonb
    );
  end if;
  return report || pg_catalog.jsonb_build_object(
    'generatedAt', pg_catalog.now(),
    'responses', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'responseId', session.id,
        'submittedAt', session.submitted_at,
        'answers', coalesce((
          select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
          from public.organization_survey_answers answer
          where answer.session_id = session.id and answer.organization_id = org
        ), '{}'::jsonb)
      ) order by session.submitted_at, session.id)
      from public.organization_survey_sessions session
      where session.organization_id = org
        and session.survey_id = survey.id
        and session.status = 'submitted'
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.export_organization_survey_results(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.export_organization_survey_results(uuid) to authenticated;

-- Weekly member-authored poll questions now carry answer options and an
-- attributable staff editorial lifecycle that publishes into the same survey
-- engine above.
alter table public.member_weekly_questions
  add column options jsonb not null default '[]'::jsonb,
  add column editorial_state text not null default 'submitted',
  add column editor_note text,
  add column published_survey_id uuid references public.organization_surveys(id) on delete restrict,
  add column updated_at timestamptz not null default pg_catalog.now(),
  add constraint member_weekly_questions_options_check
    check (pg_catalog.jsonb_typeof(options) = 'array' and pg_catalog.jsonb_array_length(options) <= 8),
  add constraint member_weekly_questions_editorial_state_check
    check (editorial_state in ('submitted', 'reserved', 'published', 'archived')),
  add constraint member_weekly_questions_editor_note_check
    check (editor_note is null or pg_catalog.char_length(editor_note) <= 1000),
  add constraint member_weekly_questions_published_link_check
    check (
      (editorial_state = 'published' and published_survey_id is not null)
      or (editorial_state <> 'published' and published_survey_id is null)
    );

create index member_weekly_questions_editorial_idx
  on public.member_weekly_questions (chapter_id, editorial_state, week_start desc, created_at, id);

create function public.submit_weekly_poll_question(p_body text, p_options jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date;
  clean_body text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]', ' ', 'g'));
  option_item jsonb;
  option_value text;
  option_values text[] := array[]::text[];
  clean_options jsonb := '[]'::jsonb;
  question_id uuid;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 10 and 280
     or pg_catalog.jsonb_typeof(p_options) <> 'array'
     or pg_catalog.jsonb_array_length(p_options) not between 2 and 8 then
    raise exception 'question and 2 to 8 answer options are required' using errcode = '22023';
  end if;
  for option_item in select value from pg_catalog.jsonb_array_elements(p_options)
  loop
    option_value := case when pg_catalog.jsonb_typeof(option_item) = 'string' then option_item #>> '{}' else null end;
    option_value := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(option_value, ''), '[[:cntrl:]]', ' ', 'g'));
    if pg_catalog.char_length(option_value) not between 1 and 120 then
      raise exception 'answer options must be plain text up to 120 characters' using errcode = '22023';
    end if;
    if option_value = any(option_values) then
      raise exception 'answer options must be unique' using errcode = '22023';
    end if;
    option_values := pg_catalog.array_append(option_values, option_value);
    clean_options := clean_options || pg_catalog.jsonb_build_array(option_value);
  end loop;

  insert into public.member_weekly_questions (chapter_id, user_id, week_start, body, options)
  values (caller_chapter, caller, current_week, clean_body, clean_options)
  on conflict (user_id, week_start) do nothing
  returning id into question_id;
  inserted := question_id is not null;
  if not inserted then
    select q.id into question_id
    from public.member_weekly_questions q
    where q.user_id = caller and q.week_start = current_week
    for update;
    update public.member_weekly_questions
    set body = clean_body, options = clean_options, updated_at = pg_catalog.now()
    where id = question_id and editorial_state = 'submitted';
    if not found then
      raise exception 'reserved or published questions cannot be edited' using errcode = '22023';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('id', question_id, 'created', inserted);
end;
$function$;

revoke all on function public.submit_weekly_poll_question(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.submit_weekly_poll_question(text, jsonb) to authenticated;
revoke all on function public.submit_weekly_question(text) from public, anon, authenticated, service_role;

create or replace function public.list_weekly_questions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ranked.id,
      'body', ranked.body,
      'options', ranked.options,
      'editorialState', ranked.editorial_state,
      'submittedByMe', ranked.user_id = caller,
      'boostedByMe', ranked.boosted_by_me,
      'priority', ranked.priority,
      'score', ranked.score,
      'createdAt', ranked.created_at
    ) order by ranked.priority desc, ranked.score desc, ranked.created_at, ranked.id)
    from (
      select q.id, q.user_id, q.body, q.options, q.editorial_state, q.created_at,
        private.member_reward_effect_enabled(q.user_id, 'priority-wq-slot') as priority,
        exists (
          select 1 from public.member_weekly_question_supports mine
          where mine.question_id = q.id and mine.user_id = caller
        ) as boosted_by_me,
        coalesce((
          select pg_catalog.sum(case
            when private.member_reward_effect_enabled(s.user_id, 'wq-boost-2x') then 2 else 1 end)::integer
          from public.member_weekly_question_supports s where s.question_id = q.id
        ), 0) as score
      from public.member_weekly_questions q
      where q.chapter_id = caller_chapter
        and q.week_start = current_week
        and q.editorial_state in ('submitted', 'reserved', 'published')
      order by priority desc, score desc, q.created_at, q.id
      limit 25
    ) ranked
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_weekly_questions() from public, anon, authenticated, service_role;
grant execute on function public.list_weekly_questions() to authenticated;

create or replace function public.boost_weekly_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_question_id is null or not exists (
    select 1 from public.member_weekly_questions q
    where q.id = p_question_id
      and q.chapter_id = caller_chapter
      and q.week_start = current_week
      and q.editorial_state in ('submitted', 'reserved')
      and q.user_id <> caller
  ) then
    raise exception 'question unavailable' using errcode = '22023';
  end if;
  insert into public.member_weekly_question_supports (question_id, user_id)
  values (p_question_id, caller)
  on conflict (question_id, user_id) do nothing;
  inserted := found;
  return pg_catalog.jsonb_build_object(
    'questionId', p_question_id,
    'created', inserted,
    'weight', case when private.member_reward_effect_enabled(caller, 'wq-boost-2x') then 2 else 1 end
  );
end;
$function$;

revoke all on function public.boost_weekly_question(uuid) from public, anon, authenticated, service_role;
grant execute on function public.boost_weekly_question(uuid) to authenticated;

create function public.list_weekly_question_editorial()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  caller_chapter text := private.current_member_chapter();
begin
  perform private.engagement_require_staff(org);
  if caller_chapter is null or not private.mi1_w2_same_org_chapter(org, caller_chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', q.id,
      'body', q.body,
      'options', q.options,
      'editorialState', q.editorial_state,
      'editorNote', q.editor_note,
      'weekStart', q.week_start,
      'score', coalesce(supports.score, 0),
      'publishedSurveyId', q.published_survey_id,
      'createdAt', q.created_at,
      'updatedAt', q.updated_at
    ) order by q.week_start desc, q.created_at, q.id)
    from public.member_weekly_questions q
    left join lateral (
      select coalesce(pg_catalog.sum(case
        when private.member_reward_effect_enabled(s.user_id, 'wq-boost-2x') then 2 else 1 end
      ), 0)::integer as score
      from public.member_weekly_question_supports s where s.question_id = q.id
    ) supports on true
    where q.chapter_id = caller_chapter
      and q.week_start >= (pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date - 84)
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_weekly_question_editorial() from public, anon, authenticated, service_role;
grant execute on function public.list_weekly_question_editorial() to authenticated;

create function public.review_weekly_poll_question(
  p_question_id uuid,
  p_editorial_state text,
  p_editor_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  caller_chapter text := private.current_member_chapter();
begin
  perform private.engagement_require_staff(org);
  if caller_chapter is null or not private.mi1_w2_same_org_chapter(org, caller_chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  if p_editorial_state not in ('submitted', 'reserved', 'archived')
     or pg_catalog.char_length(coalesce(p_editor_note, '')) > 1000 then
    raise exception 'invalid editorial decision' using errcode = '22023';
  end if;
  update public.member_weekly_questions q
  set editorial_state = p_editorial_state,
      editor_note = nullif(pg_catalog.btrim(coalesce(p_editor_note, '')), ''),
      published_survey_id = null,
      updated_at = pg_catalog.now()
  where q.id = p_question_id
    and q.chapter_id = caller_chapter
    and q.editorial_state <> 'published';
  if not found then raise exception 'editable weekly question not found' using errcode = 'P0002'; end if;
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'questionId', p_question_id,
    'status', p_editorial_state, 'action', 'weekly_question_reviewed'
  ));
  return pg_catalog.jsonb_build_object('id', p_question_id, 'editorialState', p_editorial_state);
end;
$function$;

revoke all on function public.review_weekly_poll_question(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.review_weekly_poll_question(uuid, text, text) to authenticated;

create function public.publish_weekly_poll_question(
  p_question_id uuid,
  p_privacy_min_responses integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  source_question public.member_weekly_questions%rowtype;
  survey_id uuid;
begin
  perform private.engagement_require_staff(org);
  if caller_chapter is null or not private.mi1_w2_same_org_chapter(org, caller_chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  if p_privacy_min_responses not between 3 and 50 then
    raise exception 'privacy floor must be between 3 and 50' using errcode = '22023';
  end if;
  select * into source_question
  from public.member_weekly_questions q
  where q.id = p_question_id
    and q.chapter_id = caller_chapter
    and q.editorial_state in ('submitted', 'reserved')
  for update;
  if not found then raise exception 'publishable weekly question not found' using errcode = 'P0002'; end if;
  if pg_catalog.jsonb_array_length(source_question.options) not between 2 and 8 then
    raise exception 'weekly question requires answer options' using errcode = '22023';
  end if;

  insert into public.organization_surveys (
    organization_id, chapter_id, title, description, status,
    privacy_min_responses, created_by
  ) values (
    org, caller_chapter, pg_catalog.left(source_question.body, 200),
    'Member-authored weekly question', 'open', p_privacy_min_responses, caller
  ) returning id into survey_id;
  insert into public.organization_survey_questions (
    organization_id, survey_id, sort_index, client_key, question_type, label,
    required, options, section_key, section_title
  ) values (
    org, survey_id, 0, 'weekly-question', 'radio', source_question.body,
    true, source_question.options, 'weekly', 'Weekly member question'
  );
  update public.member_weekly_questions
  set editorial_state = 'published', published_survey_id = survey_id, updated_at = pg_catalog.now()
  where id = source_question.id;
  perform private.mi1_w2_write_audit(org, 'survey_published', pg_catalog.jsonb_build_object(
    'organizationId', org, 'questionId', source_question.id,
    'surveyId', survey_id, 'privacyMinResponses', p_privacy_min_responses,
    'status', 'open', 'action', 'weekly_question_published'
  ));
  return pg_catalog.jsonb_build_object(
    'questionId', source_question.id, 'surveyId', survey_id, 'state', 'published'
  );
end;
$function$;

revoke all on function public.publish_weekly_poll_question(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.publish_weekly_poll_question(uuid, integer) to authenticated;
