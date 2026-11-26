-- SEC-UG-CASEWORK-MACRO-REFUSALS-REVEAL-FOREIGN-SCOPES-20261119 (#9243)
-- Refuse inaccessible scopes before content work. Preserve the shared audience,
-- case graph gates, learning/audit behavior, search_path pins and existing ACLs.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog, public;

do $predecessors$
declare
  entry record;
begin
  for entry in select * from (values
    ('public.casework_save_macro(uuid,text,text,jsonb,boolean)', '86ea2aa4cfcbe8c8e0d75eecfb1745d4'),
    ('public.casework_apply_macro(uuid,uuid[],uuid)', 'bf1bfecaaf66fb84e11b59d047176d16')
  ) reviewed(signature, source_md5) loop
    if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
        where p.oid = entry.signature::regprocedure) is distinct from entry.source_md5 then
      raise exception 'unreviewed casework macro predecessor: %', entry.signature using errcode = '55000';
    end if;
  end loop;
end;
$predecessors$;

create or replace function public.casework_save_macro(
  p_macro_id uuid,
  p_chapter_id text,
  p_name text,
  p_actions jsonb,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  learning_image jsonb := '{"existed": false}'::jsonb;
  v_org uuid;
  v_chapter text;
  v_name text;
  v_macro public.casework_macros%rowtype;
begin
  -- casework_macros carries a created_by reference into auth.users, so it is a
  -- case graph relation: the gate precedes the MFA read and the upsert.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  v_chapter := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  perform private.casework_require_mfa();
  if pg_catalog.char_length(v_name) not between 2 and 120 then
    raise exception 'macro name must be 2-120 characters' using errcode = '22023';
  end if;
  if not private.casework_macro_actions_valid(p_actions) then
    raise exception 'macro actions are not a valid ordered action list' using errcode = '22023';
  end if;

  -- The audience already restricts chapter authorship to the caller's
  -- selected organization. Resolve that caller-owned scope first; looking up
  -- the supplied chapter before this check reveals foreign chapter existence.
  v_org := (select private.current_mobile_staff_organization());
  if v_chapter is null and v_org is null then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;
  if not private.casework_macro_audience(v_org, v_chapter, true) then
    raise exception 'macro authorship requires the scope write role and the staff role that reads the macro'
      using errcode = '42501', hint = 'casework_macro_audience';
  end if;

  if p_macro_id is null then
    insert into public.casework_macros(organization_id, chapter_id, name, actions, active, created_by)
    values (v_org, v_chapter, v_name, p_actions, coalesce(p_active, true), (select auth.uid()))
    returning * into v_macro;
  else
    select * into v_macro from public.casework_macros
    where id = p_macro_id and organization_id = v_org
      and private.casework_macro_audience(organization_id, chapter_id, true)
    for update;
    if v_macro.id is null then raise exception 'macro not found' using errcode = 'P0002'; end if;
    -- Re-scoping a macro would move it past the role check that created it.
    if v_macro.organization_id <> v_org or v_macro.chapter_id is distinct from v_chapter then
      raise exception 'macro scope cannot change' using errcode = '42501';
    end if;
    learning_image := private.learning_casework_macro_state(v_macro.id);
    update public.casework_macros
      set name = v_name, actions = p_actions,
          active = coalesce(p_active, v_macro.active), updated_at = pg_catalog.now()
      where id = v_macro.id
      returning * into v_macro;
  end if;

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_macro.organization_id, v_macro.chapter_id, null, (select auth.uid()),
    'macro_saved', 'macro', v_macro.id,
    pg_catalog.jsonb_build_object(
      'actionCount', pg_catalog.jsonb_array_length(v_macro.actions), 'active', v_macro.active));

  -- The journal bounds a before-image by bytes; a macro too large to keep
  -- one is recorded as saved, never blocked.
  if pg_catalog.octet_length(learning_image::text) <= 16384 then
    perform private.learning_journal_append('casework_macro_save', 'public.casework_macros', v_macro.id::text, null,
      private.learning_fingerprint(private.learning_casework_macro_state(v_macro.id)), null, learning_image);
  else
    perform private.learning_journal_append('casework_macro_save_kept', 'public.casework_macros', v_macro.id::text);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', v_macro.id, 'name', v_macro.name, 'chapterId', v_macro.chapter_id,
    'actions', v_macro.actions, 'active', v_macro.active, 'updatedAt', v_macro.updated_at);
