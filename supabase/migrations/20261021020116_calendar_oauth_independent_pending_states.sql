-- A browser timeout does not stop an already-running server request. Keep
-- independent, browser-bound states until expiry so that a late predecessor
-- cannot invalidate the state returned by a successful retry.
begin;
set local lock_timeout = '5s';

create or replace function public.save_calendar_oauth_state(
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
  -- Preserve the lifecycle writer entry installed by the reconciliation migration.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider not in ('google', 'microsoft') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  if p_browser_binding_hash is null or pg_catalog.char_length(p_browser_binding_hash) <> 43 then
    raise exception 'browser binding required' using errcode = '22023';
  end if;
  delete from private.calendar_oauth_states where expires_at < pg_catalog.now();
  insert into private.calendar_oauth_states (
    state, steward_id, provider, code_verifier, redirect_uri, browser_binding_hash, expires_at
  ) values (
    p_state, p_steward, p_provider, p_code_verifier, p_redirect_uri, p_browser_binding_hash, p_expires_at
  );
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider);
end;
$function$;

revoke all on function public.save_calendar_oauth_state(text,uuid,text,text,text,text,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.save_calendar_oauth_state(text,uuid,text,text,text,text,timestamptz)
  to service_role;

-- OAuth start follows an explicit Request or Reconnect. Keep the existing
-- caller, MFA and steward checks, but never recreate intent after Remove.
create function public.authorize_calendar_oauth_start(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  saved public.member_calendar_connections%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('google', 'microsoft') then
    raise exception 'provider must be google or microsoft' using errcode = '22023';
  end if;
  update public.member_calendar_connections as c
  set status = case when c.status = 'revoked' then 'pending' else c.status end,
      updated_at = pg_catalog.now()
  where c.steward_id = caller and c.provider = p_provider
  returning c.* into saved;
  if not found then
    raise exception 'no connection for this steward and provider' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('id', saved.id, 'provider', saved.provider, 'status', saved.status);
end;
$function$;

revoke all on function public.authorize_calendar_oauth_start(text)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_calendar_oauth_start(text)
  to authenticated, service_role;
notify pgrst, 'reload schema';
commit;
