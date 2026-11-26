-- MI1 CR-091 / UB-APPT-01 / UB-CON-10: steward OAuth token custody for free-busy.
-- Public calendar tables stay token-free. This private schema holds short-lived
-- PKCE state and wrapped refresh tokens. No seed, no default provider app.

set local lock_timeout = '5s';

create table private.calendar_oauth_states (
  state text primary key check (pg_catalog.char_length(state) between 24 and 128),
  steward_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  code_verifier text not null check (pg_catalog.char_length(code_verifier) between 32 and 128),
  redirect_uri text not null check (pg_catalog.char_length(redirect_uri) between 20 and 300),
  browser_binding_hash text not null check (pg_catalog.char_length(browser_binding_hash) = 43),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null
);

create table private.steward_calendar_oauth_tokens (
  steward_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  refresh_token_ciphertext text not null check (pg_catalog.char_length(refresh_token_ciphertext) between 40 and 4000),
  wrap_key_id text not null default 'v1',
  scopes text not null default '' check (pg_catalog.char_length(scopes) <= 500),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (steward_id, provider)
);

alter table private.calendar_oauth_states enable row level security;
alter table private.steward_calendar_oauth_tokens enable row level security;
revoke all on private.calendar_oauth_states from public, anon, authenticated, service_role;
revoke all on private.steward_calendar_oauth_tokens from public, anon, authenticated, service_role;

create function public.save_calendar_oauth_state(
  p_state text,
  p_steward uuid,
  p_provider text,
  p_code_verifier text,
  p_redirect_uri text,
  p_browser_binding_hash text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider not in ('google', 'microsoft') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  if p_browser_binding_hash is null or pg_catalog.char_length(p_browser_binding_hash) <> 43 then
    raise exception 'browser binding required' using errcode = '22023';
  end if;
  delete from private.calendar_oauth_states
  where expires_at < pg_catalog.now()
     or (steward_id = p_steward and provider = p_provider);
  insert into private.calendar_oauth_states (
    state, steward_id, provider, code_verifier, redirect_uri, browser_binding_hash, expires_at
  ) values (
    p_state, p_steward, p_provider, p_code_verifier, p_redirect_uri, p_browser_binding_hash, p_expires_at
  );
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider);
end;
$function$;

create function public.consume_calendar_oauth_state(
  p_state text,
  p_browser_binding_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare saved private.calendar_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  delete from private.calendar_oauth_states where expires_at < pg_catalog.now();
  delete from private.calendar_oauth_states
  where state = p_state
    and browser_binding_hash = p_browser_binding_hash
  returning * into saved;
  if not found then
    raise exception 'state unavailable' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'stewardId', saved.steward_id,
    'provider', saved.provider,
    'codeVerifier', saved.code_verifier,
    'redirectUri', saved.redirect_uri
  );
end;
$function$;

create function public.upsert_steward_calendar_oauth_token(
  p_steward uuid,
  p_provider text,
  p_refresh_token_ciphertext text,
  p_scopes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider not in ('google', 'microsoft') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  -- Lock the public connection through this write. If Remove won the race,
  -- fail closed; if it is waiting, its delete runs next and removes this token.
  perform 1
  from public.member_calendar_connections c
  where c.steward_id = p_steward
    and c.provider = p_provider
    and c.status <> 'revoked'
  for update;
  if not found then
    raise exception 'no connection for this steward and provider' using errcode = '22023';
  end if;
  insert into private.steward_calendar_oauth_tokens (
    steward_id, provider, refresh_token_ciphertext, scopes
  ) values (
    p_steward, p_provider, p_refresh_token_ciphertext, coalesce(p_scopes, '')
  )
  on conflict (steward_id, provider) do update
    set refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        scopes = excluded.scopes,
        updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider);
end;
$function$;

create function public.list_steward_calendar_oauth_tokens()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'stewardId', t.steward_id,
      'provider', t.provider,
      'refreshTokenCiphertext', t.refresh_token_ciphertext,
      'scopes', t.scopes
    ) order by t.steward_id, t.provider)
    from private.steward_calendar_oauth_tokens t
  ), '[]'::jsonb);
end;
$function$;

create function public.delete_steward_calendar_oauth_token(
  p_steward uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  delete from private.steward_calendar_oauth_tokens
  where steward_id = p_steward and provider = p_provider;
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider);
end;
$function$;

-- A failed provider sync must not leave stale busy windows suppressing member
-- appointment slots while the connection still presents as active.
create function public.mark_calendar_connection_error(
  p_steward uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_steward is null or p_provider not in ('google', 'microsoft') then
    raise exception 'valid steward and provider required' using errcode = '22023';
  end if;
  update public.member_calendar_connections
  set status = 'error', updated_at = pg_catalog.now()
  where steward_id = p_steward and provider = p_provider;
  delete from public.member_calendar_busy
  where steward_id = p_steward and provider = p_provider;
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider);
end;
$function$;

-- When a steward removes the public connection, drop private token custody too.
create or replace function public.remove_calendar_connection(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('google', 'microsoft') then
    raise exception 'provider must be google or microsoft' using errcode = '22023';
  end if;

  delete from public.member_calendar_busy
  where steward_id = caller and provider = p_provider;
  delete from public.member_calendar_connections
  where steward_id = caller and provider = p_provider;
  delete from private.steward_calendar_oauth_tokens
  where steward_id = caller and provider = p_provider;

  return pg_catalog.jsonb_build_object('provider', p_provider, 'removed', true);
end;
$function$;

revoke all on function public.save_calendar_oauth_state(text, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_calendar_oauth_state(text, text) from public, anon, authenticated;
revoke all on function public.upsert_steward_calendar_oauth_token(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.list_steward_calendar_oauth_tokens() from public, anon, authenticated;
revoke all on function public.delete_steward_calendar_oauth_token(uuid, text) from public, anon, authenticated;
revoke all on function public.mark_calendar_connection_error(uuid, text) from public, anon, authenticated;
grant execute on function public.save_calendar_oauth_state(text, uuid, text, text, text, text, timestamptz) to service_role;
grant execute on function public.consume_calendar_oauth_state(text, text) to service_role;
grant execute on function public.upsert_steward_calendar_oauth_token(uuid, text, text, text) to service_role;
grant execute on function public.list_steward_calendar_oauth_tokens() to service_role;
grant execute on function public.delete_steward_calendar_oauth_token(uuid, text) to service_role;
grant execute on function public.mark_calendar_connection_error(uuid, text) to service_role;
grant execute on function public.remove_calendar_connection(text) to authenticated;
