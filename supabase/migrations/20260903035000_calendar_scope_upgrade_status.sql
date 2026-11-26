-- MI1 CR-090: make legacy provider grants actionable.
--
-- Google connections created for the original free/busy-only integration do
-- not have event-read consent. Keep private OAuth scopes private, but derive a
-- single steward-visible boolean so the setup surface can request re-consent
-- instead of displaying an indefinitely pending import.

set local lock_timeout = '5s';

create or replace function public.get_my_calendar_import_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'provider', connection.provider,
      'status', connection.status,
      'importStatus', connection.last_event_import_status,
      'eventCount', coalesce(connection.last_event_import_count, 0),
      'lastImportedAt', connection.last_event_import_at,
      'lastImportErrorAt', connection.last_event_import_error_at,
      'windowStartsAt', connection.last_event_import_window_start,
      'windowEndsAt', connection.last_event_import_window_end,
      'scopeUpgradeRequired', connection.status = 'active' and (
        token.steward_id is null
        or case connection.provider
          when 'google' then not (
            pg_catalog.regexp_split_to_array(
              pg_catalog.btrim(coalesce(token.scopes, '')),
              '[[:space:]]+'
            ) && array[
              'https://www.googleapis.com/auth/calendar.readonly',
              'https://www.googleapis.com/auth/calendar'
            ]::text[]
          )
          when 'microsoft' then not (
            pg_catalog.regexp_split_to_array(
              pg_catalog.btrim(coalesce(token.scopes, '')),
              '[[:space:]]+'
            ) && array['Calendars.ReadBasic', 'Calendars.Read']::text[]
          )
          else true
        end
      )
    ) order by connection.provider)
    from public.member_calendar_connections connection
    left join private.steward_calendar_oauth_tokens token
      on token.steward_id = connection.steward_id
     and token.provider = connection.provider
    where connection.steward_id = caller
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_my_calendar_import_status()
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_calendar_import_status() to authenticated;

comment on function public.get_my_calendar_import_status() is
  'Steward-only opaque import summary; derives a reconnect flag without exposing private OAuth scopes.';

-- The original daily fixed-stride rotation could skip the same rows forever
-- whenever provider latency let a run finish fewer rows than the predicted
-- stride. Order the private worker inventory by the timestamp that every
-- completed success/error attempt already advances. A timed-out provider call
-- uses the service-only marker below during the reserved cleanup window.
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

create function public.mark_steward_calendar_sync_attempt(
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
  update public.member_calendar_connections connection
  set updated_at = pg_catalog.now()
  where connection.steward_id = p_steward
    and connection.provider = p_provider
    and connection.status <> 'revoked'
    and exists (
      select 1
      from private.steward_calendar_oauth_tokens token
      where token.steward_id = connection.steward_id
        and token.provider = connection.provider
    );
  if not found then
    raise exception 'calendar token unavailable' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider);
end;
$function$;

revoke all on function public.list_steward_calendar_oauth_tokens()
  from public, anon, authenticated, service_role;
revoke all on function public.mark_steward_calendar_sync_attempt(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_steward_calendar_oauth_tokens() to service_role;
grant execute on function public.mark_steward_calendar_sync_attempt(uuid, text) to service_role;

comment on function public.mark_steward_calendar_sync_attempt(uuid, text) is
  'Advances bounded calendar-sync fairness after a provider attempt consumes the request budget.';
