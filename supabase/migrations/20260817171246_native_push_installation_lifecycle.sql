-- SEC-UG-MOBILE-PUSH-TOKEN-LIFECYCLE-20260814
--
-- Native APNs/FCM tokens are server-only bearer material. The public table is
-- intentionally reachable only through narrow, session-proving RPCs; neither
-- authenticated callers nor service_role can read it directly through the
-- Data API. The dispatch claim is the sole service-role read boundary.

create table public.member_native_push_installations (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  installation_id uuid not null check (installation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  application_id text not null default 'org.example.unionground'
    check (application_id = 'org.example.unionground'),
  provider text not null check (provider in ('apns', 'fcm')),
  environment text not null check (
    (provider = 'apns' and environment in ('sandbox', 'production'))
    or (provider = 'fcm' and environment = 'production')
  ),
  device_token text not null,
  token_hash text generated always as (
    pg_catalog.encode(extensions.digest(device_token, 'sha256'), 'hex')
  ) stored,
  session_handle text not null check (session_handle ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  last_seen_at timestamptz not null default pg_catalog.now(),
  constraint member_native_push_installations_user_installation_key
    unique (user_id, installation_id),
  constraint member_native_push_installations_provider_token_key
    unique (provider, token_hash),
  constraint member_native_push_installations_token_shape_check check (
    (provider = 'apns'
      and device_token ~ '^[0-9a-f]+$'
      and pg_catalog.char_length(device_token) between 32 and 512
      and pg_catalog.char_length(device_token) % 2 = 0)
    or
    (provider = 'fcm'
      and pg_catalog.char_length(device_token) between 20 and 4096
      and device_token = pg_catalog.btrim(device_token)
      and device_token !~ '[[:space:]]')
  )
);

create index member_native_push_installations_user_session_idx
  on public.member_native_push_installations (user_id, session_handle, last_seen_at desc);

create index member_native_push_installations_last_seen_idx
  on public.member_native_push_installations (last_seen_at);

alter table public.member_native_push_installations enable row level security;
alter table public.member_native_push_installations force row level security;

create policy mfa_assurance on public.member_native_push_installations
  as restrictive
  for all
  to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

-- Explicitly opt out of the Data API default-grant behavior. Mutations and
-- reads use the RPCs below, including dispatch and terminal-token pruning.
revoke all on table public.member_native_push_installations
  from public, anon, authenticated, service_role;

create table private.member_native_push_registration_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default pg_catalog.now(),
  request_count integer not null default 0 check (request_count between 0 and 31)
);

revoke all on table private.member_native_push_registration_limits
  from public, anon, authenticated, service_role;

-- A delivery row is shared by every web/native target for one member. Keep a
-- non-secret receipt for targets that already accepted the row so a transient
-- sibling failure can retry without sending duplicate banners to the healthy
-- devices. The dispatcher records these only through the lease-checked result
-- RPC below; no API role receives direct table access.
create table private.member_notification_push_target_receipts (
  delivery_id uuid not null
    references public.member_notification_deliveries(id) on delete cascade,
  target_key text not null check (
    target_key ~ '^web:[0-9a-f]{64}$'
    or target_key ~ '^native:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  delivered_at timestamptz not null default pg_catalog.now(),
  primary key (delivery_id, target_key)
);

revoke all on table private.member_notification_push_target_receipts
  from public, anon, authenticated, service_role;

-- A target receipt is authoritative even when the result recorder becomes
-- unavailable after the provider accepted a sibling send. Keep every terminal
-- sweep consistent with the recorder: a delivery that reached at least one
-- target is sent, never failed or skipped solely because its lease expired.
create or replace function public.expire_notification_deliveries()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare expired integer := 0; exhausted integer := 0; ineligible integer := 0;
begin
  with candidates as (
    select d.id, pg_catalog.min(r.delivered_at) as first_delivered_at
    from public.member_notification_deliveries d
    left join private.member_notification_push_target_receipts r on r.delivery_id = d.id
    where d.created_at < pg_catalog.now() - interval '48 hours'
      and (d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
    group by d.id
  )
  update public.member_notification_deliveries d
    set status = case when c.first_delivered_at is null then 'skipped' else 'sent' end,
        sent_at = coalesce(d.sent_at, c.first_delivered_at),
        last_error = case when c.first_delivered_at is null then 'expired before dispatch' else null end,
        updated_at = pg_catalog.now()
  from candidates c where d.id = c.id;
  get diagnostics expired = row_count;

  with candidates as (
    select d.id, pg_catalog.min(r.delivered_at) as first_delivered_at
    from public.member_notification_deliveries d
    left join private.member_notification_push_target_receipts r on r.delivery_id = d.id
    where d.attempts >= 6
      and (d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
    group by d.id
  )
  update public.member_notification_deliveries d
    set status = case when c.first_delivered_at is null then 'failed' else 'sent' end,
        sent_at = coalesce(d.sent_at, c.first_delivered_at),
        last_error = case when c.first_delivered_at is null
          then coalesce(d.last_error, 'attempt budget exhausted') else null end,
        updated_at = pg_catalog.now()
  from candidates c where d.id = c.id;
  get diagnostics exhausted = row_count;

  with candidates as (
    select d.id, pg_catalog.min(r.delivered_at) as first_delivered_at
    from public.member_notification_deliveries d
    join public.member_notifications n on n.id = d.notification_id
    left join private.member_notification_push_target_receipts r on r.delivery_id = d.id
    where n.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments', 'workload')
      and (d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
    group by d.id
  )
  update public.member_notification_deliveries d
    set status = case when c.first_delivered_at is null then 'skipped' else 'sent' end,
        sent_at = coalesce(d.sent_at, c.first_delivered_at),
        last_error = case when c.first_delivered_at is null
          then 'kind is not outbound-eligible' else null end,
        updated_at = pg_catalog.now()
  from candidates c where d.id = c.id;
  get diagnostics ineligible = row_count;

  return pg_catalog.jsonb_build_object(
    'expired', expired,
    'exhausted', exhausted,
    'ineligible', ineligible);
end;
$$;

revoke all on function public.expire_notification_deliveries()
  from public, anon, authenticated, service_role;
grant execute on function public.expire_notification_deliveries()
  to service_role;

create table private.member_native_push_installation_audit (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  installation_hash text not null check (installation_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('apns', 'fcm')),
  environment text not null check (environment in ('sandbox', 'production')),
  operation text not null check (operation in ('registered', 'rotated', 'deleted')),
  prior_token_hash text check (prior_token_hash is null or prior_token_hash ~ '^[0-9a-f]{64}$'),
  next_token_hash text check (next_token_hash is null or next_token_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null default pg_catalog.now()
);

create index member_native_push_installation_audit_user_time_idx
  on private.member_native_push_installation_audit (user_id, occurred_at desc);

revoke all on table private.member_native_push_installation_audit
  from public, anon, authenticated, service_role;

create function private.audit_member_native_push_installation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior_row public.member_native_push_installations%rowtype;
  next_row public.member_native_push_installations%rowtype;
  action text;
  audit_user_id uuid;
begin
  if tg_op = 'INSERT' then
    next_row := new;
    action := 'registered';
  elsif tg_op = 'DELETE' then
    prior_row := old;
    action := 'deleted';
  elsif old.token_hash is distinct from new.token_hash
     or old.provider is distinct from new.provider
     or old.environment is distinct from new.environment then
    prior_row := old;
    next_row := new;
    action := 'rotated';
  else
    return new;
  end if;

  audit_user_id := coalesce(next_row.user_id, prior_row.user_id);

  insert into private.member_native_push_installation_audit
    (user_id, installation_hash, provider, environment, operation, prior_token_hash, next_token_hash)
  values (
    -- During ON DELETE CASCADE from auth.users the parent is already absent.
    -- Insert NULL so this AFTER DELETE audit cannot recreate a dangling FK;
    -- the FK also nulls every earlier audit row for the erased account.
    case when exists (
      select 1 from auth.users u where u.id = audit_user_id
    ) then audit_user_id else null end,
    pg_catalog.encode(extensions.digest(
      coalesce(next_row.user_id, prior_row.user_id)::text || ':'
        || coalesce(next_row.installation_id, prior_row.installation_id)::text,
      'sha256'), 'hex'),
    coalesce(next_row.provider, prior_row.provider),
    coalesce(next_row.environment, prior_row.environment),
    action,
    prior_row.token_hash,
    next_row.token_hash
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.audit_member_native_push_installation()
  from public, anon, authenticated, service_role;

create trigger member_native_push_installations_audit
  after insert or update or delete on public.member_native_push_installations
  for each row execute function private.audit_member_native_push_installation();

create function public.register_my_native_push_installation(
  p_installation_id uuid,
  p_provider text,
  p_environment text,
  p_device_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  clean_provider text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_provider, '')));
  clean_environment text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_environment, '')));
  clean_token text;
  clean_hash text;
  token_owner uuid;
  rate_row private.member_native_push_registration_limits%rowtype;
  registered public.member_native_push_installations%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);

  -- Count every authenticated attempt before format or ownership checks. The
  -- generic false result below commits the counter; raising would roll the
  -- limiter update back with the rest of this transaction.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('native-push-member:' || caller::text));
  insert into private.member_native_push_registration_limits
    (user_id, window_started_at, request_count)
  values (caller, pg_catalog.now(), 1)
  on conflict (user_id) do update
    set window_started_at = case
          when private.member_native_push_registration_limits.window_started_at
            <= pg_catalog.now() - interval '1 hour'
          then pg_catalog.now()
          else private.member_native_push_registration_limits.window_started_at
        end,
        request_count = case
          when private.member_native_push_registration_limits.window_started_at
            <= pg_catalog.now() - interval '1 hour'
          then 1
          else least(private.member_native_push_registration_limits.request_count + 1, 31)
        end
  returning * into rate_row;

  if rate_row.request_count > 30
     and rate_row.window_started_at > pg_catalog.now() - interval '1 hour' then
    return pg_catalog.jsonb_build_object(
      'registered', false,
      'reason', 'rate_limited',
      'retryAfterSeconds', greatest(1, pg_catalog.ceil(
        extract(epoch from (rate_row.window_started_at + interval '1 hour' - pg_catalog.now()))
      )::integer));
  end if;

  if p_installation_id is null
     or p_installation_id = '00000000-0000-0000-0000-000000000000'::uuid
     or p_installation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or clean_provider not in ('apns', 'fcm')
     or (clean_provider = 'apns' and clean_environment not in ('sandbox', 'production'))
     or (clean_provider = 'fcm' and clean_environment <> 'production') then
    return pg_catalog.jsonb_build_object('registered', false, 'reason', 'unavailable');
  end if;

  clean_token := case
    when clean_provider = 'apns' then pg_catalog.lower(pg_catalog.btrim(coalesce(p_device_token, '')))
    else pg_catalog.btrim(coalesce(p_device_token, ''))
  end;
  if (clean_provider = 'apns' and (
       clean_token !~ '^[0-9a-f]+$'
       or pg_catalog.char_length(clean_token) not between 32 and 512
       or pg_catalog.char_length(clean_token) % 2 <> 0
     ))
     or (clean_provider = 'fcm' and (
       pg_catalog.char_length(clean_token) not between 20 and 4096
       or clean_token ~ '[[:space:]]'
     )) then
    return pg_catalog.jsonb_build_object('registered', false, 'reason', 'unavailable');
  end if;
  clean_hash := pg_catalog.encode(extensions.digest(clean_token, 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('native-push-token:' || clean_provider || ':' || clean_hash));

  select i.user_id into token_owner
  from public.member_native_push_installations i
  where i.provider = clean_provider
    and i.token_hash = clean_hash
  for update;
  if token_owner is not null and token_owner <> caller then
    -- A provider token is a high-entropy installation credential and can route
    -- to only one installed app. Possession by the current MFA-backed caller
    -- proves the shared/reinstalled device moved; atomically retire the prior
    -- binding so the former member cannot keep receiving on this phone.
    delete from public.member_native_push_installations i
    where i.provider = clean_provider
      and i.token_hash = clean_hash;
  end if;

  -- A provider token may move to a fresh installation id after reinstall, but
  -- never across members. Remove the caller's older binding before upsert.
  delete from public.member_native_push_installations i
  where i.user_id = caller
    and i.provider = clean_provider
    and i.token_hash = clean_hash
    and i.installation_id <> p_installation_id;

  insert into public.member_native_push_installations
    (user_id, installation_id, provider, environment, device_token, session_handle)
  values
    (caller, p_installation_id, clean_provider, clean_environment, clean_token, current_handle)
  on conflict (user_id, installation_id) do update
    set provider = excluded.provider,
        environment = excluded.environment,
        device_token = excluded.device_token,
        session_handle = excluded.session_handle,
        updated_at = pg_catalog.now(),
        last_seen_at = pg_catalog.now()
  returning * into registered;

  -- Bound an authenticated caller's durable token surface. Oldest inactive
  -- installations fall out privacy-first and must explicitly register again.
  delete from public.member_native_push_installations i
  where i.id in (
    select extra.id
    from public.member_native_push_installations extra
    where extra.user_id = caller
      and extra.id <> registered.id
    order by extra.last_seen_at desc, extra.created_at desc
    offset 9
  );

  return pg_catalog.jsonb_build_object(
    'registered', true,
    'installationId', registered.installation_id,
    'provider', registered.provider,
    'environment', registered.environment,
    'tokenFingerprint', pg_catalog.left(registered.token_hash, 12),
    'lastSeenAt', registered.last_seen_at);
end;
$$;

revoke all on function public.register_my_native_push_installation(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.register_my_native_push_installation(uuid, text, text, text)
  to authenticated;

create function public.list_my_native_push_installations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'installationId', i.installation_id,
    'provider', i.provider,
    'environment', i.environment,
    'tokenFingerprint', pg_catalog.left(i.token_hash, 12),
    'currentSession', i.session_handle = current_handle,
    'createdAt', i.created_at,
    'lastSeenAt', i.last_seen_at
  ) order by i.last_seen_at desc), '[]'::jsonb)
  into payload
  from public.member_native_push_installations i
  where i.user_id = caller;

  return payload;
