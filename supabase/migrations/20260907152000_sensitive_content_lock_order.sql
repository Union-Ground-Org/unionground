begin;

-- B03 message preservation and B05 case-graph work overlap on account deletion,
-- retention, messaging RPCs, and their trigger closure. The lifecycle gate is
-- therefore the first gate for every case-graph entry. Replacing only this
-- helper preserves the reviewed wrappers while removing the inverse order that
-- could deadlock a message writer against Auth deletion.
create or replace function private.lock_case_graph(p_auth_ids uuid[], p_case_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $function$
declare identity_id uuid; case_id uuid;
begin
  perform private.lock_message_lifecycle();
  perform pg_catalog.pg_advisory_xact_lock(509, 700);
  for identity_id in select distinct id from pg_catalog.unnest(p_auth_ids) id
    where id is not null order by id loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('case-graph-auth:' || identity_id::text, 509));
  end loop;
  for case_id in select distinct id from pg_catalog.unnest(p_case_ids) id
    where id is not null order by id loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('case-graph-case:' || case_id::text, 509));
  end loop;
end;
$function$;

-- Round 13 B05/ENC reconciliation: preserve the existing ENC migration bytes and
-- move its case-graph lock-order repair into this additive migration.
-- The lock is acquired before sensitive authorization reads and before direct
-- chunk FK activity can acquire member_case_files rows.
-- The installed lifecycle migration supplies lock_case_graph_row_keys() and its
-- trigger arguments are read from TG_ARGV, so this trigger passes no arguments.

