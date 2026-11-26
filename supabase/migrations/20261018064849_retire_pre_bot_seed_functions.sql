-- OPS-UG-PRE-BOT-SEED-REMOVAL-20261015
-- Forward-only retirement. Historical migrations and cleanup ledgers are retained.
-- No hosted window is opened and no user, organization or bot row is deleted.
-- Exact legacy shared SAMPLE credentials are disabled; native retirement is a separate delivery.
begin;

-- Scheduled messaging writers acquire this gate before reading auth.users.
-- Take it before credential reads or catalogue DDL can retain relation locks.
select private.lock_case_graph(array[]::uuid[], array[]::uuid[]);

-- Exact legacy shared personas, with both original machine provenance tags.
-- No account is deleted; banning + clearing the password prevents a historical
-- shared password or provider login from issuing another session.
do $retired_shared_personas$
declare retired_users uuid[];
begin
  select coalesce(array_agg(u.id order by u.id), array[]::uuid[]) into retired_users
  from auth.users u
  join (values
    ('darnell.foster@demo.example.com','member'),
    ('sam.okafor@demo.example.com','steward'),
    ('jordan.patel@demo.example.com','coordinator'),
    ('avery.nguyen@demo.example.com','advisor'),
    ('alex.rivera@demo.example.com','admin'),
    ('taylor.morgan@demo.example.com','vp')
  ) as retired(email,hat) on lower(u.email) = retired.email
  where u.raw_app_meta_data @> jsonb_build_object('sample',true,'surface','sample','sample_persona',retired.hat);
  if cardinality(retired_users) = 0 then return; end if;
  perform private.lock_case_graph(retired_users, array[]::uuid[]);
  perform private.lock_message_lifecycle();
  -- Session/refresh-token bookkeeping takes this lock shared before tuples.
  -- Take it exclusively before deleting any Auth tuple: upgrading only at
  -- the later account ban can deadlock with refresh waiting on our deletion.
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  delete from auth.refresh_tokens t where t.user_id::text = any(retired_users::text[]);
  delete from auth.sessions s where s.user_id = any(retired_users);
  update auth.users set encrypted_password = '', banned_until = 'infinity'::timestamptz,
    recovery_token = '', confirmation_token = '', email_change_token_new = '',
    email_change_token_current = '', phone_change_token = '', reauthentication_token = '',
    updated_at = clock_timestamp()
  where id = any(retired_users);
end;
$retired_shared_personas$;


create or replace function private.guard_casework_restriction_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.is_restricted and new.restricted_by is null then
      raise exception 'restricted case requires an attribution actor' using errcode = '23514';
    end if;
    return new;
  end if;

  if old.restricted_by is not null
     and new.restricted_by is null
     and new.is_restricted then
    if private.account_lifecycle_is_nested_auth_detachment(old.restricted_by, new.restricted_by)
       and (pg_catalog.to_jsonb(new) - 'restricted_by')
         is not distinct from (pg_catalog.to_jsonb(old) - 'restricted_by') then
      return new;
    end if;
    raise exception 'restricted-case attribution cannot be detached' using errcode = '42501';
  end if;
  if not old.is_restricted and new.is_restricted and new.restricted_by is null then
    raise exception 'restricted case requires an attribution actor' using errcode = '23514';
  end if;


  if row(old.is_restricted, old.restriction_reason, old.restricted_at, old.restricted_by)
     is distinct from
     row(new.is_restricted, new.restriction_reason, new.restricted_at, new.restricted_by)
     and not private.casework_staff_can_access(old.id) then
    raise exception 'restricted-case fields require authorized staff' using errcode = '42501';
  end if;
  return new;
end;
$function$;


create or replace function private.require_sensitive_envelopes()
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
  -- Only the audited maintenance channel can bypass per-operation tickets.
  if maintenance then allowed := fields;
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


create or replace function private.sample_chapter_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  -- Shared pre-bot personas and their catalog are retired.
  return '[]'::jsonb;
end;
$function$;

-- Only these two jobs belong to the retired seed families.
do $retire_jobs$
declare job record;
begin
  for job in select jobid from cron.job where jobname in
    ('demo-seed-voice-quarterly-refresh','demo-seed-analytics-health-rotate')
  loop perform cron.unschedule(job.jobid); end loop;
end;
$retire_jobs$;

drop trigger if exists demo_seed_coordination_after_evidence_insert on private.demo_seed_function_evidence;
drop trigger if exists demo_seed_coordination_after_evidence_delete on private.demo_seed_function_evidence;
drop trigger if exists demo_seed_coordination_page_evidence on private.demo_seed_page_evidence;
drop trigger if exists demo_seed_sync_organization_intelligence_evidence on private.demo_seed_function_evidence;
drop trigger if exists demo_seed_sync_member_support_evidence on private.demo_seed_function_evidence;
drop trigger if exists demo_seed_refresh_voice_page_evidence on private.demo_seed_page_evidence;
drop trigger if exists demo_seed_sync_casework_evidence on private.demo_seed_function_evidence;
drop trigger if exists demo_seed_institutional_records_from_evidence on private.demo_seed_page_evidence;
drop trigger if exists presg_demo_archive_organization_on_remove on private.presg_demo_runs;
drop trigger if exists uniondemo_archive_organization_on_remove on private.uniondemo_runs;
drop trigger if exists demo_seed_analytics_after_page_evidence_insert on private.demo_seed_page_evidence;
drop trigger if exists demo_seed_analytics_after_evidence_delete on private.demo_seed_function_evidence;
drop trigger if exists demo_seed_member_operations_from_evidence on private.demo_seed_page_evidence;
drop trigger if exists demo_seed_sync_administrative_evidence on private.demo_seed_function_evidence;
drop trigger if exists demo_seed_refresh_administrative_page_evidence on private.demo_seed_page_evidence;
drop trigger if exists demo_seed_twilio_operation_history on private.demo_seed_function_evidence;
drop trigger if exists dues_sample_remove_presg_subjects on private.presg_demo_runs;
drop trigger if exists dues_sample_remove_uniondemo_subjects on private.uniondemo_runs;
drop trigger if exists demo_seed_binding_ensure_dues_indexes on private.demo_seed_installation_bindings;

