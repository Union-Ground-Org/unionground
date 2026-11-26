-- A provider-side grant revocation (Google/Microsoft invalid_grant) is
-- terminal: the stored refresh token is dead until the steward reconnects.
-- The sync worker could only record a generic 'error', which keeps the token
-- row and leaves the connection in the worker inventory, so every cron tick
-- refreshed the same dead grant, failed again and wiped the busy cache again,
-- indefinitely. Record the 'revoked' state the schema already defines, drop
-- the token custody a live grant justified, and carry the connection status
-- into the worker inventory so a revoked row is never re-attempted against
-- the provider.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.mark_calendar_connection_revoked(
  p_steward uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Case-graph entry gate first: the calendar rows and token custody below
  -- are account-graph relations that account deletion also takes.
  perform private.lock_case_graph(array[p_steward], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_steward is null or p_provider not in ('google', 'microsoft') then
    raise exception 'valid steward and provider required' using errcode = '22023';
  end if;
  update public.member_calendar_connections
  set status = 'revoked', updated_at = pg_catalog.now(),
      last_event_import_at = null, last_event_import_count = null,
      last_event_import_window_start = null, last_event_import_window_end = null,
      last_event_import_error_at = null,
      last_event_import_status = 'pending'
  where steward_id = p_steward and provider = p_provider;
  delete from public.member_calendar_busy
  where steward_id = p_steward and provider = p_provider;
  delete from public.member_calendar_import_events
  where steward_id = p_steward and provider = p_provider;
  -- Token custody exists only for a grant the provider still honours. Deleting
  -- the wrapped refresh token in the same transaction is what ends the retry
  -- loop: the worker inventory joins on this row.
  delete from private.steward_calendar_oauth_tokens
  where steward_id = p_steward and provider = p_provider;
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider, 'status', 'revoked');
end;
$function$;

-- The inventory keeps excluding revoked connections. Carrying the status as
-- well lets the worker refuse a provider call for a revoked row and report it
-- as skipped, instead of trusting one filter to be the only guard.
create or replace function public.list_steward_calendar_oauth_tokens()
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
      'stewardId', token.steward_id,
      'provider', token.provider,
      'refreshTokenCiphertext', token.refresh_token_ciphertext,
      'scopes', token.scopes,
      'status', connection.status,
      'lastSyncAttemptAt', connection.updated_at
    ) order by connection.updated_at, token.steward_id, token.provider)
    from private.steward_calendar_oauth_tokens token
    join public.member_calendar_connections connection
      on connection.steward_id = token.steward_id
     and connection.provider = token.provider
     and connection.status <> 'revoked'
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.mark_calendar_connection_revoked(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.list_steward_calendar_oauth_tokens()
  from public, anon, authenticated, service_role;
grant execute on function public.mark_calendar_connection_revoked(uuid, text) to service_role;
grant execute on function public.list_steward_calendar_oauth_tokens() to service_role;

comment on function public.mark_calendar_connection_revoked(uuid, text) is
  'Records a terminal provider grant revocation: revoked connection status, cleared derived calendar data, and deleted private token custody. Service-role only.';

notify pgrst, 'reload schema';

commit;
