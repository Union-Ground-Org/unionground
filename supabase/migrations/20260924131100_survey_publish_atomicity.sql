-- BUG-UG-SURVEY-PUBLISH-NON-ATOMIC-20260920
--
-- Publishing a survey used to be two sequential RPC calls: publish_organization_survey
-- committed status = 'open' in its own transaction, and only the later
-- configure_organization_survey_operations call wrote cadence, period key, operations
-- state, and the readiness task. A quarterly period collision (the unique index
-- organization_surveys_quarterly_period_once_idx) or any transient failure in the
-- second call therefore left an unconfigured survey live to the membership while the
-- operator was told the save failed.
--
-- publish_organization_survey_with_operations performs the draft save, the status
-- transition, the operating configuration, and the readiness-task upsert in ONE
-- function body — one transaction — and pre-checks the quarterly period conflict
-- with a distinguishable 23505 before any row changes state. It also refuses
-- operations_state = 'draft': members see every status = 'open' survey, so a
-- draft operations payload would recreate the stranded-open failure this
-- function exists to prevent.
--
-- The legacy public.publish_organization_survey(jsonb) entry point is retired
-- in this same transaction: its body fails closed and EXECUTE is revoked from
-- every API role, so a cached client or authenticated integration cannot still
-- commit status = 'open' without operations. Draft save continues through
-- save_organization_survey_draft plus configure_organization_survey_operations.

begin;

set local check_function_bodies = on;

create function public.publish_organization_survey_with_operations(
  p_draft jsonb,
  p_operations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Acquire the case-graph gate before any declaration initializer runs, as
  -- the survey save, publish, and configuration writers already do, so this
  -- writer orders with concurrent Auth/account-deletion work.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_w2_selected_organization();
  existing public.organization_surveys%rowtype;
  saved_survey_id uuid;
  next_title text := pg_catalog.btrim(coalesce(p_draft ->> 'title', ''));
  next_description text := pg_catalog.btrim(coalesce(p_draft ->> 'description', ''));
  chapter text := nullif(pg_catalog.btrim(coalesce(p_draft ->> 'chapterId', '')), '');
  privacy integer := coalesce(nullif(p_draft ->> 'privacyMinResponses', '')::integer, 3);
  next_owner uuid := nullif(p_operations ->> 'ownerUserId', '')::uuid;
  next_cadence text := coalesce(nullif(p_operations ->> 'cadence', ''), 'one_off');
  next_period text := nullif(pg_catalog.btrim(coalesce(p_operations ->> 'periodKey', '')), '');
  next_state text := coalesce(nullif(p_operations ->> 'operationsState', ''), 'ready');
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
  if next_cadence not in ('one_off', 'quarterly', 'contextual') then
    raise exception 'invalid cadence' using errcode = '22023';
  end if;
  -- Publish never accepts operations_state = 'draft'. Member snapshots filter
  -- on status = 'open' and the time window only, so a draft operations payload
  -- would go live immediately. Omitted state defaults to 'ready' (the UI
  -- publish path); an explicit 'draft' is invalid here.
  if next_state not in ('ready', 'distributing', 'reviewing', 'complete') then
    raise exception 'invalid operations state' using errcode = '22023';
  end if;
  if next_cadence = 'quarterly' and next_period is null then
    raise exception 'quarterly surveys require a period key' using errcode = '22023';
  end if;
  if next_owner is not null and not private.engagement_user_in_organization(org, next_owner) then
    raise exception 'owner is not an active organization member' using errcode = '42501';
  end if;

  -- Refuse the quarterly period collision BEFORE any row changes state. The
  -- unique index remains as the concurrent-write backstop and raises the same
  -- 23505, so the client maps one code to the translated conflict copy.
  if next_cadence = 'quarterly' and next_period is not null then
    if exists (
      select 1 from public.organization_surveys s
      where s.organization_id = org
        and s.cadence = 'quarterly'
        and s.period_key = next_period
        and s.id is distinct from nullif(p_draft ->> 'id', '')::uuid
    ) then
      raise exception 'quarterly survey period conflict' using errcode = '23505';
    end if;
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
  if not exists (
    select 1 from public.organization_survey_questions q
    where q.survey_id = saved_survey_id and q.organization_id = org
  ) then
    raise exception 'Survey is not ready to publish.' using errcode = '22023';
  end if;

  -- Status and operating configuration commit together: any failure above or
  -- below rolls the whole publish back, so no survey can be observed at
  -- status 'open' without the cadence, period, window, and readiness task the
  -- operator submitted.
  update public.organization_surveys
  set status = 'open',
      cadence = next_cadence,
      period_key = next_period,
      opens_at = nullif(p_operations ->> 'opensAt', '')::timestamptz,
      closes_at = nullif(p_operations ->> 'closesAt', '')::timestamptz,
      owner_user_id = next_owner,
      operations_state = next_state,
      review_due_at = nullif(p_operations ->> 'reviewDueAt', '')::timestamptz,
      updated_at = pg_catalog.now()
  where id = saved_survey_id and organization_id = org;

  insert into public.organization_survey_tasks (
    organization_id, survey_id, reason, status, assigned_to, due_at, created_by
  )
  values (
    org, saved_survey_id, 'readiness',
    case when next_state in ('ready', 'distributing', 'reviewing', 'complete') then 'done' else 'open' end,
    next_owner, nullif(p_operations ->> 'readinessDueAt', '')::timestamptz, (select auth.uid())
  )
  on conflict (survey_id, reason) do update
    set status = excluded.status,
        assigned_to = excluded.assigned_to,
        due_at = excluded.due_at,
        updated_at = pg_catalog.now();

  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'surveyId', saved_survey_id,
    'status', 'draft', 'privacyMinResponses', privacy
  ));
  perform private.mi1_w2_write_audit(org, 'survey_published', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', saved_survey_id, 'status', 'open',
    'privacyMinResponses', privacy
  ));
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', saved_survey_id,
    'status', next_state,
    'reasonCode', 'operations_configured',
    'fieldsChanged', pg_catalog.jsonb_build_array('cadence', 'periodKey', 'owner', 'window', 'reviewDueAt')
  ));

  return private.mi1_w2_project_survey(saved_survey_id) || pg_catalog.jsonb_build_object(
    'cadence', next_cadence,
    'periodKey', next_period,
    'operationsState', next_state,
    'ownerUserId', next_owner
  );
end;
end;
$function$;

revoke all on function public.publish_organization_survey_with_operations(jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_organization_survey_with_operations(jsonb, jsonb) to authenticated;

-- Fail closed for every remaining caller, then drop the authenticated grant
-- the 20260826151000 migration issued. CREATE OR REPLACE keeps existing
-- EXECUTE grants, so the revoke has to follow the replacement.
create or replace function public.publish_organization_survey(p_draft jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- The signature has to stay byte-identical so cached PostgREST clients reach
  -- this fail-closed body instead of a 404, but the payload is never read.
  -- Discarding it explicitly keeps the retired entry point free of an unused
  -- parameter, which the database assurance lint baseline treats as drift.
  perform pg_catalog.jsonb_typeof(p_draft);
  raise exception 'publish_organization_survey is retired; use publish_organization_survey_with_operations'
    using errcode = '42501';
end;
$function$;

revoke all on function public.publish_organization_survey(jsonb)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
