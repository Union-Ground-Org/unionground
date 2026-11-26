-- CR-089 SAMPLE evidence: privacy-safe Twilio operation history only.
-- This evidence seed follows the organization-scoped provider schema migrations.
-- The SAMPLE lanes remain egress-disabled and keep Twilio unset. These rows
-- contain no phone number, message text, credential, provider SID, or token.

begin;

update private.demo_seed_function_catalog
set coverage = 'seeded', evidence_key = 'twilio-operation-history', gate_relation = null
where function_id = 'CR-089';

update private.demo_seed_function_evidence
set status = 'seeded', evidence_key = 'twilio-operation-history'
where function_id = 'CR-089';

create or replace function private.demo_seed_twilio_operation_history(p_lane text, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  ordinal integer;
  operation_kind text;
  operation_status text;
  delivery_status text;
  live_system_identifier numeric;
  live_database_oid oid;
begin
    select control.system_identifier::numeric into live_system_identifier from pg_catalog.pg_control_system() control;
    select database.oid into live_database_oid from pg_catalog.pg_database database where database.datname = pg_catalog.current_database();
    if not exists (
      select 1 from private.demo_seed_installation_bindings binding
      where binding.project_ref = 'sampledemoprojectref'
        and binding.system_identifier = live_system_identifier
        and binding.database_oid = live_database_oid
    ) then return; end if;
    if p_lane not in ('presg', 'uniondemo') then return; end if;
    org := private.member_stress_uuid(p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end);
    chapter := private.demo_seed_chapter(p_lane, p_run_id, 1);
    if not exists (select 1 from public.organizations row where row.id = org)
       or not exists (select 1 from public.chapters row where row.id = chapter and row.organization_id = org) then
      return;
    end if;

    for ordinal in 1..200 loop
      operation_kind := (array['sms_send','sms_status','sms_consent'])[1 + ((ordinal - 1) % 3)];
      operation_status := case when ordinal % 13 = 0 then 'failed' else 'success' end;
      delivery_status := case operation_kind
        when 'sms_consent' then case when ordinal % 2 = 0 then 'opt_in' else 'opt_out' end
        when 'sms_status' then (array['sent','delivered','read','undelivered'])[1 + ((ordinal - 1) % 4)]
        else (array['queued','sent','delivered','failed'])[1 + ((ordinal - 1) % 4)]
      end;
      insert into public.integration_jobs (
        id, organization_id, chapter_id, provider, job_kind, status,
        idempotency_key, attempt_count, processed_count, request_digest,
        provider_reference_digest, provider_status, operation_purpose,
        error_code, created_at, updated_at
      ) values (
        private.member_stress_uuid(p_run_id::text || ':twilio-operation:' || ordinal),
        org, chapter, 'twilio', operation_kind, operation_status,
        'sample-twilio-operation:' || p_run_id::text || ':' || ordinal,
        1, case when operation_status = 'success' then 1 else 0 end,
        pg_catalog.encode(extensions.digest(p_run_id::text || ':twilio-request:' || ordinal, 'sha256'), 'hex'),
        pg_catalog.encode(extensions.digest(p_run_id::text || ':twilio-reference:' || ordinal, 'sha256'), 'hex'),
        delivery_status,
        case when operation_kind = 'sms_send' then (array['urgent_alert','policy_notice','onboarding','dues_notice'])[1 + ((ordinal - 1) % 4)] end,
        case when operation_status = 'failed' then 'provider_rejected' end,
        pg_catalog.now() - (ordinal || ' hours')::interval,
        pg_catalog.now() - (ordinal || ' hours')::interval
      ) on conflict (id) do update set
        status = excluded.status, processed_count = excluded.processed_count,
        provider_status = excluded.provider_status, error_code = excluded.error_code,
        updated_at = excluded.updated_at;
    end loop;
  return;
end;
$function$;

create or replace function private.demo_seed_twilio_operation_history_from_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
begin
  for seeded_run in
    select distinct evidence.lane, evidence.run_id
    from inserted_twilio_evidence evidence
    where evidence.function_id = 'CR-089' and evidence.status = 'seeded'
  loop
    perform private.demo_seed_twilio_operation_history(seeded_run.lane, seeded_run.run_id);
  end loop;
  return null;
end;
$function$;

drop trigger if exists demo_seed_twilio_operation_history on private.demo_seed_function_evidence;
create trigger demo_seed_twilio_operation_history
after insert on private.demo_seed_function_evidence
referencing new table as inserted_twilio_evidence
for each statement execute function private.demo_seed_twilio_operation_history_from_evidence();

do $function$
declare seeded_run record;
begin
  for seeded_run in
    select distinct evidence.lane, evidence.run_id
    from private.demo_seed_function_evidence evidence
    where evidence.function_id = 'CR-089' and evidence.status = 'seeded'
  loop
    perform private.demo_seed_twilio_operation_history(seeded_run.lane, seeded_run.run_id);
  end loop;
end;
$function$;

revoke all on function private.demo_seed_twilio_operation_history(text,uuid) from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_twilio_operation_history_from_evidence() from public, anon, authenticated, service_role;

commit;
