-- Exact-head review repairs for the MI1 organization integration controls.
-- This migration is append-only because 20260822020000 is already on Main.

set local lock_timeout = '5s';

alter table public.integration_webhooks
  add column if not exists secret_ref uuid;

comment on column public.integration_webhooks.secret_ref is
  'Supabase Vault secret id for outbound HMAC signing. Never exposed to authenticated clients.';

alter table public.integration_webhook_deliveries
  add column if not exists next_attempt_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists lease_expires_at timestamptz;

create table if not exists private.integration_webhook_dispatch_controls (
  id boolean primary key default true check (id),
  dispatch_url text check (dispatch_url is null or dispatch_url ~ '^https://[[:graph:]]+$')
);

insert into private.integration_webhook_dispatch_controls (id, dispatch_url)
values (true, null)
on conflict (id) do nothing;

revoke all on private.integration_webhook_dispatch_controls from public, anon, authenticated, service_role;

alter table public.integration_webhook_deliveries
  drop constraint if exists integration_webhook_deliveries_status_check;
alter table public.integration_webhook_deliveries
  add constraint integration_webhook_deliveries_status_check
  check (status in ('queued', 'sending', 'ok', 'failed', 'skipped', 'blocked', 'dead'));

alter table public.integration_webhook_deliveries
  drop constraint if exists integration_webhook_deliverie_organization_id_idempotency_k_key;
create unique index if not exists integration_webhook_deliveries_endpoint_idempotency_key
  on public.integration_webhook_deliveries (organization_id, webhook_id, idempotency_key);

create or replace function public.list_integration_webhooks()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', w.id,
      'organizationId', w.organization_id,
      'url', w.url,
      'events', w.events,
      'active', w.active,
      'secretPresent', w.secret_ref is not null,
      'lastDeliveryAt', w.last_delivery_at,
      'lastDeliveryStatus', w.last_delivery_status
    ) order by w.created_at desc)
    from (
      select source.*
      from public.integration_webhooks source
      where source.organization_id = org
      order by source.created_at desc
      limit 100
    ) w
  ), '[]'::jsonb);
end;
$function$;

drop function if exists public.create_integration_webhook(text, text[], text);
create function public.create_integration_webhook(
  p_url text,
  p_events text[],
  p_secret_hash text,
  p_secret_plaintext text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  host text;
  webhook_id uuid := extensions.gen_random_uuid();
  secret_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_url is null or p_url !~* '^https://'
     or p_url ~* '^https://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|169\.254\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})([:/]|$)' then
    raise exception 'invalid webhook url' using errcode = '22023';
  end if;
  if p_secret_plaintext is null or p_secret_plaintext !~ '^whsec_[0-9a-f]{48}$'
     or p_secret_hash <> pg_catalog.encode(
       extensions.digest(pg_catalog.convert_to(p_secret_plaintext, 'UTF8'), 'sha256'),
       'hex'
     ) then
    raise exception 'invalid webhook secret' using errcode = '22023';
  end if;
  if p_events is null or pg_catalog.cardinality(p_events) = 0 then
    raise exception 'events required' using errcode = '22023';
  end if;
  host := (pg_catalog.regexp_match(p_url, '^https://([^/]+)'))[1];
  secret_id := vault.create_secret(
    p_secret_plaintext,
    'mi1-webhook-' || webhook_id::text,
    'Organization webhook signing secret'
  );
  insert into public.integration_webhooks (
    id, organization_id, url, events, secret_hash, secret_ref
  ) values (
    webhook_id, org, p_url, p_events, p_secret_hash, secret_id
  );
  insert into public.organization_integrations (organization_id, provider, status)
  values (org, 'customer_webhooks', 'configured')
  on conflict (organization_id, provider) do update
    set status = 'configured', updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'host', host, 'events', p_events, 'status', 'created'
  ));
  return public.list_integration_webhooks();
end;
$function$;

create or replace function public.delete_integration_webhook(p_webhook_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  secret_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  delete from public.integration_webhooks
  where id = p_webhook_id and organization_id = org
  returning secret_ref into secret_id;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if secret_id is not null then
    delete from vault.secrets where id = secret_id;
  end if;
  if not exists (select 1 from public.integration_webhooks w where w.organization_id = org) then
    update public.organization_integrations
    set status = 'unset', updated_at = pg_catalog.now()
    where organization_id = org and provider = 'customer_webhooks';
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', 'deleted'
  ));
  return public.list_integration_webhooks();
