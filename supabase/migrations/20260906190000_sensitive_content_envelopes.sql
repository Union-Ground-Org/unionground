-- Populated targets must close the database AND Storage window before any ENC
-- DDL. Ordinary migration application must enforce the same rollout boundary.
-- Empty fresh databases have no protected bytes and may apply directly.
do $window$
declare closed boolean := false;
begin
  lock table public.member_accommodation_requests, public.casework_retaliation_reports,
    public.casework_retaliation_patterns, public.member_case_files in share row exclusive mode;
  if exists(select 1 from public.member_accommodation_requests)
    or exists(select 1 from public.casework_retaliation_reports)
    or exists(select 1 from public.casework_retaliation_patterns)
    or exists(select 1 from public.member_case_files) then
    if to_regclass('private.sensitive_rollout_window') is not null then
      execute 'select exists(select 1 from private.sensitive_rollout_window where id)' into closed;
    end if;
    if not closed
      or has_schema_privilege('authenticated','public','USAGE')
      or has_schema_privilege('anon','public','USAGE')
      or not exists(select 1 from pg_policy where polrelid='storage.objects'::regclass
        and polname='sensitive_maintenance_window' and not polpermissive and polcmd='*'
        and polroles @> array['anon'::regrole::oid,'authenticated'::regrole::oid]
        and pg_get_expr(polqual,polrelid)='false' and pg_get_expr(polwithcheck,polrelid)='false') then
      raise exception 'sensitive-maintenance-window-required' using errcode = '55000';
    end if;
  end if;
end
$window$;

-- ENC: additive ciphertext metadata; existing RLS policies and grants unchanged.
-- API writes only fixed markers through the original authorization RPCs.
alter table public.member_accommodation_requests add column encrypted_content jsonb not null default '{}'::jsonb;
alter table public.casework_retaliation_reports add column encrypted_content jsonb not null default '{}'::jsonb;
alter table public.member_case_files add column encrypted_content jsonb;

create function public.sensitive_data_organization()
returns uuid language sql security definer set search_path = '' as $$
  select private.mi1_require_selected_organization()
$$;
revoke all on function public.sensitive_data_organization() from public, anon;
grant execute on function public.sensitive_data_organization() to authenticated;

