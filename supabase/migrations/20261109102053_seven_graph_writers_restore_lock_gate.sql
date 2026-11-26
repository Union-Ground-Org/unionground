-- BUG-UG-DB-SEVEN-GRAPH-WRITERS-LOST-LOCK-GATE-20261109 (#7771).
-- 20261109060229 (#7688) re-emitted seven direct case graph writers from
-- their August create text (20260821012000, 20260828210000). Their first
-- private.lock_case_graph gate was never in that text: the hash-pinned
-- case_graph_writers block in 20260907151000 added it at install time by
-- wrapping each installed body in an outer block that takes the gate before
-- the original declarations run. The re-emission kept the intended
-- member_has_chapter_staff_grant swap (and the document container check in
-- share_chapter_handshake_document) but dropped that wrapper.
--
-- Each definition below is the 20261109060229 body, unchanged, inside the
-- exact outer block the 20260907151000 wrapper installs. create or replace
-- keeps each function's owner and execute grants; security definer and the
-- empty search_path are restated as before.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- public.casework_add_bargaining_event (body: 20261109060229; outer gate: 20260907151000 case_graph_writers)
create or replace function public.casework_add_bargaining_event(
  p_workspace_id uuid, p_event_type text, p_body text, p_pulse text
)
returns public.casework_bargaining_events
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_events%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = p_workspace_id for share;
  if not private.member_has_chapter_staff_grant(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_events(workspace_id, organization_id, event_type, body, pulse, created_by)
  values (v_workspace.id, v_workspace.organization_id, p_event_type, pg_catalog.btrim(p_body), p_pulse, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_event', v_row.id, pg_catalog.jsonb_build_object('eventType', p_event_type, 'pulse', p_pulse));
  return v_row;
end;
end;
$function$;

-- public.casework_add_bargaining_proposal (body: 20261109060229; outer gate: 20260907151000 case_graph_writers)
create or replace function public.casework_add_bargaining_proposal(
  p_workspace_id uuid, p_side text, p_title text, p_body text, p_response_due_at timestamptz
)
returns public.casework_bargaining_proposals
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_proposals%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = p_workspace_id for share;
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

-- public.casework_create_bargaining_workspace (body: 20261109060229; outer gate: 20260907151000 case_graph_writers)
create or replace function public.casework_create_bargaining_workspace(p_chapter_id text, p_title text, p_starts_at timestamptz)
returns public.casework_bargaining_workspaces
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_org uuid; v_row public.casework_bargaining_workspaces%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if not private.member_has_chapter_staff_grant(p_chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_workspaces(organization_id, chapter_id, title, starts_at, created_by)
  values (v_org, p_chapter_id, pg_catalog.btrim(p_title), p_starts_at, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_workspace', v_row.id, pg_catalog.jsonb_build_object('status', v_row.status));
  return v_row;
end;
end;
$function$;

-- public.close_chapter_handshake (body: 20261109060229; outer gate: 20260907151000 case_graph_writers)
create or replace function public.close_chapter_handshake(
  p_handshake_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  previous_status text;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if caller is null or not found
     or (chapter is distinct from item.chapter_id and chapter is distinct from item.receiving_chapter_id)
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'request unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'closed' then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status not in ('requested','accepted','active') then
    raise exception 'request cannot be closed' using errcode = '22023';
  end if;
  previous_status := item.status;
  update public.chapter_handshakes set status = 'closed' where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter, 'closed', previous_status, 'closed');
  perform private.notify_handshake_staff(
    case when chapter = item.chapter_id then item.receiving_chapter_id else item.chapter_id end,
    'Partnership request closed', 'The other participating chapter closed this request.');
  return pg_catalog.to_jsonb(item);
end;
end;
$function$;

-- public.countersign_chapter_handshake (body: 20261109060229; outer gate: 20260907151000 case_graph_writers)
create or replace function public.countersign_chapter_handshake(
  p_handshake_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if not found or item.chapter_id <> chapter then raise exception 'request unavailable' using errcode = '42501'; end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'activated' then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status <> 'accepted' or item.receiver_signed_by is null then
    raise exception 'receiving signature required' using errcode = '22023';
  end if;
  update public.chapter_handshakes
  set requester_signed_by = caller, requester_signed_at = pg_catalog.clock_timestamp(), status = 'active'
  where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter, 'activated', 'accepted', 'active');
  perform private.notify_handshake_staff(item.receiving_chapter_id, 'Partnership request activated',
    'Both chapters countersigned. Only the approved data scope is now available.');
  return pg_catalog.to_jsonb(item);
end;
end;
$function$;

-- public.respond_chapter_handshake (body: 20261109060229; outer gate: 20260907151000 case_graph_writers)
create or replace function public.respond_chapter_handshake(
  p_handshake_id uuid,
  p_decision text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
  next_status text;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_decision not in ('accept','decline') or p_idempotency_key is null then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if not found or item.receiving_chapter_id <> chapter then
    raise exception 'request unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> (case when p_decision = 'accept' then 'accepted' else 'declined' end) then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status <> 'requested' then raise exception 'request already resolved' using errcode = '22023'; end if;
  next_status := case when p_decision = 'accept' then 'accepted' else 'declined' end;
  update public.chapter_handshakes
  set status = next_status,
      receiver_signed_by = case when p_decision = 'accept' then caller else null end,
      receiver_signed_at = case when p_decision = 'accept' then pg_catalog.clock_timestamp() else null end,
      countersigned_by = case when p_decision = 'accept' then caller else null end,
      countersigned_at = case when p_decision = 'accept' then pg_catalog.clock_timestamp() else null end
  where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter,
    case when p_decision = 'accept' then 'accepted' else 'declined' end,
    'requested', next_status);
  perform private.notify_handshake_staff(item.chapter_id,
    case when p_decision = 'accept' then 'Partnership request accepted' else 'Partnership request declined' end,
    case when p_decision = 'accept'
      then 'The receiving chapter accepted. An authorized requester must countersign before activation.'
      else 'The receiving chapter declined the request.' end);
  return pg_catalog.to_jsonb(item);
end;
end;
$function$;

-- public.share_chapter_handshake_document (body: 20261109060229; outer gate: 20260907151000 case_graph_writers)
create or replace function public.share_chapter_handshake_document(
  p_handshake_id uuid,
  p_document_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if caller is null or not found or item.status <> 'active' or item.data_scope <> 'docs_only'
     or (chapter is distinct from item.chapter_id and chapter is distinct from item.receiving_chapter_id)
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp'])
     or not exists (
       select 1 from public.chapter_documents d
       where d.id = p_document_id and d.chapter_id = chapter and d.status = 'published'
         and private.chapter_document_container_allows(d.chapter_id, d.access_unit_id, d.access_committee_id)
     ) then
    raise exception 'document exchange unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'document_shared'
       or prior_event.detail ->> 'documentId' is distinct from p_document_id::text then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('shared', true, 'handshakeId', item.id, 'documentId', p_document_id);
  end if;
  insert into public.chapter_handshake_documents (handshake_id, document_id, shared_by)
  values (item.id, p_document_id, caller) on conflict do nothing;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status,
     detail)
  values (item.id, p_idempotency_key, caller, chapter, 'document_shared', 'active', 'active',
    pg_catalog.jsonb_build_object('documentId', p_document_id));
  return pg_catalog.jsonb_build_object('shared', true, 'handshakeId', item.id, 'documentId', p_document_id);
end;
end;
$function$;

commit;
