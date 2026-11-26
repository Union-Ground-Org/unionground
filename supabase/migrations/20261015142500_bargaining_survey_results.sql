-- REQ-UG-BARGAINING-SURVEY-20261012
--
-- Build-it-all campaign (bargaining survey). A leader starts a
-- bargaining survey from the sourced template in
-- content/bargaining-survey/template.json through the existing survey editor
-- and publishing path; its questions keep the template's section keys
-- ('bargaining-v1:<section>') and client keys ('bargaining-v1:<question>').
-- public.get_bargaining_survey_results() is the results read behind the
-- leader dashboard and its export:
--
--   * staff of the selected organization only (private.engagement_require_staff:
--     MFA plus steward, coordinator, advisor, admin or VP), only while that
--     organization has turned on features.engagement_voice.bargaining_survey_template,
--     and only a survey of that organization carrying at least one template
--     question;
--   * the existing small-group suppression: nothing but the response count is
--     returned until the survey has at least
--       greatest(25, limits.analytics.anonymity_floor, the survey's own floor)
--     submitted responses, and a question answered by fewer than that many is
--     withheld on its own, so an optional question never shows a smaller group
--     than the survey does. The floor never drops below 25 whatever an
--     organization sets;
--   * totals only, for the whole survey: no subgroup, worksite or date-window
--     breakdown, and no written answer text (written questions report how
--     many answered);
--   * the window and version facts the export's provenance cites: the
--     survey's own open and close times, its last edit, the first and last
--     submission (only once results are shown) and the generation time.
--
-- The template's contract choices are the articles of one agreement (Units 8
-- and 10, 2024-2026), so it is an organization activation, not a default:
-- the new switch features.engagement_voice.bargaining_survey_template starts
-- OFF for every organization, the Engagement tab offers the template only
-- when it is on, and this read refuses (42501) when it is off. An
-- organization covered by that agreement turns it on in its settings.
--
-- No new table; the only row written is the switch's platform setting
-- definition. A deferred constraint trigger keeps every bargaining survey's
-- own floor at 25 or more, so the existing report and export readers, which
-- use that floor, cannot show such a survey's totals below 25 either. The generic staff report and export keep their own
-- floor and behaviour unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.engagement_voice.bargaining_survey_template', 'boolean', 'Bargaining survey from the Units 8 and 10 agreement',
   'Staff can start a bargaining survey built on the articles of the Units 8 and 10 agreement (2024 to 2026) and read its totals once 25 members answer. Turn on only for an organization that agreement covers. Off: not offered.',
   'false', null, null, null, 130, 'engagement_voice', true)
on conflict (key) do nothing;

create function public.get_bargaining_survey_results(p_survey_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  organization_name text;
  floor_size integer;
  responses integer;
  first_submitted timestamptz;
  last_submitted timestamptz;
  base jsonb;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_feature_enabled(org, 'features.engagement_voice.bargaining_survey_template') then
    raise exception 'bargaining survey template is off for this organization' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = survey.id and question.organization_id = org
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    raise exception 'not a bargaining survey' using errcode = 'P0002';
  end if;
  select o.name into organization_name from public.organizations o where o.id = org;
  floor_size := greatest(
    25,
    coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25),
    survey.privacy_min_responses
  );
  select pg_catalog.count(*)::integer, pg_catalog.min(session.submitted_at), pg_catalog.max(session.submitted_at)
  into responses, first_submitted, last_submitted
  from public.organization_survey_sessions session
  where session.organization_id = org and session.survey_id = survey.id and session.status = 'submitted';

  base := pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'organizationName', organization_name,
    'title', survey.title,
    'status', survey.status,
    'surveyUpdatedAt', survey.updated_at,
    'opensAt', survey.opens_at,
    'closesAt', survey.closes_at,
    'generatedAt', pg_catalog.now(),
    'responseCount', responses,
    'minimumResponses', floor_size
  );
  if responses < floor_size then
    return base || pg_catalog.jsonb_build_object('available', false, 'questions', '[]'::jsonb);
  end if;

  return base || pg_catalog.jsonb_build_object(
    'available', true,
    'firstSubmittedAt', first_submitted,
    'lastSubmittedAt', last_submitted,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(
        case when counted.answered < floor_size then pg_catalog.jsonb_build_object(
          'id', counted.id, 'clientKey', counted.client_key, 'sectionKey', counted.section_key,
          'type', counted.question_type, 'label', counted.label, 'options', counted.options,
          'withheld', true, 'answered', null, 'distribution', '[]'::jsonb
        ) else pg_catalog.jsonb_build_object(
          'id', counted.id, 'clientKey', counted.client_key, 'sectionKey', counted.section_key,
          'type', counted.question_type, 'label', counted.label, 'options', counted.options,
          'withheld', false, 'answered', counted.answered,
          'distribution', case
            when counted.question_type in ('text', 'paragraph') then '[]'::jsonb
            when counted.question_type = 'checkbox' then (
              select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
              from (
                select chosen.value, pg_catalog.count(distinct answer.session_id)::integer as count
                from public.organization_survey_answers answer
                join public.organization_survey_sessions session
                  on session.id = answer.session_id and session.organization_id = org
                 and session.survey_id = survey.id and session.status = 'submitted'
                cross join lateral pg_catalog.jsonb_array_elements(
                  case when pg_catalog.jsonb_typeof(answer.value) = 'array' then answer.value else '[]'::jsonb end
                ) chosen(value)
                where answer.question_id = counted.id and answer.organization_id = org
                group by chosen.value
              ) bucket
            )
            else (
              select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
              from (
                select answer.value, pg_catalog.count(*)::integer as count
                from public.organization_survey_answers answer
                join public.organization_survey_sessions session
                  on session.id = answer.session_id and session.organization_id = org
                 and session.survey_id = survey.id and session.status = 'submitted'
                where answer.question_id = counted.id and answer.organization_id = org
                group by answer.value
              ) bucket
            )
          end
        ) end
        order by counted.sort_index, counted.id
      )
      from (
        select question.id, question.client_key, question.section_key, question.question_type,
          question.label, question.options, question.sort_index,
          (
            select pg_catalog.count(*)::integer
            from public.organization_survey_answers answer
            join public.organization_survey_sessions session
              on session.id = answer.session_id and session.organization_id = org
             and session.survey_id = survey.id and session.status = 'submitted'
            where answer.question_id = question.id and answer.organization_id = org
              and answer.value not in ('null'::jsonb, '[]'::jsonb, '""'::jsonb)
          ) as answered
        from public.organization_survey_questions question
        where question.survey_id = survey.id and question.organization_id = org
      ) counted
    ), '[]'::jsonb)
  );
