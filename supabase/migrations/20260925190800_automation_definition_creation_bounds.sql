-- SEC-UG-AUTOMATION-DEFINITION-CREATION-BOUNDS-20260921
--
-- public.mi1_save_automation_definition_v2 (live body 20260911070000) and the
-- still-granted legacy public.save_organization_automation_definition
-- (installed wrapped body, 20260829023000 + 20260907151000) both create
-- automation definitions with no per-organization count or rate bound.
--
-- Documented creation bounds, per organization:
--   * at most 200 definitions that are not archived;
--   * at most 100 new definitions per rolling hour (archived ones included, so
--     archive-and-recreate churn is bounded too).
-- Headroom: the connected-automation verifier, one admin configuring every
-- recipe in one session, creates 56 definitions in one organization.
--
-- Both RPCs call private.automation_definition_creation_admit(org) in their
-- new-definition branch only, after they take the existing
-- 'organization-automation:<org>' transaction lock, so the count runs inside
-- that lock and concurrent creations cannot both pass at the bound. A
-- creation over either bound is refused with errcode 54000 before the insert,
-- so no definition and no automation_definition_created audit row is
-- written. Edits never reach the helper. Everything else in both bodies is
-- unchanged, including the case-graph lock statements; grants are preserved
-- by CREATE OR REPLACE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.automation_definition_creation_admit(p_org uuid)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  live_definitions integer;
  recent_creations integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if p_org is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select count(*)::integer into live_definitions
  from public.organization_automation_definitions d
  where d.organization_id = p_org
    and d.status <> 'archived';
  -- 200 non-archived definitions per organization.
  if live_definitions >= 200 then
    raise exception 'automation definition limit reached: 200 per organization' using errcode = '54000';
  end if;
  select count(*)::integer into recent_creations
  from public.organization_automation_definitions d
  where d.organization_id = p_org
    and d.created_at > pg_catalog.now() - interval '1 hour';
  -- 100 new definitions per organization per rolling hour.
  if recent_creations >= 100 then
    raise exception 'automation definition creation rate limited: 100 per hour' using errcode = '54000';
  end if;
end;
$function$;

revoke all on function private.automation_definition_creation_admit(uuid) from public, anon, authenticated, service_role;

