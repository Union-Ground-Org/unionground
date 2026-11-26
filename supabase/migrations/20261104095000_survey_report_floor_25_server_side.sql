-- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104 (#7018).
--
-- #7017 (20261104073000) holds the organization anonymity floor at 25 on the
-- server, but the generic organization survey readers still released results
-- at the survey's own privacy_min_responses, which publishing accepts from 3
-- to 50. A survey published with a floor of 3 showed and exported totals for
-- groups of 3. Each reader below now holds its floor at
--   greatest(25, limits.analytics.anonymity_floor through
--            private.organization_limit, the survey's own floor),
-- the same rule get_bargaining_survey_results already uses:
--
--   1. public.get_organization_survey_report, and so
--      public.export_organization_survey_results (it returns no response rows
--      unless this report is available).
--   2. public.get_organization_survey_report_window, and so
--      public.export_organization_survey_window (it refuses with 22023 unless
--      this report is available). The floor still applies to the responses
--      inside the window.
--      In both reports each question is also held at the same floor: a
--      question answered by fewer people (an optional question, say) is
--      returned withheld, with no answer count and no distribution, as
--      get_bargaining_survey_results already does. A blank answer (null, an
--      empty list, or a string of only whitespace: spaces, tabs, carriage
--      returns, line feeds) does not count.
--   3. public.get_organization_survey_worksites: the group, cell and
--      complement suppression and the release digest use the held floor. A
--      worksite release first recorded under a smaller floor no longer matches
--      its digest and stays withheld, the conservative outcome.
--   4. private.organization_survey_review_lane, so the per-response review
--      (get_organization_survey_review_detail) and the staff survey pages stay
--      collecting until the survey has the held number of responses.
--   5. private.survey_operations_state: reviewReady uses the held floor, so
--      the operations sweep (run_survey_operations_sweep) opens no
--      response_review task and get_survey_operations_attention raises no
--      review escalation before the review lane and the reports open.
--   6. Both exports leave out of every response row the answers to a question
--      their report withholds.
--
-- Each payload's privacyMinResponses (the worksite digest's minimum) now
-- reports the held floor. Existing surveys are not rewritten: no
-- organization_surveys row changes, and publishing and
-- set_organization_survey_privacy_floor still accept 3 to 50 for the survey's
-- own floor. Volatility, signatures and grants are unchanged (create or
-- replace keeps the grants); each report question gains a withheld flag.
--
-- Apply order: after 20261104073000_privacy_floor_25_server_side.sql (on
-- Main) and after the migrations open at the time of writing,
-- 20261104074500 (#7016), 20261104075000 (#7000), 20261104080000 (#7020) and
-- 20261104090000 (#7022). Nothing here depends on any of them.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- Pin the predecessors so a concurrent change is not lost.
do $assert_survey_floor_predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_survey_report(uuid)'::pg_catalog.regprocedure))
      <> '474e62309a5faa04b3adb4b6987b273f' then
    raise exception 'Unreviewed survey report predecessor: integrate current Main before holding the survey floor at 25';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_survey_report_window(uuid,timestamptz,timestamptz)'::pg_catalog.regprocedure))
      <> 'c015dfce6603ef806afa881bad656e26' then
    raise exception 'Unreviewed survey report window predecessor: integrate current Main before holding the survey floor at 25';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_survey_worksites(uuid)'::pg_catalog.regprocedure))
      <> 'cd8408f18c9703ff5378643b277ede73' then
    raise exception 'Unreviewed survey worksite predecessor: integrate current Main before holding the survey floor at 25';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.organization_survey_review_lane(uuid,uuid)'::pg_catalog.regprocedure))
      <> '20a6ff2ada2f65d0806705c49e558cca' then
    raise exception 'Unreviewed survey review lane predecessor: integrate current Main before holding the survey floor at 25';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.survey_operations_state(uuid)'::pg_catalog.regprocedure))
      <> '60ce532ae63a46effb191cce7dbaba4f' then
    raise exception 'Unreviewed survey operations state predecessor: integrate current Main before holding the survey floor at 25';
  end if;
  -- The exports read their floor through the two reports.
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.export_organization_survey_results(uuid)'::pg_catalog.regprocedure))
      <> '9cd16436d4389b5a905840dd8b35e460' then
    raise exception 'Unreviewed survey export predecessor: integrate current Main before holding the survey floor at 25';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.export_organization_survey_window(uuid,timestamptz,timestamptz,text)'::pg_catalog.regprocedure))
      <> '7cc03dcf68f1e5b8cd5d721ab0dcdab8' then
    raise exception 'Unreviewed survey window export predecessor: integrate current Main before holding the survey floor at 25';
  end if;
end;
$assert_survey_floor_predecessors$;

-- 1. Survey report. Everything else in the body is unchanged from 20261028080000.
CREATE OR REPLACE FUNCTION public.get_organization_survey_report(p_survey_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  responses integer;
  floor_size integer;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: never
  -- below 25 or the organization floor, whatever the survey's own floor.
  floor_size := greatest(25, coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25), survey.privacy_min_responses);
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
  if responses < floor_size then
    return pg_catalog.jsonb_build_object(
      'surveyId', survey.id,
      'responseCount', responses,
      'privacyMinResponses', floor_size,
      'available', false,
      'questions', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'title', survey.title,
    'responseCount', responses,
    'privacyMinResponses', floor_size,
    'available', true,
    'questions', coalesce((
      -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104 (gate r2):
      -- a question answered by fewer people than the held floor is withheld.
      select pg_catalog.jsonb_agg(case when counted.answered < floor_size then pg_catalog.jsonb_build_object(
        'id', question.id,
        'label', question.label,
        'type', question.question_type,
        'withheld', true,
        'answered', null,
        'distribution', '[]'::jsonb
      ) else pg_catalog.jsonb_build_object(
        'id', question.id,
        'label', question.label,
        'type', question.question_type,
        'withheld', false,
        'answered', counted.answered,
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
      ) end order by question.sort_index)
      from public.organization_survey_questions question
      cross join lateral (
        select pg_catalog.count(*)::integer as answered
        from public.organization_survey_answers answer
        join public.organization_survey_sessions session on session.id = answer.session_id
        where answer.question_id = question.id and session.status = 'submitted'
          -- Gate r3: a blank optional answer is stored verbatim (an empty or
          -- whitespace-only string, null or an empty list) and is not an answer.
          and answer.value not in ('null'::jsonb, '[]'::jsonb, '""'::jsonb)
          and not (pg_catalog.jsonb_typeof(answer.value) = 'string' and (answer.value #>> '{}') ~ '^[[:space:]]*$')
      ) counted
      where question.survey_id = survey.id and question.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;

-- 2. Survey report for a submitted-date window. Everything else in the body
-- is unchanged from 20261028080000.
CREATE OR REPLACE FUNCTION public.get_organization_survey_report_window(p_survey_id uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  responses integer;
  floor_size integer;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.engagement_voice.survey_report_exports') then
    raise exception 'survey report exports are turned off' using errcode = '55000';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'invalid report window' using errcode = '22023';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: never
  -- below 25 or the organization floor, whatever the survey's own floor.
  floor_size := greatest(25, coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25), survey.privacy_min_responses);
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
  if responses < floor_size then
    return pg_catalog.jsonb_build_object(
      'surveyId', survey.id, 'title', survey.title,
      'from', p_from, 'to', p_to,
      'responseCount', responses,
      'privacyMinResponses', floor_size,
      'available', false,
      'questions', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'title', survey.title,
    'from', p_from, 'to', p_to,
    'responseCount', responses,
    'privacyMinResponses', floor_size,
    'available', true,
    'questions', coalesce((
      -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104 (gate r2):
      -- a question answered by fewer people than the held floor is withheld.
      select pg_catalog.jsonb_agg(case when counted.answered < floor_size then pg_catalog.jsonb_build_object(
        'id', question.id,
        'label', question.label,
        'type', question.question_type,
        'withheld', true,
        'answered', null,
        'distribution', '[]'::jsonb
      ) else pg_catalog.jsonb_build_object(
        'id', question.id,
        'label', question.label,
        'type', question.question_type,
        'withheld', false,
        'answered', counted.answered,
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
      ) end order by question.sort_index)
      from public.organization_survey_questions question
      cross join lateral (
        select pg_catalog.count(*)::integer as answered
        from public.organization_survey_answers answer
        where answer.question_id = question.id
          and answer.session_id in (select private.survey_window_sessions(org, survey.id, p_from, p_to))
          -- Gate r3: a blank optional answer is stored verbatim (an empty or
          -- whitespace-only string, null or an empty list) and is not an answer.
          and answer.value not in ('null'::jsonb, '[]'::jsonb, '""'::jsonb)
          and not (pg_catalog.jsonb_typeof(answer.value) = 'string' and (answer.value #>> '{}') ~ '^[[:space:]]*$')
      ) counted
      where question.survey_id = survey.id and question.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;

-- 3. Admin worksite split. Everything else in the body is unchanged from
-- 20261028080000.
CREATE OR REPLACE FUNCTION public.get_organization_survey_worksites(p_survey_id uuid)
 RETURNS jsonb
 language plpgsql volatile security definer
 SET search_path TO ''
AS $function$
declare
  org uuid;
  survey public.organization_surveys%rowtype;
  result jsonb;
  current_signature text;
  released private.organization_survey_worksite_releases%rowtype;
  floor_size integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  org := private.engagement_selected_organization();
  if auth.uid() is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys where id=p_survey_id and organization_id=org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: never
  -- below 25 or the organization floor, whatever the survey's own floor.
  floor_size := greatest(25, coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25), survey.privacy_min_responses);
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
    return pg_catalog.jsonb_build_object('privacyMinResponses',floor_size,
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
    select * from groups where site is null or n < floor_size
  ), visible as materialized (
    select * from groups g where g.site is not null and g.n >= floor_size
      and (not exists (select 1 from hidden)
        or g.site <> (select g2.site from groups g2 where g2.site is not null
          and g2.n >= floor_size order by g2.n, g2.site limit 1))
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
      where c.n < floor_size
        or (g.n-c.n > 0 and g.n-c.n < floor_size)
    union
    select q.id from public.organization_survey_questions q cross join groups g
      where q.survey_id=survey.id and q.organization_id=org
        and g.n - coalesce((select sum(c.n) from cells c where c.question_id=q.id
          and c.site is not distinct from g.site),0) between 1 and floor_size-1
    union
    -- The largest cell has the smallest complement. If it is nonzero and
    -- small, hide the question everywhere, including sites with zero cells.
    select c.question_id from cells c group by c.question_id, c.value
      having sum(c.n)-max(c.n) between 1 and floor_size-1
  )
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'minimum',floor_size,
      'sessions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(s.id,s.site) order by s.id) from sessions s),
      'answers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.session_id,a.question_id,a.value) order by a.session_id,a.question_id)
        from public.organization_survey_answers a join sessions s on s.id=a.session_id
        where a.organization_id=org),
      'questions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(q.id,q.question_type,q.label,q.sort_index) order by q.id)
        from public.organization_survey_questions q where q.survey_id=survey.id and q.organization_id=org)
    )::text, 'UTF8')), 'hex'), pg_catalog.jsonb_build_object(
    'privacyMinResponses',floor_size,
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
    return pg_catalog.jsonb_build_object('privacyMinResponses',floor_size,
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

-- 4. Review lane. Everything else in the body is unchanged from 20261015142500.
CREATE OR REPLACE FUNCTION private.organization_survey_review_lane(p_organization_id uuid, p_survey_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'state', case
      when exists (
        select 1 from public.organization_survey_questions question
        where question.survey_id = survey.id
          and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
      ) then 'totals_only'
      when counted.responses >= floored.floor_size then 'ready'
      else 'collecting'
    end,
    'responseCount', counted.responses,
    'privacyMinResponses', floored.floor_size
  )
  from public.organization_surveys survey
  cross join lateral (
    select pg_catalog.count(*)::integer as responses
    from public.organization_survey_sessions session
    where session.organization_id = p_organization_id
      and session.survey_id = survey.id
      and session.status = 'submitted'
  ) counted
  -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: never
  -- below 25 or the organization floor, whatever the survey's own floor.
  cross join lateral (
    select greatest(25, coalesce(private.organization_limit(p_organization_id, 'limits.analytics.anonymity_floor'), 25),
      survey.privacy_min_responses) as floor_size
  ) floored
  where survey.id = p_survey_id and survey.organization_id = p_organization_id
$function$;

-- 5. Survey operations state. Everything else in the body is unchanged from
-- 20261002102000.
CREATE OR REPLACE FUNCTION private.survey_operations_state(p_survey_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: ready only
  -- when the review lane and the reports open, never below 25 or the
  -- organization floor, whatever the survey's own floor.
  review_ready := responses >= greatest(25,
    coalesce(private.organization_limit(survey.organization_id, 'limits.analytics.anonymity_floor'), 25),
    survey.privacy_min_responses);

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

-- 6. Survey exports: every response row leaves out the answers to a question
-- the report withholds. Everything else in each body is unchanged from
-- 20261028080000; create or replace keeps the grants.
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
  withheld uuid[];
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
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
  -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104 (gate r2):
  -- no answer to a question the report withholds leaves in any response row.
  withheld := array(
    select (question.value ->> 'id')::uuid
    from pg_catalog.jsonb_array_elements(report -> 'questions') question
    where (question.value ->> 'withheld')::boolean
  );
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
            and answer.question_id <> all(withheld)
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

create or replace function public.export_organization_survey_window(
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
  withheld uuid[];
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if p_format is null or p_format not in ('csv', 'xlsx', 'json') then
    raise exception 'invalid export format' using errcode = '22023';
  end if;
  report := public.get_organization_survey_report_window(p_survey_id, p_from, p_to);
  if not coalesce((report ->> 'available')::boolean, false) then
    raise exception 'privacy floor not met' using errcode = '22023';
  end if;
  -- REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104 (gate r2):
  -- no answer to a question the report withholds leaves in any response row.
  withheld := array(
    select (question.value ->> 'id')::uuid
    from pg_catalog.jsonb_array_elements(report -> 'questions') question
    where (question.value ->> 'withheld')::boolean
  );
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'responseId', session.id,
    'submittedAt', session.submitted_at,
    'answers', coalesce((
      select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
      from public.organization_survey_answers answer
      where answer.session_id = session.id and answer.organization_id = org
        and answer.question_id <> all(withheld)
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

notify pgrst, 'reload schema';

commit;