end;
$function$;

create or replace function public.list_integration_jobs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', j.id,
      'organizationId', j.organization_id,
      'chapterId', j.chapter_id,
      'provider', j.provider,
      'jobKind', j.job_kind,
      'status', j.status,
      'attemptCount', j.attempt_count,
      'processedCount', j.processed_count,
      'errorCode', j.error_code,
      'createdAt', j.created_at,
      'updatedAt', j.updated_at
    ) order by j.created_at desc, j.id desc)
    from (
      select source.*
      from public.integration_jobs source
      where source.organization_id = org
      order by source.created_at desc, source.id desc
      limit 100
    ) j
  ), '[]'::jsonb);
end;
$function$;

create function public.enqueue_integration_job(
  p_provider text,
  p_job_kind text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  integration_id uuid;
  next_key text := coalesce(nullif(pg_catalog.btrim(p_idempotency_key), ''), 'manual:' || extensions.gen_random_uuid()::text);
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_job_kind not in ('provider_health', 'connection_probe') then
    raise exception 'invalid job kind' using errcode = '22023';
  end if;
  if pg_catalog.char_length(next_key) > 160 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  select i.id into integration_id
  from public.organization_integrations i
  where i.organization_id = org and i.provider = p_provider and i.provider <> 'scim';
  if integration_id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  insert into public.integration_jobs (
    organization_id, provider, job_kind, status, idempotency_key
  ) values (
    org, p_provider, p_job_kind, 'queued', next_key
  ) on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'status', 'job_queued'
  ));
  return public.list_integration_jobs();
end;
$function$;

create function public.run_next_integration_job()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  job public.integration_jobs%rowtype;
  integration_status text;
  next_status text;
  next_error text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select j.* into job
  from public.integration_jobs j
  where j.organization_id = org
    and j.status = 'queued'
    and j.job_kind in ('provider_health', 'connection_probe')
  order by j.created_at, j.id
  for update skip locked
  limit 1;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select i.status into integration_status
  from public.organization_integrations i
  where i.organization_id = org and i.provider = job.provider;
  next_status := case
    when integration_status in ('configured', 'connected') then 'success'
    when integration_status = 'degraded' then 'failed'
    else 'skipped'
  end;
  next_error := case
    when next_status = 'success' then null
    when next_status = 'failed' then 'provider_degraded'
    else 'activation_unset'
  end;
  update public.integration_jobs
  set status = next_status,
      attempt_count = attempt_count + 1,
      processed_count = case when next_status = 'success' then 1 else 0 end,
      error_code = next_error,
      updated_at = pg_catalog.now()
  where id = job.id and organization_id = org;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', job.provider, 'status', next_status
  ));
  return public.list_integration_jobs();
end;
$function$;

create function public.retry_integration_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  update public.integration_jobs
  set status = 'queued', error_code = null, updated_at = pg_catalog.now()
  where id = p_job_id
    and organization_id = org
    and status in ('failed', 'skipped')
    and attempt_count < 5
    and job_kind in ('provider_health', 'connection_probe');
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return public.list_integration_jobs();
end;
$function$;

create function public.list_integration_webhook_delivery_page(
  p_limit integer default 25,
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
  page_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'incomplete delivery cursor' using errcode = '22023';
  end if;
  with candidates as (
    select d.*
    from public.integration_webhook_deliveries d
    where d.organization_id = org
      and (
        p_before_created_at is null
        or (d.created_at, d.id) < (p_before_created_at, p_before_id)
      )
    order by d.created_at desc, d.id desc
    limit page_limit + 1
  ), numbered as (
    select c.*, pg_catalog.row_number() over (order by c.created_at desc, c.id desc) as row_number
    from candidates c
  ), items as (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', d.id,
      'webhookId', d.webhook_id,
      'eventName', d.event_name,
      'eventId', d.event_id,
      'status', d.status,
      'attemptCount', d.attempt_count,
      'errorCode', d.error_code,
      'destinationHost', d.destination_host,
      'nextAttemptAt', d.next_attempt_at,
      'deliveredAt', d.delivered_at,
      'createdAt', d.created_at
    ) order by d.created_at desc, d.id desc), '[]'::jsonb) as value
    from numbered d
    where d.row_number <= page_limit
  ), cursor_row as (
    select d.created_at, d.id
    from numbered d
    where d.row_number = page_limit
      and exists (select 1 from numbered extra where extra.row_number = page_limit + 1)
  )
  select pg_catalog.jsonb_build_object(
    'items', items.value,
    'nextBeforeCreatedAt', cursor_row.created_at,
    'nextBeforeId', cursor_row.id
  )
  into result
  from items
  left join cursor_row on true;
  return result;