-- These are additive final definitions because the ENC base migration is
-- immutable on Main. The common gate precedes all authorization reads and
-- declaration initializers in each sensitive writer.
create or replace function public.write_sensitive_content(p_operation text, p_arguments jsonb, p_envelopes jsonb, p_ticket uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  perform 1 from private.sensitive_write_tickets t where t.id = p_ticket
    and t.actor = (select auth.uid()) and t.operation = p_operation
    and t.arguments = p_arguments and t.envelopes = p_envelopes
    and t.expires_at > clock_timestamp() for update;
  if not found then raise exception 'sensitive-data-trusted-write-required' using errcode = '42501'; end if;
  perform set_config('app.sensitive_ticket', p_ticket::text, true);
  case p_operation
  when 'create_member_accommodation_request' then
    result := public.create_member_accommodation_request(p_arguments->>'p_request_type', p_arguments->>'p_description', (p_arguments->>'p_idempotency_key')::uuid);
  when 'transition_member_accommodation_request' then
    result := public.transition_member_accommodation_request((p_arguments->>'p_request_id')::uuid, p_arguments->>'p_status', p_arguments->>'p_staff_note', (p_arguments->>'p_idempotency_key')::uuid);
  when 'casework_submit_retaliation_report' then
    result := to_jsonb(public.casework_submit_retaliation_report((p_arguments->>'p_case_id')::uuid, (p_arguments->>'p_incident_at')::timestamptz,
      p_arguments->>'p_management_person', p_arguments->>'p_protected_activity', p_arguments->>'p_adverse_action', p_arguments->>'p_requested_support', (p_arguments->>'p_idempotency_key')::uuid));
  when 'casework_scan_retaliation_patterns' then
    result := to_jsonb(public.casework_scan_retaliation_patterns(p_arguments->>'p_chapter_id'));
  when 'casework_withdraw_retaliation_report' then
    result := to_jsonb(public.casework_withdraw_retaliation_report((p_arguments->>'p_report_id')::uuid, p_arguments->>'p_reason'));
  else raise exception 'sensitive-data-operation-refused' using errcode = '42501';
  end case;
  perform set_config('app.sensitive_ticket', '', true);
  delete from private.sensitive_write_tickets where id = p_ticket;
  return result;
end
$$;
create or replace function public.casework_scan_retaliation_patterns(p_chapter_id text)
returns integer language plpgsql security definer set search_path = '' as $$
declare org uuid; ticket private.sensitive_write_tickets%rowtype;
  sources jsonb; g jsonb; report_ids uuid[]; count_out integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  count_out := 0;
  org := private.mi1_require_selected_organization();
  perform private.casework_require_mfa();
  if not exists(select 1 from public.chapters where id = p_chapter_id and organization_id = org)
    or not private.member_has_chapter_role(p_chapter_id, array['coordinator','advisor','admin','vp']) then
    raise exception 'chapter not found' using errcode = '42501';
  end if;
  select * into ticket from private.sensitive_write_tickets
    where id = nullif(current_setting('app.sensitive_ticket',true),'')::uuid
    and actor = (select auth.uid()) and operation = 'casework_scan_retaliation_patterns'
    and arguments->>'p_chapter_id' = p_chapter_id and expires_at > clock_timestamp();
  if ticket.id is null then raise exception 'sensitive-data-trusted-write-required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sensitive-pattern:' || org::text || p_chapter_id,0));
  perform 1 from public.casework_retaliation_reports r where r.organization_id = org and r.chapter_id = p_chapter_id
    and (r.reporter_user_id = (select auth.uid()) or (r.case_id is null or private.casework_staff_can_access(r.case_id))) for update;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'version',r.encrypted_content->'management_person'->>'dataVersion') order by r.id),'[]'::jsonb)
    into sources from public.casework_retaliation_reports r where r.organization_id = org and r.chapter_id = p_chapter_id
    and (r.reporter_user_id = (select auth.uid()) or (r.case_id is null or private.casework_staff_can_access(r.case_id)))
    and r.status <> 'withdrawn' and r.incident_at >= now() - interval '3 years';
  if sources is distinct from ticket.arguments->'sources' then raise exception 'sensitive-pattern-source-changed' using errcode = '40001'; end if;
  for g in select value from jsonb_array_elements(ticket.envelopes->'groups') loop
    select array_agg(value::uuid) into report_ids from jsonb_array_elements_text(g->'reports');
    if cardinality(report_ids) < 2 or (select count(distinct id) from unnest(report_ids) id) <> cardinality(report_ids)
      or exists(select 1 from unnest(report_ids) id where not sources @> jsonb_build_array(jsonb_build_object('id',id)))
      or g->'label'->>'organization' is distinct from org::text
      or g->'label'->>'record' is distinct from g->>'id'
      or g->'label'->>'field' is distinct from 'subject_label'
      or g->'label'->>'purpose' is distinct from 'casework_retaliation_patterns' then
      raise exception 'sensitive-pattern-invalid-group' using errcode = '22023';
    end if;
    -- Retain existing reviewed patterns as history; replace only unreviewed
    -- generated groups whose membership overlaps this fresh detection.
    delete from public.casework_retaliation_patterns p where p.organization_id = org and p.chapter_id = p_chapter_id
      and p.reviewed_at is null and p.encrypted_content <> '{}'::jsonb
      and exists(select 1 from public.casework_retaliation_pattern_reports link where link.pattern_id = p.id and link.report_id = any(report_ids))
      and not exists(select 1 from public.casework_retaliation_pattern_reports link
        where link.pattern_id = p.id
          and not sources @> jsonb_build_array(jsonb_build_object('id',link.report_id)))
      and not exists(select 1 from public.casework_retaliation_pattern_notes n where n.pattern_id = p.id);
    insert into public.casework_retaliation_patterns(id,organization_id,chapter_id,fingerprint,subject_label,report_count,encrypted_content)
      values((g->>'id')::uuid,org,p_chapter_id,g->>'id','[encrypted]',cardinality(report_ids),jsonb_build_object('subject_label',g->'label'));
    insert into public.casework_retaliation_pattern_reports(pattern_id,report_id,organization_id)
      select (g->>'id')::uuid,id,org from unnest(report_ids) id;
    insert into public.casework_audit_events(organization_id,chapter_id,actor_user_id,event_type,entity_type,entity_id,metadata)
      values(org,p_chapter_id,(select auth.uid()),'pattern_detected','retaliation_pattern',(g->>'id')::uuid,jsonb_build_object('reportCount',cardinality(report_ids)));
    count_out := count_out + 1;
  end loop;
  return count_out;