end;
end;
$function$;

create or replace function public.casework_apply_macro(
  p_macro_id uuid,
  p_case_ids uuid[],
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_macro public.casework_macros%rowtype;
  v_case public.member_cases%rowtype;
  v_case_id uuid;
  v_action jsonb;
  v_index integer;
  v_key uuid;
  v_applied integer;
  v_skipped integer;
  v_count integer;
  v_org_count integer;
  v_org uuid;
  v_alert_id uuid;
  v_entity uuid;
begin
  -- Applying a macro re-enters casework_advance_step, casework_bulk_update_cases
  -- and assign_member_case, so this routine is itself a message-lifecycle and
  -- case-graph writer entry. It therefore opens with the canonical entry gate in
  -- the exact shape every other enrolled entry carries (the wrapper's
  -- array[auth.uid()], array[]::uuid[] form, pinned by
  -- tests/message-preservation-db.test.js), and only then adds this batch's own
  -- case identifiers. Both calls run through private.lock_case_graph, which takes
  -- the message-lifecycle lock and (509, 700) first and then walks its
  -- identifiers in sorted order, so the second call widens the acquisition
  -- without reordering it. Each per-action routine re-enters the same advisory
  -- locks, so the ordering established here is the ordering they all see.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.lock_case_graph(array[(select auth.uid())], p_case_ids);
  v_applied := 0;
  v_skipped := 0;
  perform private.casework_require_mfa();
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if coalesce(pg_catalog.array_length(p_case_ids, 1), 0) not between 1 and 100 then
    raise exception 'select 1 to 100 cases' using errcode = '22023';
  end if;

  -- Decide the caller's application role before touching the supplied id.
  -- Unreadable and missing macros take the same caller-scoped lookup and
  -- refusal, without inspecting their active flag, actions or chapter.
  v_org := (select private.current_mobile_staff_organization());
  if not private.has_organization_role(v_org, array['coordinator','admin','vp']) then
    raise exception 'macro not found' using errcode = 'P0002';
  end if;
  select * into v_macro from public.casework_macros
    where id = p_macro_id and organization_id = v_org
      and private.casework_macro_audience(organization_id, chapter_id, false);
  if v_macro.id is null or not v_macro.active then
    raise exception 'macro not found' using errcode = 'P0002';
  end if;

  -- Same selection bound casework_bulk_update_cases enforces: every case
  -- accessible, every case in this macro's organization, one organization.
  select pg_catalog.count(*), pg_catalog.count(distinct c.organization_id)
    into v_count, v_org_count
  from public.member_cases c
  where c.id = any(p_case_ids)
    and c.organization_id = v_macro.organization_id
    and private.casework_staff_can_access(c.id);
  if v_count <> pg_catalog.array_length(p_case_ids, 1) or v_org_count <> 1 then
    raise exception 'case selection is not authorized' using errcode = 'P0002';
  end if;
  if v_macro.chapter_id is not null and exists (
    select 1 from public.member_cases c
    where c.id = any(p_case_ids) and c.chapter_id is distinct from v_macro.chapter_id
  ) then
    raise exception 'macro is scoped to another chapter' using errcode = '42501';
  end if;

  -- The gate above admits the organization admin/VP hats because only they may
  -- author an organization-wide macro, but two delegates ask a narrower hat.
  -- Settle both before any write, so an author is never told mid-batch that
  -- they lack a role this routine just admitted:
  --   add_note: coordinator_add_case_note (through
  --     private.coordinator_case_for_update, the one visibility-gated note
  --     path every client-callable note writer must use) wants coordinator.
  --   assign: assign_member_case's role gate and its
  --     staff_can_see_user(..., 'coordinator') scope check, which only a
  --     coordinator hat passes, evaluated for every selected case.
  -- An admin/VP without the coordinator hat can write neither anywhere, so a
  -- macro does not grant it; their macros of the other kinds run as before.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_macro.actions) as t(element)
    where t.element->>'kind' = 'add_note'
  ) and not public.member_has_role(array['coordinator']) then
    raise exception 'adding case notes requires the coordinator role' using errcode = '42501';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_macro.actions) as t(element)
    where t.element->>'kind' = 'assign'
  ) and (
    not public.member_has_role(array['coordinator', 'admin'])
    or exists (
      select 1 from public.member_cases c
      where c.id = any(p_case_ids)
        and not public.staff_can_see_user(c.user_id, 'coordinator'))
  ) then
    raise exception 'assigning cases requires the coordinator role' using errcode = '42501';
  end if;

  foreach v_case_id in array p_case_ids loop
    v_index := 0;
    for v_action in select element from pg_catalog.jsonb_array_elements(v_macro.actions) as t(element) loop
      v_key := pg_catalog.md5(p_idempotency_key::text || v_case_id::text || v_index::text)::uuid;
      if exists (
        select 1 from public.casework_audit_events e
        where e.case_id = v_case_id and e.event_type = 'macro_applied'
          and e.metadata->>'operationId' = v_key::text
      ) then
        v_skipped := v_skipped + 1;
        v_index := v_index + 1;
        continue;
      end if;

      select * into v_case from public.member_cases where id = v_case_id;
      v_entity := v_case.id;

      if v_action->>'kind' = 'advance_step' then
        -- casework_advance_step refuses a no-op hop, so a case already parked
        -- on the target step is left alone instead of failing the batch.
        if v_case.step is distinct from pg_catalog.btrim(v_action->>'step') then
          perform public.casework_advance_step(
            v_case.id, v_case.step, v_action->>'step', v_action->>'outcome', v_key);
        end if;
      elsif v_action->>'kind' = 'set_status' then
        if v_case.status is distinct from (v_action->>'status') then
          perform public.casework_bulk_update_cases(
            array[v_case.id], v_case.status, v_action->>'status', null, v_key);
        end if;
      elsif v_action->>'kind' = 'assign' then
        perform public.assign_member_case(
          v_case.id, (v_action->>'stewardId')::uuid, (v_action->>'coordinatorId')::uuid);
        insert into public.casework_audit_events(
          organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
        values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
          'case_assigned', 'case', v_case.id,
          pg_catalog.jsonb_build_object('operationId', v_key::text, 'macroId', v_macro.id));
      elsif v_action->>'kind' = 'add_note' then
        perform public.coordinator_add_case_note(v_case.id, v_action->>'body');
      elsif v_action->>'kind' = 'add_alert' then
        insert into public.casework_alerts(
          case_id, organization_id, chapter_id, kind, severity, message, created_by)
        values (v_case.id, v_case.organization_id, v_case.chapter_id,
          v_action->>'alertKind', v_action->>'severity',
          pg_catalog.btrim(v_action->>'message'), (select auth.uid()))
        returning id into v_alert_id;
        v_entity := v_alert_id;
        insert into public.casework_audit_events(
          organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
        values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
          'alert_created', 'alert', v_alert_id,
          pg_catalog.jsonb_build_object('operationId', v_key::text, 'macroId', v_macro.id));
      end if;

      insert into public.casework_audit_events(
        organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
      values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
        'macro_applied', 'macro', v_macro.id,
        pg_catalog.jsonb_build_object(
          'operationId', v_key::text, 'batchId', p_idempotency_key::text,
          'macroId', v_macro.id, 'actionIndex', v_index,
          'kind', v_action->>'kind', 'entityId', v_entity));
      v_applied := v_applied + 1;
      v_index := v_index + 1;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'macroId', v_macro.id,
    'caseCount', pg_catalog.array_length(p_case_ids, 1),
    'actionsApplied', v_applied,
    'actionsSkipped', v_skipped);
end;
$function$;

notify pgrst, 'reload schema';
commit;
