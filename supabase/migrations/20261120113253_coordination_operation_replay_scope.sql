-- SEC-UG-COORDINATION-REPLAY-RETURNS-FOREIGN-IDS-20261120 (#9274).
-- Operation keys belong to an organization, never to the global table.
-- The shared receipt guard serializes each organization/operation/key and binds
-- its actor, target and normalized payload; retries return the original response.
-- Existing own rows are adopted only after the same binding is checked.
-- Latest Main bodies retain case-graph locks, the platform export boundary and
-- the unit/committee document guard. Provisional Eastern stamp; HOLD only.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='public.record_organization_coordination_outreach(uuid,uuid,text,text,uuid)'::regprocedure) is distinct from '93a15b5485bcbb728bd3ae707cf3efbc' then
    raise exception 'unreviewed public.record_organization_coordination_outreach predecessor' using errcode='55000';
  end if;
  if (select md5(prosrc) from pg_proc where oid='public.run_organization_coordination_export(uuid,text,uuid)'::regprocedure) is distinct from '55dc5b20cdc7d83ef48fa2b29e4e0946' then
    raise exception 'unreviewed public.run_organization_coordination_export predecessor' using errcode='55000';
  end if;
  if (select md5(prosrc) from pg_proc where oid='public.send_organization_coordination_message(uuid,text,uuid)'::regprocedure) is distinct from '8f8b36ebd70cc180c7aef5a51e0f13f7' then
    raise exception 'unreviewed public.send_organization_coordination_message predecessor' using errcode='55000';
  end if;
  if (select md5(prosrc) from pg_proc where oid='public.propose_organization_coalition_decision(uuid,uuid,text,text,text,integer,uuid)'::regprocedure) is distinct from '5c397b7b564a18dd0f7d3ddf3331fd15' then
    raise exception 'unreviewed public.propose_organization_coalition_decision predecessor' using errcode='55000';
  end if;
  if (select md5(prosrc) from pg_proc where oid='public.share_organization_coordination_resource(uuid,text,text,uuid,uuid)'::regprocedure) is distinct from 'c321567a414a08ba728011fe663bfd00' then
    raise exception 'unreviewed public.share_organization_coordination_resource predecessor' using errcode='55000';
  end if;
  if (select md5(prosrc) from pg_proc where oid='public.take_over_public_chapter_page(text,text,text,text,uuid)'::regprocedure) is distinct from '41305fd0eee86c7fecde0441c4d57935' then
    raise exception 'unreviewed public.take_over_public_chapter_page predecessor' using errcode='55000';
  end if;
end $guard$;

alter table public.organization_coordination_outreach_events
  drop constraint organization_coordination_outreach_events_idempotency_key_key,
  add constraint coordination_replay_1_scope_key unique (organization_id, actor_user_id, idempotency_key);

alter table public.organization_coordination_export_runs
  drop constraint organization_coordination_export_runs_idempotency_key_key,
  add constraint coordination_replay_2_scope_key unique (organization_id, requested_by, idempotency_key);

alter table public.organization_coordination_messages
  drop constraint organization_coordination_messages_idempotency_key_key,
  add constraint coordination_replay_3_scope_key unique (sender_organization_id, sender_user_id, idempotency_key);

alter table public.organization_coalition_decisions
  drop constraint organization_coalition_decisions_idempotency_key_key,
  add constraint coordination_replay_4_scope_key unique (proposing_organization_id, proposed_by, idempotency_key);

alter table public.organization_coordination_resources
  drop constraint organization_coordination_resources_idempotency_key_key,
  add constraint coordination_replay_5_scope_key unique (from_organization_id, created_by, idempotency_key);

alter table public.public_chapter_page_takeovers
  drop constraint public_chapter_page_takeovers_idempotency_key_key,
  add constraint coordination_replay_6_scope_key unique (organization_id, new_owner_id, idempotency_key);

