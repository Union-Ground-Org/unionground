-- UB-IDN-05 / UB-SET-05: self-scoped Supabase Auth session controls.
--
-- auth.sessions remains the one access/session authority. Browser callers see
-- only a SHA-256 equality handle plus coarse labels; raw session ids, IPs,
-- full user agents and refresh tokens never cross this RPC boundary.

create function private.member_session_handle(p_session_id uuid)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(p_session_id::text, 'sha256'), 'hex')
$$;

revoke all on function private.member_session_handle(uuid) from public, anon, authenticated, service_role;

-- Resolve and re-prove the actual Auth session behind the JWT. Supabase
-- documents that a revoked access token remains cryptographically valid until
-- its one-hour expiry; checking auth.sessions prevents such a token from using
-- these definer functions after its refresh-token chain has been removed.
create function private.current_member_session_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  claimed text := (select auth.jwt() ->> 'session_id');
  resolved uuid;
begin
  if caller is null
     or claimed is null
     or claimed !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'member session required' using errcode = '42501';
  end if;

  select s.id into resolved
  from auth.sessions s
  where s.id = claimed::uuid
    and s.user_id = caller;

  if resolved is null then
    raise exception 'member session required' using errcode = '42501';
  end if;
  return resolved;
end;
$$;

revoke all on function private.current_member_session_id() from public, anon, authenticated, service_role;

-- Exact-replay ledger. It carries no raw Auth identifier or device metadata,
-- and no API role can read it. A row exists only after the target session and
-- its push registrations were removed in the same transaction.
create table private.member_session_revocations (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_handle text not null check (session_handle ~ '^[0-9a-f]{64}$'),
  push_rows_removed integer not null default 0 check (push_rows_removed >= 0),
  revoked_at timestamptz not null default now(),
  primary key (user_id, session_handle)
);

revoke all on private.member_session_revocations from public, anon, authenticated, service_role;

-- Associate a push registration with an opaque session handle. Existing rows
-- remain nullable until that browser next boots the updated app; remote revoke
-- deletes legacy NULL rows privacy-first rather than guessing their device.
alter table public.member_push_subscriptions
  add column session_handle text;

alter table public.member_push_subscriptions
  add constraint member_push_subscriptions_session_handle_check
  check (session_handle is null or session_handle ~ '^[0-9a-f]{64}$');

create index member_push_subscriptions_session_handle_idx
  on public.member_push_subscriptions (user_id, session_handle)
  where session_handle is not null;

-- The existing writer remains parameter-compatible. The binding is derived
-- from the verified JWT session, never accepted from the browser.
create or replace function public.upsert_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);

  if p_endpoint is null
     or pg_catalog.lower(p_endpoint) !~ '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)/' then
    raise exception 'unsupported push endpoint' using errcode = '22023';
  end if;
  if p_p256dh is null or p_auth is null
     or pg_catalog.char_length(p_p256dh) not between 1 and 512
     or pg_catalog.char_length(p_auth) not between 1 and 512 then
    raise exception 'invalid push key material' using errcode = '22023';
  end if;

  insert into public.member_push_subscriptions
    (user_id, endpoint, p256dh, auth_key, session_handle)
  values
    (caller, p_endpoint, p_p256dh, p_auth, current_handle)
  on conflict (endpoint) do update
    set user_id = caller,
        p256dh = excluded.p256dh,
        auth_key = excluded.auth_key,
        session_handle = excluded.session_handle,
        last_seen_at = pg_catalog.now();
end;
$$;

revoke all on function public.upsert_push_subscription(text, text, text) from public, anon, authenticated;
grant execute on function public.upsert_push_subscription(text, text, text) to authenticated;

create or replace function public.list_my_sessions()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  current_session := private.current_member_session_id();

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'handle', private.member_session_handle(s.id),
    'deviceLabel', case
      when coalesce(s.user_agent, '') ~* 'iphone|ipad|ipod' then 'apple_mobile'
      when coalesce(s.user_agent, '') ~* 'android' then 'android_mobile'
      when coalesce(s.user_agent, '') ~* 'windows' then 'windows_computer'
      when coalesce(s.user_agent, '') ~* 'macintosh|mac os' then 'apple_computer'
      when coalesce(s.user_agent, '') ~* 'linux' then 'linux_computer'
      else 'signed_in_device'
    end,
    'browserLabel', case
      when coalesce(s.user_agent, '') ~* 'edg/' then 'edge'
      when coalesce(s.user_agent, '') ~* 'firefox/' then 'firefox'
      when coalesce(s.user_agent, '') ~* 'chrome/|crios/' then 'chrome'
      when coalesce(s.user_agent, '') ~* 'safari/' then 'safari'
      else 'browser'
    end,
    'current', s.id = current_session,
    'createdAt', s.created_at,
    'lastActiveAt', coalesce(s.updated_at, s.created_at)
  ) order by (s.id = current_session) desc, coalesce(s.updated_at, s.created_at) desc), '[]'::jsonb)
  into payload
  from auth.sessions s
  where s.user_id = caller
    and (s.not_after is null or s.not_after > pg_catalog.now())
    and coalesce(s.updated_at, s.created_at) > pg_catalog.now() - interval '8 hours';

  return payload;
end;
$$;

revoke all on function public.list_my_sessions() from public, anon, authenticated;
grant execute on function public.list_my_sessions() to authenticated;

create function public.revoke_my_session(p_session_handle text)
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

  -- NULL covers legacy rows that predate session binding. Removing them may
  -- ask another active device to re-enable push, but never leaves a shared
  -- device receiving alerts after its Auth session was revoked.
  delete from public.member_push_subscriptions
  where user_id = caller
    and (session_handle = clean_handle or session_handle is null);
  get diagnostics push_removed = row_count;

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
    'pushSubscriptionsRemoved', push_removed);
end;
$$;

revoke all on function public.revoke_my_session(text) from public, anon, authenticated;
grant execute on function public.revoke_my_session(text) to authenticated;

-- Push cleanup must precede Auth logout. Global scope deletes every endpoint;
-- local scope deletes the current binding and any unbound legacy row. The
-- browser independently invalidates its Push API subscription.
create function public.prepare_my_signout(p_scope text)
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
  push_removed integer := 0;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  if clean_scope not in ('local', 'global') then
    raise exception 'invalid signout scope' using errcode = '22023';
  end if;

  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member-sessions:' || caller::text));

  if clean_scope = 'global' then
    delete from public.member_push_subscriptions
    where user_id = caller;
  else
    delete from public.member_push_subscriptions
    where user_id = caller
      and (session_handle = current_handle or session_handle is null);
  end if;
  get diagnostics push_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'scope', clean_scope,
    'pushSubscriptionsRemoved', push_removed,
    'serverCleanupComplete', true);
end;
$$;

revoke all on function public.prepare_my_signout(text) from public, anon, authenticated;
grant execute on function public.prepare_my_signout(text) to authenticated;

notify pgrst, 'reload schema';