create or replace function public.mi1_save_automation_definition_v2(p_definition jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
  definition_id uuid;
  approver boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  approver := private.automation_v3_actor_is_approver(actor, org);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.automation_v3_require_author() is distinct from org then
    raise exception 'organization changed' using errcode = '42501';
  end if;
  perform private.automation_v2_validate(org, p_definition);
  definition_id := (p_definition->>'id')::uuid;
  if not approver and not ((p_definition->'conditions') ? 'chapterId' or (p_definition->'conditions') ? 'sourceId') then
    raise exception 'staff drafts require visible chapter or source scope' using errcode = '42501';
  end if;

  if definition_id is null then
    if p_definition ? 'expectedVersion' then
      raise exception 'new definition cannot have version' using errcode = '22023';
    end if;
    perform private.automation_definition_creation_admit(org);
    insert into public.organization_automation_definitions (
      organization_id, name, trigger_kind, threshold_days, task_priority,
      cadence, action_kind, schema_version, conditions, action_config,
      created_by, updated_by, review_status, review_version
    ) values (
      org, pg_catalog.btrim(p_definition->>'name'), p_definition->>'triggerKind',
      (p_definition->>'thresholdDays')::smallint, p_definition->>'taskPriority',
      p_definition->>'cadence', p_definition->>'actionKind', 2,
      p_definition->'conditions', p_definition->'actionConfig', actor, actor,
      'draft', null
    ) returning * into saved;
  else
    update public.organization_automation_definitions d
       set name = pg_catalog.btrim(p_definition->>'name'),
           trigger_kind = p_definition->>'triggerKind',
           threshold_days = (p_definition->>'thresholdDays')::smallint,
           task_priority = p_definition->>'taskPriority',
           cadence = p_definition->>'cadence',
           action_kind = p_definition->>'actionKind',
           schema_version = 2,
           conditions = p_definition->'conditions',
           action_config = p_definition->'actionConfig',
           version = d.version + 1,
           updated_by = actor,
           updated_at = pg_catalog.now(),
           review_status = 'draft',
           review_version = null,
           submitted_by = null,
           submitted_at = null,
           reviewed_by = null,
           reviewed_at = null,
           review_note = null
     where d.id = definition_id
       and d.organization_id = org
       and d.version = (p_definition->>'expectedVersion')::integer
       and d.status <> 'archived'
       and (approver or (d.created_by = actor and d.review_status in ('draft', 'changes_requested')))
     returning d.* into saved;
    if saved.id is null then
      raise exception 'definition changed or is not editable' using errcode = '40001';
    end if;
  end if;

  perform private.cr108_record_audit(
    org,
    case when definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,
    case when definition_id is null then 'create' else 'update' end,
    'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'reviewStatus', saved.review_status, 'version', saved.version),
    extensions.gen_random_uuid()
  );
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

create or replace function public.save_organization_automation_definition(p_definition_id uuid, p_name text, p_trigger_kind text, p_threshold_days integer, p_cadence text, p_task_priority text, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  saved public.organization_automation_definitions%rowtype;
  audit_id uuid := extensions.gen_random_uuid();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 3 and 80
     or p_name ~ '[[:cntrl:]]' then
    raise exception 'automation name must be 3 to 80 visible characters' using errcode = '22023';
  end if;
  if p_trigger_kind not in ('overdue_task', 'case_deadline', 'unassigned_case')
     or p_cadence not in ('hourly', 'daily', 'weekly')
     or p_task_priority not in ('low', 'medium', 'high')
     or p_threshold_days not between 0 and 90
     or (p_trigger_kind = 'unassigned_case' and p_threshold_days <> 0) then
    raise exception 'invalid automation definition' using errcode = '22023';
  end if;

  if exists(select 1 from public.organization_automation_definitions where id=p_definition_id and organization_id=org and schema_version=2) then
    raise exception 'v2 definition requires v2 editor' using errcode='22023';
  end if;
  if p_definition_id is null then
    if p_expected_version is not null then
      raise exception 'new automation definition cannot have a version' using errcode = '22023';
    end if;
    perform private.automation_definition_creation_admit(org);
    insert into public.organization_automation_definitions (
      organization_id, name, trigger_kind, threshold_days, task_priority,
      cadence, created_by, updated_by
    ) values (
      org, pg_catalog.btrim(p_name), p_trigger_kind, p_threshold_days,
      p_task_priority, p_cadence, actor, actor
    ) returning * into saved;
  else
    if p_expected_version is null then
      raise exception 'expected automation version required' using errcode = '22023';
    end if;
    update public.organization_automation_definitions d
       set name = pg_catalog.btrim(p_name),
           trigger_kind = p_trigger_kind,
           threshold_days = p_threshold_days,
           task_priority = p_task_priority,
           cadence = p_cadence,
           version = d.version + 1,
           updated_by = actor,
           updated_at = pg_catalog.now()
     where d.id = p_definition_id
       and d.organization_id = org
       and d.version = p_expected_version
       and d.status <> 'archived'
     returning d.* into saved;
    if saved.id is null then
      raise exception 'automation definition changed; reload before saving' using errcode = '40001';
    end if;
  end if;

  perform private.cr108_record_audit(
    org,
    case when p_definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,
    case when p_definition_id is null then 'create' else 'update' end,
    'automation_definition',
    saved.id::text,
    actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'cadence', saved.cadence),
    audit_id
  );

  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'name', saved.name, 'triggerKind', saved.trigger_kind,
    'thresholdDays', saved.threshold_days, 'taskPriority', saved.task_priority,
    'cadence', saved.cadence, 'status', saved.status, 'version', saved.version
  );
end;
end;
$function$;

commit;
