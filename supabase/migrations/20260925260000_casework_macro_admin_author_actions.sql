-- BUG-UG-CASEWORK-MACRO-ACTIONS-REJECT-ADMIN-AUTHORS-20260921
--
-- public.casework_apply_macro admits the coordinator, admin and VP hats of the
-- macro's organization, and private.casework_macro_audience lets only the
-- admin/VP hats author an organization-wide macro. Two of the delegates it
-- replays ask for a narrower hat: coordinator_add_case_note (through
-- private.coordinator_case_for_update) wants coordinator, and
-- assign_member_case wants coordinator or admin. An admin without a
-- coordinator grant who applied their own macro with an add_note step got
-- 'coordinator role required' (42501) part-way through the batch, after the
-- routine had admitted them, and the whole batch rolled back. An admin/VP author
-- without the coordinator hat hit the same on an assign step.
--
-- This re-emission settles both before any write, with one honest 42501
-- naming the role the step needs:
--   * add_note: coordinator_add_case_note's role requirement (the coordinator
--     hat) is evaluated up front. The note stays on its delegate:
--     private.coordinator_case_for_update is the one visibility-gated path
--     every client-callable note writer must take
--     (tests/casework-note-restriction-db.test.js), so the macro does not
--     become a second writer beside it.
--   * assign: assign_member_case's two authorization refusals (its
--     coordinator/admin role gate and its staff_can_see_user(..., 'coordinator')
--     scope check, which only the coordinator hat passes) are evaluated up
--     front for every selected case.
-- An admin/VP without the coordinator hat can do neither anywhere today, so a
-- macro does not grant it. Their macros made of the other kinds
-- (advance_step, set_status, add_alert) run exactly as before.
-- Nothing else moves: signature, grants, lock prologue, selection bounds,
-- delegates, replay guard and audit rows are the 20260917144000 body byte for
-- byte.
--
-- The installed body is the 20260917144000 source (no later wrapper touched
-- it; its own case-graph prologue is already the first statement), digest
-- 5e9f031a0bb4a76c1a5b045c40ee1be54a008c5916e9af009c5ceb45eb4b7ac7. That is
-- the only predecessor this repair may supersede.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.casework_apply_macro(uuid, uuid[], uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '5e9f031a0bb4a76c1a5b045c40ee1be54a008c5916e9af009c5ceb45eb4b7ac7' then
    raise exception 'unreviewed casework_apply_macro predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

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

  select * into v_macro from public.casework_macros where id = p_macro_id;
  if v_macro.id is null or not v_macro.active then
    raise exception 'macro not found' using errcode = 'P0002';
  end if;
  if not private.has_organization_role(v_macro.organization_id, array['coordinator','admin','vp']) then
    raise exception 'coordinator role required' using errcode = '42501';
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

revoke all on function public.casework_apply_macro(uuid, uuid[], uuid) from public, anon;
grant execute on function public.casework_apply_macro(uuid, uuid[], uuid) to authenticated;

do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.casework_apply_macro(uuid, uuid[], uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'f383773b03767f4e5c2627235997fb574cdaf6623cadd13261c8c253ec78fc46' then
    raise exception 'casework_apply_macro source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