end;
$$;

revoke all on function public.list_my_native_push_installations()
  from public, anon, authenticated, service_role;
grant execute on function public.list_my_native_push_installations()
  to authenticated;

create function public.delete_my_native_push_installation(p_installation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  removed integer := 0;
begin
  -- Sign-out can arrive while a valid session is awaiting its MFA challenge.
  -- The installation UUID is device-held random material, deletion is scoped
  -- to the caller, and false is uniform for unknown or non-owned identifiers.
  if caller is null then
    raise exception 'member session required' using errcode = '42501';
  end if;
  perform private.current_member_session_id();
  if p_installation_id is null then
    raise exception 'native push installation unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('native-push-member:' || caller::text));
  delete from public.member_native_push_installations i
  where i.user_id = caller
    and i.installation_id = p_installation_id;
  get diagnostics removed = row_count;

  return pg_catalog.jsonb_build_object('deleted', removed = 1);
end;
$$;

revoke all on function public.delete_my_native_push_installation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_my_native_push_installation(uuid)
  to authenticated;

create function public.prune_native_push_installation(
  p_installation_id uuid,
  p_provider text,
  p_environment text,
  p_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_provider text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_provider, '')));
  clean_environment text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_environment, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  removed integer := 0;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_installation_id is null
     or clean_provider not in ('apns', 'fcm')
     or (clean_provider = 'apns' and clean_environment not in ('sandbox', 'production'))
     or (clean_provider = 'fcm' and clean_environment <> 'production')
     or clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'native push installation unavailable' using errcode = '22023';
  end if;

  delete from public.member_native_push_installations i
  where i.installation_id = p_installation_id
    and i.provider = clean_provider
    and i.environment = clean_environment
    and i.token_hash = clean_hash;
  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;

