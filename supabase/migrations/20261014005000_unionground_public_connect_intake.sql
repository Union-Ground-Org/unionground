-- Public organizing-intake boundary for Union Ground.
--
-- The browser never writes this table and the database never receives public
-- intake plaintext. The same-origin serverless endpoint validates a deliberately
-- narrow field set, encrypts it with AES-256-GCM, then calls the service-role-only
-- RPC below. Employer names, coworker names, support/card counts, allegations,
-- and narrative fields are intentionally absent from this contract.
--
-- Reconciled with the current schema on 2026-10-14 (this file ran at
-- 20260724093000 against an earlier schema). The earlier schema has no public
-- intake object under these names (its chapter-connection suggestions are a
-- different, authenticated feature), and api/connect.js and
-- api/connect-purge.js still call these two RPCs, so the file is unchanged.

create table private.unionground_connect_requests (
  request_id uuid primary key,
  payload_ciphertext text not null,
  payload_iv text not null,
  payload_auth_tag text not null,
  payload_digest text not null,
  key_version text not null,
  status text not null default 'new'
    check (status in ('new', 'contacted', 'closed')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at > created_at),
  check (pg_catalog.length(payload_ciphertext) between 16 and 4096),
  check (pg_catalog.length(payload_iv) = 16),
  check (pg_catalog.length(payload_auth_tag) = 24),
  check (payload_digest ~ '^[0-9a-f]{64}$'),
  check (key_version ~ '^[A-Za-z0-9._-]{1,32}$')
);

create index unionground_connect_requests_expiry_idx
  on private.unionground_connect_requests (expires_at);

create table private.unionground_connect_rate_buckets (
  ip_hash text not null
    check (ip_hash ~ '^[0-9a-f]{64}$'),
  bucket_start timestamptz not null,
  attempt_count integer not null
    check (attempt_count between 1 and 30),
  accepted_count integer not null default 0
    check (accepted_count between 0 and 5),
  primary key (ip_hash, bucket_start)
);

create index unionground_connect_rate_buckets_expiry_idx
  on private.unionground_connect_rate_buckets (bucket_start);

alter table private.unionground_connect_requests enable row level security;
alter table private.unionground_connect_requests force row level security;
alter table private.unionground_connect_rate_buckets enable row level security;
alter table private.unionground_connect_rate_buckets force row level security;

revoke all on table private.unionground_connect_requests
  from public, anon, authenticated, service_role;
revoke all on table private.unionground_connect_rate_buckets
  from public, anon, authenticated, service_role;

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
  v_attempts integer;
  v_count integer;
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
  returning attempt_count into v_attempts;

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
  returning accepted_count into v_count;

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

revoke all on function public.submit_unionground_connect_request(
  uuid, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.submit_unionground_connect_request(
  uuid, text, text, text, text, text, text
) to service_role;

create or replace function public.purge_expired_unionground_connect_requests()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requests integer;
  v_buckets integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  delete from private.unionground_connect_requests
  where expires_at <= pg_catalog.clock_timestamp();
  get diagnostics v_requests = row_count;

  delete from private.unionground_connect_rate_buckets
  where bucket_start < pg_catalog.date_trunc('hour', pg_catalog.clock_timestamp())
    - interval '24 hours';
  get diagnostics v_buckets = row_count;

  return pg_catalog.jsonb_build_object(
    'requestsDeleted', v_requests,
    'bucketsDeleted', v_buckets
  );
end;
$$;

revoke all on function public.purge_expired_unionground_connect_requests()
  from public, anon, authenticated;
grant execute on function public.purge_expired_unionground_connect_requests()
  to service_role;

comment on table private.unionground_connect_requests is
  'Encrypted, minimal public Union Ground contact requests. No organizing narrative or workplace details.';
comment on function public.submit_unionground_connect_request(
  uuid, text, text, text, text, text, text
) is
  'Service-role-only encrypted public contact intake with idempotency, hourly abuse control, and 30-day expiry.';
comment on function public.purge_expired_unionground_connect_requests() is
  'Service-role-only retention purge for expired encrypted intake and stale rate buckets.';