end;
$function$;

comment on function public.get_bargaining_survey_results(uuid) is
  'REQ-UG-BARGAINING-SURVEY-20261012: staff-only totals for a bargaining-template survey of the selected organization, only while its switch features.engagement_voice.bargaining_survey_template is on; nothing but the response count below greatest(25, limits.analytics.anonymity_floor, the survey floor) submitted responses, each question withheld below the same floor, no written answer text and no subgroup or date-window breakdown.';

revoke all on function public.get_bargaining_survey_results(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_bargaining_survey_results(uuid)
  to authenticated;

-- The existing staff report, review and export readers each honour the
-- survey's own privacy_min_responses. So that none of them can show a
-- bargaining survey's totals below 25, a survey carrying a template question
-- may not keep a floor under 25: checked at commit, whichever order a save
-- writes the survey row and its questions, and whichever path writes the
-- floor (draft save, publish, the card's floor control).
create function private.enforce_bargaining_survey_floor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target uuid;
begin
  if tg_table_name = 'organization_surveys' then
    target := new.id;
  else
    target := new.survey_id;
  end if;
  if exists (
    select 1 from public.organization_surveys survey
    where survey.id = target and survey.privacy_min_responses < 25
      and exists (
        select 1 from public.organization_survey_questions question
        where question.survey_id = survey.id
          and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
      )
  ) then
    raise exception 'a bargaining survey keeps a privacy floor of at least 25' using errcode = '22023';
  end if;
  return null;
end;
$function$;

revoke all on function private.enforce_bargaining_survey_floor()
  from public, anon, authenticated, service_role;

create constraint trigger organization_surveys_bargaining_floor
  after insert or update of privacy_min_responses on public.organization_surveys
  deferrable initially deferred
  for each row execute function private.enforce_bargaining_survey_floor();

create constraint trigger organization_survey_questions_bargaining_floor
  after insert or update of section_key on public.organization_survey_questions
  deferrable initially deferred
  for each row execute function private.enforce_bargaining_survey_floor();

-- Review fix: the floor alone still let the generic readers show a
-- bargaining survey below the organization's anonymity floor, and the review
-- lane and raw exports return each member's answers. A bargaining survey is
-- read only through get_bargaining_survey_results: both generic reports (and
-- the two exports built on them) refuse it, and its review lane stays
-- totals_only, so get_organization_survey_review_detail returns no answers.
create or replace function public.get_organization_survey_report(p_survey_id uuid)
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
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- REQ-UG-BARGAINING-SURVEY-20261012: a bargaining survey reports
  -- totals only, through get_bargaining_survey_results.
  if exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = survey.id
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    raise exception 'a bargaining survey reports totals only' using errcode = '42501';
  end if;
  select pg_catalog.count(*)::integer into responses
  from public.organization_survey_sessions session
  where session.organization_id = org and session.survey_id = survey.id and session.status = 'submitted';
  if responses < survey.privacy_min_responses then
    return pg_catalog.jsonb_build_object(
      'surveyId', survey.id,
      'responseCount', responses,
      'privacyMinResponses', survey.privacy_min_responses,
      'available', false,
      'questions', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'title', survey.title,
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
          join public.organization_survey_sessions session on session.id = answer.session_id
          where answer.question_id = question.id and session.status = 'submitted'
        ),
        'distribution', case
          when question.question_type in ('radio', 'dropdown', 'yes_no', 'scale', 'rating') then (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
            from (
              select answer.value, pg_catalog.count(*)::integer as count
              from public.organization_survey_answers answer
              join public.organization_survey_sessions session on session.id = answer.session_id
              where answer.question_id = question.id and session.status = 'submitted'
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

create or replace function public.get_organization_survey_report_window(
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
  -- REQ-UG-BARGAINING-SURVEY-20261012: a bargaining survey reports
  -- totals only, through get_bargaining_survey_results.
  if exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = survey.id
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    raise exception 'a bargaining survey reports totals only' using errcode = '42501';
  end if;
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

create or replace function private.organization_survey_review_lane(p_organization_id uuid, p_survey_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'state', case
      when exists (
        select 1 from public.organization_survey_questions question
        where question.survey_id = survey.id
          and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
      ) then 'totals_only'
      when counted.responses >= survey.privacy_min_responses then 'ready'
      else 'collecting'
    end,
    'responseCount', counted.responses,
    'privacyMinResponses', survey.privacy_min_responses
  )
  from public.organization_surveys survey
  cross join lateral (
    select pg_catalog.count(*)::integer as responses
    from public.organization_survey_sessions session
    where session.organization_id = p_organization_id
      and session.survey_id = survey.id
      and session.status = 'submitted'
  ) counted
  where survey.id = p_survey_id and survey.organization_id = p_organization_id
$function$;

-- Review fix: the admin worksite split read the survey floor only
-- and split a bargaining survey by worksite; it now refuses one too.
create or replace function public.get_organization_survey_worksites(p_survey_id uuid)
-- VOLATILE because the first successful release records a digest and a later
-- changed release permanently withholds it. This is an explicit button action,
-- never a passive read-RPC probe or a GET request.
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  org uuid;
  survey public.organization_surveys%rowtype;
  result jsonb;
  current_signature text;
  released private.organization_survey_worksite_releases%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  org := private.engagement_selected_organization();
  if auth.uid() is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys where id=p_survey_id and organization_id=org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- REQ-UG-BARGAINING-SURVEY-20261012: no worksite split of a
  -- bargaining survey; its totals come only from get_bargaining_survey_results.
  if exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = survey.id
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    raise exception 'a bargaining survey reports totals only' using errcode = '42501';
  end if;
  -- Serialize the first publication and comparisons for this survey. The
  -- digest and aggregates below share one statement snapshot, even if another
  -- transaction changes a profile, membership or answer during this request.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('worksite-release:' || survey.id::text, 0));
  select * into released from private.organization_survey_worksite_releases where survey_id=survey.id;
  if released.invalidated then
    return pg_catalog.jsonb_build_object('privacyMinResponses',survey.privacy_min_responses,
      'withheld',true,'releaseChanged',true,'groups','[]'::jsonb);
  end if;
  with sessions as materialized (
    select s.id,
      case when d.details_visibility='admins' then nullif(pg_catalog.btrim(d.worksite), '') end as site
    from public.organization_survey_sessions s
    left join public.member_profile_details d on d.user_id=s.respondent_user_id
      and exists (select 1 from public.organization_memberships m
        where m.user_id=s.respondent_user_id and m.organization_id=org and m.status='active')
      and exists (select 1 from public.member_chapter_memberships m
        join public.chapters c on c.id=m.chapter_id and c.organization_id=org
        where m.user_id=s.respondent_user_id and m.status='active')
    where s.organization_id=org and s.survey_id=survey.id and s.status='submitted'
  ), groups as materialized (
    select site, pg_catalog.count(*)::integer as n from sessions group by site
  ), hidden as (
    select * from groups where site is null or n < survey.privacy_min_responses
  ), visible as materialized (
    select * from groups g where g.site is not null and g.n >= survey.privacy_min_responses
      and (not exists (select 1 from hidden)
        or g.site <> (select g2.site from groups g2 where g2.site is not null
          and g2.n >= survey.privacy_min_responses order by g2.n, g2.site limit 1))
  ), cells as materialized (
    select q.id as question_id, s.site, a.value, pg_catalog.count(*)::integer as n
    from sessions s
    join public.organization_survey_answers a on a.session_id=s.id and a.organization_id=org
    join public.organization_survey_questions q on q.id=a.question_id
      and q.survey_id=survey.id and q.organization_id=org
    where q.question_type in ('radio','dropdown','yes_no','scale','rating')
    group by q.id, s.site, a.value
  ), unsafe as (
    select distinct c.question_id from cells c join groups g on g.site is not distinct from c.site
      where c.n < survey.privacy_min_responses
        or (g.n-c.n > 0 and g.n-c.n < survey.privacy_min_responses)
    union
    select q.id from public.organization_survey_questions q cross join groups g
      where q.survey_id=survey.id and q.organization_id=org
        and g.n - coalesce((select sum(c.n) from cells c where c.question_id=q.id
          and c.site is not distinct from g.site),0) between 1 and survey.privacy_min_responses-1
    union
    -- The largest cell has the smallest complement. If it is nonzero and
    -- small, hide the question everywhere, including sites with zero cells.
    select c.question_id from cells c group by c.question_id, c.value
      having sum(c.n)-max(c.n) between 1 and survey.privacy_min_responses-1
  )
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'minimum',survey.privacy_min_responses,
      'sessions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(s.id,s.site) order by s.id) from sessions s),
      'answers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.session_id,a.question_id,a.value) order by a.session_id,a.question_id)
        from public.organization_survey_answers a join sessions s on s.id=a.session_id
        where a.organization_id=org),
      'questions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(q.id,q.question_type,q.label,q.sort_index) order by q.id)
        from public.organization_survey_questions q where q.survey_id=survey.id and q.organization_id=org)
    )::text, 'UTF8')), 'hex'), pg_catalog.jsonb_build_object(
    'privacyMinResponses',survey.privacy_min_responses,
    'withheld',exists(select 1 from groups g where not exists(select 1 from visible v where v.site=g.site)),
    'groups',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'worksite',v.site,'responseCount',v.n,
      'questions',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',q.id,'label',q.label,
        'available',not exists(select 1 from unsafe u where u.question_id=q.id),
        'distribution',case when exists(select 1 from unsafe u where u.question_id=q.id) then '[]'::jsonb
          else coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value',c.value,'count',c.n) order by c.value)
            from cells c where c.question_id=q.id and c.site=v.site),'[]'::jsonb) end
      ) order by q.sort_index) from public.organization_survey_questions q
        where q.survey_id=survey.id and q.organization_id=org
          and q.question_type in ('radio','dropdown','yes_no','scale','rating')),'[]'::jsonb)
    ) order by v.site) from visible v),'[]'::jsonb)
  ) into current_signature, result;
  if released.signature is not null and released.signature <> current_signature then
    update private.organization_survey_worksite_releases set invalidated=true where survey_id=survey.id;
    return pg_catalog.jsonb_build_object('privacyMinResponses',survey.privacy_min_responses,
      'withheld',true,'releaseChanged',true,'groups','[]'::jsonb);
  end if;
  -- An entirely suppressed response publishes no cohort counts. It must not
  -- prevent the first useful report after enough responses arrive.
  if released.signature is null and pg_catalog.jsonb_array_length(result->'groups') > 0 then
    insert into private.organization_survey_worksite_releases(survey_id,signature)
      values(survey.id,current_signature);
  end if;
  return result;