revoke all on function public.prune_native_push_installation(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_native_push_installation(uuid, text, text, text)
  to service_role;

create function public.prune_stale_native_push_installations(
  p_before timestamptz default (pg_catalog.now() - interval '60 days'),
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap integer := greatest(1, least(coalesce(p_limit, 100), 500));
  removed integer := 0;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_before is null or p_before > pg_catalog.now() - interval '7 days' then
    raise exception 'invalid stale-token cutoff' using errcode = '22023';
  end if;

  with stale as (
    select i.id
    from public.member_native_push_installations i
    where i.last_seen_at < p_before
    order by i.last_seen_at
    limit cap
    for update skip locked
  )
  delete from public.member_native_push_installations i
  using stale
  where i.id = stale.id;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_stale_native_push_installations(timestamptz, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_stale_native_push_installations(timestamptz, integer)
  to service_role;

-- Extend selected-session revocation so native installations disappear in the
-- same transaction and before the target Auth session is removed.
create or replace function public.revoke_my_session(p_session_handle text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  target_session uuid;
  clean_handle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_session_handle, '')));
  web_push_removed integer := 0;
  native_push_removed integer := 0;
  push_removed integer := 0;
  session_removed integer := 0;
  prior private.member_session_revocations%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  if clean_handle = '' or p_session_handle !~ '^[0-9a-f]{64}$' then
    raise exception 'session unavailable' using errcode = '22023';
  end if;

  current_session := private.current_member_session_id();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member-sessions:' || caller::text));

  select * into prior
  from private.member_session_revocations r
  where r.user_id = caller
    and r.session_handle = clean_handle;
  if prior.user_id is not null then
    return pg_catalog.jsonb_build_object(
      'revoked', true,
      'alreadyRevoked', true,
      'pushSubscriptionsRemoved', prior.push_rows_removed);
  end if;

  select s.id into target_session
  from auth.sessions s
  where s.user_id = caller
    and private.member_session_handle(s.id) = clean_handle
  for update;

  if target_session is null then
    raise exception 'session unavailable' using errcode = '22023';
  end if;
  if target_session::text = current_session::text then
    raise exception 'cannot revoke the current session' using errcode = '22023';
  end if;

  delete from public.member_push_subscriptions
  where user_id = caller
    and (session_handle = clean_handle or session_handle is null);
  get diagnostics web_push_removed = row_count;

  delete from public.member_native_push_installations
  where user_id = caller
    and session_handle = clean_handle;
  get diagnostics native_push_removed = row_count;
  push_removed := web_push_removed + native_push_removed;

  delete from auth.sessions
  where id = target_session
    and user_id = caller;
  get diagnostics session_removed = row_count;
  if session_removed <> 1 then
    raise exception 'session unavailable' using errcode = '22023';
  end if;

  insert into private.member_session_revocations
    (user_id, session_handle, push_rows_removed)
  values
    (caller, clean_handle, push_removed);

  return pg_catalog.jsonb_build_object(
    'revoked', true,
    'alreadyRevoked', false,
    'pushSubscriptionsRemoved', push_removed,
    'nativePushInstallationsRemoved', native_push_removed);
end;
$$;

revoke all on function public.revoke_my_session(text) from public, anon, authenticated, service_role;
grant execute on function public.revoke_my_session(text) to authenticated;

-- Push teardown remains a prerequisite for Auth sign-out. Local removes the
-- current session's browser and native bindings; global removes all of them.
create or replace function public.prepare_my_signout(p_scope text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  clean_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_scope, '')));
  web_push_removed integer := 0;
  native_push_removed integer := 0;
  push_removed integer := 0;
  mfa_ok boolean := false;
