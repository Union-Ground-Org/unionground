-- CR-089: multi-tenant Twilio operations over the existing integration spine.
-- This schema follows the provider migrations already present on Main.
-- Provider secrets remain in deployment secret custody; Postgres retains only
-- digests, bounded status codes, consent state, and organization-scoped jobs.

begin;

alter table public.integration_jobs
  drop constraint if exists integration_jobs_job_kind_check;
alter table public.integration_jobs
  add constraint integration_jobs_job_kind_check check (job_kind in (
    'provider_health', 'connection_probe', 'webhook_deliver', 'webhook_retry',
    'sms_send', 'sms_status', 'sms_consent'
  ));

alter table public.integration_jobs
  add column if not exists request_digest text,
  add column if not exists provider_reference_digest text,
  add column if not exists provider_status text,
  add column if not exists target_user_id uuid references auth.users(id) on delete set null,
  add column if not exists operation_purpose text;

alter table private.member_sms_preferences
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
update private.member_sms_preferences preference
set organization_id = chapter.organization_id
from public.member_profiles profile
join public.chapters chapter on chapter.id = profile.chapter_id
where profile.id = preference.user_id and preference.organization_id is null;
alter table private.member_sms_preferences
  alter column organization_id set not null,
  drop constraint if exists member_sms_preferences_pkey,
  add constraint member_sms_preferences_pkey primary key (organization_id, user_id);

alter table public.integration_jobs
  drop constraint if exists integration_jobs_request_digest_check,
  add constraint integration_jobs_request_digest_check check (
    request_digest is null or request_digest ~ '^[a-f0-9]{64}$'
  ),
  drop constraint if exists integration_jobs_provider_reference_digest_check,
  add constraint integration_jobs_provider_reference_digest_check check (
    provider_reference_digest is null or provider_reference_digest ~ '^[a-f0-9]{64}$'
  ),
  drop constraint if exists integration_jobs_provider_status_check,
  add constraint integration_jobs_provider_status_check check (
    provider_status is null or provider_status in (
      'queued', 'accepted', 'scheduled', 'sending', 'sent', 'delivered',
      'undelivered', 'failed', 'canceled', 'read', 'suppressed',
      'opt_in', 'opt_out', 'help', 'unknown'
    )
  ),
  drop constraint if exists integration_jobs_operation_purpose_check,
  add constraint integration_jobs_operation_purpose_check check (
    operation_purpose is null or operation_purpose in (
      'urgent_alert', 'policy_notice', 'onboarding', 'dues_notice'
    )
  );

create index if not exists integration_jobs_twilio_reference
  on public.integration_jobs (organization_id, provider_reference_digest)
  where provider = 'twilio' and provider_reference_digest is not null;

create table private.twilio_sms_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.integration_jobs(id) on delete cascade,
  organization_id uuid not null,
  target_user_id uuid not null,
  attempted_at timestamptz not null default pg_catalog.now()
);

create index twilio_sms_attempts_recipient_rate
  on private.twilio_sms_attempts (organization_id, target_user_id, attempted_at);

create index twilio_sms_attempts_organization_rate
  on private.twilio_sms_attempts (organization_id, attempted_at);

revoke all on table private.twilio_sms_attempts from public, anon, authenticated, service_role;