end;
$function$;

create or replace function public.list_integration_webhook_deliveries()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  -- Keep the compatibility wrapper's MFA boundary explicit. The contract
  -- verifier intentionally does not infer guards through nested RPC calls.
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return public.list_integration_webhook_delivery_page(25, null, null)->'items';
end;
$function$;

create function public.enqueue_integration_webhook_test(
  p_webhook_id uuid,
  p_event_name text,
  p_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  hook public.integration_webhooks%rowtype;
  delivery_id uuid;
  replayed boolean := false;
  recent_test_count integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_event_id is null
     or pg_catalog.char_length(p_event_id) not between 6 and 120
     or p_event_id not like 'test:%' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  select * into hook
  from public.integration_webhooks w
  where w.id = p_webhook_id and w.organization_id = org
  for update;
  if not found or not hook.active or hook.secret_ref is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not (p_event_name = any(hook.events)) then
    raise exception 'event not subscribed' using errcode = '22023';
  end if;
  select d.id into delivery_id
  from public.integration_webhook_deliveries d
  where d.organization_id = org
    and d.webhook_id = hook.id
    and d.idempotency_key = p_event_id;
  if delivery_id is null then
    select pg_catalog.count(*) into recent_test_count
    from public.integration_webhook_deliveries d
    where d.organization_id = org
      and d.event_id like 'test:%'
      and d.created_at >= pg_catalog.now() - interval '1 hour';
    if recent_test_count >= 10 then
      raise exception 'webhook test rate limit exceeded' using errcode = 'P0001';
    end if;
    insert into public.integration_webhook_deliveries (
      organization_id, webhook_id, event_name, event_id, idempotency_key,
      status, attempt_count, destination_host
    ) values (
      org, hook.id, p_event_name, p_event_id, p_event_id, 'queued', 0,
      (pg_catalog.regexp_match(hook.url, '^https://([^/]+)'))[1]
    ) returning id into delivery_id;
    insert into public.integration_jobs (
      organization_id, provider, job_kind, status, idempotency_key
    ) values (
      org, 'customer_webhooks', 'webhook_deliver', 'queued', 'delivery:' || delivery_id::text
    ) on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;
  else
    replayed := true;
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', 'test_queued', 'eventType', p_event_name
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'deliveryId', delivery_id, 'replayed', replayed);
end;
$function$;

