-- REQ-UG-LEARNING-PERIOD-EXPORTS-WITHOUT-RUN-ROWS-20261104 (#7034).
-- Apply after 20261104123000; sorts after the independent 20261104130000.
-- Each successful export call has an opaque, unique logical receipt in the
-- existing journal. private.learning_export_calls is a journal target namespace,
-- not a relation or a copy of an exported row (like learning_case_restriction).
-- Four kinds extend slice 6's exports domain and permanent disposition: sent
-- files cannot be recalled. The engine keeps them from the start and on close.
-- No undo handler is added, so the installed dispatcher and its hand-off to
-- learning_dispatch_before_case_workflow (and earlier slices) stay unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

insert into private.learning_action_kinds
  (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note)
values
  ('member_directory_export_request', 'exports', 'permanent', 'private.learning_export_calls', true, null, array[]::text[],
    'Requesting a member directory CSV. The file cannot be recalled.'),
  ('survey_export_request', 'exports', 'permanent', 'private.learning_export_calls', true, null, array[]::text[],
    'Requesting survey results, including a date-window export. The file cannot be recalled.'),
  ('ballot_nominations_export_request', 'exports', 'permanent', 'private.learning_export_calls', true, null, array[]::text[],
    'Requesting ballot nominations. The file cannot be recalled.'),
  ('case_export_request', 'exports', 'permanent', 'private.learning_export_calls', true, null, array[]::text[],
    'Recording a case export. The file cannot be recalled.');

create or replace function public.export_member_directory_csv(
  p_expected_org uuid,
  p_expected_chapter text,
  p_locale text default 'en'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  export_payload jsonb;
  caller uuid;
  caller_org uuid;
  caller_chapter text;
  org_admin boolean;
  chapter_admin boolean;
  officer boolean;
  basis text;
  spanish boolean;
  total integer;
  lines text;
  header text;
  crlf text;
begin
  -- The audit write joins the case graph: take its lock before anything else.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  org_admin := false;
  chapter_admin := false;
  officer := false;
  spanish := p_locale = 'es';
  crlf := pg_catalog.chr(13) || pg_catalog.chr(10);
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then
    raise exception 'MFA required' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'locale out of range' using errcode = '22023';
  end if;
  if caller is null or caller_org is null or caller_chapter is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- The page exports the directory it displayed: a chapter or organization
  -- switched since then (another tab) refuses rather than exporting another
  -- list under the old one.
  if caller_org is distinct from p_expected_org or caller_chapter is distinct from p_expected_chapter then
    raise exception 'directory context changed' using errcode = '40001';
  end if;
  -- The internal platform organization stays outside union exports
  -- (AGENTS.md; private.organization_export_dataset, 20261028080000).
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  org_admin := private.has_organization_role(caller_org, array['admin']);
  if not org_admin then
    chapter_admin := private.member_has_chapter_role(caller_chapter, array['admin']);
    if not chapter_admin then
      officer := private.member_directory_officer(caller_org, caller_chapter);
    end if;
  end if;
  if not (org_admin or chapter_admin or officer) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  basis := case
    when org_admin then 'organization_admin'
    when chapter_admin then 'chapter_admin'
    when private.member_has_chapter_role(caller_chapter, array['vp']) then 'president'
    else 'secretary_treasurer'
  end;

  -- The same rows and fields as get_admin_member_directory, without paging.
  with visible as materialized (
    select p.id, p.full_name,
      p.member_since::integer as member_since_year,
      located.chapter_name, located.display_title,
      private.organization_member_roles(
        p.id, caller_org, case when org_admin then null else caller_chapter end
      ) as roles,
      -- Only the fields the member shared with administrators leave this row.
      case when d.details_visibility = 'admins' then d.pronouns end as shared_pronouns,
      case when d.details_visibility = 'admins' then d.job_title end as shared_job_title,
      case when d.details_visibility = 'admins' then d.worksite end as shared_worksite,
      case when d.details_visibility = 'admins' then d.shift end as shared_shift,
      case when d.details_visibility = 'admins' then d.classification end as shared_classification,
      case when d.phone_visibility = 'admins' then d.phone end as shared_phone
    from public.member_profiles p
    join public.organization_memberships om
      on om.user_id = p.id
     and om.organization_id = caller_org
     and om.status = 'active'
    join lateral (
      select c.id as chapter_id, c.name as chapter_name, cm.display_title
      from public.member_chapter_memberships cm
      join public.chapters c
        on c.id = cm.chapter_id
       and c.organization_id = caller_org
      where cm.user_id = p.id
        and cm.status = 'active'
        and (org_admin or c.id = caller_chapter)
      order by (c.id = p.chapter_id) desc, c.order_index, c.id
      limit 1
    ) located on true
    left join public.member_profile_details d on d.user_id = p.id
  )
  select pg_catalog.count(*)::integer,
    pg_catalog.string_agg(pg_catalog.concat_ws(',',
      private.member_directory_csv_cell(v.full_name),
      private.member_directory_csv_cell(v.member_since_year::text),
      private.member_directory_csv_cell(v.chapter_name),
      private.member_directory_csv_cell(v.display_title),
      private.member_directory_csv_cell((
        select pg_catalog.string_agg(case r.role
          when 'steward' then case when spanish then 'Delegado' else 'Steward' end
          when 'coordinator' then case when spanish then 'Coordinador' else 'Coordinator' end
          when 'advisor' then case when spanish then 'Asesor' else 'Advisor' end
          when 'admin' then 'Admin'
          when 'vp' then case when spanish then 'Presidente' else 'President' end
          else r.role end, '; ' order by r.role)
        from pg_catalog.jsonb_array_elements_text(v.roles) as r(role)
      )),
      private.member_directory_csv_cell(v.shared_pronouns),
      private.member_directory_csv_cell(v.shared_job_title),
      private.member_directory_csv_cell(v.shared_worksite),
      private.member_directory_csv_cell(v.shared_shift),
      private.member_directory_csv_cell(v.shared_classification),
      private.member_directory_csv_cell(v.shared_phone)
    ), crlf order by v.full_name, v.id)
  into total, lines
  from visible v;

  -- At most 5,000 rows in one file.
  if total > 5000 then
    raise exception 'export too large' using errcode = '54000';
  end if;

  header := case when spanish
    then 'Nombre completo,Miembro desde,Capítulo,Título de cargo,Funciones del personal,Pronombres,Puesto,Lugar de trabajo,Turno,Clasificación del puesto,Teléfono'
    else 'Full name,Member since,Chapter,Officer title,Staff roles,Pronouns,Job title,Worksite,Shift,Job classification,Phone'
  end;

  insert into public.organization_audit_ledger
    (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
  values (caller_org, 'exports', 'member_directory_export', 'export', caller,
    case when org_admin then 'organization' else 'chapter' end,
    case when org_admin then caller_org::text else caller_chapter end,
    extensions.gen_random_uuid(),
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'chapterId', case when org_admin then null else caller_chapter end,
      'count', total,
      'exportType', 'member_directory_csv',
      'role', basis)));

  export_payload := pg_catalog.jsonb_build_object(
    'csv', header || crlf || coalesce(lines || crlf, ''),
    'rowCount', total,
    'scope', case when org_admin then 'organization' else 'chapter' end,
    'chapterId', case when org_admin then null else caller_chapter end
  );
  -- Journal only after the complete, available response has been built.
  perform private.learning_journal_append('member_directory_export_request',
    'private.learning_export_calls', extensions.gen_random_uuid()::text);

  return export_payload;
end;
$function$;

create or replace function public.export_organization_survey_results(p_survey_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  export_payload jsonb;
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
  export_payload := report || pg_catalog.jsonb_build_object(
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
  -- Journal only after the complete, available response has been built.
  perform private.learning_journal_append('survey_export_request',
    'private.learning_export_calls', extensions.gen_random_uuid()::text);

  return export_payload;
end;
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
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  export_payload jsonb;
  org uuid := private.engagement_selected_organization();
  report jsonb;
  responses jsonb;
  survey public.organization_surveys%rowtype;
  withheld uuid[];
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if p_format is null or p_format not in ('csv', 'xlsx', 'json') then
    raise exception 'invalid export format' using errcode = '22023';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
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
  where session.organization_id = org
    and session.survey_id = survey.id
    and session.id in (select private.survey_window_sessions(org, p_survey_id, p_from, p_to));
  perform private.mi1_w2_write_audit(org, 'organization_export_completed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', p_survey_id, 'userId', (select auth.uid()),
    'exportType', 'survey', 'exportFormat', p_format,
    'rowCount', pg_catalog.jsonb_array_length(responses), 'status', 'completed'
  ));

  export_payload := report || pg_catalog.jsonb_build_object(
    'format', p_format,
    'generatedAt', pg_catalog.now(),
    'responses', responses
  );
  -- Journal only after the complete, available response has been built.
  perform private.learning_journal_append('survey_export_request',
    'private.learning_export_calls', extensions.gen_random_uuid()::text);

  return export_payload;
end;
end;
$function$;

create function public.get_ballot_nominations(p_ballot_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  ballot record;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select b.id, b.title, b.nominations_close_at into ballot
  from public.member_ballots b
  where b.id = p_ballot_id
    and private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
    and b.ballot_type = 'standard';
  if not found then raise exception 'campaign not found' using errcode = '22023'; end if;
  return pg_catalog.jsonb_build_object(
    'ballotId', ballot.id, 'title', ballot.title, 'nominationsCloseAt', ballot.nominations_close_at,
    'generatedAt', pg_catalog.now(),
    'nominations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', n.id, 'nomineeName', n.nominee_name, 'statement', n.statement,
        'nominatedBy', nominator.full_name, 'nominatedAt', n.created_at,
        'secondedBy', seconder.full_name, 'secondedAt', n.seconded_at
      ) order by n.created_at, n.id)
      from public.ballot_nominations n
      left join public.member_profiles nominator on nominator.id = n.nominated_by
      left join public.member_profiles seconder on seconder.id = n.seconded_by
      where n.ballot_id = ballot.id
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_ballot_nominations(text) from public, anon, authenticated, service_role;
grant execute on function public.get_ballot_nominations(text) to authenticated;
comment on function public.get_ballot_nominations(text) is
  'REQ-UG-LEARNING-PERIOD-EXPORTS-WITHOUT-RUN-ROWS-20261104: authorized read for nomination panel loads, refreshes and ballot-choice hand-offs; only export_ballot_nominations records an export.';

create or replace function public.export_ballot_nominations(p_ballot_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  export_payload jsonb;
  caller uuid := (select auth.uid());
  ballot record;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select b.id, b.title, b.nominations_close_at into ballot
  from public.member_ballots b
  where b.id = p_ballot_id
    and private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
    and b.ballot_type = 'standard';
  if not found then raise exception 'campaign not found' using errcode = '22023'; end if;

  export_payload := pg_catalog.jsonb_build_object(
    'ballotId', ballot.id, 'title', ballot.title, 'nominationsCloseAt', ballot.nominations_close_at,
    'generatedAt', pg_catalog.now(),
    'nominations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', n.id, 'nomineeName', n.nominee_name, 'statement', n.statement,
        'nominatedBy', nominator.full_name, 'nominatedAt', n.created_at,
        'secondedBy', seconder.full_name, 'secondedAt', n.seconded_at
      ) order by n.created_at, n.id)
      from public.ballot_nominations n
      left join public.member_profiles nominator on nominator.id = n.nominated_by
      left join public.member_profiles seconder on seconder.id = n.seconded_by
      where n.ballot_id = ballot.id
    ), '[]'::jsonb)
  );
  -- Journal only after the complete, available response has been built.
  perform private.learning_journal_append('ballot_nominations_export_request',
    'private.learning_export_calls', extensions.gen_random_uuid()::text);

  return export_payload;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_record_case_export(p_case_ids uuid[], p_scope text, p_filter_keys text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  export_payload jsonb;
  v_scope text;
  v_filters text[];
  v_count integer;
  v_readable integer;
  v_org uuid;
  v_org_count integer;
  v_chapter text;
  v_chapter_count integer;
  v_export_id uuid;
begin
  -- Case graph gate first, before any declaration initializer, authorization
  -- read or row acquisition: this routine writes public.casework_audit_events,
  -- which carries both an auth.users and a member_cases reference.
  perform private.lock_case_graph(array[(select auth.uid())], p_case_ids);
  perform private.casework_require_mfa();

  v_scope := pg_catalog.btrim(coalesce(p_scope, ''));
  if v_scope not in ('selection', 'visible') then
    raise exception 'export scope must be selection or visible' using errcode = '22023';
  end if;

  -- The count is derived, never asserted by the caller: the number in the audit
  -- row is the number of cases the caller had to name and pass the read gate
  -- for, so it cannot understate the export.
  --
  -- DISTINCT, because the read gate below counts distinct ids: counting the
  -- raw array would let a request with a repeated id record a rowCount above
  -- the number of cases that actually left the browser, and both caps would be
  -- measured against a number that is not the export's size either.
  select pg_catalog.count(distinct entry.id) into v_count
  from pg_catalog.unnest(coalesce(p_case_ids, '{}'::uuid[])) as entry(id);
  if v_count not between 1 and 500 then
    raise exception 'an export is limited to 500 cases' using errcode = '22023';
  end if;
  if v_scope = 'selection' and v_count > 100 then
    raise exception 'a selection export is limited to 100 cases' using errcode = '22023';
  end if;
  if pg_catalog.array_position(p_case_ids, null) is not null then
    raise exception 'export case ids must not be null' using errcode = '22023';
  end if;

  -- Closed vocabulary of facet NAMES. The facet's value never travels.
  v_filters := coalesce(p_filter_keys, '{}'::text[]);
  if pg_catalog.cardinality(v_filters) > 6 then
    raise exception 'export filter keys are not recognized' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(v_filters) as entry(key)
    where entry.key is null
      or entry.key not in ('step', 'caseType', 'assignee', 'deadline', 'status', 'chapter')
  ) then
    raise exception 'export filter keys are not recognized' using errcode = '22023';
  end if;

  -- The shared staff predicate, applied to every id. Distinct ids are counted
  -- so a repeated id cannot stand in for one the actor may not read.
  select pg_catalog.count(distinct c.id), pg_catalog.count(distinct c.organization_id),
         pg_catalog.count(distinct c.chapter_id)
    into v_readable, v_org_count, v_chapter_count
  from public.member_cases c
  where c.id = any(p_case_ids)
    and private.casework_staff_can_access(c.id);
  if v_readable <> v_count then
    raise exception 'export selection is not authorized' using errcode = 'P0002';
  end if;
  -- One tenant per export, exactly as casework_apply_macro requires: the audit
  -- row carries one organization_id, so a cross-organization export could not
  -- be recorded honestly in a single row.
  if v_org_count <> 1 then
    raise exception 'an export covers one organization' using errcode = '22023';
  end if;
  -- One row is enough: v_org_count has already proved the tenant is unique.
  select c.organization_id into v_org
  from public.member_cases c where c.id = any(p_case_ids) limit 1;
  if not private.organization_is_union(v_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  -- chapter_id is left null when the export spans chapters rather than naming
  -- one of them arbitrarily.
  if v_chapter_count = 1 then
    select c.chapter_id into v_chapter
    from public.member_cases c where c.id = any(p_case_ids) and c.chapter_id is not null limit 1;
  end if;

  v_export_id := extensions.gen_random_uuid();
  -- case_id stays null: an export is not an event on one case, and the
  -- composite member_cases reference is satisfied by the null key. The row is
  -- therefore readable by an organization coordinator who is not authorized for
  -- every exported case, so a selection records one salted digest per case id
  -- rather than the id itself: a reader who already holds a case id can prove
  -- the case was in this export, and a reader who does not learns nothing. A
  -- visible-slice export records its facets and its count.
  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, v_chapter, null, (select auth.uid()),
    'cases_exported', 'case_export', v_export_id,
    pg_catalog.jsonb_build_object(
      'scope', v_scope,
      'rowCount', v_count,
      'filterKeys', pg_catalog.to_jsonb(v_filters))
    || (case when v_scope = 'selection'
          then pg_catalog.jsonb_build_object('caseIdDigests',
                 (select pg_catalog.jsonb_agg(distinct pg_catalog.left(
                    pg_catalog.encode(
                      extensions.digest(v_export_id::text || ':' || entry.id::text, 'sha256'),
                      'hex'), 32))
                  from pg_catalog.unnest(p_case_ids) as entry(id)))
          else '{}'::jsonb end));

  export_payload := pg_catalog.jsonb_build_object(
    'exportId', v_export_id, 'scope', v_scope, 'rowCount', v_count,
    'limit', 500, 'selectionLimit', 100);
  -- Journal only after the complete, available response has been built.
  perform private.learning_journal_append('case_export_request',
    'private.learning_export_calls', v_export_id::text);

  return export_payload;
end;
$function$;

notify pgrst, 'reload schema';
commit;