create or replace function private.mi1_twilio_send_context(p_organization_id uuid, p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  integration public.organization_integrations%rowtype;
  chapter_override public.chapter_integration_overrides%rowtype;
  target_phone text;
  target_chapter text;
  account_sid text;
  from_number text;
begin
  select pref.phone_e164, profile.chapter_id into target_phone, target_chapter
  from private.member_sms_preferences pref
  join public.member_profiles profile on profile.id = pref.user_id
  join public.chapters chapter on chapter.id = profile.chapter_id
  join public.organization_memberships organization_membership
    on organization_membership.organization_id = chapter.organization_id
   and organization_membership.user_id = pref.user_id
   and organization_membership.status = 'active'
  join public.member_chapter_memberships chapter_membership
    on chapter_membership.user_id = pref.user_id
   and chapter_membership.chapter_id = profile.chapter_id
   and chapter_membership.status = 'active'
  where pref.user_id = p_member_id and chapter.organization_id = p_organization_id
    and pref.organization_id = p_organization_id
    and pref.consented and pref.revoked_at is null;
  if target_phone is null then
    raise exception 'sms consent unavailable' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.chapter_connection_readiness readiness
    where readiness.chapter_id = target_chapter and readiness.capability = 'sms'
      and readiness.status = 'active'
  ) then
    raise exception 'sms readiness unavailable' using errcode = '42501';
  end if;

  select * into integration
  from public.organization_integrations row
  where row.organization_id = p_organization_id and row.provider = 'twilio';
  account_sid := integration.default_settings ->> 'accountSid';
  from_number := integration.default_settings ->> 'fromNumber';
  if integration.id is null or integration.status <> 'connected'
     or integration.credential_ref is null
     or account_sid !~ '^AC[0-9A-Fa-f]{32}$'
     or from_number !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'twilio activation incomplete' using errcode = '55000';
  end if;

  if integration.allow_chapter_overrides then
    select * into chapter_override
    from public.chapter_integration_overrides row
    where row.organization_integration_id = integration.id and row.chapter_id = target_chapter;
    if chapter_override.id is not null and chapter_override.status = 'disabled' then
      raise exception 'twilio disabled for chapter' using errcode = '42501';
    end if;
    if chapter_override.id is not null and chapter_override.status = 'enabled'
       and chapter_override.override_settings ? 'fromNumber' then
      from_number := chapter_override.override_settings ->> 'fromNumber';
    end if;
  end if;
  if from_number !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'twilio chapter activation incomplete' using errcode = '55000';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id, 'chapterId', target_chapter,
    'accountSid', account_sid, 'fromNumber', from_number, 'toPhone', target_phone
  );
end;
$function$;