create function public.claim_integration_webhook_deliveries(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claimed jsonb;
begin
  with candidates as (
    select d.id
    from public.integration_webhook_deliveries d
    join public.integration_webhooks w
      on w.id = d.webhook_id and w.organization_id = d.organization_id
    join vault.decrypted_secrets secret on secret.id = w.secret_ref
    where w.active and w.secret_ref is not null
      and (
        d.status = 'queued'
        or (d.status = 'failed' and coalesce(d.next_attempt_at, '-infinity'::timestamptz) <= pg_catalog.now())
        or (d.status = 'sending' and d.lease_expires_at < pg_catalog.now())
      )
      and d.attempt_count < 5
    order by d.created_at
    for update of d skip locked
    limit least(greatest(coalesce(p_limit, 10), 1), 25)
  ), updated as (
    update public.integration_webhook_deliveries d
    set status = 'sending',
        attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '5 minutes',
        next_attempt_at = null
    from candidates c
    where d.id = c.id
    returning d.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', d.id,
    'attemptCount', d.attempt_count,
    'url', w.url,
    'eventName', d.event_name,
    'eventId', d.event_id,
    'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  ) order by d.created_at), '[]'::jsonb)
  into claimed
  from updated d
  join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;

  update public.integration_jobs j
  set status = 'running', updated_at = pg_catalog.now()
  where j.idempotency_key in (
    select 'delivery:' || (entry->>'deliveryId')
    from pg_catalog.jsonb_array_elements(claimed) entry
  );
  return claimed;
end;
$function$;

create function public.claim_integration_webhook_delivery(p_delivery_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claimed jsonb;
begin
  with candidate as (
    select d.id
    from public.integration_webhook_deliveries d
    join public.integration_webhooks w
      on w.id = d.webhook_id and w.organization_id = d.organization_id
    join vault.decrypted_secrets secret on secret.id = w.secret_ref
    where d.id = p_delivery_id
      and w.active and w.secret_ref is not null
      and (
        d.status = 'queued'
        or (d.status = 'failed' and coalesce(d.next_attempt_at, '-infinity'::timestamptz) <= pg_catalog.now())
        or (d.status = 'sending' and d.lease_expires_at < pg_catalog.now())
      )
      and d.attempt_count < 5
    for update of d skip locked
  ), updated as (
    update public.integration_webhook_deliveries d
    set status = 'sending',
        attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '5 minutes',
        next_attempt_at = null
    from candidate c
    where d.id = c.id
    returning d.*
  )
  select pg_catalog.jsonb_build_object(
    'deliveryId', d.id,
    'attemptCount', d.attempt_count,
    'url', w.url,
    'eventName', d.event_name,
    'eventId', d.event_id,
    'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  )
  into claimed
  from updated d
  join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;

  if claimed is not null then
    update public.integration_jobs
    set status = 'running', updated_at = pg_catalog.now()
    where idempotency_key = 'delivery:' || (claimed->>'deliveryId');
  end if;
  return claimed;
end;
$function$;

create function public.record_integration_webhook_delivery(
  p_delivery_id uuid,
  p_attempt_count integer,
  p_status text,
  p_error_code text,
  p_destination_host text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  row public.integration_webhook_deliveries%rowtype;
  terminal_status text;
begin
  if p_status not in ('ok', 'failed', 'blocked') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select * into row
  from public.integration_webhook_deliveries d
  where d.id = p_delivery_id and d.status = 'sending' and d.attempt_count = p_attempt_count
  for update;
  if not found then return false; end if;
  terminal_status := case
    when p_status = 'ok' then 'ok'
    when p_status = 'blocked' then 'blocked'
    when row.attempt_count >= 5 then 'dead'
    else 'failed'
  end;
  update public.integration_webhook_deliveries
  set status = terminal_status,
      error_code = case when terminal_status = 'ok' then null else pg_catalog.left(coalesce(p_error_code, 'delivery_failed'), 80) end,
      destination_host = pg_catalog.left(coalesce(p_destination_host, destination_host), 255),
      delivered_at = case when terminal_status = 'ok' then pg_catalog.now() else delivered_at end,
      next_attempt_at = case when terminal_status = 'failed' then
        pg_catalog.now() + least(
          interval '30 seconds',
          interval '1 second' * pg_catalog.power(2, row.attempt_count - 1)::double precision
        )
        else null end,
      lease_expires_at = null
  where id = row.id;
  update public.integration_webhooks
  set last_delivery_at = pg_catalog.now(), last_delivery_status = terminal_status
  where id = row.webhook_id and organization_id = row.organization_id;
  update public.integration_jobs
  set status = case when terminal_status = 'ok' then 'success' else 'failed' end,
      processed_count = 1,
      error_code = case when terminal_status = 'ok' then null else pg_catalog.left(coalesce(p_error_code, 'delivery_failed'), 80) end,
      updated_at = pg_catalog.now()
  where organization_id = row.organization_id
    and idempotency_key = 'delivery:' || row.id::text;
  return true;
end;
$function$;

create or replace function public.upsert_chapter_integration_override(
  p_provider text,
  p_chapter_id text,
  p_status text,
  p_override_settings jsonb,
  p_credential_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  integration_id uuid;
  overrides_enabled boolean;
  allowed_keys text[];
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select i.id, i.allow_chapter_overrides, i.allowed_chapter_override_keys
  into integration_id, overrides_enabled, allowed_keys
  from public.organization_integrations i
  where i.organization_id = org and i.provider = p_provider
  for update;
  if integration_id is null then raise exception 'not found' using errcode = 'P0002'; end if;
  if not overrides_enabled then raise exception 'chapter overrides disabled' using errcode = '42501'; end if;
  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(coalesce(p_override_settings, '{}'::jsonb)) as requested(key)
    where not (requested.key = any(coalesce(allowed_keys, '{}'::text[])))
  ) then
    raise exception 'chapter override key is not allowed' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.chapters c where c.id = p_chapter_id and c.organization_id = org
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  insert into public.chapter_integration_overrides (
    organization_id, organization_integration_id, chapter_id, status,
    override_settings, credential_ref
  ) values (
    org, integration_id, p_chapter_id, coalesce(nullif(p_status, ''), 'inherit'),
    coalesce(p_override_settings, '{}'::jsonb), nullif(p_credential_ref, '')
  )
  on conflict (organization_integration_id, chapter_id) do update
    set status = excluded.status,
        override_settings = excluded.override_settings,
        credential_ref = coalesce(excluded.credential_ref, chapter_integration_overrides.credential_ref);
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'chapterId', p_chapter_id,
    'status', coalesce(p_status, 'inherit')
  ));
  return public.list_chapter_integration_overrides();
end;
$function$;

create function public.set_integration_chapter_controls(
  p_provider text,
  p_enabled boolean,
  p_allowed_chapter_override_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  update public.organization_integrations
  set allow_chapter_overrides = coalesce(p_enabled, false),
      allowed_chapter_override_keys = case
        when coalesce(p_enabled, false) then coalesce(p_allowed_chapter_override_keys, '{}'::text[])
        else '{}'::text[]
      end,
      updated_at = pg_catalog.now()
  where organization_id = org and provider = p_provider and provider <> 'scim';
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'provider', p_provider,
    'status', case when coalesce(p_enabled, false) then 'chapter_controls_enabled' else 'chapter_controls_disabled' end
  ));
  return public.list_organization_integrations();
end;
$function$;

create or replace function public.create_integration_api_key(p_name text, p_key_hash text, p_key_prefix text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'invalid key name' using errcode = '22023';
  end if;
  insert into public.integration_api_keys (organization_id, name, key_hash, key_prefix)
  values (org, pg_catalog.btrim(p_name), p_key_hash, p_key_prefix);
  insert into public.organization_integrations (organization_id, provider, status)
  values (org, 'customer_api', 'configured')
  on conflict (organization_id, provider) do update
    set status = 'configured', updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_api_key_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'name', pg_catalog.btrim(p_name), 'status', 'created'
  ));
  return public.list_integration_api_keys();
end;
$function$;

create function public.rotate_integration_api_key(p_key_id uuid, p_key_hash text, p_key_prefix text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  update public.integration_api_keys
  set key_hash = p_key_hash,
      key_prefix = p_key_prefix,
      last_rotated_at = pg_catalog.now(),
      revoked_at = null
  where id = p_key_id and organization_id = org and revoked_at is null;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.mi1_write_tenant_audit(org, 'integration_api_key_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', 'rotated'
  ));
  return public.list_integration_api_keys();
end;
$function$;

create function public.authenticate_integration_api_key(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  matched public.integration_api_keys%rowtype;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  select k.* into matched
  from public.integration_api_keys k
  join public.organizations o on o.id = k.organization_id and o.status = 'active'
  where k.key_hash = p_key_hash and k.revoked_at is null
  for update of k;
  if not found then return null; end if;
  update public.integration_api_keys set last_used_at = pg_catalog.now() where id = matched.id;
  return pg_catalog.jsonb_build_object(
    'keyId', matched.id,
    'organizationId', matched.organization_id,
    'name', matched.name
  );
end;
$function$;

create or replace function public.revoke_integration_api_key(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  update public.integration_api_keys
  set revoked_at = pg_catalog.now()
  where id = p_key_id and organization_id = org and revoked_at is null;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.integration_api_keys k
    where k.organization_id = org and k.revoked_at is null
  ) then
    update public.organization_integrations
    set status = 'unset', updated_at = pg_catalog.now()
    where organization_id = org and provider = 'customer_api';
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_api_key_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', 'revoked'
  ));
  return public.list_integration_api_keys();