end;
$function$;

-- Review fix: the hourly sweep opened a response review task once
-- a bargaining survey reached its floor; it opens none now.
create or replace function private.open_survey_follow_up_task(
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
  -- REQ-UG-BARGAINING-SURVEY-20261012: a bargaining survey's
  -- individual responses are never shown, so no response review is opened.
  if p_reason = 'response_review' and exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = p_survey.id
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    return false;
  end if;
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

comment on function private.organization_survey_review_lane(uuid, uuid) is
  'Review-lane privacy state of one survey in one organization: totals_only for a bargaining-template survey (REQ-UG-BARGAINING-SURVEY-20261012), otherwise collecting until the submitted responses reach the survey privacy_min_responses, then ready. Null when the survey is not in that organization.';

-- The account lifecycle trigger inventory reviews every trigger and trigger
-- function; the floor check touches no account data.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger'
    and schema_name = 'public'
    and ((table_name = 'organization_surveys' and object_name = 'organization_surveys_bargaining_floor')
      or (table_name = 'organization_survey_questions' and object_name = 'organization_survey_questions_bargaining_floor')))
  or (kind = 'function'
    and schema_name = 'private'
    and object_name = 'enforce_bargaining_survey_floor()')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_bargaining_floor_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the bargaining survey floor';
  end if;
end;
$assert_bargaining_floor_trigger_review$;

commit;