CREATE OR REPLACE FUNCTION public.record_organization_coordination_outreach(p_campaign_id uuid, p_target_user_id uuid, p_disposition text, p_note text DEFAULT ''::text, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
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
  event_id uuid;
  prior public.organization_coordination_outreach_events%rowtype;
  request_payload jsonb;
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.has_organization_role(organization, array['steward','coordinator','admin','vp']) then
    raise exception 'organization outreach role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_coordination_records r
    where r.id = p_campaign_id and r.organization_id = organization
      and r.kind = 'mobilization_campaign' and r.status in ('active', 'paused')
  ) then
    raise exception 'mobilization campaign unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = organization and m.user_id = p_target_user_id
      and m.status = 'active'
  ) then
    raise exception 'member unavailable' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object('actor', caller, 'requestHash',
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to((pg_catalog.jsonb_build_object('actor', caller, 'campaign', p_campaign_id, 'member', p_target_user_id, 'disposition', p_disposition, 'note', coalesce(p_note, '')))::text, 'UTF8'), 'sha256'), 'hex'));
  result := private.member_operations_replay(organization, 'record_organization_coordination_outreach', p_idempotency_key, request_payload);
  if result is not null then return result; end if;

  select * into prior from public.organization_coordination_outreach_events r
  where r.organization_id = organization and r.actor_user_id = caller
    and r.idempotency_key = p_idempotency_key;
  if found then
    if prior.actor_user_id is distinct from caller
       or prior.campaign_id is distinct from p_campaign_id
       or prior.target_user_id is distinct from p_target_user_id
       or prior.disposition is distinct from p_disposition
       or prior.note is distinct from coalesce(p_note, '') then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    event_id := prior.id;
  else
  insert into public.organization_coordination_outreach_events (
    campaign_id, organization_id, target_user_id, actor_user_id,
    disposition, note, idempotency_key
  ) values (
    p_campaign_id, organization, p_target_user_id, caller,
    p_disposition, coalesce(p_note, ''), p_idempotency_key
  )
  returning id into event_id;
  end if;
  result := pg_catalog.jsonb_build_object('recorded', true, 'eventId', event_id);
  perform private.member_operations_store_receipt(organization, 'record_organization_coordination_outreach', p_idempotency_key, request_payload, result);
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.run_organization_coordination_export(p_schedule_id uuid, p_format text DEFAULT 'csv'::text, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
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
  run_id uuid;
  prior public.organization_coordination_export_runs%rowtype;
  request_payload jsonb;
  result jsonb;
  rows_ready integer;
  chosen text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if not private.organization_is_union(organization) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if p_format not in ('csv', 'json') then
    raise exception 'export format unavailable' using errcode = '22023';
  end if;
  select coalesce(record.config ->> 'dataset', 'coordination_records') into chosen
  from public.organization_coordination_records record
  where record.id = p_schedule_id and record.organization_id = organization
    and record.kind = 'network_export_schedule' and record.status = 'active';
  if not found then
    raise exception 'export schedule unavailable' using errcode = '22023';
  end if;
  if not private.has_organization_role(organization, private.organization_export_dataset_roles(chosen)) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if private.organization_export_restored_dataset(chosen)
     and not private.organization_feature_enabled(organization, 'features.automation.scheduled_dataset_exports') then
    raise exception 'scheduled dataset exports are turned off for this organization' using errcode = '42501';
  end if;
  request_payload := pg_catalog.jsonb_build_object('actor', caller, 'requestHash',
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to((pg_catalog.jsonb_build_object('actor', caller, 'schedule', p_schedule_id, 'format', p_format))::text, 'UTF8'), 'sha256'), 'hex'));
  result := private.member_operations_replay(organization, 'run_organization_coordination_export', p_idempotency_key, request_payload);
  if result is not null then
    -- A schedule may now choose another dataset. Authorize the stored
    -- response's dataset too, before exposing its metadata.
    if not private.has_organization_role(organization, private.organization_export_dataset_roles(result ->> 'dataset')) then
      raise exception 'organization export role required' using errcode = '42501';
    end if;
    if private.organization_export_restored_dataset(result ->> 'dataset')
       and not private.organization_feature_enabled(organization, 'features.automation.scheduled_dataset_exports') then
      raise exception 'scheduled dataset exports are turned off for this organization' using errcode = '42501';
    end if;
    return result;
  end if;

  if chosen = 'coordination_records' then
    select pg_catalog.count(*)::integer into rows_ready
    from public.organization_coordination_records record
    where private.organization_is_union(record.organization_id)
      and (record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      ));
  else
    rows_ready := pg_catalog.jsonb_array_length(private.organization_export_dataset(organization, chosen) -> 'rows');
  end if;
  select * into prior from public.organization_coordination_export_runs r
  where r.organization_id = organization and r.requested_by = caller
    and r.idempotency_key = p_idempotency_key;
  if found then
    if prior.requested_by is distinct from caller
       or prior.schedule_id is distinct from p_schedule_id
       or prior.format is distinct from p_format then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    run_id := prior.id;
    rows_ready := prior.row_count;
    chosen := prior.dataset;
    -- Legacy runs have no receipt yet, but their stored dataset has the
    -- same live role and feature requirements as a receipt-backed run.
    if not private.has_organization_role(organization, private.organization_export_dataset_roles(chosen)) then
      raise exception 'organization export role required' using errcode = '42501';
    end if;
    if private.organization_export_restored_dataset(chosen)
       and not private.organization_feature_enabled(organization, 'features.automation.scheduled_dataset_exports') then
      raise exception 'scheduled dataset exports are turned off for this organization' using errcode = '42501';
    end if;
  else
  insert into public.organization_coordination_export_runs (
    schedule_id, organization_id, requested_by, format, delivery_mode,
    status, row_count, idempotency_key, dataset
  ) values (
    p_schedule_id, organization, caller, p_format, 'internal_download',
    'ready', rows_ready, p_idempotency_key, chosen
  )
  returning id into run_id;
  end if;
  result := pg_catalog.jsonb_build_object(
    'runId', run_id, 'status', 'ready', 'rowCount', rows_ready,
    'deliveryMode', 'internal_download', 'dataset', chosen
  );
  perform private.member_operations_store_receipt(organization, 'run_organization_coordination_export', p_idempotency_key, request_payload, result);
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.send_organization_coordination_message(p_conversation_id uuid, p_body text, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
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
  item public.organization_coordination_records%rowtype;
  network public.organization_coordination_records%rowtype;
  message_id uuid;
  prior public.organization_coordination_messages%rowtype;
  request_payload jsonb;
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  select * into item
  from public.organization_coordination_records record
  where record.id = p_conversation_id
    and record.kind in ('network_conversation', 'coalition_campaign')
    and record.status = 'active';
  if not found or not private.organization_coordination_can_read(item.id) then
    raise exception 'coordination conversation unavailable' using errcode = '22023';
  end if;
  if item.kind = 'network_conversation' then
    select * into network
    from public.organization_coordination_records record
    where record.id = item.parent_id and record.kind = 'network_link'
      and record.status = 'active';
    if not found or not private.organization_network_has_permission(
      network.organization_id, network.partner_organization_id, 'message'
    ) then
      raise exception 'organization message permission required' using errcode = '42501';
    end if;
  end if;
  if not private.organization_coordination_is_staff(organization)
    and not exists (
      select 1
      from public.organization_coordination_user_participants participant
      where participant.record_id = item.id
        and participant.organization_id = organization
        and participant.user_id = caller and participant.status = 'active'
    ) then
    raise exception 'conversation participation required' using errcode = '42501';
  end if;
  request_payload := pg_catalog.jsonb_build_object('actor', caller, 'requestHash',
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to((pg_catalog.jsonb_build_object('actor', caller, 'conversation', p_conversation_id, 'body', pg_catalog.btrim(p_body)))::text, 'UTF8'), 'sha256'), 'hex'));
  result := private.member_operations_replay(organization, 'send_organization_coordination_message', p_idempotency_key, request_payload);
  if result is not null then return result; end if;

  select * into prior from public.organization_coordination_messages r
  where r.sender_organization_id = organization and r.sender_user_id = caller
    and r.idempotency_key = p_idempotency_key;
  if found then
    if prior.sender_user_id is distinct from caller
       or prior.conversation_id is distinct from p_conversation_id
       or prior.body is distinct from pg_catalog.btrim(p_body) then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    message_id := prior.id;
  else
  insert into public.organization_coordination_messages (
    conversation_id, sender_organization_id, sender_user_id, body,
    idempotency_key
  ) values (
    item.id, organization, caller, pg_catalog.btrim(p_body), p_idempotency_key
  )
  returning id into message_id;
  end if;
  result := pg_catalog.jsonb_build_object('sent', true, 'messageId', message_id);
  perform private.member_operations_store_receipt(organization, 'send_organization_coordination_message', p_idempotency_key, request_payload, result);
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propose_organization_coalition_decision(p_campaign_id uuid, p_subject_record_id uuid, p_title text, p_rationale text DEFAULT ''::text, p_action text DEFAULT 'authorize_work'::text, p_required_approvals integer DEFAULT NULL::integer, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
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
  campaign public.organization_coordination_records%rowtype;
  eligible_count integer;
  required_count integer;
  decision_id uuid;
  prior public.organization_coalition_decisions%rowtype;
  request_payload jsonb;
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'coalition decision role required' using errcode = '42501';
  end if;
  select * into campaign
  from public.organization_coordination_records record
  where record.id = p_campaign_id and record.kind = 'coalition_campaign'
    and record.status in ('active', 'paused') for update;
  if not found or not private.organization_coordination_can_read(campaign.id)
    or not exists (
      select 1
      from public.organization_coordination_organization_participants participant
      where participant.record_id = campaign.id
        and participant.organization_id = organization
        and participant.status = 'active'
    ) then
    raise exception 'active coalition campaign unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_coordination_records work
    where work.id = p_subject_record_id
      and work.kind = 'coalition_work_item'
      and work.parent_id = campaign.id
      and work.status in ('draft', 'active', 'paused')
  ) then
    raise exception 'coalition work item unavailable' using errcode = '22023';
  end if;
  if p_action not in ('authorize_work', 'pause_work', 'complete_work') then
    raise exception 'coalition decision action unavailable' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object('actor', caller, 'requestHash',
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to((pg_catalog.jsonb_build_object('actor', caller, 'campaign', p_campaign_id, 'subject', p_subject_record_id, 'title', pg_catalog.btrim(p_title), 'rationale', coalesce(p_rationale, ''), 'action', p_action, 'requiredApprovals', p_required_approvals))::text, 'UTF8'), 'sha256'), 'hex'));
  result := private.member_operations_replay(organization, 'propose_organization_coalition_decision', p_idempotency_key, request_payload);
  if result is not null then return result; end if;

  select pg_catalog.count(*)::integer into eligible_count
  from public.organization_coordination_organization_participants participant
  where participant.record_id = campaign.id and participant.status = 'active';

  select * into prior from public.organization_coalition_decisions r
  where r.proposing_organization_id = organization and r.proposed_by = caller
    and r.idempotency_key = p_idempotency_key;
  if found then
    -- A legacy NULL argument selected the majority at creation time. Keep
    -- that stored threshold; participant changes do not change the request.
    required_count := coalesce(p_required_approvals, prior.required_approvals);
    if prior.proposed_by is distinct from caller
       or prior.campaign_id is distinct from p_campaign_id
       or prior.subject_record_id is distinct from p_subject_record_id
       or prior.title is distinct from pg_catalog.btrim(p_title)
       or prior.rationale is distinct from coalesce(p_rationale, '')
       or prior.action is distinct from p_action
       or prior.required_approvals is distinct from required_count then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    decision_id := prior.id;
  else
  required_count := coalesce(p_required_approvals, (eligible_count / 2) + 1);
  if required_count not between 1 and eligible_count then
    raise exception 'coalition approval threshold unavailable' using errcode = '22023';
  end if;
  insert into public.organization_coalition_decisions (
    campaign_id, subject_record_id, proposing_organization_id, title,
    rationale, action, required_approvals, proposed_by, idempotency_key
  ) values (
    campaign.id, p_subject_record_id, organization,
    pg_catalog.btrim(p_title), coalesce(p_rationale, ''), p_action,
    required_count, caller, p_idempotency_key
  )
  returning id into decision_id;
  end if;

  if prior.id is null then
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, metadata,
    idempotency_key
  ) values (
    campaign.id, organization, caller, 'coalition_decision_proposed',
    pg_catalog.jsonb_build_object(
      'decisionId', decision_id,
      'subjectRecordId', p_subject_record_id,
      'action', p_action,
      'requiredApprovals', required_count
    ), extensions.gen_random_uuid()
  );
  end if;
  result := pg_catalog.jsonb_build_object(
    'decisionId', decision_id, 'status', 'open',
    'requiredApprovals', required_count, 'eligibleOrganizations', eligible_count
  );
  perform private.member_operations_store_receipt(organization, 'propose_organization_coalition_decision', p_idempotency_key, request_payload, result);
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.share_organization_coordination_resource(p_record_id uuid, p_resource_kind text, p_title text, p_chapter_document_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
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
  item public.organization_coordination_records%rowtype;
  target uuid;
  resource_id uuid;
  prior public.organization_coordination_resources%rowtype;
  request_payload jsonb;
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization staff role required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_record_id and r.status = 'active';
  if not found or not private.organization_coordination_can_read(item.id)
     or item.partner_organization_id is null then
    raise exception 'coordination resource lane unavailable' using errcode = '22023';
  end if;
  target := case when item.organization_id = organization
    then item.partner_organization_id else item.organization_id end;
  -- #8752: the caller must reach the document's unit or committee, under
  -- that unit's documents switch, not only hold an organization staff role.
  if p_resource_kind = 'share' and not exists (
    select 1 from public.chapter_documents d
    join public.chapters c on c.id = d.chapter_id
    where d.id = p_chapter_document_id and c.organization_id = organization
      and private.organization_coordination_document_allows(d.id)
  ) then
    raise exception 'authorized chapter document required' using errcode = '22023';
  end if;
  -- This permission was also checked by the old INSERT trigger, even
  -- on conflict. Revalidate it before returning a receipt or legacy row.
  if not private.organization_network_has_permission(organization, target,
    case when p_resource_kind = 'share' then 'resource_share' else 'resource_request' end
  ) then
    raise exception 'organization resource permission required' using errcode = '42501';
  end if;
  request_payload := pg_catalog.jsonb_build_object('actor', caller, 'requestHash',
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to((pg_catalog.jsonb_build_object('actor', caller, 'record', p_record_id, 'kind', p_resource_kind, 'title', pg_catalog.btrim(p_title), 'document', p_chapter_document_id))::text, 'UTF8'), 'sha256'), 'hex'));
  result := private.member_operations_replay(organization, 'share_organization_coordination_resource', p_idempotency_key, request_payload);
  if result is not null then return result; end if;

  select * into prior from public.organization_coordination_resources r
  where r.from_organization_id = organization and r.created_by = caller
    and r.idempotency_key = p_idempotency_key;
  if found then
    if prior.created_by is distinct from caller
       or prior.record_id is distinct from p_record_id
       or prior.resource_kind is distinct from p_resource_kind
       or prior.title is distinct from pg_catalog.btrim(p_title)
       or prior.chapter_document_id is distinct from p_chapter_document_id
       or prior.to_organization_id is distinct from target then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    resource_id := prior.id;
  else
  insert into public.organization_coordination_resources (
    record_id, from_organization_id, to_organization_id, chapter_document_id,
    resource_kind, title, status, idempotency_key, created_by
  ) values (
    item.id, organization, target, p_chapter_document_id, p_resource_kind,
    pg_catalog.btrim(p_title), case when p_resource_kind = 'share' then 'available' else 'requested' end,
    p_idempotency_key, caller
  )
  returning id into resource_id;
  end if;
  result := pg_catalog.jsonb_build_object('created', true, 'resourceId', resource_id);
  perform private.member_operations_store_receipt(organization, 'share_organization_coordination_resource', p_idempotency_key, request_payload, result);
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.take_over_public_chapter_page(p_chapter_code text, p_section_slug text, p_page_slug text, p_reason text, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
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
  page public.public_chapter_pages%rowtype;
  takeover_id uuid;
  prior public.public_chapter_page_takeovers%rowtype;
  request_payload jsonb;
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['admin','vp']) then
    raise exception 'chapter takeover role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 4 and 500 then
    raise exception 'takeover reason required' using errcode = '22023';
  end if;
  select * into page from public.public_chapter_pages record
  where record.organization_id = organization
    and record.chapter_code = p_chapter_code
    and record.section_slug = p_section_slug
    and record.slug = p_page_slug for update;
  if not found then
    raise exception 'public chapter page unavailable' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object('actor', caller, 'requestHash',
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to((pg_catalog.jsonb_build_object('actor', caller, 'chapter', p_chapter_code, 'section', p_section_slug, 'page', p_page_slug, 'reason', pg_catalog.btrim(p_reason)))::text, 'UTF8'), 'sha256'), 'hex'));
  result := private.member_operations_replay(organization, 'take_over_public_chapter_page', p_idempotency_key, request_payload);
  if result is not null then return result; end if;

  select * into prior from public.public_chapter_page_takeovers r
  where r.organization_id = organization and r.new_owner_id = caller
    and r.idempotency_key = p_idempotency_key;
  if found then
    if prior.new_owner_id is distinct from caller
       or prior.chapter_code is distinct from p_chapter_code
       or prior.section_slug is distinct from p_section_slug
       or prior.page_slug is distinct from p_page_slug
       or prior.reason is distinct from pg_catalog.btrim(p_reason) then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    takeover_id := prior.id;
  else
  insert into public.public_chapter_page_takeovers (
    organization_id, chapter_code, section_slug, page_slug,
    previous_owner_id, new_owner_id, reason, idempotency_key
  ) values (
    organization, p_chapter_code, p_section_slug, p_page_slug,
    page.created_by, caller, pg_catalog.btrim(p_reason), p_idempotency_key
  )
  returning id into takeover_id;
  end if;
  if prior.id is null then
  update public.public_chapter_pages
  set created_by = caller, updated_at = pg_catalog.clock_timestamp()
  where organization_id = organization
    and chapter_code = p_chapter_code
    and section_slug = p_section_slug and slug = p_page_slug;
  end if;
  result := pg_catalog.jsonb_build_object(
    'takenOver', true, 'takeoverId', takeover_id,
    'chapterCode', p_chapter_code, 'pageSlug', p_page_slug,
    'ownerId', caller
  );
  perform private.member_operations_store_receipt(organization, 'take_over_public_chapter_page', p_idempotency_key, request_payload, result);
  return result;
end;
end;
$function$;

commit;
