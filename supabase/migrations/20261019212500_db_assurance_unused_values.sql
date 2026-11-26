-- Preserve the retained dispatch signatures and their unconditional refusal.
-- Discard their arguments explicitly; never configure an outside endpoint.
-- Connect intake needs FOUND, not the returned counters. Removing unused
-- targets preserves the existing atomic rate limits and FOUND semantics.
begin;
set local lock_timeout = '5s';
-- Written out as literal definitions (each from its source migration with
-- this edit applied), so the function inventory can read every body; the
-- predecessor check below refuses an unreviewed definition as before.
do $predecessors$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.configure_integration_webhook_dispatch(text,text)'::regprocedure) is distinct from '1ef57de90d7eb25c6833a96436089cf1' then
    raise exception 'unreviewed predecessor: %', 'public.configure_integration_webhook_dispatch(text,text)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.configure_notification_dispatch(text,text)'::regprocedure) is distinct from '8c93d7e9da5d7a322eae6df4d4d94a65' then
    raise exception 'unreviewed predecessor: %', 'public.configure_notification_dispatch(text,text)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.submit_unionground_connect_request(uuid,text,text,text,text,text,text)'::regprocedure) is distinct from 'dc2e04443f8c6a2391e311effd7b24c9' then
    raise exception 'unreviewed predecessor: %', 'public.submit_unionground_connect_request(uuid,text,text,text,text,text,text)';
  end if;
end;
$predecessors$;

-- public.configure_integration_webhook_dispatch: its definition from 20261015120000_unionground_sibling_dispatch_neutralized.sql with this migration's edit.
create or replace function public.configure_integration_webhook_dispatch(p_dispatch_url text, p_cron_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform p_dispatch_url, p_cron_secret;
  raise exception 'integration webhook dispatch has no Union Ground endpoint to configure'
    using errcode = '55000';
end;
$function$;

-- public.configure_notification_dispatch: its definition from 20261015120000_unionground_sibling_dispatch_neutralized.sql with this migration's edit.
create or replace function public.configure_notification_dispatch(p_dispatch_url text, p_dispatch_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform p_dispatch_url, p_dispatch_secret;
  raise exception 'notification dispatch has no Union Ground endpoint to configure'
    using errcode = '55000';
end;
$function$;

-- public.submit_unionground_connect_request: its definition from 20261014005000_unionground_public_connect_intake.sql with this migration's edit.
create or replace function public.submit_unionground_connect_request(
  p_request_id uuid,
  p_payload_ciphertext text,
  p_payload_iv text,
  p_payload_auth_tag text,
  p_payload_digest text,
  p_key_version text,
  p_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_digest text;
  v_bucket_start timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_request_id is null
    or pg_catalog.length(coalesce(p_payload_ciphertext, '')) not between 16 and 4096
    or p_payload_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$'
    or pg_catalog.length(coalesce(p_payload_iv, '')) <> 16
    or p_payload_iv !~ '^[A-Za-z0-9+/]+={0,2}$'
    or pg_catalog.length(coalesce(p_payload_auth_tag, '')) <> 24
    or p_payload_auth_tag !~ '^[A-Za-z0-9+/]+={0,2}$'
    or coalesce(p_payload_digest, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_key_version, '') !~ '^[A-Za-z0-9._-]{1,32}$'
    or coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$'
  then
    raise exception using
      errcode = '22023',
      message = 'invalid public connect request';
  end if;

  -- Serialize retries for one browser-generated request ID. A 64-bit advisory
  -- key is sufficient here because the UUID remains the table uniqueness key.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  -- Opportunistic cleanup limits retained ciphertext and stale abuse-control
  -- metadata even before a dedicated maintenance job is configured.
  delete from private.unionground_connect_requests
  where expires_at <= pg_catalog.clock_timestamp();
  delete from private.unionground_connect_rate_buckets
  where bucket_start < pg_catalog.date_trunc('hour', pg_catalog.clock_timestamp())
    - interval '24 hours';

  v_bucket_start := pg_catalog.date_trunc('hour', pg_catalog.clock_timestamp());
  insert into private.unionground_connect_rate_buckets (
    ip_hash,
    bucket_start,
    attempt_count,
    accepted_count
  )
  values (p_ip_hash, v_bucket_start, 1, 0)
  on conflict (ip_hash, bucket_start) do update
    set attempt_count =
      private.unionground_connect_rate_buckets.attempt_count + 1
    where private.unionground_connect_rate_buckets.attempt_count < 30
;

  if not found then
    return pg_catalog.jsonb_build_object(
      'accepted', false,
      'reason', 'rate-limit'
    );
  end if;

  select r.payload_digest
    into v_existing_digest
  from private.unionground_connect_requests r
  where r.request_id = p_request_id;

  if found then
    if v_existing_digest <> p_payload_digest then
      raise exception using
        errcode = '22023',
        message = 'request id already used';
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true,
      'idempotent', true,
      'requestId', p_request_id
    );
  end if;

  update private.unionground_connect_rate_buckets
  set accepted_count = accepted_count + 1
  where ip_hash = p_ip_hash
    and bucket_start = v_bucket_start
    and accepted_count < 5
;

  if not found then
    return pg_catalog.jsonb_build_object(
      'accepted', false,
      'reason', 'rate-limit'
    );
  end if;

  insert into private.unionground_connect_requests (
    request_id,
    payload_ciphertext,
    payload_iv,
    payload_auth_tag,
    payload_digest,
    key_version,
    expires_at
  )
  values (
    p_request_id,
    p_payload_ciphertext,
    p_payload_iv,
    p_payload_auth_tag,
    p_payload_digest,
    p_key_version,
    pg_catalog.clock_timestamp() + interval '30 days'
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'idempotent', false,
    'requestId', p_request_id
  );
end;
$$;
commit;