do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_refresh_administrative_page_evidence()') is not null then
    revoke all on function private.demo_seed_refresh_administrative_page_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_refresh_administrative_page_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_sync_administrative_evidence()') is not null then
    revoke all on function private.demo_seed_sync_administrative_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_sync_administrative_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_administrative_evidence(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_administrative_evidence(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_administrative_evidence(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_administrative_evidence(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_administrative_evidence(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_administrative_evidence(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.remove_mi1_knowledge_sample(text, uuid, text, text)') is not null then
    revoke all on function public.remove_mi1_knowledge_sample(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.remove_mi1_knowledge_sample(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.mi1_knowledge_sample_status(text, uuid)') is not null then
    revoke all on function public.mi1_knowledge_sample_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.mi1_knowledge_sample_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.activate_mi1_knowledge_sample(text, uuid, text, text)') is not null then
    revoke all on function public.activate_mi1_knowledge_sample(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.activate_mi1_knowledge_sample(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_knowledge_library(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_knowledge_library(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_knowledge_library(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_knowledge_library_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_knowledge_library_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_knowledge_library_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_knowledge_library(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_knowledge_library(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_knowledge_library(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_sync_member_support_evidence()') is not null then
    revoke all on function private.demo_seed_sync_member_support_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_sync_member_support_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_member_support(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_member_support(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_member_support(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_member_support_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_member_support_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_member_support_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_member_support(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_member_support(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_member_support(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_sync_organization_intelligence_evidence()') is not null then
    revoke all on function private.demo_seed_sync_organization_intelligence_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_sync_organization_intelligence_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_organization_intelligence_unwindowed_20260829(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_organization_intelligence_unwindowed_20260829(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_organization_intelligence_unwindowed_20260829(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_organization_intelligence(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_organization_intelligence(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_organization_intelligence(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_organization_intelligence(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_organization_intelligence(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_organization_intelligence(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_coordination_page_evidence()') is not null then
    revoke all on function private.demo_seed_coordination_page_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_coordination_page_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_coordination_after_evidence_delete()') is not null then
    revoke all on function private.demo_seed_coordination_after_evidence_delete() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_coordination_after_evidence_delete() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_coordination_after_evidence_insert()') is not null then
    revoke all on function private.demo_seed_coordination_after_evidence_insert() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_coordination_after_evidence_insert() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_organization_coordination(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_organization_coordination(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_organization_coordination(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_organization_coordination(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_organization_coordination(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_organization_coordination(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_topup_upcoming_events(text[], text, text)') is not null then
    revoke all on function public.uniondemo_topup_upcoming_events(p_chapter_ids text[], p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_topup_upcoming_events(p_chapter_ids text[], p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_remove_function_parity(uuid, text, text)') is not null then
    revoke all on function public.uniondemo_remove_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_remove_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_function_parity_status(uuid)') is not null then
    revoke all on function public.uniondemo_function_parity_status(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_function_parity_status(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_seed_function_parity(uuid, text, text)') is not null then
    revoke all on function public.uniondemo_seed_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_seed_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_remove_batch(uuid, integer, text, text)') is not null then
    revoke all on function public.uniondemo_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_begin_remove(uuid, text, text)') is not null then
    revoke all on function public.uniondemo_begin_remove(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_begin_remove(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_verify(uuid, text)') is not null then
    revoke all on function public.uniondemo_verify(p_run_id uuid, p_password text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_verify(p_run_id uuid, p_password text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_status(uuid)') is not null then
    revoke all on function public.uniondemo_status(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_status(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_enrich_batch(uuid, text, integer, integer, text, text)') is not null then
    revoke all on function public.uniondemo_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_seed_channels(uuid, integer, text, text)') is not null then
    revoke all on function public.uniondemo_seed_channels(p_run_id uuid, p_chapter_index integer, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_seed_channels(p_run_id uuid, p_chapter_index integer, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_seed_org(uuid, integer, text, text)') is not null then
    revoke all on function public.uniondemo_seed_org(p_run_id uuid, p_chapter_index integer, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_seed_org(p_run_id uuid, p_chapter_index integer, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_prepare_reapply(uuid, text, text, text)') is not null then
    revoke all on function public.uniondemo_prepare_reapply(p_run_id uuid, p_password text, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_prepare_reapply(p_run_id uuid, p_password text, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_apply_batch(uuid, integer, integer, text, text, text)') is not null then
    revoke all on function public.uniondemo_apply_batch(p_run_id uuid, p_start_ordinal integer, p_batch_count integer, p_password text, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_apply_batch(p_run_id uuid, p_start_ordinal integer, p_batch_count integer, p_password text, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.uniondemo_begin(uuid, text, integer, integer, integer, text, text, text)') is not null then
    revoke all on function public.uniondemo_begin(p_run_id uuid, p_dataset_version text, p_member_count integer, p_steward_count integer, p_login_count integer, p_config_hash text, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.uniondemo_begin(p_run_id uuid, p_dataset_version text, p_member_count integer, p_steward_count integer, p_login_count integer, p_config_hash text, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_remove_function_parity(uuid, text, text)') is not null then
    revoke all on function public.presg_demo_remove_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_remove_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_function_parity_status(uuid)') is not null then
    revoke all on function public.presg_demo_function_parity_status(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_function_parity_status(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_seed_function_parity(uuid, text, text)') is not null then
    revoke all on function public.presg_demo_seed_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_seed_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_remove_batch(uuid, integer, text, text)') is not null then
    revoke all on function public.presg_demo_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_begin_remove(uuid, text, text)') is not null then
    revoke all on function public.presg_demo_begin_remove(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_begin_remove(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_verify(uuid, text)') is not null then
    revoke all on function public.presg_demo_verify(p_run_id uuid, p_password text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_verify(p_run_id uuid, p_password text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_status(uuid)') is not null then
    revoke all on function public.presg_demo_status(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_status(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_enrich_batch(uuid, text, integer, integer, text, text)') is not null then
    revoke all on function public.presg_demo_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_seed_channels(uuid, text, text)') is not null then
    revoke all on function public.presg_demo_seed_channels(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_seed_channels(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_seed_org(uuid, text, text)') is not null then
    revoke all on function public.presg_demo_seed_org(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_seed_org(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_prepare_reapply(uuid, text, text, text)') is not null then
    revoke all on function public.presg_demo_prepare_reapply(p_run_id uuid, p_password text, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_prepare_reapply(p_run_id uuid, p_password text, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_apply_batch(uuid, integer, integer, text, text, text)') is not null then
    revoke all on function public.presg_demo_apply_batch(p_run_id uuid, p_start_ordinal integer, p_batch_count integer, p_password text, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_apply_batch(p_run_id uuid, p_start_ordinal integer, p_batch_count integer, p_password text, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.presg_demo_begin(uuid, text, integer, integer, integer, text, text, text)') is not null then
    revoke all on function public.presg_demo_begin(p_run_id uuid, p_dataset_version text, p_member_count integer, p_committee_count integer, p_login_count integer, p_config_hash text, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.presg_demo_begin(p_run_id uuid, p_dataset_version text, p_member_count integer, p_committee_count integer, p_login_count integer, p_config_hash text, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_institutional_records(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_institutional_records(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_institutional_records(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_institutional_records_from_evidence()') is not null then
    revoke all on function private.demo_seed_institutional_records_from_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_institutional_records_from_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_auth_operations(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_auth_operations(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_auth_operations(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_auth_operations(text, uuid, text, text)') is not null then
    revoke all on function private.demo_seed_apply_auth_operations(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_auth_operations(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_auth_operations_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_auth_operations_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_auth_operations_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_function_parity(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_function_parity(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_function_parity(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_drop_voice_operations_refresh()') is not null then
    revoke all on function private.demo_seed_drop_voice_operations_refresh() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_drop_voice_operations_refresh() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_ensure_voice_operations_refresh()') is not null then
    revoke all on function private.demo_seed_ensure_voice_operations_refresh() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_ensure_voice_operations_refresh() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_refresh_voice_quarterly_windows()') is not null then
    revoke all on function private.demo_seed_refresh_voice_quarterly_windows() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_refresh_voice_quarterly_windows() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_analytics_after_evidence_delete()') is not null then
    revoke all on function private.demo_seed_analytics_after_evidence_delete() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_analytics_after_evidence_delete() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_analytics_after_page_evidence_insert()') is not null then
    revoke all on function private.demo_seed_analytics_after_page_evidence_insert() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_analytics_after_page_evidence_insert() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_analytics(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_analytics(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_analytics(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_analytics(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_analytics(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_analytics(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_drop_analytics_health_rotation()') is not null then
    revoke all on function private.demo_seed_drop_analytics_health_rotation() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_drop_analytics_health_rotation() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_ensure_analytics_health_rotation()') is not null then
    revoke all on function private.demo_seed_ensure_analytics_health_rotation() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_ensure_analytics_health_rotation() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_rotate_analytics_health()') is not null then
    revoke all on function private.demo_seed_rotate_analytics_health() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_rotate_analytics_health() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_refresh_analytics_health(text, uuid)') is not null then
    revoke all on function private.demo_seed_refresh_analytics_health(text, uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_refresh_analytics_health(text, uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_archive_organization_on_remove()') is not null then
    revoke all on function private.demo_seed_archive_organization_on_remove() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_archive_organization_on_remove() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_analytics_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_analytics_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_analytics_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_refresh_voice_page_evidence()') is not null then
    revoke all on function private.demo_seed_refresh_voice_page_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_refresh_voice_page_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_voice_operations(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_voice_operations(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_voice_operations(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_voice_operations_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_voice_operations_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_voice_operations_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_voice_operations(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_voice_operations(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_voice_operations(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_voice_parity(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_voice_parity(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_voice_parity(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_voice_parity_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_voice_parity_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_voice_parity_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_voice_parity(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_voice_parity(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_voice_parity(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_function_parity_status_pre_casework_20260830(text, uuid)') is not null then
    revoke all on function private.demo_seed_function_parity_status_pre_casework_20260830(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_function_parity_status_pre_casework_20260830(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_function_parity_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_function_parity_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_function_parity_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_function_parity(text, uuid, text, text)') is not null then
    revoke all on function private.demo_seed_apply_function_parity(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_function_parity(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_sync_casework_evidence()') is not null then
    revoke all on function private.demo_seed_sync_casework_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_sync_casework_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_casework(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_casework(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_casework(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_casework_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_casework_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_casework_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_casework(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_casework(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_casework(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_record_page_evidence_pre_casework_20260830(text, uuid, uuid, uuid, uuid, uuid)') is not null then
    revoke all on function private.demo_seed_record_page_evidence_pre_casework_20260830(p_lane text, p_run_id uuid, p_organization_id uuid, p_featured_user uuid, p_featured_steward uuid, p_featured_conversation uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_record_page_evidence_pre_casework_20260830(p_lane text, p_run_id uuid, p_organization_id uuid, p_featured_user uuid, p_featured_steward uuid, p_featured_conversation uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_record_page_evidence(text, uuid, uuid, uuid, uuid, uuid)') is not null then
    revoke all on function private.demo_seed_record_page_evidence(p_lane text, p_run_id uuid, p_organization_id uuid, p_featured_user uuid, p_featured_steward uuid, p_featured_conversation uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_record_page_evidence(p_lane text, p_run_id uuid, p_organization_id uuid, p_featured_user uuid, p_featured_steward uuid, p_featured_conversation uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_chapter(text, uuid, integer)') is not null then
    revoke all on function private.demo_seed_chapter(p_lane text, p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_chapter(p_lane text, p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_user(text, uuid, integer)') is not null then
    revoke all on function private.demo_seed_user(p_lane text, p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_user(p_lane text, p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_verify_pre_function_parity(uuid, text)') is not null then
    revoke all on function private.uniondemo_verify_pre_function_parity(p_run_id uuid, p_password text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_verify_pre_function_parity(p_run_id uuid, p_password text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_protected_snapshot(uuid)') is not null then
    revoke all on function private.uniondemo_protected_snapshot(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_protected_snapshot(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_sweep_trigger_rows(uuid)') is not null then
    revoke all on function private.uniondemo_sweep_trigger_rows(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_sweep_trigger_rows(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_impersonate(uuid)') is not null then
    revoke all on function private.uniondemo_impersonate(p_user_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_impersonate(p_user_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_authorize(text, text)') is not null then
    revoke all on function private.uniondemo_authorize(p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_authorize(p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_receipt_code(text)') is not null then
    revoke all on function private.uniondemo_receipt_code(p_seed text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_receipt_code(p_seed text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_joined_at(uuid, integer, boolean)') is not null then
    revoke all on function private.uniondemo_joined_at(p_run_id uuid, p_ordinal integer, p_steward boolean) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_joined_at(p_run_id uuid, p_ordinal integer, p_steward boolean) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_full_name(uuid, integer)') is not null then
    revoke all on function private.uniondemo_full_name(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_full_name(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_last_name(uuid, integer)') is not null then
    revoke all on function private.uniondemo_last_name(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_last_name(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_first_name(uuid, integer)') is not null then
    revoke all on function private.uniondemo_first_name(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_first_name(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_email(uuid, integer)') is not null then
    revoke all on function private.uniondemo_email(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_email(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.uniondemo_user_id(uuid, integer)') is not null then
    revoke all on function private.uniondemo_user_id(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.uniondemo_user_id(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_verify_pre_function_parity(uuid, text)') is not null then
    revoke all on function private.presg_demo_verify_pre_function_parity(p_run_id uuid, p_password text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_verify_pre_function_parity(p_run_id uuid, p_password text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_protected_snapshot(uuid)') is not null then
    revoke all on function private.presg_demo_protected_snapshot(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_protected_snapshot(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_sweep_trigger_rows(uuid)') is not null then
    revoke all on function private.presg_demo_sweep_trigger_rows(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_sweep_trigger_rows(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_impersonate(uuid)') is not null then
    revoke all on function private.presg_demo_impersonate(p_user_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_impersonate(p_user_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_authorize(text, text)') is not null then
    revoke all on function private.presg_demo_authorize(p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_authorize(p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_receipt_code(text)') is not null then
    revoke all on function private.presg_demo_receipt_code(p_seed text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_receipt_code(p_seed text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_joined_at(uuid, integer, integer)') is not null then
    revoke all on function private.presg_demo_joined_at(p_run_id uuid, p_ordinal integer, p_committee integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_joined_at(p_run_id uuid, p_ordinal integer, p_committee integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_full_name(uuid, integer)') is not null then
    revoke all on function private.presg_demo_full_name(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_full_name(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_last_name(uuid, integer)') is not null then
    revoke all on function private.presg_demo_last_name(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_last_name(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_first_name(uuid, integer)') is not null then
    revoke all on function private.presg_demo_first_name(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_first_name(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_email(uuid, integer)') is not null then
    revoke all on function private.presg_demo_email(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_email(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.presg_demo_user_id(uuid, integer)') is not null then
    revoke all on function private.presg_demo_user_id(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.presg_demo_user_id(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.member_stress_verify(uuid, text)') is not null then
    revoke all on function public.member_stress_verify(p_run_id uuid, p_password text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.member_stress_verify(p_run_id uuid, p_password text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.member_stress_status(uuid)') is not null then
    revoke all on function public.member_stress_status(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.member_stress_status(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.member_stress_remove_batch(uuid, integer, text, text)') is not null then
    revoke all on function public.member_stress_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.member_stress_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.member_stress_begin_remove(uuid, text, text)') is not null then
    revoke all on function public.member_stress_begin_remove(p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.member_stress_begin_remove(p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.member_stress_enrich_verify(uuid)') is not null then
    revoke all on function public.member_stress_enrich_verify(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.member_stress_enrich_verify(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.member_stress_enrich_batch(uuid, text, integer, integer, text, text)') is not null then
    revoke all on function public.member_stress_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.member_stress_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.member_stress_begin(uuid, text, integer, integer, text, text, text)') is not null then
    revoke all on function public.member_stress_begin(p_run_id uuid, p_dataset_version text, p_member_count integer, p_login_count integer, p_config_hash text, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.member_stress_begin(p_run_id uuid, p_dataset_version text, p_member_count integer, p_login_count integer, p_config_hash text, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.member_stress_apply_batch(uuid, integer, integer, text, text, text)') is not null then
    revoke all on function public.member_stress_apply_batch(p_run_id uuid, p_start_ordinal integer, p_batch_count integer, p_password text, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.member_stress_apply_batch(p_run_id uuid, p_start_ordinal integer, p_batch_count integer, p_password text, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_retention_status(text, uuid)') is not null then
    revoke all on function private.demo_seed_retention_status(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_retention_status(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_retention_engine(text, uuid, text, text)') is not null then
    revoke all on function private.demo_seed_retention_engine(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_retention_engine(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_retention_engine(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_retention_engine(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_retention_engine(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.member_stress_uuid(text)') is not null then
    revoke all on function private.member_stress_uuid(p_value text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.member_stress_uuid(p_value text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.member_stress_user_id(uuid, integer)') is not null then
    revoke all on function private.member_stress_user_id(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.member_stress_user_id(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.member_stress_protected_snapshot(uuid)') is not null then
    revoke all on function private.member_stress_protected_snapshot(p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.member_stress_protected_snapshot(p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.member_stress_rand(text)') is not null then
    revoke all on function private.member_stress_rand(p_seed text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.member_stress_rand(p_seed text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.member_stress_pick(text, integer)') is not null then
    revoke all on function private.member_stress_pick(p_seed text, p_n integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.member_stress_pick(p_seed text, p_n integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.member_stress_email(uuid, integer)') is not null then
    revoke all on function private.member_stress_email(p_run_id uuid, p_ordinal integer) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.member_stress_email(p_run_id uuid, p_ordinal integer) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.member_stress_authorize(text, text)') is not null then
    revoke all on function private.member_stress_authorize(p_target_ref text, p_confirm_token text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.member_stress_authorize(p_target_ref text, p_confirm_token text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_member_operations(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_member_operations(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_member_operations(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_member_operations_from_evidence()') is not null then
    revoke all on function private.demo_seed_member_operations_from_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_member_operations_from_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_casework_status_pre_member_operations_20260830(text, uuid)') is not null then
    revoke all on function private.demo_seed_casework_status_pre_member_operations_20260830(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_casework_status_pre_member_operations_20260830(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_twilio_operation_history_from_evidence()') is not null then
    revoke all on function private.demo_seed_twilio_operation_history_from_evidence() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_twilio_operation_history_from_evidence() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_twilio_operation_history(text, uuid)') is not null then
    revoke all on function private.demo_seed_twilio_operation_history(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_twilio_operation_history(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.dues_sample_seed_organization(text, uuid)') is not null then
    revoke all on function private.dues_sample_seed_organization(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.dues_sample_seed_organization(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.dues_sample_seed_authorize(text, text, text, uuid, text)') is not null then
    revoke all on function private.dues_sample_seed_authorize(p_target_ref text, p_confirm_token text, p_lane text, p_run_id uuid, p_mode text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.dues_sample_seed_authorize(p_target_ref text, p_confirm_token text, p_lane text, p_run_id uuid, p_mode text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.dues_sample_remove_subjects_on_lane_removal()') is not null then
    revoke all on function private.dues_sample_remove_subjects_on_lane_removal() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.dues_sample_remove_subjects_on_lane_removal() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.on_demo_seed_binding_ensure_dues_indexes()') is not null then
    revoke all on function private.on_demo_seed_binding_ensure_dues_indexes() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.on_demo_seed_binding_ensure_dues_indexes() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.ensure_dues_sample_seed_covering_indexes()') is not null then
    revoke all on function private.ensure_dues_sample_seed_covering_indexes() from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.ensure_dues_sample_seed_covering_indexes() restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_verify_dues(text, uuid)') is not null then
    revoke all on function private.demo_seed_verify_dues(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_verify_dues(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_remove_dues(text, uuid)') is not null then
    revoke all on function private.demo_seed_remove_dues(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_remove_dues(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('private.demo_seed_apply_dues(text, uuid)') is not null then
    revoke all on function private.demo_seed_apply_dues(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists private.demo_seed_apply_dues(p_lane text, p_run_id uuid) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.authorize_dues_sample_seed(text, text, text, uuid, text)') is not null then
    revoke all on function public.authorize_dues_sample_seed(p_target_ref text, p_confirm_token text, p_lane text, p_run_id uuid, p_mode text) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.authorize_dues_sample_seed(p_target_ref text, p_confirm_token text, p_lane text, p_run_id uuid, p_mode text) restrict;
do $revoke$ begin
  if pg_catalog.to_regprocedure('public.sensitive_demo_seed_plan(text, uuid)') is not null then
    revoke all on function public.sensitive_demo_seed_plan(p_lane text, p_run_id uuid) from public, anon, authenticated, service_role;
  end if;
end; $revoke$;
drop function if exists public.sensitive_demo_seed_plan(p_lane text, p_run_id uuid) restrict;

-- Exact unowned historical placeholders only; no pattern selectors.
-- Union Ground dropped the public.demo_* tables in 20261014010000, so only
-- the shared tables are cleaned here, matched on this edition's own seed text.
-- The sample Guide articles stay: 20261014013000 rewrote them as this
-- edition's own retired organizing content.
delete from public.member_broadcasts where id is not distinct from 'broadcast-2026-q2' and sender is not distinct from 'Chapter steward' and title is not distinct from 'Fictional Public Service Chapter 3E024208 Q2 update' and body is not distinct from 'Members are tracking contract enforcement, upcoming meetings, and next steps.' and organization_id is null and created_by is null and chapter_id is null;
delete from public.member_broadcasts where id is not distinct from 'broadcast-2026-q1' and sender is not distinct from 'Chapter steward' and title is not distinct from 'Fictional Public Service Chapter 3E024208 Q1 update' and body is not distinct from 'Quarterly enforcement results and the next member meeting agenda are ready.' and organization_id is null and created_by is null and chapter_id is null;
delete from public.member_broadcasts where id is not distinct from 'broadcast-2025-q3' and sender is not distinct from 'Chapter steward' and title is not distinct from 'Fictional Public Service Chapter 3E024208 Q3 update' and body is not distinct from 'Members closed three grievances and approved the fall bargaining priorities.' and organization_id is null and created_by is null and chapter_id is null;
delete from public.member_broadcasts where id is not distinct from 'broadcast-2025-q1' and sender is not distinct from 'Chapter steward' and title is not distinct from 'Fictional Public Service Chapter 3E024208 Q1 update' and body is not distinct from 'Read the contract enforcement recap and upcoming training dates.' and organization_id is null and created_by is null and chapter_id is null;
delete from public.member_broadcasts where id is not distinct from 'broadcast-2024-q3' and sender is not distinct from 'Chapter steward' and title is not distinct from 'Fictional Public Service Chapter 3E024208 Q3 update' and body is not distinct from 'Clear communication standards and member office hours are now posted.' and organization_id is null and created_by is null and chapter_id is null;
delete from public.member_broadcasts where id is not distinct from 'broadcast-2024-q2' and sender is not distinct from 'Chapter steward' and title is not distinct from 'Fictional Public Service Chapter 3E024208 Q2 update' and body is not distinct from 'The chapter approved new communication practices and escalation contacts.' and organization_id is null and created_by is null and chapter_id is null;
delete from public.member_ballots where id is not distinct from 'ballot-2026' and title is not distinct from 'Ratify the 2026 Fictional Public Service Chapter 3E024208 action budget priorities' and closes_at is not distinct from '2027-07-22T00:00:00Z' and organization_id is null and created_by is null and chapter_id is null;
delete from public.member_surveys where id is not distinct from 'pulse-new-members' and title is not distinct from 'Which support would help newer members most?' and closes_at is not distinct from '2027-07-25T00:00:00Z' and organization_id is null and created_by is null and chapter_id is null;
delete from public.member_events where id is not distinct from 'evt-2026-chapter-meeting' and title is not distinct from 'Chapter meeting' and location is not distinct from 'Boston office hall + Zoom' and summary is not distinct from 'Bargaining survey vote and contract update.' and check_in_code is not distinct from 'SG-CHAPTER' and chapter_id is null;
delete from public.member_events where id is not distinct from 'evt-2026-steward-training' and title is not distinct from 'New-steward training' and location is not distinct from 'Juniper hall · 30 Example Way' and summary is not distinct from 'Module 3 — Weingarten rights and Step 1 practice.' and check_in_code is not distinct from 'SG-TRAINING' and chapter_id is null;
delete from public.member_events where id is not distinct from 'evt-2026-office-hours' and title is not distinct from 'Bargaining team office hours' and location is not distinct from 'Zoom' and summary is not distinct from 'Tentative-agreement questions answered live.' and check_in_code is not distinct from 'SG-OFFICE' and chapter_id is null;
delete from public.member_events where id is not distinct from 'evt-2026-relief-rally' and title is not distinct from 'Caseload-relief rally' and location is not distinct from 'State House steps' and summary is not distinct from 'Bring your local T-shirt — noon start.' and check_in_code is not distinct from 'SG-RALLY' and chapter_id is null;
delete from public.member_events where id is not distinct from 'evt-2026-ratification-call' and title is not distinct from 'Ratification results call' and location is not distinct from 'Zoom · all chapters' and summary is not distinct from 'Live results of the 2026 contract ratification vote.' and check_in_code is not distinct from 'SG-RATIFY' and chapter_id is null;
delete from public.member_broadcasts where id = 'broadcast-archive-01' and title = 'Member briefing 1' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-02' and title = 'Member briefing 2' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-03' and title = 'Member briefing 3' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-04' and title = 'Member briefing 4' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-05' and title = 'Member briefing 5' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-06' and title = 'Member briefing 6' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-07' and title = 'Member briefing 7' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-08' and title = 'Member briefing 8' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-09' and title = 'Member briefing 9' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-10' and title = 'Member briefing 10' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-11' and title = 'Member briefing 11' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-12' and title = 'Member briefing 12' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-13' and title = 'Member briefing 13' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;
delete from public.member_broadcasts where id = 'broadcast-archive-14' and title = 'Member briefing 14' and body = 'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.' and organization_id is null and chapter_id is null and created_by is null;

-- Reconcile only the exact reviewed entries changed by this retirement.
-- Never refresh the whole catalogue: unrelated drift must still fail closed.
do $retired_lifecycle_review$
declare entry record; reviewed_hash text; installed_hash text;
begin
  for entry in with changes(kind, schema_name, table_name, object_name, before_hash, after_hash) as (values
    ('function', 'private', '', 'demo_seed_analytics_after_evidence_delete()', '0cb8c7960051816cc2bdae81b87e746f', null::text),
    ('function', 'private', '', 'demo_seed_analytics_after_page_evidence_insert()', '65c3206bc0cc63228e5dac6fa4859447', null::text),
    ('function', 'private', '', 'demo_seed_analytics_status(p_lane text, p_run_id uuid)', '6c858f4cea4054287e03480fd231678c', null::text),
    ('function', 'private', '', 'demo_seed_apply_administrative_evidence(p_lane text, p_run_id uuid)', '1a81a27dfee2f50fc10ce930937b4237', null::text),
    ('function', 'private', '', 'demo_seed_apply_analytics(p_lane text, p_run_id uuid)', 'b3d466a3d238c07cd9c5ab62e0e0507b', null::text),
    ('function', 'private', '', 'demo_seed_apply_casework(p_lane text, p_run_id uuid)', '0f3a31831828e74811945d4cb6d12e33', null::text),
    ('function', 'private', '', 'demo_seed_apply_member_support(p_lane text, p_run_id uuid)', 'cdfafb6a6882ec49d35d4eed0c2b4c5b', null::text),
    ('function', 'private', '', 'demo_seed_apply_organization_coordination(p_lane text, p_run_id uuid)', '339ec015407c2fb4182bcbc4060949d4', null::text),
    ('function', 'private', '', 'demo_seed_apply_organization_intelligence_unwindowed_20260829(p_lane text, p_run_id uuid)', '655a7f5ad07918d7ccb82da3bd5ce114', null::text),
    ('function', 'private', '', 'demo_seed_apply_organization_intelligence(p_lane text, p_run_id uuid)', '9eeab9835e371b97fa8fd5dfbf252d11', null::text),
    ('function', 'private', '', 'demo_seed_archive_organization_on_remove()', '7facae9acde7b17cf55a8cd3ab5f0df6', null::text),
    ('function', 'private', '', 'demo_seed_casework_status_pre_member_operations_20260830(p_lane text, p_run_id uuid)', '48ed056668ab1c16db2f1c93c779a901', null::text),
    ('function', 'private', '', 'demo_seed_casework_status(p_lane text, p_run_id uuid)', '81aca5406677b2ee5486be1bf5286d39', null::text),
    ('function', 'private', '', 'demo_seed_chapter(p_lane text, p_run_id uuid, p_ordinal integer)', '9a9cc1fcbe9d0c664e2fa590a58182ba', null::text),
    ('function', 'private', '', 'demo_seed_coordination_after_evidence_delete()', '1db23717b2639ae4e1ac3304a3d3d8cb', null::text),
    ('function', 'private', '', 'demo_seed_coordination_after_evidence_insert()', 'ca3b9e71df8bb82cf0f692754ffad9b1', null::text),
    ('function', 'private', '', 'demo_seed_coordination_page_evidence()', '360b71fd2493c465c0712b1e1ed22046', null::text),
    ('function', 'private', '', 'demo_seed_drop_analytics_health_rotation()', '949caf08650de228078ff8308ec2da6b', null::text),
    ('function', 'private', '', 'demo_seed_ensure_analytics_health_rotation()', '0d5145b0843670eb60f7e6bd6e54aaa7', null::text),
    ('function', 'private', '', 'demo_seed_institutional_records_from_evidence()', '13ac6a62955b37e439301977974c3ddb', null::text),
    ('function', 'private', '', 'demo_seed_member_operations_from_evidence()', 'f92f149db0a24fa24fcfef267e4e1b2a', null::text),
    ('function', 'private', '', 'demo_seed_member_support_status(p_lane text, p_run_id uuid)', 'ff3052c20ef4ef07d5078bca678d2cdf', null::text),
    ('function', 'private', '', 'demo_seed_refresh_administrative_page_evidence()', '8cda44d92fffbc0af525394da6de4523', null::text),
    ('function', 'private', '', 'demo_seed_refresh_analytics_health(text, uuid)', 'd92a1702397cd13961e41e728c09fb02', null::text),
    ('function', 'private', '', 'demo_seed_refresh_voice_page_evidence()', 'f0c824fe111bcfc95263af82821c6364', null::text),
    ('function', 'private', '', 'demo_seed_remove_administrative_evidence(p_lane text, p_run_id uuid)', '8db9fd6f7c25fc7a368d89f1f2a15b7f', null::text),
    ('function', 'private', '', 'demo_seed_remove_analytics(p_lane text, p_run_id uuid)', '4584a24b5bd6702ee65e9e45a87af611', null::text),
    ('function', 'private', '', 'demo_seed_remove_casework(p_lane text, p_run_id uuid)', '84b2d247c5c1d75c1436be447d51c73e', null::text),
    ('function', 'private', '', 'demo_seed_remove_member_support(p_lane text, p_run_id uuid)', '9fc71658fca41afc506fe7012c3a17f5', null::text),
    ('function', 'private', '', 'demo_seed_remove_organization_coordination(p_lane text, p_run_id uuid)', '698f65f08214fa033fea03b4b69a6740', null::text),
    ('function', 'private', '', 'demo_seed_remove_organization_intelligence(p_lane text, p_run_id uuid)', 'd09f46503e7e925337eb60b20860cf5f', null::text),
    ('function', 'private', '', 'demo_seed_rotate_analytics_health()', '29ee7f99037495235367a397704d0c49', null::text),
    ('function', 'private', '', 'demo_seed_sync_administrative_evidence()', '5879b2b34277914038eb11da4b964750', null::text),
    ('function', 'private', '', 'demo_seed_sync_casework_evidence()', '985e873dbeddea3d58d84ae468229a75', null::text),
    ('function', 'private', '', 'demo_seed_sync_member_support_evidence()', 'a5cbc83cfd2f32fd320bd9904b3f72b3', null::text),
    ('function', 'private', '', 'demo_seed_sync_organization_intelligence_evidence()', 'e75757cc55f70e63844ae91a828efcd9', null::text),
    ('function', 'private', '', 'demo_seed_twilio_operation_history_from_evidence()', '81de00bc23406062a0aa0113c463e05b', null::text),
    ('function', 'private', '', 'demo_seed_twilio_operation_history(p_lane text, p_run_id uuid)', '6fae777477406e9defea382451b56a07', null::text),
    ('function', 'private', '', 'demo_seed_user(p_lane text, p_run_id uuid, p_ordinal integer)', '8b415d66ec6ea8579bcfb240b0a6d072', null::text),
    ('function', 'private', '', 'dues_sample_remove_subjects_on_lane_removal()', '1843a59b9715c0510baa06e00c67aea7', null::text),
    ('function', 'private', '', 'dues_sample_seed_organization(p_lane text, p_run_id uuid)', 'efd4a9e7d3304459d75dffdca4bb370b', null::text),
    ('function', 'private', '', 'ensure_dues_sample_seed_covering_indexes()', 'cda5a24bf234657832b583cbec6dee38', null::text),
    ('function', 'private', '', 'guard_casework_restriction_update()', 'bed9fb23735c63f688e689da75b2478f', 'f4cc253209860bd8cc169f3b5e06f801'),
    ('function', 'private', '', 'member_stress_pick(p_seed text, p_n integer)', 'f924f17eefb79ba89e15134fa6160232', null::text),
    ('function', 'private', '', 'member_stress_rand(p_seed text)', '1a7ad8f140d13b2a48f541620f779845', null::text),
    ('function', 'private', '', 'member_stress_uuid(p_value text)', 'bf52530c2820740b3ac4a39a48f02748', null::text),
    ('function', 'private', '', 'on_demo_seed_binding_ensure_dues_indexes()', 'ead1a8e4010dc8aa105be9ba75a97248', null::text),
    ('function', 'private', '', 'require_sensitive_envelopes()', 'dcfd913959f311dcce0824a16eda0ae6', '21566aeaa2a3b2cd0a807b3c7f266c08'),
    ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_analytics_after_evidence_delete', 'b3e0c87615239abd0c046b3fe1dcd930', null::text),
    ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_coordination_after_evidence_delete', 'd667f422b2a398c380a7fa92e46d41bf', null::text),
    ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_coordination_after_evidence_insert', 'a2a1dfc3e4d152ebfea0472636e033f5', null::text),
    ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_sync_administrative_evidence', '776cf610e7950428e46d7fc6fdff8db4', null::text),
    ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_sync_casework_evidence', 'c8d1dfdf0895b5340ef7fd9940edcb27', null::text),
    ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_sync_member_support_evidence', '7c49f90578b7d62be8c0e4cda7119183', null::text),
    ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_sync_organization_intelligence_evidence', 'a6311c3b4a5e5f350d6240fcc0b0cfb0', null::text),
    ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_twilio_operation_history', '5e88372d9dde1f38cb5739299312334c', null::text),
    ('trigger', 'private', 'demo_seed_installation_bindings', 'demo_seed_binding_ensure_dues_indexes', 'f94ec31e51b22620acdaa7c08129d6bc', null::text),
    ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_analytics_after_page_evidence_insert', '6c974fbe48507935de5a872d907730d9', null::text),
    ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_coordination_page_evidence', '7d34728773d8f379e942ddd7c1b754bd', null::text),
    ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_institutional_records_from_evidence', '70dbb70a6826a09bd77ea26cfb1510e5', null::text),
    ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_member_operations_from_evidence', 'fb8ca2f0fc28467f41607f436e82e008', null::text),
    ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_refresh_administrative_page_evidence', '2a613a5ed1ad88342b3a71e2e58bde4a', null::text),
    ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_refresh_voice_page_evidence', '81091487b690d06d3b709e062c8de14d', null::text),
    ('trigger', 'private', 'presg_demo_runs', 'dues_sample_remove_presg_subjects', 'cbed189551703758d389f851bf65c579', null::text),
    ('trigger', 'private', 'presg_demo_runs', 'presg_demo_archive_organization_on_remove', 'ecbbb878f5251a570c5049d681009cae', null::text),
    ('trigger', 'private', 'uniondemo_runs', 'dues_sample_remove_uniondemo_subjects', 'b5391c987d70f605d1ca1ac5d19b238f', null::text),
    ('trigger', 'private', 'uniondemo_runs', 'uniondemo_archive_organization_on_remove', '65bc8d15b8202a9834fd4a4a8179d2b1', null::text)
  ), installed as materialized (select * from private.account_lifecycle_trigger_surface())
  select changes.*, r.definition_hash reviewed_hash, i.definition_hash installed_hash
    from changes left join private.account_lifecycle_trigger_review r
      using (kind,schema_name,table_name,object_name)
    left join installed i using (kind,schema_name,table_name,object_name)
  loop
    reviewed_hash := entry.reviewed_hash;
    installed_hash := entry.installed_hash;
    if entry.after_hash is null then
      if installed_hash is not null or
        (reviewed_hash is not null and reviewed_hash <> entry.before_hash) then
        raise exception 'retired lifecycle review changed: %', entry.object_name;
      end if;
      delete from private.account_lifecycle_trigger_review r
        where (r.kind,r.schema_name,r.table_name,r.object_name,r.definition_hash) =
          (entry.kind,entry.schema_name,entry.table_name,entry.object_name,entry.before_hash);
    else
      if installed_hash is distinct from entry.after_hash or reviewed_hash is null
        or reviewed_hash not in (entry.before_hash,entry.after_hash) then
        raise exception 'retained lifecycle review changed: %', entry.object_name;
      end if;
      update private.account_lifecycle_trigger_review r set definition_hash=entry.after_hash
        where (r.kind,r.schema_name,r.table_name,r.object_name,r.definition_hash) =
          (entry.kind,entry.schema_name,entry.table_name,entry.object_name,entry.before_hash);
    end if;
  end loop;
  if exists(select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'unrelated lifecycle review drift during seed retirement';
  end if;
end;
$retired_lifecycle_review$;

commit;
