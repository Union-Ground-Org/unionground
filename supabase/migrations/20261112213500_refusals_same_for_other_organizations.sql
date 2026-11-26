-- SEC-UG-NON-INTERFERENCE-REFUSALS-REVEAL-OTHER-ORGANIZATIONS-OBJECTS-20261111
-- (#8365). Given the id of another organization's, chapter's or unit's
-- object, these functions refused differently from an id that does not
-- exist, so the refusal told the caller the object exists (found by the leak
-- guard of #8323). Every body below is the live definition on a stack built
-- from Main with only these changes, so no later rewrite is undone.
--
-- 1. Thirteen casework functions looked the object up with `into strict`: a
--    missing id raised 'query returned no rows' while another organization's
--    object reached the named '<object> not found' refusal. The lookup now
--    raises that same named refusal when no row is found.
-- 2. private.coordinator_case_for_update raised 'case unavailable' with
--    22023 on one path and 42501 on the other, so the code told a case out
--    of the caller's reach from a missing one. Both are now 42501
--    (coordinator_add_case_note,
--    coordinator_log_case_contact, coordinator_record_case_outcome,
--    coordinator_update_case and casework_add_case_note use it).
-- 3. public.assign_member_case refused a case of a member outside the
--    caller's scope with 'member outside your scope'; it is now 'case not
--    found', as for a missing case.
-- 4. public.create_organization_coordination_record accepted any active
--    organization as partner, so it told the caller whether an organization
--    id exists. A partner is now accepted only when the caller can already
--    see it: through the network directory, or an existing coordination
--    record between the two organizations; any other id gets the same
--    'partner organization unavailable'. An
--    unverified organization, which can discover no partner, keeps its
--    'organization verification required' refusal, now raised before the
--    partner is looked at.
-- 5. public.list_chapter_connection_profiles put a registry-wide counter in
--    its snapshot token, moved by every organization's profile changes,
--    drafts included. The token's epoch is now a fingerprint of what the
--    caller can see (the published profiles the list can return and the
--    viewer chapter's hides), in the same token format.
--    It covers exactly the rows the list may
--    return at the snapshot time (expiry and hides in both directions
--    applied, cursor and limit aside), so the snapshot time is resolved first.
--
-- The hosted runner applies every migration under set local search_path=''
-- (scripts/hosted-migration-apply-runner.mjs), so each name that resolves when
-- a function is created, such as a composite return type, is schema-qualified.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.casework_add_bargaining_event(p_workspace_id uuid, p_event_type text, p_body text, p_pulse text)
 RETURNS public.casework_bargaining_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_events%rowtype;
begin
  perform private.casework_require_mfa();
  select * into v_workspace from public.casework_bargaining_workspaces where id = p_workspace_id for share; if not found then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if not private.member_has_chapter_staff_grant(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_events(workspace_id, organization_id, event_type, body, pulse, created_by)
  values (v_workspace.id, v_workspace.organization_id, p_event_type, pg_catalog.btrim(p_body), p_pulse, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_event', v_row.id, pg_catalog.jsonb_build_object('eventType', p_event_type, 'pulse', p_pulse));
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_add_bargaining_proposal(p_workspace_id uuid, p_side text, p_title text, p_body text, p_response_due_at timestamp with time zone)
 RETURNS public.casework_bargaining_proposals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_proposals%rowtype;
begin
  perform private.casework_require_mfa();
  select * into v_workspace from public.casework_bargaining_workspaces where id = p_workspace_id for share; if not found then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if not private.member_has_chapter_staff_grant(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_proposals(workspace_id, organization_id, side, title, body, response_due_at, created_by)
  values (v_workspace.id, v_workspace.organization_id, p_side, pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_response_due_at, (select auth.uid())) returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, proposal_id, event_type, body, created_by)
  values (v_workspace.id, v_workspace.organization_id, v_row.id, 'proposal_status', 'Proposal created as draft', (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_proposal', v_row.id, pg_catalog.jsonb_build_object('status', v_row.status));
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_create_alert(p_case_id uuid, p_kind text, p_severity text, p_message text, p_escalation_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS public.casework_alerts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_case public.member_cases%rowtype;
  v_row public.casework_alerts%rowtype;
begin
  -- Same gate order as casework_create_deadline, for the same reason.
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  select * into v_case from public.member_cases where id = p_case_id; if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  insert into public.casework_alerts(
    case_id, organization_id, chapter_id, kind, severity, message, escalation_due_at, created_by)
  values (
    v_case.id, v_case.organization_id, v_case.chapter_id, p_kind, p_severity,
    pg_catalog.btrim(p_message), p_escalation_due_at, (select auth.uid()))
  returning * into v_row;
  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (
    v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()),
    'alert_created', 'alert', v_row.id,
    pg_catalog.jsonb_build_object(
      'kind', v_row.kind,
      'severity', v_row.severity,
      'escalationSet', v_row.escalation_due_at is not null));
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_create_bargaining_workspace(p_chapter_id text, p_title text, p_starts_at timestamp with time zone)
 RETURNS public.casework_bargaining_workspaces
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_org uuid; v_row public.casework_bargaining_workspaces%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into v_org from public.chapters c where c.id = p_chapter_id; if not found then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if not private.member_has_chapter_staff_grant(p_chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_workspaces(organization_id, chapter_id, title, starts_at, created_by)
  values (v_org, p_chapter_id, pg_catalog.btrim(p_title), p_starts_at, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_workspace', v_row.id, pg_catalog.jsonb_build_object('status', v_row.status));
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_create_checklist_template(p_chapter_id text, p_case_type text, p_step text, p_title text, p_items jsonb)
 RETURNS public.casework_checklist_templates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_org uuid; v_row public.casework_checklist_templates%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into v_org from public.chapters c where c.id = p_chapter_id; if not found then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if not private.casework_checklist_template_audience(v_org, p_chapter_id, true) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) not between 1 and 50
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_items) item where pg_catalog.jsonb_typeof(item) <> 'object' or pg_catalog.char_length(pg_catalog.btrim(item->>'label')) not between 1 and 300)
  then raise exception 'invalid checklist items' using errcode = '22023'; end if;
  insert into public.casework_checklist_templates(organization_id, chapter_id, case_type, step, title, items, created_by)
  values (v_org, p_chapter_id, pg_catalog.btrim(p_case_type), pg_catalog.btrim(p_step), pg_catalog.btrim(p_title), p_items, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_org, p_chapter_id, (select auth.uid()), 'checklist_created', 'checklist_template', v_row.id);
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_create_deadline(p_case_id uuid, p_kind text, p_label text, p_due_at timestamp with time zone, p_reminder_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS public.casework_deadlines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  v_case public.member_cases%rowtype;
  v_row public.casework_deadlines%rowtype;
begin
  -- Case graph gate first, before any declaration initializer, authorization
  -- read or row acquisition: this routine writes public.casework_audit_events,
  -- which carries both an auth.users and a member_cases reference.
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  select * into v_case from public.member_cases where id = p_case_id; if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  insert into public.casework_deadlines(
    case_id, organization_id, chapter_id, kind, label, due_at, reminder_at, created_by)
  values (
    v_case.id, v_case.organization_id, v_case.chapter_id, p_kind,
    pg_catalog.btrim(p_label), p_due_at, p_reminder_at, (select auth.uid()))
  returning * into v_row;
  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (
    v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()),
    'deadline_created', 'deadline', v_row.id,
    pg_catalog.jsonb_build_object(
      'kind', v_row.kind,
      'dueAt', v_row.due_at,
      'reminderSet', v_row.reminder_at is not null));
  perform private.learning_casework_journal('casework_deadline_create', p_case_id);
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_decide_deadline_extension(p_extension_id uuid, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS public.casework_deadline_extensions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_extension public.casework_deadline_extensions%rowtype; v_deadline public.casework_deadlines%rowtype;
begin
  perform private.casework_require_mfa();
  if p_decision not in ('approved','denied') then raise exception 'invalid decision' using errcode = '22023'; end if;
  select * into v_extension from public.casework_deadline_extensions where id = p_extension_id for update; if not found then raise exception 'extension not found' using errcode = 'P0002'; end if;
  select * into v_deadline from public.casework_deadlines where id = v_extension.deadline_id for update; if not found then raise exception 'extension not found' using errcode = 'P0002'; end if;
  if not private.casework_staff_can_access(v_deadline.case_id) then raise exception 'extension not found' using errcode = 'P0002'; end if;
  if v_extension.status <> 'requested' then return v_extension; end if;
  update public.casework_deadline_extensions set status = p_decision, decided_by = (select auth.uid()), decided_at = pg_catalog.now(), decision_note = nullif(pg_catalog.btrim(p_note), '')
  where id = v_extension.id returning * into v_extension;
  if p_decision = 'approved' then
    update public.casework_deadlines set due_at = v_extension.requested_due_at, status = 'extended', updated_at = pg_catalog.now() where id = v_deadline.id;
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()), 'deadline_decided', 'deadline_extension', v_extension.id, pg_catalog.jsonb_build_object('decision', p_decision));
  perform private.learning_casework_journal('casework_extension_decide', v_deadline.case_id);
  return v_extension;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_grant_access(p_case_id uuid, p_grantee_user_id uuid, p_reason text)
 RETURNS public.casework_access_grants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_case public.member_cases%rowtype; v_row public.casework_access_grants%rowtype; v_before jsonb;
begin
  perform private.casework_require_mfa();
  select * into v_case from public.member_cases where id = p_case_id for share; if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not private.casework_may_manage_case_access(v_case.id)
  then raise exception 'case not found' using errcode = 'P0002'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 8 and 500
  then raise exception 'grant reason must be 8 to 500 characters' using errcode = '22023', detail = 'casework_grant_reason_invalid'; end if;
  perform private.casework_require_case_access_grantee(v_case.id, p_grantee_user_id);
  select * into v_row from public.casework_access_grants where case_id = v_case.id and grantee_user_id = p_grantee_user_id and revoked_at is null;
  if found then return v_row; end if;
  v_before := private.learning_case_access_state(v_case.id, p_grantee_user_id);
  insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, p_grantee_user_id, (select auth.uid()), pg_catalog.btrim(p_reason)) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'access_granted', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', p_grantee_user_id));
  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103.
  if private.learning_case_in_own_organization(v_case.id) then
    perform private.learning_journal_append(
      'case_access_grant', 'public.casework_access_grants', v_case.id::text || ':' || p_grantee_user_id::text, null,
      private.learning_fingerprint(private.learning_case_access_state(v_case.id, p_grantee_user_id)), null,
      v_before || pg_catalog.jsonb_build_object('audit_floor', (
        select pg_catalog.max(a.id) from public.casework_audit_events a
        where a.case_id = v_case.id and a.event_type in ('access_granted', 'access_revoked')
          and a.metadata ->> 'granteeUserId' = p_grantee_user_id::text)));
  end if;
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_revoke_access(p_grant_id uuid)
 RETURNS public.casework_access_grants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_row public.casework_access_grants%rowtype; v_before jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  -- Resolve the parent without a child lock, then acquire case before grant.
  -- Re-read the grant after waiting; the case may have been deleted meanwhile.
  select * into v_row from public.casework_access_grants where id = p_grant_id; if not found then raise exception 'grant not found' using errcode = 'P0002'; end if;
  perform 1 from public.member_cases where id = v_row.case_id for update;
  if not found then raise exception 'grant not found' using errcode = 'P0002'; end if;
  select * into v_row from public.casework_access_grants where id = p_grant_id for update; if not found then raise exception 'grant not found' using errcode = 'P0002'; end if;
  if not private.casework_staff_can_access(v_row.case_id)
     or not (private.member_has_chapter_staff_grant(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role(v_row.organization_id, array['advisor','admin','vp']))
  then raise exception 'grant not found' using errcode = 'P0002'; end if;
  if v_row.revoked_at is not null then return v_row; end if;
  v_before := private.learning_case_access_state(v_row.case_id, v_row.grantee_user_id);
  update public.casework_access_grants set revoked_at = pg_catalog.now(), revoked_by = (select auth.uid()) where id = v_row.id returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'access_revoked', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', v_row.grantee_user_id));
  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103.
  if private.learning_case_in_own_organization(v_row.case_id) then
    perform private.learning_journal_append(
      'case_access_revoke', 'public.casework_access_grants', v_row.case_id::text || ':' || v_row.grantee_user_id::text, null,
      private.learning_fingerprint(private.learning_case_access_state(v_row.case_id, v_row.grantee_user_id)), null,
      v_before || pg_catalog.jsonb_build_object('audit_floor', (
        select pg_catalog.max(a.id) from public.casework_audit_events a
        where a.case_id = v_row.case_id and a.event_type in ('access_granted', 'access_revoked')
          and a.metadata ->> 'granteeUserId' = v_row.grantee_user_id::text)));
  end if;
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_save_intake_draft(p_draft_id uuid, p_chapter_id text, p_member_user_id uuid, p_case_id uuid, p_payload jsonb, p_expected_revision integer)
 RETURNS public.casework_intake_drafts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_org uuid; v_row public.casework_intake_drafts%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into v_org from public.chapters c where c.id = p_chapter_id; if not found then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if v_org is null or not private.member_has_chapter_staff_grant(p_chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if p_member_user_id is not null and not private.chapter_staff_member_allowed(p_chapter_id, p_member_user_id, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' or pg_catalog.pg_column_size(p_payload) > 32768 then raise exception 'invalid draft payload' using errcode = '22023'; end if;
  if p_case_id is not null and (not private.casework_scope_matches(p_case_id, v_org, p_chapter_id) or not private.casework_staff_can_access(p_case_id)) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_draft_id is null then
    insert into public.casework_intake_drafts(organization_id, chapter_id, owner_user_id, member_user_id, case_id, payload)
    values (v_org, p_chapter_id, (select auth.uid()), p_member_user_id, p_case_id, p_payload) returning * into v_row;
  else
    update public.casework_intake_drafts set member_user_id = p_member_user_id, case_id = p_case_id, payload = p_payload, revision = revision + 1, updated_at = pg_catalog.now()
    where id = p_draft_id and owner_user_id = (select auth.uid()) and revision = p_expected_revision
      and organization_id = v_org and chapter_id = p_chapter_id
      and (member_user_id is null or private.chapter_staff_member_allowed(chapter_id, member_user_id, array['steward','coordinator','advisor','admin','vp']))
      and (case_id is null or private.casework_staff_can_access(case_id)) returning * into v_row;
    if not found then raise exception 'draft changed' using errcode = 'PT409'; end if;
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, p_case_id, (select auth.uid()), 'draft_saved', 'intake_draft', v_row.id, pg_catalog.jsonb_build_object('revision', v_row.revision));
  perform private.learning_casework_journal('casework_draft_save', null, true);
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_set_bargaining_status(p_workspace_id uuid, p_expected_status text, p_next_status text)
 RETURNS public.casework_bargaining_workspaces
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_row public.casework_bargaining_workspaces%rowtype;
begin
  perform private.casework_require_mfa();
  if p_next_status not in ('planning','live','paused','tentative_agreement','closed') then raise exception 'invalid session status' using errcode = '22023'; end if;
  select * into v_row from public.casework_bargaining_workspaces where id = p_workspace_id for update; if not found then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if not private.member_has_chapter_staff_grant(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if v_row.status <> p_expected_status then raise exception 'workspace changed' using errcode = 'PT409'; end if;
  update public.casework_bargaining_workspaces set status = p_next_status, updated_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, event_type, body, created_by)
  values (v_row.id, v_row.organization_id, 'session_status', p_expected_status || ' → ' || p_next_status, (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_workspace', v_row.id, pg_catalog.jsonb_build_object('fromStatus', p_expected_status, 'toStatus', p_next_status));
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_set_checklist_item(p_item_id uuid, p_completed boolean)
 RETURNS public.casework_checklist_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_item public.casework_checklist_items%rowtype; v_checklist public.casework_checklists%rowtype;
begin
  perform private.casework_require_mfa();
  select c.* into v_checklist
  from public.casework_checklists c join public.casework_checklist_items i on i.checklist_id = c.id
  where i.id = p_item_id for update of c; if not found then raise exception 'checklist item not found' using errcode = 'P0002'; end if;
  if not private.casework_staff_can_access(v_checklist.case_id) then raise exception 'checklist item not found' using errcode = 'P0002'; end if;
  update public.casework_checklist_items set
    completed_at = case when p_completed then pg_catalog.now() else null end,
    completed_by = case when p_completed then (select auth.uid()) else null end
  where id = p_item_id returning * into v_item;
  update public.casework_checklists set completed_at = case
    when exists (select 1 from public.casework_checklist_items i where i.checklist_id = v_checklist.id and i.completed_at is null) then null
    else pg_catalog.now()
  end where id = v_checklist.id;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_checklist.organization_id, v_checklist.chapter_id, v_checklist.case_id, (select auth.uid()), 'checklist_item_changed', 'checklist_item', v_item.id, pg_catalog.jsonb_build_object('completed', p_completed));
  perform private.learning_casework_journal('casework_checklist_item', v_checklist.case_id);
  return v_item;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_transition_bargaining_proposal(p_proposal_id uuid, p_expected_status text, p_next_status text, p_response_due_at timestamp with time zone)
 RETURNS public.casework_bargaining_proposals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_proposals%rowtype;
begin
  perform private.casework_require_mfa();
  if p_next_status not in ('draft','proposed','countered','tentative','accepted','rejected','withdrawn') then raise exception 'invalid proposal status' using errcode = '22023'; end if;
  select * into v_row from public.casework_bargaining_proposals where id = p_proposal_id for update; if not found then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  select * into v_workspace from public.casework_bargaining_workspaces where id = v_row.workspace_id; if not found then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if not private.member_has_chapter_staff_grant(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if v_row.status <> p_expected_status then raise exception 'proposal changed' using errcode = 'PT409'; end if;
  update public.casework_bargaining_proposals set status = p_next_status, response_due_at = p_response_due_at, updated_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, proposal_id, event_type, body, created_by)
  values (v_workspace.id, v_workspace.organization_id, v_row.id, 'proposal_status', p_expected_status || ' → ' || p_next_status, (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_proposal', v_row.id, pg_catalog.jsonb_build_object('fromStatus', p_expected_status, 'toStatus', p_next_status));
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.coordinator_case_for_update(p_case_id uuid)
 RETURNS public.member_cases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare found public.member_cases%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if not private.member_case_visible_to_caller(p_case_id) then
    raise exception 'case unavailable' using errcode = '42501';
  end if;
  select c.* into found from public.member_cases c
  where c.id = p_case_id and public.staff_can_see_user(c.user_id, 'coordinator')
    and private.member_case_visible_to_caller(c.id)
  for update of c;
  if found.id is null then raise exception 'case unavailable' using errcode = '42501'; end if;
  return found;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.assign_member_case(p_case_id uuid, p_steward uuid DEFAULT NULL::uuid, p_coordinator uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid := (select auth.uid());
  unchanged uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  case_row public.member_cases%rowtype;
  case_chapter text;
  steward_label text;
  coordinator_label text;
  actor_label text;
  before_value jsonb;
  after_value jsonb;
  new_steward uuid;
  new_coordinator uuid;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator', 'admin']) then
    raise exception 'coordinator role and MFA required' using errcode = '42501';
  end if;

  select c.* into case_row from public.member_cases c where c.id = p_case_id for update;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not public.staff_can_see_user(case_row.user_id, 'coordinator') or not private.chapter_case_staff_readable(case_row) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select p.chapter_id into case_chapter from public.member_profiles p where p.id = case_row.user_id;

  -- The leave-unchanged intent is resolved against the locked row before any
  -- validation: a role the caller did not name is carried over byte-for-byte,
  -- never re-checked, never re-labelled, and never written as a null.
  new_steward := case when p_steward = unchanged then case_row.steward_user_id else p_steward end;
  new_coordinator := case when p_coordinator = unchanged then case_row.coordinator_user_id else p_coordinator end;

  -- Scope checks run only for a role that is actually being written. The
  -- stored display name follows the same three-way intent as the user id: a
  -- named person is looked up, the leave-unchanged sentinel keeps the existing
  -- label, and an explicit null clears the label with the id.
  if p_steward is not null and p_steward <> unchanged then
    select p.full_name into steward_label
    from public.member_roles r join public.member_profiles p on p.id = r.user_id
    where r.user_id = p_steward and r.role = 'steward'
      and (r.chapter_id is null or r.chapter_id = case_chapter)
      and private.actor_role_covers_member(r.user_id,case_chapter,r.role,case_row.user_id,true);
    if not found then raise exception 'steward is outside case scope or lacks role' using errcode = '23514'; end if;
  elsif p_steward = unchanged then
    steward_label := case_row.steward_name;
  else
    steward_label := null;
  end if;
  if p_coordinator is not null and p_coordinator <> unchanged then
    select p.full_name into coordinator_label
    from public.member_roles r join public.member_profiles p on p.id = r.user_id
    where r.user_id = p_coordinator and r.role = 'coordinator'
      and (r.chapter_id is null or r.chapter_id = case_chapter)
      and private.actor_role_covers_member(r.user_id,case_chapter,r.role,case_row.user_id,true);
    if not found then raise exception 'coordinator is outside case scope or lacks role' using errcode = '23514'; end if;
  elsif p_coordinator = unchanged then
    coordinator_label := case_row.coordinator_name;
  else
    coordinator_label := null;
  end if;

  before_value := pg_catalog.jsonb_build_object(
    'stewardUserId', case_row.steward_user_id, 'stewardName', case_row.steward_name,
    'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name
  );
  after_value := pg_catalog.jsonb_build_object(
    'stewardUserId', new_steward, 'stewardName', steward_label,
    'coordinatorUserId', new_coordinator, 'coordinatorName', coordinator_label
  );
  if before_value = after_value then return; end if;

  update public.member_cases set
    steward_user_id = new_steward, steward_name = steward_label,
    coordinator_user_id = new_coordinator, coordinator_name = coordinator_label,
    assigned_at = case when new_steward is null and new_coordinator is null then null else now() end
  where id = p_case_id;

  actor_label := coalesce(
    (select p.full_name from public.member_profiles p where p.id = caller),
    'Staff member'
  );
  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (p_case_id, caller, actor_label, before_value, after_value);

  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103: a
  -- practice reassignment can be undone while the ones set here stay.
  if private.learning_case_in_own_organization(p_case_id) then
    perform private.learning_journal_append(
      'case_assign', 'public.member_case_assignment_audit', p_case_id::text, null,
      private.learning_fingerprint(private.learning_case_assignment_state(p_case_id)), null,
      pg_catalog.jsonb_build_object('steward_user_id', case_row.steward_user_id,
        'coordinator_user_id', case_row.coordinator_user_id, 'assigned_at', case_row.assigned_at,
        'audit_floor', (select pg_catalog.max(a.id) from public.member_case_assignment_audit a where a.case_id = p_case_id)));
  end if;
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_organization_coordination_record(p_kind text, p_title text, p_summary text DEFAULT ''::text, p_visibility text DEFAULT 'staff'::text, p_partner_organization_id uuid DEFAULT NULL::uuid, p_parent_id uuid DEFAULT NULL::uuid, p_chapter_id text DEFAULT NULL::text, p_config jsonb DEFAULT '{}'::jsonb, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  created public.organization_coordination_records%rowtype;
  parent_item public.organization_coordination_records%rowtype;
  resolved_partner uuid := p_partner_organization_id;
  handshake_id uuid;
  initial_status text := 'draft';
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization staff role required' using errcode = '42501';
  end if;
  if p_kind not in (
    'mission', 'mission_objective', 'network_link', 'network_conversation',
    'network_request', 'network_export_schedule', 'handshake_workspace_item',
    'coalition', 'coalition_campaign', 'coalition_work_item', 'merger_plan',
    'microsite_page', 'coverage_schedule', 'coverage_override', 'committee',
    'mobilization_campaign', 'mobilization_cohort'
  ) then
    raise exception 'unsupported coordination record kind' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_config, '{}'::jsonb)) <> 'object'
     or pg_catalog.octet_length(coalesce(p_config, '{}'::jsonb)::text) > 12000 then
    raise exception 'coordination config unavailable' using errcode = '22023';
  end if;
  if p_parent_id is not null then
    select * into parent_item
    from public.organization_coordination_records r
    where r.id = p_parent_id;
    if not found or not private.organization_coordination_can_read(parent_item.id) then
      raise exception 'coordination parent unavailable' using errcode = '22023';
    end if;
    if resolved_partner is null then
      resolved_partner := case
        when parent_item.organization_id = organization then parent_item.partner_organization_id
        else parent_item.organization_id
      end;
    end if;
  end if;
  -- An unverified organization cannot take a partner (its boundary trigger
  -- refuses the insert too); this refuses before the partner is looked at, so
  -- the answer is the same for every partner id.
  if resolved_partner is not null and not private.organization_clears_signup_boundary(organization) then
    raise exception 'organization verification required' using errcode = '42501';
  end if;
  if resolved_partner is not null and (
    resolved_partner = organization
    or not exists (
      select 1 from public.organizations o
      where o.id = resolved_partner and o.status = 'active'
    )
    or not coalesce(
      private.organization_network_can_discover(resolved_partner)
      -- The owner or partner of a coordination record the caller may read (a
      -- parent, or a coalition it joined as an accepted participant) is
      -- already known to it, whether named or taken from a parent.
      or exists (
        select 1 from public.organization_coordination_records readable
        where (readable.organization_id = resolved_partner or readable.partner_organization_id = resolved_partner)
          and private.organization_coordination_can_read(readable.id)
      )
      or exists (
        select 1 from public.organization_coordination_records known
        where (known.organization_id = organization and known.partner_organization_id = resolved_partner)
           or (known.organization_id = resolved_partner and known.partner_organization_id = organization)
      ),
      false
    )
  ) then
    raise exception 'partner organization unavailable' using errcode = '22023';
  end if;
  if p_chapter_id is not null and not exists (
    select 1 from public.chapters c
    where c.id = p_chapter_id and c.organization_id = organization
  ) then
    raise exception 'chapter unavailable' using errcode = '22023';
  end if;
  if p_kind in ('network_link', 'merger_plan') and resolved_partner is null then
    raise exception 'partner organization required' using errcode = '22023';
  end if;
  if p_kind = 'microsite_page' and p_chapter_id is null then
    raise exception 'chapter required for microsite page' using errcode = '22023';
  end if;
  if p_kind = 'handshake_workspace_item' then
    begin
      handshake_id := nullif(p_config ->> 'handshakeId', '')::uuid;
    exception when invalid_text_representation then
      handshake_id := null;
    end;
    if handshake_id is null or not exists (
      select 1
      from public.chapter_handshakes h
      join public.chapters c on c.id in (h.chapter_id, h.receiving_chapter_id)
      where h.id = handshake_id and h.status = 'active'
        and c.organization_id = organization
    ) then
      raise exception 'active chapter handshake required' using errcode = '22023';
    end if;
  end if;
  if p_kind in ('mission', 'coalition', 'committee', 'mobilization_campaign') then
    initial_status := 'active';
  elsif p_kind in ('network_link', 'merger_plan') then
    initial_status := 'requested';
  elsif p_kind = 'microsite_page' then
    initial_status := 'draft';
  end if;

  insert into public.organization_coordination_records (
    organization_id, partner_organization_id, chapter_id, parent_id, kind,
    title, summary, status, visibility, config, created_by, idempotency_key
  ) values (
    organization, resolved_partner, p_chapter_id, p_parent_id, p_kind,
    pg_catalog.btrim(p_title), coalesce(p_summary, ''), initial_status,
    p_visibility, coalesce(p_config, '{}'::jsonb), caller, p_idempotency_key
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into created;

  if created.organization_id <> organization then
    raise exception 'idempotency key unavailable' using errcode = '42501';
  end if;

  insert into public.organization_coordination_organization_participants (
    record_id, organization_id, role, status, invited_by, responded_by
  ) values (created.id, organization, 'owner', 'active', caller, caller)
  on conflict (record_id, organization_id) do nothing;

  if created.partner_organization_id is not null then
    insert into public.organization_coordination_organization_participants (
      record_id, organization_id, role, status, invited_by
    ) values (created.id, created.partner_organization_id, 'partner', 'invited', caller)
    on conflict (record_id, organization_id) do nothing;
  end if;

  if p_parent_id is not null then
    insert into public.organization_coordination_organization_participants (
      record_id, organization_id, role, status, invited_by, responded_by
    )
    select created.id, participant.organization_id,
      case when participant.organization_id = organization then 'owner' else 'member' end,
      participant.status, caller,
      case when participant.status = 'active' then caller else null end
    from public.organization_coordination_organization_participants participant
    where participant.record_id = p_parent_id
      and participant.status in ('active', 'invited')
    on conflict (record_id, organization_id) do nothing;
  end if;

  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    created.id, organization, caller, 'record_created', created.status,
    pg_catalog.jsonb_build_object('kind', created.kind),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', created.id, 'kind', created.kind, 'status', created.status,
    'organizationId', created.organization_id
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_chapter_connection_profiles(p_selected_hat text, p_after_id text DEFAULT NULL::text, p_limit integer DEFAULT 250, p_snapshot_token text DEFAULT NULL::text, p_chapter_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  viewer_chapter text;
  cap integer;
  current_epoch bigint;
  token_epoch bigint;
  snapshot_at timestamptz;
  token text;
  scope_hash text;
  after_id text;
  rows_out jsonb;
  fetched integer;
  last_id text;
begin
  org := private.mi1_require_selected_organization();
  viewer_chapter := private.chapter_connection_require_chapter(org, coalesce(nullif(pg_catalog.btrim(p_chapter_id), ''), private.current_member_chapter()));
  perform private.chapter_connection_require_hat(
    org, p_selected_hat, viewer_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);

  scope_hash := pg_catalog.md5(org::text || ':' || viewer_chapter || ':' || p_selected_hat);

  cap := least(greatest(coalesce(p_limit, 250), 1), 500);
  after_id := nullif(pg_catalog.btrim(coalesce(p_after_id, '')), '');

  if p_snapshot_token is null then
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()))::double precision);
  else
    if p_snapshot_token !~ '^[0-9]{1,18}:[0-9]{1,12}:[a-f0-9]{32}$' then
      raise exception 'connection registry snapshot token invalid' using errcode = '22023';
    end if;
    token_epoch := pg_catalog.split_part(p_snapshot_token, ':', 1)::bigint;
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.split_part(p_snapshot_token, ':', 2)::double precision);
    if pg_catalog.split_part(p_snapshot_token, ':', 3) <> scope_hash then
      raise exception 'connection registry snapshot scope changed' using errcode = '22023';
    end if;
  end if;
  -- The epoch is a fingerprint of every row the list may return at the
  -- snapshot time, cursor and limit aside: the same filters as the page below,
  -- so a profile or hide the caller cannot observe never moves it.
  select ('x' || pg_catalog.substr(pg_catalog.md5(coalesce(pg_catalog.string_agg(visible.fingerprint, '|' order by visible.fingerprint collate "C"), '')), 1, 14))::bit(56)::bigint
    into current_epoch
  from (
    select p.chapter_id || ':' || private.chapter_connection_profile_projection(p, c.name)::text as fingerprint
    from private.chapter_connection_profiles p
    join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
    join public.organizations o on o.id = p.organization_id and o.status = 'active' and o.kind = 'union'
    where p.publication_status = 'published'
      and (p.organization_id = org or private.organization_visible_in_directory(p.organization_id))
      and p.expires_at > snapshot_at
      and p.chapter_id <> viewer_chapter
      and private.organization_clears_signup_boundary(org)
      and not exists (
        select 1 from private.chapter_connection_hides h
        where (h.chapter_id = viewer_chapter and h.hidden_chapter_id = p.chapter_id)
           or (h.chapter_id = p.chapter_id and h.hidden_chapter_id = viewer_chapter)
      )
  ) visible;
  current_epoch := coalesce(current_epoch, 1);
  if p_snapshot_token is not null then
    -- An expired token is refused as expired whatever has changed since, so
    -- the order of the two refusals reveals nothing.
    if snapshot_at > pg_catalog.now() + interval '1 minute'
       or snapshot_at < pg_catalog.now() - interval '1 hour' then
      raise exception 'connection registry snapshot expired' using errcode = '22023';
    end if;
    if token_epoch <> current_epoch then
      raise exception 'connection registry snapshot changed' using errcode = '22023';
    end if;
  end if;
  token := current_epoch::text || ':' || pg_catalog.floor(extract(epoch from snapshot_at))::bigint::text || ':' || scope_hash;

  select
    coalesce(pg_catalog.jsonb_agg(page.item order by page.chapter_id collate "C"), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    pg_catalog.max(page.chapter_id collate "C")
  into rows_out, fetched, last_id
  from (
    select
      p.chapter_id,
      private.chapter_connection_profile_projection(p, c.name) as item
    from private.chapter_connection_profiles p
    join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
    join public.organizations o on o.id = p.organization_id and o.status = 'active' and o.kind = 'union'
    where p.publication_status = 'published'
      and (p.organization_id = org or private.organization_visible_in_directory(p.organization_id))
      and p.expires_at > snapshot_at
      and p.chapter_id <> viewer_chapter
      and private.organization_clears_signup_boundary(org)
      and (after_id is null or p.chapter_id collate "C" > after_id collate "C")
      and not exists (
        select 1 from private.chapter_connection_hides h
        where (h.chapter_id = viewer_chapter and h.hidden_chapter_id = p.chapter_id)
           or (h.chapter_id = p.chapter_id and h.hidden_chapter_id = viewer_chapter)
      )
    order by p.chapter_id collate "C"
    limit cap + 1
  ) page;

  if fetched > cap then
    -- Drop the look-ahead row: the page is the first cap rows in order.
    rows_out := (
      select coalesce(pg_catalog.jsonb_agg(elem.value order by elem.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(rows_out) with ordinality as elem
      where elem.ordinality <= cap
    );
    last_id := rows_out -> (cap - 1) ->> 'id';
  end if;

  return pg_catalog.jsonb_build_object(
    'snapshotToken', token,
    'snapshotAt', snapshot_at,
    'rows', rows_out,
    'nextCursor', case when fetched > cap then last_id else null end,
    'complete', fetched <= cap
  );
end;
$function$;

notify pgrst, 'reload schema';

commit;