end;
$function$;

create function public.configure_integration_webhook_dispatch(p_dispatch_url text, p_cron_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_url text := pg_catalog.rtrim(coalesce(p_dispatch_url, ''), '/');
begin
  -- This setup RPC is intentionally SAMPLE-only. The SaaS environment must
  -- receive its own source-pinned activation migration instead of allowing a
  -- service-role caller to cross-wire one database to the other host.
  if normalized_url <> 'https://demo.example.com/api/integration-webhooks-dispatch' then
    raise exception 'invalid dispatch url' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(p_cron_secret, '')) not between 32 and 512
     or p_cron_secret ~ '[[:cntrl:]]' then
    raise exception 'invalid dispatch secret' using errcode = '22023';
  end if;
  delete from vault.secrets where name = 'integration-webhooks-dispatch-secret';
  perform vault.create_secret(
    p_cron_secret,
    'integration-webhooks-dispatch-secret',
    'Bearer secret shared with the selected integration webhook dispatcher'
  );
  update private.integration_webhook_dispatch_controls
  set dispatch_url = normalized_url
  where id;
  return pg_catalog.jsonb_build_object('configured', true, 'dispatchUrl', normalized_url);
end;
$function$;

revoke all on function public.create_integration_webhook(text, text[], text, text) from public, anon, authenticated, service_role;
revoke all on function public.list_integration_jobs() from public, anon, authenticated, service_role;
revoke all on function public.enqueue_integration_job(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.run_next_integration_job() from public, anon, authenticated, service_role;
revoke all on function public.retry_integration_job(uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_integration_chapter_controls(text, boolean, text[]) from public, anon, authenticated, service_role;
revoke all on function public.list_integration_webhook_deliveries() from public, anon, authenticated, service_role;
revoke all on function public.list_integration_webhook_delivery_page(integer, timestamptz, uuid) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_integration_webhook_test(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_integration_webhook_deliveries(integer) from public, anon, authenticated, service_role;
revoke all on function public.claim_integration_webhook_delivery(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_integration_webhook_delivery(uuid, integer, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.rotate_integration_api_key(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.authenticate_integration_api_key(text) from public, anon, authenticated, service_role;
revoke all on function public.configure_integration_webhook_dispatch(text, text) from public, anon, authenticated, service_role;

grant execute on function public.create_integration_webhook(text, text[], text, text) to authenticated;
grant execute on function public.list_integration_jobs() to authenticated;
grant execute on function public.enqueue_integration_job(text, text, text) to authenticated;
grant execute on function public.run_next_integration_job() to authenticated;
grant execute on function public.retry_integration_job(uuid) to authenticated;
grant execute on function public.set_integration_chapter_controls(text, boolean, text[]) to authenticated;
grant execute on function public.list_integration_webhook_deliveries() to authenticated;
grant execute on function public.list_integration_webhook_delivery_page(integer, timestamptz, uuid) to authenticated;
grant execute on function public.enqueue_integration_webhook_test(uuid, text, text) to authenticated;
grant execute on function public.rotate_integration_api_key(uuid, text, text) to authenticated;
grant execute on function public.claim_integration_webhook_deliveries(integer) to service_role;
grant execute on function public.claim_integration_webhook_delivery(uuid) to service_role;
grant execute on function public.record_integration_webhook_delivery(uuid, integer, text, text, text) to service_role;
grant execute on function public.authenticate_integration_api_key(text) to service_role;
grant execute on function public.configure_integration_webhook_dispatch(text, text) to service_role;

create table if not exists private.integration_webhook_dispatch_ticks (
  request_id bigint primary key,
  created_at timestamptz not null default pg_catalog.now()
);

revoke all on private.integration_webhook_dispatch_ticks from public, anon, authenticated, service_role;

-- Vercel's daily tick is a backstop. The primary retry trigger is this
-- five-minute pg_cron job. It remains inert until an environment deliberately
-- sets its own dispatch URL and dedicated integration-dispatch Vault secret.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    return;
  end if;
  execute 'create extension if not exists pg_cron';
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    return;
  end if;
  execute 'create extension if not exists pg_net';
  perform cron.unschedule(jobid) from cron.job where jobname = 'integration-webhooks-dispatch-tick';
  perform cron.schedule(
    'integration-webhooks-dispatch-tick',
    '*/5 * * * *',
    $job$
    insert into private.integration_webhook_dispatch_ticks (request_id)
    select net.http_post(
      url := controls.dispatch_url,
      headers := pg_catalog.jsonb_build_object(
        'Authorization', 'Bearer ' || secret.decrypted_secret,
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    )
    from private.integration_webhook_dispatch_controls controls
    cross join vault.decrypted_secrets secret
    where controls.id
      and controls.dispatch_url is not null
      and secret.name = 'integration-webhooks-dispatch-secret'
    limit 1;
    delete from private.integration_webhook_dispatch_ticks
    where created_at < pg_catalog.now() - interval '7 days';
    $job$
  );
end
$block$;

notify pgrst, 'reload schema';