create or replace function public.prepare_twilio_sms_send(
  p_member_id uuid,
  p_purpose text,
  p_body_digest text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  send_context jsonb;
  existing public.integration_jobs%rowtype;
  created public.integration_jobs%rowtype;
  stable_key text := 'sms-send:' || p_idempotency_key::text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_purpose is null or p_purpose not in ('urgent_alert', 'policy_notice', 'onboarding', 'dues_notice')
     or p_body_digest is null or p_body_digest !~ '^[a-f0-9]{64}$' or p_idempotency_key is null then
    raise exception 'invalid sms request' using errcode = '22023';
  end if;
  send_context := private.mi1_twilio_send_context(org, p_member_id);

  select job.* into existing
  from public.integration_jobs job
  where job.organization_id = org and job.idempotency_key = stable_key
  for update;
  if existing.id is not null then
    if existing.request_digest is distinct from p_body_digest
       or existing.target_user_id is distinct from p_member_id
       or existing.operation_purpose is distinct from p_purpose then
      raise exception 'idempotency payload mismatch' using errcode = '22023';
    end if;
    if existing.status = 'failed'
       and existing.error_code in ('provider_rejected', 'invalid_send', 'registry_context_changed') then
      update public.integration_jobs
      set status = 'queued', provider_reference_digest = null, provider_status = null,
          error_code = null, updated_at = pg_catalog.now()
      where id = existing.id
      returning * into existing;
    else
      return pg_catalog.jsonb_build_object(
        'jobId', existing.id,
        'organizationId', org,
        'accountSid', send_context ->> 'accountSid',
        'fromNumber', send_context ->> 'fromNumber',
        'status', existing.status
      );
    end if;
  else
    insert into public.integration_jobs (
      organization_id, chapter_id, provider, job_kind, status, idempotency_key,
      request_digest, target_user_id, operation_purpose
    ) values (
      org, send_context ->> 'chapterId', 'twilio', 'sms_send', 'queued', stable_key,
      p_body_digest, p_member_id, p_purpose
    ) returning * into created;
    existing := created;
  end if;

  return pg_catalog.jsonb_build_object(
    'jobId', existing.id,
    'organizationId', org,
    'accountSid', send_context ->> 'accountSid',
    'fromNumber', send_context ->> 'fromNumber',
    'status', existing.status
  );
end;
$function$;

create or replace function public.claim_twilio_sms_send(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job_organization_id uuid;
  job_target_user_id uuid;
  job public.integration_jobs%rowtype;
  send_context jsonb;
  recent_recipient_hour integer;
  recent_organization_day integer;
  max_per_recipient_hour constant integer := 12;
  max_per_organization_day constant integer := 20000;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select candidate.organization_id, candidate.target_user_id
  into job_organization_id, job_target_user_id
  from public.integration_jobs candidate
  where candidate.id = p_job_id
    and candidate.provider = 'twilio'
    and candidate.job_kind = 'sms_send';
  if job_organization_id is null or job_target_user_id is null then
    return pg_catalog.jsonb_build_object('claimed', false);
  end if;

  -- Capacity is reserved at the provider-attempt transition, never at request
  -- preparation. An append-only attempt timestamp cannot be renewed by status
  -- callbacks or a stale queued replay. The organization lock is always first
  -- so different-recipient claims cannot race the organization-wide cap.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('twilio_sms_rate_org:' || job_organization_id::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'twilio_sms_rate_member:' || job_organization_id::text || ':' || job_target_user_id::text,
      509
    ));

  select * into job from public.integration_jobs
  where id = p_job_id and provider = 'twilio' and job_kind = 'sms_send'
  for update;
  if job.id is null or job.status <> 'queued' then
    return pg_catalog.jsonb_build_object('claimed', false);
  end if;
  send_context := private.mi1_twilio_send_context(job.organization_id, job.target_user_id);
  if send_context ->> 'chapterId' is distinct from job.chapter_id then
    raise exception 'sms chapter changed' using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer into recent_recipient_hour
  from private.twilio_sms_attempts attempt
  where attempt.organization_id = job.organization_id
    and attempt.target_user_id = job.target_user_id
    and attempt.attempted_at > pg_catalog.now() - interval '1 hour';

  select pg_catalog.count(*)::integer into recent_organization_day
  from private.twilio_sms_attempts attempt
  where attempt.organization_id = job.organization_id
    and attempt.attempted_at > pg_catalog.now() - interval '24 hours';

  if recent_recipient_hour >= max_per_recipient_hour then
    return pg_catalog.jsonb_build_object(
      'claimed', false, 'reason', 'rate_limited',
      'scope', 'recipient_hour', 'retryAfterSeconds', 3600
    );
  end if;
  if recent_organization_day >= max_per_organization_day then
    return pg_catalog.jsonb_build_object(
      'claimed', false, 'reason', 'rate_limited',
      'scope', 'organization_day', 'retryAfterSeconds', 86400
    );
  end if;

  insert into private.twilio_sms_attempts (
    job_id, organization_id, target_user_id
  ) values (
    job.id, job.organization_id, job.target_user_id
  );

  update public.integration_jobs
  set status = 'running', attempt_count = attempt_count + 1, updated_at = pg_catalog.now()
  where id = p_job_id and provider = 'twilio' and job_kind = 'sms_send' and status = 'queued';
  if not found then return pg_catalog.jsonb_build_object('claimed', false); end if;
  return send_context || pg_catalog.jsonb_build_object('claimed', true);
end;
$function$;

create or replace function public.record_twilio_sms_send_result(
  p_job_id uuid,
  p_success boolean,
  p_provider_reference_digest text,
  p_provider_status text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job public.integration_jobs%rowtype;
  callback_status text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if coalesce(p_success, false) and (
    p_provider_reference_digest !~ '^[a-f0-9]{64}$'
    or p_provider_status not in ('queued','accepted','scheduled','sending','sent','delivered','undelivered','failed','canceled','read')
  ) then
    raise exception 'invalid provider result' using errcode = '22023';
  end if;
  select * into job from public.integration_jobs
  where id = p_job_id and provider = 'twilio' and job_kind = 'sms_send'
  for update;
  if job.id is null then return false; end if;
  if job.status <> 'running' then
    return case when coalesce(p_success, false) then
      job.status = 'success'
      and job.provider_reference_digest = p_provider_reference_digest
      and job.provider_status = p_provider_status
    else
      job.status = 'failed'
      and job.error_code = pg_catalog.left(coalesce(p_error_code, 'provider_failed'), 80)
    end;
  end if;
  if p_success then
    select event.provider_status into callback_status
    from public.integration_jobs event
    where event.organization_id = job.organization_id and event.provider = 'twilio'
      and event.job_kind = 'sms_status'
      and event.provider_reference_digest = p_provider_reference_digest
    order by private.mi1_twilio_status_rank(event.provider_status) desc, event.updated_at desc
    limit 1;
  end if;
  update public.integration_jobs
  set status = case when coalesce(p_success, false) then 'success' else 'failed' end,
      processed_count = case when coalesce(p_success, false) then 1 else 0 end,
      provider_reference_digest = case when p_success then p_provider_reference_digest else null end,
      provider_status = case when p_success then coalesce(callback_status, p_provider_status) else null end,
      error_code = case when p_success then null else pg_catalog.left(coalesce(p_error_code, 'provider_failed'), 80) end,
      updated_at = pg_catalog.now()
  where id = job.id;
  update public.organization_integrations
  set last_job_status = case when p_success then 'success' else 'failed' end,
      last_error_code = case when p_success then null else pg_catalog.left(coalesce(p_error_code, 'provider_failed'), 80) end,
      updated_at = pg_catalog.now()
  where organization_id = job.organization_id and provider = 'twilio';
  return true;
end;
$function$;

create or replace function private.mi1_twilio_status_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $function$
  select case p_status
    when 'queued' then 10 when 'accepted' then 20 when 'scheduled' then 30
    when 'sending' then 40 when 'sent' then 50 when 'delivered' then 80
    when 'undelivered' then 80 when 'failed' then 80 when 'canceled' then 80
    when 'read' then 90 else 0 end
$function$;

create or replace function public.record_twilio_status_callback(
  p_organization_id uuid,
  p_provider_reference_digest text,
  p_provider_status text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected integer := 0;
  event_id uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider_reference_digest !~ '^[a-f0-9]{64}$'
     or p_provider_status not in ('queued','accepted','scheduled','sending','sent','delivered','undelivered','failed','canceled','read') then
    raise exception 'invalid status callback' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_integrations integration
    where integration.organization_id = p_organization_id and integration.provider = 'twilio'
  ) then
    raise exception 'integration unavailable' using errcode = 'P0002';
  end if;
  insert into public.integration_jobs (
    organization_id, provider, job_kind, status, idempotency_key, processed_count,
    provider_reference_digest, provider_status, error_code
  ) values (
    p_organization_id, 'twilio', 'sms_status', 'success',
    'sms-status:' || p_provider_reference_digest || ':' || p_provider_status,
    affected, p_provider_reference_digest, p_provider_status,
    nullif(pg_catalog.left(coalesce(p_error_code, ''), 80), '')
  ) on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into event_id;
  if event_id is null then return true; end if;
  update public.integration_jobs job
  set provider_status = p_provider_status,
      error_code = nullif(pg_catalog.left(coalesce(p_error_code, ''), 80), ''),
      updated_at = pg_catalog.now()
  where job.organization_id = p_organization_id and job.provider = 'twilio'
    and job.job_kind = 'sms_send' and job.provider_reference_digest = p_provider_reference_digest
    and (
      job.provider_status = p_provider_status
      or (
        private.mi1_twilio_status_rank(p_provider_status) > private.mi1_twilio_status_rank(job.provider_status)
        and (job.provider_status not in ('delivered','read','undelivered','failed','canceled')
          or (job.provider_status = 'delivered' and p_provider_status = 'read'))
      )
    );
  get diagnostics affected = row_count;
  update public.integration_jobs set processed_count = affected where id = event_id;
  return true;
end;
$function$;

create or replace function public.record_twilio_inbound_consent(
  p_organization_id uuid,
  p_provider_reference_digest text,
  p_from_e164 text,
  p_from_phone_digest text,
  p_event_type text,
  p_keyword text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected integer := 0;
  event_id uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider_reference_digest !~ '^[a-f0-9]{64}$'
     or p_from_phone_digest !~ '^[a-f0-9]{64}$'
     or p_from_e164 !~ '^\+[1-9][0-9]{7,14}$'
     or p_event_type not in ('opt_in','opt_out','help','unknown')
     or pg_catalog.char_length(coalesce(p_keyword, '')) > 24 then
    raise exception 'invalid inbound callback' using errcode = '22023';
  end if;
  insert into public.integration_jobs (
    organization_id, provider, job_kind, status, idempotency_key, processed_count,
    request_digest, provider_reference_digest, provider_status
  ) values (
    p_organization_id, 'twilio', 'sms_consent', 'running',
    'sms-consent:' || p_provider_reference_digest, 0,
    p_from_phone_digest, p_provider_reference_digest, p_event_type
  ) on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into event_id;
  if event_id is null then return true; end if;

  if not exists (
    select 1 from public.organization_integrations integration
    where integration.organization_id = p_organization_id and integration.provider = 'twilio'
  ) then
    raise exception 'integration unavailable' using errcode = 'P0002';
  end if;

  if p_event_type = 'opt_out' then
    update private.member_sms_preferences preference
    set consented = false, consented_at = null, revoked_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
    from public.member_profiles profile
    join public.chapters chapter on chapter.id = profile.chapter_id
    where preference.user_id = profile.id and preference.phone_e164 = p_from_e164
      and preference.organization_id = p_organization_id
      and chapter.organization_id = p_organization_id;
    get diagnostics affected = row_count;
  elsif p_event_type = 'opt_in' then
    -- Twilio's ordinary inbound webhook has no authenticated event timestamp or
    -- ordering cursor. A delayed first delivery of an older START can therefore
    -- arrive after a newer STOP. Keep callback STOP sticky and require the
    -- member's authenticated set_my_sms_consent action to restore eligibility.
    update public.integration_jobs
    set provider_status = 'suppressed',
        error_code = 'authenticated_reconsent_required',
        updated_at = pg_catalog.now()
    where id = event_id;
  end if;
  update public.integration_jobs set status = 'success', processed_count = affected,
    updated_at = pg_catalog.now() where id = event_id;
  return true;
end;
$function$;

create or replace function public.get_my_sms_preference()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'activationStatus', coalesce((select c.status from public.chapter_connection_readiness c where c.chapter_id = private.current_member_chapter() and c.capability = 'sms'), 'unset'),
    'publicMessage', coalesce((select c.public_message from public.chapter_connection_readiness c where c.chapter_id = private.current_member_chapter() and c.capability = 'sms'), 'SMS is not configured for this chapter.'),
    'consented', coalesce(p.consented, false),
    'phoneLast4', case when p.phone_e164 is null then null else pg_catalog.right(p.phone_e164, 4) end,
    'updatedAt', p.updated_at
  )
  from (select 1 where private.mfa_satisfied()) one
  left join private.member_sms_preferences p
    on p.user_id = (select auth.uid())
   and p.organization_id = private.current_member_organization()
$function$;

create or replace function public.set_my_sms_consent(p_phone_e164 text, p_consented boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
begin
  if caller is null or org is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  if coalesce(p_consented, false) and not exists (select 1 from public.chapter_connection_readiness c where c.chapter_id = chapter and c.capability = 'sms' and c.status = 'active') then raise exception 'sms is not active for this chapter' using errcode = '22023'; end if;
  if coalesce(p_consented, false) and (p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$') then raise exception 'valid E.164 phone required' using errcode = '22023'; end if;
  if not coalesce(p_consented, false) and p_phone_e164 is null
     and not exists (select 1 from private.member_sms_preferences p where p.organization_id = org and p.user_id = caller) then return public.get_my_sms_preference(); end if;
  insert into private.member_sms_preferences (organization_id, user_id, phone_e164, consented, consented_at, revoked_at)
  values (org, caller, coalesce(p_phone_e164, (select existing.phone_e164 from private.member_sms_preferences existing where existing.organization_id = org and existing.user_id = caller)), coalesce(p_consented,false),
    case when p_consented then pg_catalog.clock_timestamp() else null end,
    case when p_consented then null else pg_catalog.clock_timestamp() end)
  on conflict (organization_id, user_id) do update set phone_e164 = excluded.phone_e164, consented = excluded.consented,
    consented_at = excluded.consented_at, revoked_at = excluded.revoked_at, updated_at = pg_catalog.clock_timestamp();
  return public.get_my_sms_preference();
end;
$function$;

create or replace function public.search_twilio_sms_recipients(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if pg_catalog.char_length(needle) < 2 then raise exception 'query too short' using errcode = '22023'; end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');
  return coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', candidate.id, 'fullName', candidate.full_name,
      'chapterId', candidate.chapter_id, 'phoneLast4', pg_catalog.right(candidate.phone_e164, 4)
    ) order by candidate.full_name, candidate.id)
    from (select profile.id, profile.full_name, profile.chapter_id, preference.phone_e164
      from public.member_profiles profile
      join public.chapters chapter on chapter.id = profile.chapter_id and chapter.organization_id = org
      join public.organization_memberships organization_membership on organization_membership.organization_id = org and organization_membership.user_id = profile.id and organization_membership.status = 'active'
      join public.member_chapter_memberships chapter_membership on chapter_membership.user_id = profile.id and chapter_membership.chapter_id = profile.chapter_id and chapter_membership.status = 'active'
      join private.member_sms_preferences preference on preference.organization_id = org and preference.user_id = profile.id and preference.consented and preference.revoked_at is null
      where profile.full_name ilike '%' || needle || '%' escape '\'
      order by profile.full_name, profile.id limit 20) candidate
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.list_integration_jobs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', job.id, 'organizationId', job.organization_id, 'chapterId', job.chapter_id,
      'provider', job.provider, 'jobKind', job.job_kind, 'status', job.status,
      'attemptCount', job.attempt_count, 'processedCount', job.processed_count,
      'errorCode', job.error_code, 'providerStatus', job.provider_status,
      'createdAt', job.created_at, 'updatedAt', job.updated_at
    ) order by job.created_at desc, job.id desc)
    from (
      select candidate.* from public.integration_jobs candidate
      where candidate.organization_id = org
      order by candidate.created_at desc, candidate.id desc limit 100
    ) job
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.list_integration_job_page(
  p_limit integer default 100,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  page_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  page_items jsonb;
  next_created_at timestamptz;
  next_id uuid;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'incomplete job cursor' using errcode = '22023';
  end if;

  with candidates as (
    select job.*
    from public.integration_jobs job
    where job.organization_id = org
      and (p_before_created_at is null or (job.created_at, job.id) < (p_before_created_at, p_before_id))
    order by job.created_at desc, job.id desc
    limit page_limit + 1
  ), page as (
    select * from candidates order by created_at desc, id desc limit page_limit
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', job.id, 'organizationId', job.organization_id, 'chapterId', job.chapter_id,
      'provider', job.provider, 'jobKind', job.job_kind, 'status', job.status,
      'attemptCount', job.attempt_count, 'processedCount', job.processed_count,
      'errorCode', job.error_code, 'providerStatus', job.provider_status,
      'createdAt', job.created_at, 'updatedAt', job.updated_at
    ) order by job.created_at desc, job.id desc), '[]'::jsonb)
  into page_items from page job;

  if pg_catalog.jsonb_array_length(page_items) = page_limit and exists (
    select 1 from public.integration_jobs job
    where job.organization_id = org
      and (p_before_created_at is null or (job.created_at, job.id) < (p_before_created_at, p_before_id))
    order by job.created_at desc, job.id desc
    offset page_limit limit 1
  ) then
    select job.created_at, job.id into next_created_at, next_id
    from public.integration_jobs job
    where job.organization_id = org
      and (p_before_created_at is null or (job.created_at, job.id) < (p_before_created_at, p_before_id))
    order by job.created_at desc, job.id desc offset page_limit - 1 limit 1;
  end if;

  return pg_catalog.jsonb_build_object(
    'items', page_items,
    'nextBeforeCreatedAt', next_created_at,
    'nextBeforeId', next_id
  );
end;
$function$;

revoke all on function public.prepare_twilio_sms_send(uuid,text,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.prepare_twilio_sms_send(uuid,text,text,uuid) to authenticated;
revoke all on function private.mi1_twilio_send_context(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function private.mi1_twilio_status_rank(text) from public, anon, authenticated, service_role;
revoke all on function public.list_integration_job_page(integer,timestamptz,uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_integration_job_page(integer,timestamptz,uuid) to authenticated;
revoke all on function public.search_twilio_sms_recipients(text) from public, anon, authenticated, service_role;
grant execute on function public.search_twilio_sms_recipients(text) to authenticated;
revoke all on function public.claim_twilio_sms_send(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_twilio_sms_send(uuid) to service_role;
revoke all on function public.record_twilio_sms_send_result(uuid,boolean,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.record_twilio_sms_send_result(uuid,boolean,text,text,text) to service_role;
revoke all on function public.record_twilio_status_callback(uuid,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.record_twilio_status_callback(uuid,text,text,text) to service_role;
revoke all on function public.record_twilio_inbound_consent(uuid,text,text,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.record_twilio_inbound_consent(uuid,text,text,text,text,text) to service_role;

notify pgrst, 'reload schema';
commit;