begin
  if caller is null then
    raise exception 'member session required' using errcode = '42501';
  end if;
  if clean_scope not in ('local', 'global') then
    raise exception 'invalid signout scope' using errcode = '22023';
  end if;
  mfa_ok := private.mfa_satisfied();
  if clean_scope = 'global' and not mfa_ok then
    raise exception 'member session required' using errcode = '42501';
  end if;

  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member-sessions:' || caller::text));

  if clean_scope = 'global' then
    delete from public.member_push_subscriptions where user_id = caller;
    get diagnostics web_push_removed = row_count;
    delete from public.member_native_push_installations where user_id = caller;
    get diagnostics native_push_removed = row_count;
  else
    delete from public.member_push_subscriptions
    where user_id = caller
      and (session_handle = current_handle or (session_handle is null and mfa_ok));
    get diagnostics web_push_removed = row_count;
    -- Local sign-out must never de-register another phone or let a browser
    -- session clean up native devices. The mobile client deletes its exact
    -- installation before this call; this current-handle deletion is the
    -- idempotent fallback. The bounded service-role stale sweep owns orphans.
    delete from public.member_native_push_installations i
    where i.user_id = caller
      and i.session_handle = current_handle;
    get diagnostics native_push_removed = row_count;
  end if;
  push_removed := web_push_removed + native_push_removed;

  return pg_catalog.jsonb_build_object(
    'scope', clean_scope,
    'pushSubscriptionsRemoved', push_removed,
    'nativePushInstallationsRemoved', native_push_removed,
    'serverCleanupComplete', true);