end
$$;
create or replace function public.set_sensitive_case_envelope(p_file_id uuid, p_envelope jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare org uuid; changed integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  select c.organization_id into org from public.member_case_files f join public.member_cases c on c.id = f.case_id where f.id = p_file_id;
  if p_envelope->>'organization' is distinct from org::text
    or p_envelope->>'record' is distinct from p_file_id::text
    or p_envelope->>'field' is distinct from 'bytes'
    or p_envelope->>'purpose' is distinct from 'case-document'
    or p_envelope->>'schema' is distinct from '1'
    or p_envelope->'payload' ? 'ciphertext'
  then raise exception 'invalid envelope' using errcode = '22023'; end if;
  update public.member_case_files set encrypted_content = p_envelope
  where id = p_file_id and encrypted_content is null and confirmed_at is null and removal_requested_at is null;
  get diagnostics changed = row_count;
  return changed = 1;
end
$$;

-- The case-file FK is an implicit case-graph acquisition: coordinate direct
-- chunk writes and cascading file deletion before either relation is locked.
create trigger a00_case_graph_lock before insert or update or delete on public.sensitive_case_chunks
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.sensitive_case_chunks
for each row execute function private.lock_case_graph_row_keys('', '');

-- ENC ran before the lifecycle migration after the B05 renumbering. The base
-- migration therefore installs the ticket setter before B05 adds the outer
-- lock wrapper. Assert the resulting order rather than rewriting fixture bodies.
do $seed$
declare definition text; name text; lock_at integer; ticket_at integer;
begin
  foreach name in array array['demo_seed_apply_member_support','demo_seed_apply_casework'] loop
    select pg_get_functiondef(('private.' || name || '(text,uuid)')::regprocedure) into definition;
    lock_at := position('perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);' in definition);
    ticket_at := position('perform set_config(''app.sensitive_seed_ticket''' in definition);
    if lock_at = 0 or ticket_at = 0 or lock_at > ticket_at then
      raise exception 'sensitive-seed-definition-drift';
    end if;
  end loop;
end
$seed$;

-- B07 provenance writers also reach the case graph. Their final definitions
-- move all evaluated identity and organization lookups below the shared gate.
create or replace function public.record_knowledge_conversion(
  p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_conversion jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  source public.organization_knowledge_sources%rowtype;
  previous public.organization_knowledge_conversions%rowtype;
  next_attempt integer;
  digest text;
  raw_byte_size text;
  byte_size bigint;
  source_format text;
  converter_name text;
  converter_version text;
  pipeline_version text;
  outcome text;
  error_code text;
  metadata jsonb;
  manual_correction boolean;
  change_kind text;
  inserted public.organization_knowledge_conversions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  digest := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'sourceSha256', '')), '');
  raw_byte_size := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'sourceByteSize', '')), '');
  source_format := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'sourceFormat', '')), '');
  converter_name := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'converterName', '')), '');
  converter_version := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'converterVersion', '')), '');
  pipeline_version := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'pipelineVersion', '')), '');
  outcome := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'outcome', '')), '');
  error_code := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'errorCode', '')), '');
  metadata := coalesce(p_conversion -> 'metadata', '{}'::jsonb);
  manual_correction := coalesce((p_conversion ->> 'manualCorrection')::boolean, false);
  if (select auth.role()) <> 'service_role'
     or p_organization_id is null or p_source_id is null or p_actor_user_id is null
     or pg_catalog.jsonb_typeof(coalesce(p_conversion, 'null'::jsonb)) <> 'object'
     or digest is null or raw_byte_size is null or raw_byte_size !~ '^[0-9]{1,10}$'
     or source_format is null
     or converter_name is null or converter_version is null or pipeline_version is null
     or outcome is null then
    raise exception 'invalid conversion provenance' using errcode = '22023';
  end if;
  byte_size := raw_byte_size::bigint;

  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = p_organization_id
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;

  -- The same staff authorization the ingest completion demands. A conversion
  -- attributed to somebody who could not have started it is worse than none.
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;

  select * into previous from public.organization_knowledge_conversions row
  where row.source_id = source.id
  order by row.attempt desc limit 1;

  next_attempt := coalesce(previous.attempt, 0) + 1;
  if manual_correction then
    change_kind := 'manual-correction';
  elsif previous.id is null then
    change_kind := 'initial';
  elsif previous.source_sha256 is distinct from digest then
    change_kind := 'changed-source';
  elsif previous.converter_name is distinct from converter_name
     or previous.converter_version is distinct from converter_version
     or previous.pipeline_version is distinct from pipeline_version then
    change_kind := 'changed-converter';
  else
    change_kind := 'identical-input';
  end if;

  insert into public.organization_knowledge_conversions (
    organization_id, source_id, file_id, attempt, source_sha256, source_byte_size,
    source_format, converter_name, converter_version, pipeline_version,
    outcome, error_code, change_kind, conversion_metadata
  ) values (
    p_organization_id, source.id, source.file_id, next_attempt, digest, byte_size,
    source_format, converter_name, converter_version, pipeline_version,
    outcome, error_code, change_kind, metadata
  ) returning * into inserted;

  return pg_catalog.jsonb_build_object(
    'id', inserted.id,
    'sourceId', inserted.source_id,
    'attempt', inserted.attempt,
    'changeKind', inserted.change_kind,
    'outcome', inserted.outcome
  );