-- Server-produced envelopes are staged by service_role, then consumed once by
-- the authenticated caller. The ticket is not an authorization grant: all
-- original SQL role/MFA/ownership/transition checks still execute on consumption.
create table private.sensitive_write_tickets (
  id uuid primary key default extensions.gen_random_uuid(),
  actor uuid not null, operation text not null, arguments jsonb not null,
  envelopes jsonb not null, expires_at timestamptz not null default now() + interval '2 minutes'
);
revoke all on private.sensitive_write_tickets from public, anon, authenticated, service_role;
create function public.stage_sensitive_write(p_actor uuid, p_operation text, p_arguments jsonb, p_envelopes jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare ticket uuid;
begin
  if p_actor is null or pg_column_size(p_envelopes) > 2097152 then
    raise exception 'sensitive-data-stage-refused' using errcode = '22023';
  end if;
  delete from private.sensitive_write_tickets where expires_at < clock_timestamp();
  insert into private.sensitive_write_tickets(actor,operation,arguments,envelopes)
    values(p_actor,p_operation,p_arguments,p_envelopes) returning id into ticket;
  return ticket;
end
$$;
revoke all on function public.stage_sensitive_write(uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.stage_sensitive_write(uuid,text,jsonb,jsonb) to service_role;

create function private.require_sensitive_envelopes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  source jsonb := '{}'::jsonb; operation text; allowed text[] := array[]::text[];
  maintenance boolean := session_user in ('postgres','supabase_admin')
    and current_setting('role') in ('none','postgres','supabase_admin')
    and current_setting('app.sensitive_maintenance',true) = 'on';
  fields text[]; field_name text; envelope jsonb; value text; previous jsonb;
begin
  if maintenance then
    source := coalesce(nullif(current_setting('app.sensitive_envelopes',true),'')::jsonb,'{}'::jsonb);
  else
    select t.envelopes, t.operation into source, operation from private.sensitive_write_tickets t
      where t.id = nullif(current_setting('app.sensitive_ticket',true),'')::uuid
      and t.actor = (select auth.uid()) and t.expires_at > clock_timestamp();
  end if;
  fields := case tg_table_name
    when 'casework_retaliation_patterns' then array['subject_label']
    when 'member_accommodation_requests' then array['description','staff_note']
    when 'casework_retaliation_reports' then array['management_person','protected_activity','adverse_action','requested_support','withdrawal_reason']
  end;
  -- SAMPLE fixtures are sealed by the server before the seed RPC executes.
  -- Client roles cannot activate this channel, even with a forged GUC/ticket.
  if tg_op = 'INSERT' and current_setting('role') in ('service_role','none','postgres','supabase_admin') then
    select t.envelopes->tg_table_name->new.id::text into envelope
      from private.sensitive_write_tickets t
      where t.id = nullif(current_setting('app.sensitive_seed_ticket',true),'')::uuid
        and t.operation = 'demo_seed' and t.actor = new.organization_id
        and t.expires_at > clock_timestamp()
        and t.actor = private.member_stress_uuid((t.arguments->>'runId') ||
          case t.arguments->>'lane' when 'presg' then ':presg:organization' when 'uniondemo' then ':ud:organization' end);
    if envelope is not null then source := envelope; operation := 'demo_seed'; end if;
  end if;
  if maintenance or operation = 'demo_seed' then allowed := fields;
  elsif tg_table_name = 'casework_retaliation_patterns' and tg_op = 'INSERT'
    and operation = 'casework_scan_retaliation_patterns'
    and private.member_has_chapter_role(to_jsonb(new)->>'chapter_id', array['coordinator','advisor','admin','vp']) then
    select jsonb_build_object('subject_label',g->'label') into source
      from jsonb_array_elements(source->'groups') g where g->>'id' = new.id::text;
    allowed := array['subject_label'];
  elsif tg_table_name = 'member_accommodation_requests' then
    if tg_op = 'INSERT' and operation = 'create_member_accommodation_request'
      and (to_jsonb(new)->>'member_user_id')::uuid = (select auth.uid()) then allowed := array['description'];
    elsif tg_op = 'UPDATE' and operation = 'transition_member_accommodation_request'
      and new.status <> 'withdrawn' and old.status <> 'withdrawn'
      and private.member_support_is_staff(new.organization_id) then allowed := array['staff_note']; end if;
  elsif tg_table_name = 'casework_retaliation_reports' then
    if tg_op = 'INSERT' and operation = 'casework_submit_retaliation_report'
      and (to_jsonb(new)->>'reporter_user_id')::uuid = (select auth.uid()) then
      allowed := array['management_person','protected_activity','adverse_action','requested_support'];
    elsif tg_op = 'UPDATE' and operation = 'casework_withdraw_retaliation_report'
      and new.status = 'withdrawn' and old.status <> 'withdrawn'
      and (to_jsonb(new)->>'reporter_user_id')::uuid = (select auth.uid()) then allowed := array['withdrawal_reason']; end if;
  end if;
  previous := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  if tg_op = 'UPDATE' and (new.id <> old.id or new.organization_id <> old.organization_id) then
    raise exception 'sensitive-data-identity-immutable' using errcode = '22023';
  end if;
  -- Metadata is writable only through this transaction's envelope channel.
  if tg_op = 'UPDATE' then new.encrypted_content := old.encrypted_content;
  else new.encrypted_content := '{}'::jsonb; end if;
  foreach field_name in array fields loop
    value := to_jsonb(new)->>field_name;
    envelope := source->field_name;
    if not (field_name = any(allowed)) then
      -- Ignore surplus ciphertext on a no-op field, including a member's
      -- withdrawal, but reject any actual plaintext/marker change.
      if coalesce(value,'') is distinct from coalesce(previous->>field_name,'') then
        raise exception 'sensitive-data-encryption-required' using errcode = '22023';
      end if;
      continue;
    end if;
    if envelope is not null then
      if value is distinct from '[encrypted]'
        or envelope->>'organization' is distinct from new.organization_id::text
        or envelope->>'record' is distinct from new.id::text
        or envelope->>'field' is distinct from field_name
        or envelope->>'purpose' is distinct from tg_table_name
        or envelope->>'schema' is distinct from '1'
        or jsonb_typeof(envelope->'payload') is distinct from 'object'
        or jsonb_typeof(envelope->'wrappedKey') is distinct from 'object'
        or coalesce(envelope->>'keyVersion','') !~ '^[a-zA-Z0-9_-]{1,64}$'
        or coalesce(envelope->>'dataVersion','') !~ '^[0-9a-f-]{36}$'
      then raise exception 'sensitive-data-envelope-required' using errcode = '22023'; end if;
      new.encrypted_content := new.encrypted_content || jsonb_build_object(field_name, envelope);
    elsif coalesce(value, '') <> '' and (tg_op = 'INSERT' or value is distinct from previous->>field_name) then
      raise exception 'sensitive-data-encryption-required' using errcode = '22023';
    elsif coalesce(value, '') = '' and value is distinct from previous->>field_name then
      new.encrypted_content := new.encrypted_content - field_name;
    end if;
  end loop;
  return new;
end
$$;
revoke all on function private.require_sensitive_envelopes() from public, anon, authenticated;
create trigger sensitive_envelopes before insert or update on public.member_accommodation_requests
for each row execute function private.require_sensitive_envelopes();
create trigger sensitive_envelopes before insert or update on public.casework_retaliation_reports
for each row execute function private.require_sensitive_envelopes();

-- New retaliation IDs are the already caller-minted idempotency UUID. Existing
-- rows retain their IDs. Existing replay semantics remain with the original key.
DO $migration$
declare definition text;
begin
  select pg_get_functiondef('public.casework_submit_retaliation_report(uuid,timestamptz,text,text,text,text,uuid)'::regprocedure) into definition;
  if position('insert into public.casework_retaliation_reports(organization_id' in definition) = 0 then
    raise exception 'sensitive-data-retaliation-definition-drift';
  end if;
  definition := replace(definition,
    'insert into public.casework_retaliation_reports(organization_id',
    'insert into public.casework_retaliation_reports(id, organization_id');
  definition := replace(definition,
    'values (v_case.organization_id, v_case.chapter_id, (select auth.uid()), v_case.id, p_incident_at',
    'values (p_idempotency_key, v_case.organization_id, v_case.chapter_id, (select auth.uid()), v_case.id, p_incident_at');
  -- Replays return the original row without running an UPDATE trigger that
  -- could attach fresh ciphertext to an idempotent no-op.
  definition := replace(definition,
    'on conflict (organization_id, reporter_user_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key' || chr(10) || '  returning * into v_row;',
    'on conflict (organization_id, reporter_user_id, idempotency_key) do nothing' || chr(10) || '  returning * into v_row;' || chr(10) ||
    '  if not found then select * into strict v_row from public.casework_retaliation_reports where organization_id = v_case.organization_id and reporter_user_id = (select auth.uid()) and idempotency_key = p_idempotency_key; end if;');
  execute definition;
end
$migration$;

-- No dynamic function name or SQL from the client is executed. The original
-- routines retain selected-organization, ownership, role, MFA and audit checks.
create function public.write_sensitive_content(p_operation text, p_arguments jsonb, p_envelopes jsonb, p_ticket uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
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
revoke all on function public.write_sensitive_content(text,jsonb,jsonb,uuid) from public, anon;
grant execute on function public.write_sensitive_content(text,jsonb,jsonb,uuid) to authenticated;

-- No identity equality index: group plaintext only in the authorized server,
-- persist encrypted labels and opaque group IDs, and bind results to an exact
-- current source set before storing derivatives.
alter table public.casework_retaliation_patterns add column encrypted_content jsonb not null default '{}'::jsonb;
create trigger sensitive_envelopes before insert or update on public.casework_retaliation_patterns
for each row execute function private.require_sensitive_envelopes();
create function public.sensitive_pattern_source(p_chapter_id text, p_after uuid default null)
returns setof public.casework_retaliation_reports language plpgsql security definer set search_path = '' as $$
declare org uuid := private.mi1_require_selected_organization();
begin
  perform private.casework_require_mfa();
  if not exists(select 1 from public.chapters where id = p_chapter_id and organization_id = org)
    or not private.member_has_chapter_role(p_chapter_id, array['coordinator','advisor','admin','vp']) then
    raise exception 'chapter not found' using errcode = '42501';
  end if;
  return query select r.* from public.casework_retaliation_reports r
    where r.organization_id = org and r.chapter_id = p_chapter_id and r.status <> 'withdrawn'
    and (r.reporter_user_id = (select auth.uid()) or (r.case_id is null or private.casework_staff_can_access(r.case_id)))
    and r.incident_at >= now() - interval '3 years' and (p_after is null or r.id > p_after)
    order by r.id limit 200;
end
$$;
revoke all on function public.sensitive_pattern_source(text,uuid) from public, anon;
grant execute on function public.sensitive_pattern_source(text,uuid) to authenticated;
create or replace function public.casework_scan_retaliation_patterns(p_chapter_id text)
returns integer language plpgsql security definer set search_path = '' as $$
declare org uuid := private.mi1_require_selected_organization(); ticket private.sensitive_write_tickets%rowtype;
  sources jsonb; g jsonb; report_ids uuid[]; count_out integer := 0;
begin
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

comment on column public.member_accommodation_requests.encrypted_content is 'Application AES-256-GCM envelopes; no plaintext search indexes. Legacy rows require explicit offline backfill.';
comment on column public.casework_retaliation_reports.encrypted_content is 'Application AES-256-GCM envelopes authenticated against organization, record, field, purpose and versions.';
comment on column public.member_case_files.encrypted_content is 'Ciphertext authentication metadata; payload ciphertext is stored in case-files, never plaintext.';

-- Pending rows are intentionally hidden by ordinary RLS. This narrow upload
-- target reuses the begin contract's owner, MFA and lifecycle checks.
create function public.sensitive_case_upload_target(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare f public.member_case_files%rowtype; org uuid;
begin
  perform private.casework_require_mfa();
  select * into f from public.member_case_files where id = p_file_id
    and uploaded_by = (select auth.uid()) and confirmed_at is null and removal_requested_at is null;
  if f.id is null then raise exception 'file unavailable' using errcode = '42501'; end if;
  select organization_id into org from public.member_cases where id = f.case_id;
  if org is distinct from private.mi1_require_selected_organization()
    or not (f.user_id = (select auth.uid()) or (public.staff_can_see_user(f.user_id, 'coordinator')
      and private.casework_staff_can_access(f.case_id))) then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  return to_jsonb(f) || jsonb_build_object('organization_id', org);
end
$$;
revoke all on function public.sensitive_case_upload_target(uuid) from public, anon;
grant execute on function public.sensitive_case_upload_target(uuid) to authenticated;

create function public.set_sensitive_case_envelope(p_file_id uuid, p_envelope jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare org uuid; changed integer;
begin
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
revoke all on function public.set_sensitive_case_envelope(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.set_sensitive_case_envelope(uuid,jsonb) to service_role;

-- Restrictive addition: existing feature ACL and quarantine policies remain.
-- Only the server may upload ciphertext. Old clients fail closed on insert.
create policy sensitive_case_server_upload on storage.objects as restrictive
for insert to authenticated with check (bucket_id <> 'case-files');
create policy sensitive_case_server_update on storage.objects as restrictive
for update to authenticated using (bucket_id <> 'case-files') with check (bucket_id <> 'case-files');

-- Bounded temporary ciphertext transport. Ten 1-MiB chunks maximum per pending
-- file; API re-authorizes every chunk and finish. No client table privileges.
create table public.sensitive_case_chunks (
  file_id uuid not null references public.member_case_files(id) on delete cascade,
  chunk_index integer not null check(chunk_index between 0 and 9),
  envelope jsonb not null check(pg_column_size(envelope) <= 1500000),
  expires_at timestamptz not null default now() + interval '1 hour',
  primary key(file_id,chunk_index)
);
alter table public.sensitive_case_chunks enable row level security;
create policy mfa_assurance on public.sensitive_case_chunks as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
revoke all on public.sensitive_case_chunks from public, anon, authenticated;
grant select, insert, update, delete on public.sensitive_case_chunks to service_role;

create table private.sensitive_retired_objects (object_name text primary key);
revoke all on private.sensitive_retired_objects from public, anon, authenticated, service_role;

-- Read-only verdict check uses the caller's ordinary file RLS. No attempt,
-- quota, metadata or plaintext is returned, and no service-role read is needed.
create function public.sensitive_case_read_current(p_file_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select private.private_upload_is_current('case-files', f.object_name)
    from public.member_case_files f where f.id = p_file_id
$$;
revoke all on function public.sensitive_case_read_current(uuid) from public, anon, service_role;
grant execute on function public.sensitive_case_read_current(uuid) to authenticated;

-- Inspection needs pending-file metadata, which ordinary caller RLS hides.
-- Keep service_role's direct table grants closed. Only an active authorized
-- attempt for this exact case object/version permits this bounded projection.
create function public.sensitive_case_inspection_metadata(p_file_id uuid, p_attempt_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('id', f.id, 'size_bytes', f.size_bytes,
    'object_name', f.object_name, 'encrypted_content', f.encrypted_content,
    'organization_id', c.organization_id)
  from public.member_case_files f
  join public.member_cases c on c.id = f.case_id
  join private.private_upload_inspection_attempts a
    on a.bucket_id = f.bucket_id and a.object_name = f.object_name
  join storage.objects o on o.id = a.object_id
    and o.bucket_id = a.bucket_id and o.name = a.object_name
    and o.version is not distinct from a.object_version
  where (select auth.role()) = 'service_role'
    and f.id = p_file_id and f.bucket_id = 'case-files' and a.id = p_attempt_id
    and a.completed_at is null and a.expires_at > clock_timestamp()
    and f.removal_requested_at is null and f.cleanup_requested_at is null
    and f.encrypted_content is not null
$$;
revoke all on function public.sensitive_case_inspection_metadata(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sensitive_case_inspection_metadata(uuid,uuid) to service_role;

-- This plan contains deterministic fictional fixture text only, never customer
-- records or database keys. The service encrypts it with independent SAMPLE keys.
create function public.sensitive_demo_seed_plan(p_lane text, p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare org uuid; result jsonb := '[]'::jsonb; chapter record; fields jsonb;
begin
  if p_lane not in ('presg','uniondemo') then raise exception 'sensitive-seed-lane-refused'; end if;
  if (p_lane = 'presg' and not exists(select 1 from private.presg_demo_runs where id=p_run_id and state in ('applied','verified')))
    or (p_lane = 'uniondemo' and not exists(select 1 from private.uniondemo_runs where id=p_run_id and state in ('applied','verified'))) then
    raise exception 'sensitive-seed-run-refused';
  end if;
  org := private.member_stress_uuid(p_run_id::text || case p_lane when 'presg' then ':presg:organization' else ':ud:organization' end);
  for n in 1..36 loop
    fields := jsonb_build_object('description',(array[
      'Request for a consistent start-time adjustment during the current schedule cycle.',
      'Request for equipment that supports the essential duties of the position.',
      'Request to review a workspace change and an effective implementation date.',
      'Request to document a leave-related schedule and the return-to-work plan.'
    ])[1 + (n % 4)]);
    if n % 5 in (2,3) then fields := fields || jsonb_build_object('staff_note','Written disposition recorded after the interactive review.'); end if;
    result := result || jsonb_build_array(jsonb_build_object('organization',org,'record',private.member_stress_uuid(p_run_id::text || ':member-support:accommodation:' || n),
      'purpose','member_accommodation_requests','fields',fields));
  end loop;
  for n in 1..120 loop
    fields := jsonb_build_object('management_person','Management contact ' || (1 + (n % 10)),
      'protected_activity','The member participated in a protected workplace discussion and requested representation.',
      'adverse_action','A schedule or assignment changed soon after the protected activity.',
      'requested_support','Document the sequence and review available safeguards.');
    if n % 4 = 0 then fields := fields || jsonb_build_object('withdrawal_reason','The member chose to pause this fictional report after receiving support.'); end if;
    result := result || jsonb_build_array(jsonb_build_object('organization',org,'record',private.member_stress_uuid(p_run_id::text || ':casework:retaliation-report:' || n),
      'purpose','casework_retaliation_reports','fields',fields));
  end loop;
  for chapter in select id from public.chapters where organization_id=org loop
    for n in 1..10 loop
      result := result || jsonb_build_array(jsonb_build_object('organization',org,'record',private.member_stress_uuid(p_run_id::text || ':casework:retaliation-pattern:' || chapter.id || ':management contact ' || n),
        'purpose','casework_retaliation_patterns','fields',jsonb_build_object('subject_label','Management contact ' || n)));
    end loop;
  end loop;
  return result;
end
$$;
revoke all on function public.sensitive_demo_seed_plan(text,uuid) from public,anon,authenticated;
grant execute on function public.sensitive_demo_seed_plan(text,uuid) to service_role;

-- Redefine the two delivered lanes in place, preserving their existing run,
-- password, tenant, cleanup, page-depth and side-effect guards. Drift fails closed.
do $seed$
declare definition text; name text; original text; replacement text;
begin
  foreach name in array array['demo_seed_apply_member_support','demo_seed_apply_casework'] loop
    select pg_get_functiondef(('private.' || name || '(text,uuid)')::regprocedure) into definition;
    if position('sensitive_seed_ticket' in definition) > 0 then raise exception 'sensitive-seed-definition-drift'; end if;
    definition := replace(definition, 'begin' || chr(10), 'begin' || chr(10) ||
      '  perform set_config(''app.sensitive_seed_ticket'', coalesce((select id::text from private.sensitive_write_tickets where operation=''demo_seed'' and arguments=jsonb_build_object(''lane'',p_lane,''runId'',p_run_id) and expires_at>clock_timestamp() order by expires_at desc limit 1),''''),true);' || chr(10));
    if name = 'demo_seed_apply_member_support' then
      original := $text$(array[
        'Request for a consistent start-time adjustment during the current schedule cycle.',
        'Request for equipment that supports the essential duties of the position.',
        'Request to review a workspace change and an effective implementation date.',
        'Request to document a leave-related schedule and the return-to-work plan.'
      ])[1 + (n % 4)]$text$;
      if position(original in definition)=0 then raise exception 'sensitive-seed-definition-drift'; end if;
      definition := replace(definition,original,quote_literal('[encrypted]'));
      definition := replace(definition,quote_literal('Written disposition recorded after the interactive review.'),quote_literal('[encrypted]'));
    else
      foreach original in array array[
        'The member participated in a protected workplace discussion and requested representation.',
        'A schedule or assignment changed soon after the protected activity.',
        'Document the sequence and review available safeguards.',
        'The member chose to pause this fictional report after receiving support.'
      ] loop
        if position(quote_literal(original) in definition)=0 then raise exception 'sensitive-seed-definition-drift'; end if;
        definition := replace(definition,quote_literal(original),quote_literal('[encrypted]'));
      end loop;
      definition := replace(definition,quote_literal('Management contact ') || ' || (1 + (case_row.ordinal % 10))',quote_literal('[encrypted]'));
      -- Group known fixture coordinates, never ciphertext markers or customer text.
      replacement := '(''Management contact '' || (1 + (seed.ordinal % 10)))';
      definition := replace(definition,'report.management_person',replacement);
      definition := replace(definition,'from public.casework_retaliation_reports report',
        'from public.casework_retaliation_reports report join generate_series(1,120) seed(ordinal) on report.id=private.member_stress_uuid(p_run_id::text || '':casework:retaliation-report:'' || seed.ordinal)');
      definition := replace(definition,'pg_catalog.md5(pattern_row.chapter_id || '':'' || pattern_row.person_key)','pattern_id::text');
      definition := replace(definition,'      pattern_row.subject_label,','      ''[encrypted]'',');
    end if;
    definition := replace(definition,'  return result;','  perform set_config(''app.sensitive_seed_ticket'','''',true);' || chr(10) || '  return result;');
    execute definition;
  end loop;
end
$seed$;