end;
$$;

revoke all on function public.prepare_my_signout(text) from public, anon, authenticated, service_role;
grant execute on function public.prepare_my_signout(text) to authenticated;

-- Extend the existing lease-checked recorder with two push-only properties:
-- accepted target keys land atomically with the row result, and a provider-
-- configuration deferral returns the row to pending without consuming one of
-- its six real send attempts. A stale lease can write neither state.
create or replace function public.record_notification_delivery_results(p_results jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  target_item jsonb;
  v_id uuid;
  v_attempt integer;
  v_status text;
  v_target_key text;
  v_first_delivered_at timestamptz;
  v_has_current_receipt boolean;
  v_rows integer;
  applied integer := 0;
  ignored integer := 0;
begin
  if p_results is null or pg_catalog.jsonb_typeof(p_results) <> 'array' then
    raise exception 'p_results must be a json array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_results) > 500 then
    raise exception 'too many results' using errcode = '22023';
  end if;

  for item in select value from pg_catalog.jsonb_array_elements(p_results)
  loop
    v_status := item ->> 'status';
    if v_status is null or v_status not in ('sent', 'failed', 'skipped', 'deferred') then
      raise exception 'unknown result status' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(item -> 'deliveryId') <> 'string'
       or pg_catalog.jsonb_typeof(item -> 'attempt') <> 'number'
       or (item ? 'deliveredTargetKeys'
         and pg_catalog.jsonb_typeof(item -> 'deliveredTargetKeys') <> 'array')
       or pg_catalog.jsonb_array_length(coalesce(item -> 'deliveredTargetKeys', '[]'::jsonb)) > 20 then
      raise exception 'malformed result entry' using errcode = '22023';
    end if;
    v_id := (item ->> 'deliveryId')::uuid;
    v_attempt := (item ->> 'attempt')::integer;
    v_has_current_receipt := pg_catalog.jsonb_array_length(
      coalesce(item -> 'deliveredTargetKeys', '[]'::jsonb)) > 0;
    select pg_catalog.min(r.delivered_at)
      into v_first_delivered_at
      from private.member_notification_push_target_receipts r
      where r.delivery_id = v_id;

    if v_status = 'sent' then
      update public.member_notification_deliveries d
        set status = 'sent', sent_at = pg_catalog.now(),
            provider_message_id = pg_catalog.left(coalesce(item ->> 'providerMessageId', ''), 200),
            last_error = null, updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt;
    elsif v_status = 'skipped' then
      update public.member_notification_deliveries d
        set status = case when v_first_delivered_at is null then 'skipped' else 'sent' end,
            sent_at = case when v_first_delivered_at is null then d.sent_at else v_first_delivered_at end,
            last_error = case
              when v_first_delivered_at is null
                then pg_catalog.left(coalesce(item ->> 'error', 'skipped'), 500)
              else null
            end,
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt;
    elsif v_status = 'deferred' then
      update public.member_notification_deliveries d
        set status = 'pending',
            attempts = greatest(0, d.attempts - 1),
            last_error = pg_catalog.left(coalesce(item ->> 'error', 'provider unavailable'), 500),
            next_attempt_at = pg_catalog.now() + interval '15 minutes',
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt;
    else
      update public.member_notification_deliveries d
        set status = case
              when d.attempts >= 6
                and (v_first_delivered_at is not null or v_has_current_receipt) then 'sent'
              when d.attempts >= 6 then 'failed'
              else 'pending'
            end,
            sent_at = case
              when d.attempts >= 6
                and (v_first_delivered_at is not null or v_has_current_receipt)
                then coalesce(v_first_delivered_at, pg_catalog.now())
              else d.sent_at
            end,
            last_error = case
              when d.attempts >= 6
                and (v_first_delivered_at is not null or v_has_current_receipt) then null
              else pg_catalog.left(coalesce(item ->> 'error', 'send failed'), 500)
            end,
            next_attempt_at = pg_catalog.now()
              + least(60, pg_catalog.power(2, least(d.attempts, 10))::integer) * interval '1 minute',
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt;
    end if;

    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      if pg_catalog.jsonb_array_length(
           coalesce(item -> 'deliveredTargetKeys', '[]'::jsonb)) > 0
         and not exists (
           select 1 from public.member_notification_deliveries d
           where d.id = v_id and d.channel = 'push'
         ) then
        raise exception 'target receipts require push delivery' using errcode = '22023';
      end if;
      for target_item in
        select value from pg_catalog.jsonb_array_elements(
          coalesce(item -> 'deliveredTargetKeys', '[]'::jsonb))
      loop
        if pg_catalog.jsonb_typeof(target_item) <> 'string' then
          raise exception 'malformed target receipt' using errcode = '22023';
        end if;
        v_target_key := target_item #>> '{}';
        if v_target_key !~ '^web:[0-9a-f]{64}$'
           and v_target_key !~ '^native:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
          raise exception 'malformed target receipt' using errcode = '22023';
        end if;
        insert into private.member_notification_push_target_receipts (delivery_id, target_key)
        values (v_id, v_target_key)
        on conflict (delivery_id, target_key) do nothing;
      end loop;
      applied := applied + 1;
    else
      ignored := ignored + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('applied', applied, 'ignored', ignored);
end;
$$;

revoke all on function public.record_notification_delivery_results(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_notification_delivery_results(jsonb)
  to service_role;

-- The service-role-only claim is the only function that emits raw device
-- tokens. Notification content remains closed metadata; member-authored title
-- and body fields never enter the claim.
create or replace function public.claim_notification_deliveries(p_channel text, p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap integer := greatest(1, least(coalesce(p_limit, 200), 500));
  max_subscriptions constant integer := 10;
  max_native_installations constant integer := 10;
  outbound_on boolean;
  claimed jsonb;
begin
  if p_channel is null or p_channel not in ('email', 'push', 'sms') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;
  select c.outbound_enabled into outbound_on from private.notification_controls c where c.id;
  if not coalesce(outbound_on, false) then return '[]'::jsonb; end if;

  with candidates as (
    select d.id from public.member_notification_deliveries d
    join public.member_notifications n on n.id = d.notification_id
    where d.channel = p_channel and d.attempts < 6
      and d.created_at >= pg_catalog.now() - interval '48 hours'
      and ((d.status = 'pending' and d.next_attempt_at <= pg_catalog.now())
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
      and ((n.kind = 'workload' and n.workload_event = 'receipt')
        or not private.member_focus_blocks(d.user_id, n.kind))
    order by d.next_attempt_at limit cap for update of d skip locked
  ), flipped as (
    update public.member_notification_deliveries d set
      status = 'sending', attempts = d.attempts + 1, updated_at = pg_catalog.now()
    from candidates c where d.id = c.id
    returning d.id, d.notification_id, d.user_id, d.attempts
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', f.id, 'kind', n.kind, 'lang', coalesce(pr.language, 'en'),
    'attempt', f.attempts,
    'event', n.workload_event,
    'receiptCode', n.workload_receipt_code,
    'email', case when p_channel = 'email' then u.email end,
    'subscriptions', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth_key,
        'targetKey', s.target_key))
      from (select s2.endpoint, s2.p256dh, s2.auth_key,
          'web:' || pg_catalog.encode(extensions.digest(s2.endpoint, 'sha256'), 'hex') as target_key
        from public.member_push_subscriptions s2 where s2.user_id = f.user_id
          and not exists (
            select 1 from private.member_notification_push_target_receipts r
            where r.delivery_id = f.id
              and r.target_key = 'web:' || pg_catalog.encode(extensions.digest(s2.endpoint, 'sha256'), 'hex')
          )
        order by s2.last_seen_at desc limit max_subscriptions) s
    ) end,
    'nativeInstallations', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'installationId', i.installation_id,
        'provider', i.provider,
        'environment', i.environment,
        'token', i.device_token,
        'tokenHash', i.token_hash,
        'targetKey', i.target_key))
      from (select i2.installation_id, i2.provider, i2.environment, i2.device_token, i2.token_hash,
          'native:' || i2.installation_id::text as target_key
        from public.member_native_push_installations i2 where i2.user_id = f.user_id
          and not exists (
            select 1 from private.member_notification_push_target_receipts r
            where r.delivery_id = f.id
              and r.target_key = 'native:' || i2.installation_id::text
          )
        order by i2.last_seen_at desc limit max_native_installations) i
    ) end)), '[]'::jsonb)
  into claimed from flipped f
  join public.member_notifications n on n.id = f.notification_id
  left join public.member_profiles pr on pr.id = f.user_id
  left join auth.users u on u.id = f.user_id;
  return claimed;
end;
$$;

revoke all on function public.claim_notification_deliveries(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_notification_deliveries(text, integer)
  to service_role;

notify pgrst, 'reload schema';