end;
$function$;

create or replace function public.review_knowledge_conversion(
  p_organization_id uuid, p_conversion_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  reviewer uuid;
  row_out public.organization_knowledge_conversions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  reviewer := (select auth.uid());
  if reviewer is null or p_organization_id is null or p_conversion_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not (select private.mfa_satisfied()) then
    raise exception 'reauthentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = reviewer and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;

  update public.organization_knowledge_conversions
  set conversion_reviewed_at = pg_catalog.now(), conversion_reviewed_by = reviewer
  where id = p_conversion_id
    and organization_id = p_organization_id
    and conversion_reviewed_at is null
  returning * into row_out;
  if not found then
    raise exception 'conversion is not awaiting review' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'sourceId', row_out.source_id,
    'attempt', row_out.attempt,
    'reviewedAt', row_out.conversion_reviewed_at,
    'reviewedBy', row_out.conversion_reviewed_by
  );
end;
$function$;

create or replace function private.record_knowledge_workflow_provenance(
  p_source_id uuid, p_article_id uuid, p_article_version integer,
  p_manual_correction boolean, p_review boolean
)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  org uuid;
  actor uuid;
  source public.organization_knowledge_sources%rowtype;
  previous public.organization_knowledge_conversions%rowtype;
  current_id uuid;
  next_attempt integer;
  digest text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.mi1_w2_selected_organization();
  actor := (select auth.uid());
  if actor is null or not private.mfa_satisfied()
     or not private.has_organization_role(org, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into source from public.organization_knowledge_sources
  where id = p_source_id and organization_id = org for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into previous from public.organization_knowledge_conversions
  where source_id = source.id order by attempt desc limit 1;
  if not found then return; end if;
  if not private.knowledge_source_object_verdict_locked(org, source.id) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  select content_sha256 into digest from public.organization_knowledge_files where id = source.file_id;
  if previous.outcome <> 'succeeded' or previous.source_sha256 is distinct from digest then
    raise exception 'conversion is not current for this source' using errcode = '42501';
  end if;
  next_attempt := previous.attempt + 1;
  select * into previous from public.organization_knowledge_conversions
  where source_id = source.id
    and (change_kind <> 'manual-correction' or corrected_article_id = p_article_id)
  order by attempt desc limit 1;
  if not found then raise exception 'conversion binding is unavailable' using errcode = '42501'; end if;
  current_id := previous.id;
  if p_manual_correction then
    if not exists (select 1 from public.member_kb_articles
      where id = p_article_id and version = p_article_version
        and knowledge_source_id = source.id and content_origin = 'derived') then
      raise exception 'correction is not bound to this article version' using errcode = '42501';
    end if;
    insert into public.organization_knowledge_conversions (
      organization_id, source_id, file_id, attempt, source_sha256, source_byte_size,
      source_format, converter_name, converter_version, pipeline_version,
      outcome, change_kind, conversion_metadata, parent_conversion_id,
      corrected_article_id, corrected_article_version, corrected_by
    ) values (
      org, source.id, source.file_id, next_attempt, previous.source_sha256,
      previous.source_byte_size, previous.source_format, previous.converter_name,
      previous.converter_version, previous.pipeline_version, 'succeeded',
      'manual-correction', '{}'::jsonb, previous.id, p_article_id, p_article_version, actor
    ) returning id into current_id;
  end if;
  if p_review and (p_manual_correction or previous.conversion_reviewed_at is null) then
    perform public.review_knowledge_conversion(org, current_id);
  end if;
end;
$function$;
-- B03 message lifecycle writers require the shared case-graph gate before
-- declaration initializers, identity reads, and message-row acquisitions.
create or replace function public.place_member_message_legal_hold(
  p_conversation_id uuid,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
  conversation_org uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  org := (select private.current_member_organization());
  if caller is null or org is null or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'authorization required' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code not in (
    'litigation', 'arbitration', 'agency_charge', 'internal_investigation'
  ) then
    raise exception 'unsupported legal hold reason' using errcode = '22023';
  end if;

  perform private.lock_member_message_conversation(p_conversation_id);

  -- The conversation must belong to the administrator's own tenant. Resolving
  -- through member_profiles keeps the check on the same path the rest of the
  -- organization scope uses instead of trusting a client-supplied tenant.
  select coalesce(c.organization_id, h.organization_id) into conversation_org
  from public.member_conversations v
  left join public.member_profiles p on p.id = v.user_id
  left join public.chapters c on c.id = p.chapter_id
  left join public.member_message_legal_holds h on h.conversation_id = v.id
  where v.id = p_conversation_id;
  if conversation_org is null or conversation_org is distinct from org then
    raise exception 'authorization required' using errcode = '42501';
  end if;

  insert into public.member_message_legal_holds (
    conversation_id, organization_id, reason_code, placed_by
  ) values (p_conversation_id, org, p_reason_code, caller)
  on conflict (conversation_id) do update
    set organization_id = excluded.organization_id,
        reason_code = excluded.reason_code,
        placed_by = excluded.placed_by,
        placed_at = pg_catalog.now(),
        released_by = null,
        released_at = null
    where public.member_message_legal_holds.released_at is not null;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'message.legal_hold_placed', 'settings_change', caller,
    'message_legal_hold', p_conversation_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('reasonCode', p_reason_code, 'operation', 'hold')
  );

  return pg_catalog.jsonb_build_object('held', true, 'reasonCode', p_reason_code);
end;
$function$;

create or replace function public.release_member_message_legal_hold(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
  released integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  released := 0;
  caller := (select auth.uid());
  org := (select private.current_member_organization());
  if caller is null or org is null or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'authorization required' using errcode = '42501';
  end if;

  perform private.lock_member_message_conversation(p_conversation_id);

  update public.member_message_legal_holds h
    set released_at = pg_catalog.now(), released_by = caller
    where h.conversation_id = p_conversation_id
      and h.organization_id = org
      and h.released_at is null;
  get diagnostics released = row_count;
  if released = 0 then
    return pg_catalog.jsonb_build_object('released', false);
  end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'message.legal_hold_released', 'settings_change', caller,
    'message_legal_hold', p_conversation_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('operation', 'release')
  );

  return pg_catalog.jsonb_build_object('released', true);
end;
$function$;

create or replace function private.redact_member_message_row(
  p_message_id uuid,
  p_reason text,
  p_actor uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  message_row public.member_messages%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if p_reason not in ('sender_removed', 'staff_removed', 'retention_expired', 'account_closed') then
    raise exception 'unsupported redaction reason' using errcode = '22023';
  end if;

  perform private.lock_member_message_conversation(m.conversation_id)
  from public.member_messages m where m.id = p_message_id;
  select m.* into message_row
  from public.member_messages m
  where m.id = p_message_id
  for update;
  if message_row.id is null then
    return false;
  end if;
  if message_row.redacted_at is not null then
    return false;
  end if;
  if private.member_message_under_legal_hold(message_row.conversation_id) then
    raise exception 'conversation is under a preservation order' using errcode = '42501';
  end if;

  update public.member_messages m
    set body = '',
        body_sha256 = pg_catalog.encode(
          extensions.digest(message_row.body, 'sha256'), 'hex'),
        original_length = pg_catalog.char_length(message_row.body),
        redacted_at = pg_catalog.now(),
        redacted_by = p_actor,
        redaction_reason = p_reason
    where m.id = message_row.id;

  -- Sweep the dispatched copy; section 6 invalidates persisted briefings.
  update public.member_scheduled_messages s
    set body = '', redacted_at = pg_catalog.now()
    where s.sent_message_id = message_row.id and s.redacted_at is null;

  return true;
end;
$function$;

create or replace function private.redact_member_scheduled_message_row(p_scheduled_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  scheduled_row public.member_scheduled_messages%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.lock_member_message_conversation(s.conversation_id)
  from public.member_scheduled_messages s where s.id = p_scheduled_id;
  select s.* into scheduled_row
  from public.member_scheduled_messages s
  where s.id = p_scheduled_id
  for update;
  if scheduled_row.id is null then
    return false;
  end if;
  if scheduled_row.redacted_at is not null then
    return false;
  end if;
  -- A dispatched draft is the delivered message's second copy and is governed by
  -- that message's redaction, so the two paths can never both destroy one body.
  if scheduled_row.sent_message_id is not null then
    return false;
  end if;
  if private.member_message_under_legal_hold(scheduled_row.conversation_id) then
    raise exception 'conversation is under a preservation order' using errcode = '42501';
  end if;

  update public.member_scheduled_messages s
    set body = '', redacted_at = pg_catalog.now()
    where s.id = scheduled_row.id;

  return true;
end;
$function$;

create or replace function public.redact_member_message(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  message_row public.member_messages%rowtype;
  org uuid;
  reason text;
  removed boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select m.* into message_row
  from public.member_messages m
  where m.id = p_message_id;
  if message_row.id is null then
    -- Flat denial: an unauthorized caller must not learn that an id exists.
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if message_row.user_id = caller and message_row.sender_kind = 'member' then
    -- The member removes content the member wrote. A steward's reply in the
    -- member's own conversation is the steward's content and takes the staff
    -- path below.
    reason := 'sender_removed';
  elsif public.member_has_role(array['steward', 'coordinator', 'admin'])
        and exists (
          select 1
          from public.member_profiles author
          join public.chapters c on c.id = author.chapter_id
          where author.id = message_row.user_id
            and c.id = private.current_member_chapter()
        ) then
    reason := 'staff_removed';
  else
    raise exception 'not permitted' using errcode = '42501';
  end if;

  removed := private.redact_member_message_row(message_row.id, reason, caller);
  if not removed then
    return pg_catalog.jsonb_build_object('redacted', false, 'alreadyRedacted', true,
      'message', (select pg_catalog.jsonb_build_object('id', m.id, 'body', '', 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) from public.member_messages m where m.id = message_row.id));
  end if;

  org := (select private.current_member_organization());
  if org is not null then
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'privacy', 'message.redacted', 'delete', caller,
      'message', message_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('reasonCode', reason, 'operation', 'redact', 'count', 1)
    );
  end if;

  return pg_catalog.jsonb_build_object('redacted', true, 'reasonCode', reason,
    'message', (select pg_catalog.jsonb_build_object('id', m.id, 'body', '', 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) from public.member_messages m where m.id = message_row.id));
end;
$function$;

create or replace function private.preserve_member_messages_on_account_delete()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare conversation uuid; message uuid; draft uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  for conversation in
    select v.id from public.member_conversations v where v.user_id = old.id
    union select m.conversation_id from public.member_messages m where m.user_id = old.id
    union select s.conversation_id from public.member_scheduled_messages s
      where s.actor_id = old.id or s.recipient_id = old.id
    union select b.target_id from public.compass_message_briefings b
      where b.requested_by = old.id and b.source_kind = 'private'
    union select m.conversation_id from public.compass_workspace_actions a
      join public.member_messages m on m.id::text = a.source_id
      where a.actor_user_id = old.id and a.source_kind = 'message'
    order by 1
  loop
    perform private.lock_member_message_conversation(conversation);
    if private.member_message_under_legal_hold(conversation) then
      -- Requester/actor may own no source row. Detach their identity only;
      -- preserve summary, action_items, title and source binding in place.
      update public.compass_message_briefings set requested_by = null
        where source_kind = 'private' and target_id = conversation and requested_by = old.id;
      update public.compass_workspace_actions set actor_user_id = null
        where source_kind = 'message' and actor_user_id = old.id and source_id in
          (select m.id::text from public.member_messages m where m.conversation_id = conversation);
      update public.member_conversations set user_id = null, title = 'Preserved conversation', initials = ''
        where id = conversation and user_id = old.id;
      update public.member_messages set user_id = null,
        sender_name = case when sender_kind = 'member' then 'Deleted account' else sender_name end
        where conversation_id = conversation and user_id = old.id;
      update public.member_scheduled_messages
        set actor_id = case when actor_id = old.id then null else actor_id end,
            recipient_id = case when recipient_id = old.id then null else recipient_id end,
            status = case when status = 'pending' then 'cancelled' else status end
        where conversation_id = conversation and (actor_id = old.id or recipient_id = old.id);
    else
      for message in select m.id from public.member_messages m where m.conversation_id = conversation
        and (m.user_id = old.id or m.id in (select s.sent_message_id from public.member_scheduled_messages s
          where s.actor_id = old.id or s.recipient_id = old.id)) order by m.id loop
        perform private.redact_member_message_row(message, 'account_closed', null);
      end loop;
      for draft in select s.id from public.member_scheduled_messages s
        where s.conversation_id = conversation and s.sent_message_id is null
          and (s.actor_id = old.id or s.recipient_id = old.id) order by s.id loop
        perform private.redact_member_scheduled_message_row(draft);
      end loop;
      -- Remove the already-redacted copies while the auth parent still exists.
      -- Their sent-state CHECK cannot tolerate an intermediate SET NULL from
      -- deleting the delivered message first in the later FK cascade.
      delete from public.member_scheduled_messages s where s.conversation_id = conversation
        and (s.actor_id = old.id or s.recipient_id = old.id);
    end if;
  end loop;
  return old;
end;
$function$;

create or replace function private.guard_member_message_destruction()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare conversation uuid; candidate uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_table_name = 'member_conversations' then conversation := old.id;
  else conversation := old.conversation_id; end if;
  perform private.lock_member_message_conversation(conversation);
  if private.member_message_under_legal_hold(conversation) then
    raise exception 'conversation is under a preservation order' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    if tg_table_name = 'member_conversations' then
      for candidate in select m.id from public.member_messages m where m.conversation_id = old.id order by m.id loop
        perform private.redact_member_message_row(candidate, 'account_closed', null);
      end loop;
      for candidate in select s.id from public.member_scheduled_messages s
        where s.conversation_id = old.id and s.sent_message_id is null order by s.id loop
        perform private.redact_member_scheduled_message_row(candidate);
      end loop;
    elsif tg_table_name = 'member_messages' then
      if old.redacted_at is null then
        raise exception 'redaction required before deletion' using errcode = '42501';
      end if;
      -- Permit the sent_message_id SET NULL referential action: a deleted
      -- delivered row no longer satisfies the scheduled sent-state constraint.
      update public.member_scheduled_messages set status = 'cancelled', dispatched_at = null
        where sent_message_id = old.id;
    elsif tg_table_name = 'member_scheduled_messages' then
      if old.redacted_at is null then
        raise exception 'redaction required before deletion' using errcode = '42501';
      end if;
    end if;
    return old;
  end if;
  return new;
end;
$function$;

create or replace function private.invalidate_message_briefings()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare kind text; target uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'UPDATE' and old.body is not distinct from new.body then return new; end if;
  if tg_table_name = 'member_messages' then kind := 'private'; target := old.conversation_id;
  elsif tg_table_name = 'chapter_thread_posts' then kind := 'channel'; target := old.thread_id;
  else kind := 'task'; target := old.task_id; end if;
  delete from public.compass_message_briefings where source_kind = kind and target_id = target;
  if kind = 'private' then
    update public.compass_workspace_actions set title = 'Follow up on member message'
      where source_kind = 'message' and source_id in
        (select m.id::text from public.member_messages m where m.conversation_id = target
         union select old.id::text);
  end if;
  return null;
end;
$function$;

create or replace function public.propose_compass_workspace_action(
  p_source_kind text,
  p_source_id text,
  p_title text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  actor uuid;
  created public.compass_workspace_actions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.engagement_selected_organization();
  actor := (select auth.uid());
  perform private.engagement_require_staff(org);
  if p_source_kind not in ('message', 'broadcast', 'notification', 'survey', 'case') then
    raise exception 'invalid action source' using errcode = '22023';
  end if;
  if p_source_kind = 'message' then
    perform private.lock_message_lifecycle();
    if not exists (select 1 from public.member_messages m
      where m.id::text = p_source_id and m.redacted_at is null
        and private.engagement_can_read_message_target('private', m.conversation_id)) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  end if;
  insert into public.compass_workspace_actions (
    organization_id, actor_user_id, action_kind, source_kind, source_id, title
  ) values (
    org, actor, 'create_task', p_source_kind,
    pg_catalog.btrim(coalesce(p_source_id, '')),
    case when p_source_kind = 'message' then 'Follow up on member message'
      else pg_catalog.btrim(coalesce(p_title, '')) end
  ) returning * into created;
  return pg_catalog.jsonb_build_object(
    'id', created.id, 'actionKind', created.action_kind,
    'sourceKind', created.source_kind, 'sourceId', created.source_id,
    'title', created.title, 'state', created.state
  );
end;
$function$;

create or replace function public.persist_compass_message_briefing(
  p_source_kind text,
  p_target_id uuid,
  p_summary text,
  p_action_items jsonb,
  p_source_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  actor uuid;
  saved public.compass_message_briefings%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.engagement_selected_organization();
  actor := (select auth.uid());
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.engagement_can_read_message_target(p_source_kind, p_target_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.jsonb_typeof(p_action_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_action_items) > 12 then
    raise exception 'invalid briefing result' using errcode = '22023';
  end if;
  perform private.lock_message_lifecycle();
  if p_source_revision is null or p_source_revision is distinct from
    (public.get_message_briefing_context(p_source_kind, p_target_id)->>'sourceRevision') then
    raise exception 'message source changed; request a new briefing' using errcode = '40001';
  end if;
  insert into public.compass_message_briefings (
    organization_id, requested_by, source_kind, target_id, summary, action_items
  ) values (
    org, actor, p_source_kind, p_target_id,
    pg_catalog.btrim(p_summary), p_action_items
  ) returning * into saved;
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'sourceKind', saved.source_kind,
    'targetId', saved.target_id, 'summary', saved.summary,
    'actionItems', saved.action_items, 'createdAt', saved.created_at
  );
end;
$function$;

create or replace function public.get_organization_retention_engine()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  org uuid;
  caller uuid;
  result jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.current_member_organization();
  caller := private.assert_retention_admin(org);

  with catalog(data_class) as (values
    ('organization_page_views'::text),
    ('organization_engagement_events'),
    ('integration_job_history'),
    ('public_event_rsvps'),
    ('deleted_chapter_tasks'),
    ('member_message_bodies')
  ), policy_rows as (
    select
      c.data_class,
      private.retention_data_class_config(c.data_class) as config,
      p.retention_days,
      p.execution_enabled,
      p.updated_at
    from catalog c
    left join public.organization_retention_policies p
      on p.organization_id = org
     and p.data_class = c.data_class
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', org,
    'schedulerConfigured', private.retention_scheduler_configured(),
    'policies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'dataClass', p.data_class,
        'label', p.config ->> 'label',
        'description', p.config ->> 'description',
        'minimumDays', (p.config ->> 'minimumDays')::integer,
        'maximumDays', (p.config ->> 'maximumDays')::integer,
        'defaultDays', (p.config ->> 'defaultDays')::integer,
        'retentionDays', coalesce(p.retention_days, (p.config ->> 'defaultDays')::integer),
        'configured', p.retention_days is not null,
        'executionEnabled', coalesce(p.execution_enabled, false),
        'updatedAt', p.updated_at
      ) order by p.data_class)
      from policy_rows p
    ), '[]'::jsonb),
    'runs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'dataClass', r.data_class,
        'retentionDays', r.retention_days,
        'mode', r.mode,
        'status', r.status,
        'eligibleCount', r.eligible_count,
        'deletedCount', r.deleted_count,
        'remainingCount', r.remaining_count,
        'requestedBy', r.requested_by,
        'authorizedBy', r.authorized_by,
        'authorizationExpiresAt', r.authorization_expires_at,
        'createdAt', r.created_at,
        'completedAt', r.completed_at,
        'failureCode', r.failure_code,
        'confirmationPhrase', case when r.status = 'previewed'
          then 'AUTHORIZE ' || r.data_class else null end
      ) order by r.created_at desc, r.id desc)
      from (
        select history.*
        from public.organization_retention_runs history
        where history.organization_id = org
        order by history.created_at desc, history.id desc
        limit 25
      ) r
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

-- Merged B03 catalogue reconciliation: redaction added two Auth references to
-- delivered messages after the lifecycle manifest's original gate catalogue.
drop trigger z99_case_graph_keys on public.member_messages;
create trigger z99_case_graph_keys before insert or update or delete on public.member_messages
for each row execute function private.lock_case_graph_row_keys('{redacted_by},{sender_id},{user_id}', '');

-- Merged B03 catalogue reconciliation: preserve the complete case-graph gate
-- for the legal-hold table that remains after dormant channel controls retire.
create trigger a00_case_graph_lock before insert or update or delete on public.member_message_legal_holds
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_message_legal_holds
for each row execute function private.lock_case_graph_row_keys('{placed_by},{released_by}', '');

commit;
