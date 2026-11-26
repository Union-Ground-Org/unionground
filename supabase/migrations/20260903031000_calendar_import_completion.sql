-- MI1 CR-090: opaque provider-event import and reconciliation.
--
-- OAuth remains optional and ships unset. Once an organization registers its
-- provider app and a steward consents, the existing scheduled sync imports a
-- bounded 60-day event window. Only a one-way hash of the provider event id,
-- its time range, all-day state, and provider update instant are retained.
-- Titles, attendees, descriptions, and locations never cross the API boundary.

set local lock_timeout = '5s';

alter table public.member_calendar_connections
  add column last_event_import_at timestamptz,
  add column last_event_import_count integer,
  add column last_event_import_window_start timestamptz,
  add column last_event_import_window_end timestamptz,
  add column last_event_import_error_at timestamptz,
  add column last_event_import_status text not null default 'pending'
    check (last_event_import_status in ('pending', 'complete', 'capacity_exceeded', 'error')),
  add constraint member_calendar_connections_import_status_complete check (
    (last_event_import_status = 'pending'
      and last_event_import_at is null and last_event_import_count is null
      and last_event_import_window_start is null and last_event_import_window_end is null
      and last_event_import_error_at is null)
    or (last_event_import_status = 'complete' and last_event_import_at is not null
      and last_event_import_count between 0 and 500
      and last_event_import_window_start is not null
      and last_event_import_window_end > last_event_import_window_start
      and last_event_import_error_at is null)
    or (last_event_import_status = 'capacity_exceeded'
      and last_event_import_at is not null and last_event_import_count is null
      and last_event_import_window_start is null and last_event_import_window_end is null
      and last_event_import_error_at is null)
    or (last_event_import_status = 'error' and last_event_import_error_at is not null
      and ((last_event_import_at is null and last_event_import_count is null
        and last_event_import_window_start is null and last_event_import_window_end is null)
        or (last_event_import_at is not null and last_event_import_count between 0 and 500
          and last_event_import_window_start is not null
          and last_event_import_window_end > last_event_import_window_start)
        or (last_event_import_at is not null and last_event_import_count is null
          and last_event_import_window_start is null and last_event_import_window_end is null)))
  );

create table public.member_calendar_import_events (
  steward_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  provider_event_key text not null
    check (provider_event_key ~ '^[0-9a-f]{64}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  source_updated_at timestamptz,
  imported_at timestamptz not null default pg_catalog.now(),
  primary key (steward_id, provider, provider_event_key),
  constraint member_calendar_import_events_time_order check (ends_at > starts_at)
);

create index member_calendar_import_events_steward_window_idx
  on public.member_calendar_import_events (steward_id, starts_at, ends_at);

alter table public.member_calendar_import_events enable row level security;
alter table public.member_calendar_import_events force row level security;

create policy mfa_assurance
  on public.member_calendar_import_events
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy member_calendar_import_events_owner_read
  on public.member_calendar_import_events for select to authenticated
  using (steward_id = (select auth.uid()) and (select private.mfa_satisfied()));

revoke all on table public.member_calendar_import_events
  from public, anon, authenticated, service_role;

create or replace function public.replace_calendar_import_events(
  p_steward uuid,
  p_provider text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item record;
  event_key text;
  event_start timestamptz;
  event_end timestamptz;
  source_updated timestamptz;
  imported_count integer := 0;
begin
  if (select auth.role()) <> 'service_role'
     or p_steward is null or p_provider not in ('google', 'microsoft')
     or p_window_start is null or p_window_end is null
     or p_window_end <= p_window_start
     or p_window_end > p_window_start + interval '61 days'
     or pg_catalog.jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 500 then
    raise exception 'invalid calendar import' using errcode = '22023';
  end if;
  perform 1 from public.member_calendar_connections connection
  where connection.steward_id = p_steward
    and connection.provider = p_provider
    and connection.status = 'active'
  for update;
  if not found then raise exception 'active connection required' using errcode = '42501'; end if;

  delete from public.member_calendar_import_events event
  where event.steward_id = p_steward and event.provider = p_provider;

  for item in select value from pg_catalog.jsonb_array_elements(p_events)
  loop
    event_key := pg_catalog.btrim(coalesce(item.value ->> 'eventKey', ''));
    begin
      event_start := (item.value ->> 'startsAt')::timestamptz;
      event_end := (item.value ->> 'endsAt')::timestamptz;
      source_updated := nullif(item.value ->> 'sourceUpdatedAt', '')::timestamptz;
    exception when others then
      raise exception 'invalid calendar event' using errcode = '22023';
    end;
    if event_key !~ '^[0-9a-f]{64}$'
       -- Providers legitimately return long-running events that began before
       -- the requested window. Admit any event that overlaps the window;
       -- bounds on the response count and end keep the stored view finite.
       or event_start >= p_window_end
       or event_end <= event_start
       or event_end <= p_window_start then
      raise exception 'invalid calendar event' using errcode = '22023';
    end if;
    insert into public.member_calendar_import_events (
      steward_id, provider, provider_event_key, starts_at, ends_at,
      all_day, source_updated_at, imported_at
    ) values (
      p_steward, p_provider, event_key, event_start, event_end,
      coalesce((item.value ->> 'allDay')::boolean, false),
      source_updated, pg_catalog.now()
    ) on conflict (steward_id, provider, provider_event_key) do update
      set starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          all_day = excluded.all_day,
          source_updated_at = excluded.source_updated_at,
          imported_at = excluded.imported_at;
    imported_count := imported_count + 1;
  end loop;
  update public.member_calendar_connections connection
  set last_event_import_at = pg_catalog.now(),
      last_event_import_count = imported_count,
      last_event_import_window_start = p_window_start,
      last_event_import_window_end = p_window_end,
      last_event_import_error_at = null,
      last_event_import_status = 'complete',
      updated_at = pg_catalog.now()
  where connection.steward_id = p_steward and connection.provider = p_provider;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'provider', p_provider, 'imported', imported_count
  );
end;
$function$;

-- More than 500 events cannot be represented inside the deliberately bounded
-- privacy-preserving import. Clear only the reconciliation view and its status;
-- the active OAuth connection and independently computed free/busy windows stay
-- healthy and current.
create function public.clear_calendar_import_events(
  p_steward uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.role()) <> 'service_role'
     or p_steward is null or p_provider not in ('google', 'microsoft') then
    raise exception 'service role and valid provider required' using errcode = '42501';
  end if;
  perform 1 from public.member_calendar_connections connection
  where connection.steward_id = p_steward
    and connection.provider = p_provider
    and connection.status = 'active'
  for update;
  if not found then raise exception 'active connection required' using errcode = '42501'; end if;
  delete from public.member_calendar_import_events event
  where event.steward_id = p_steward and event.provider = p_provider;
  update public.member_calendar_connections connection
  set last_event_import_at = pg_catalog.now(),
      last_event_import_count = null,
      last_event_import_window_start = null,
      last_event_import_window_end = null,
      last_event_import_error_at = null,
      last_event_import_status = 'capacity_exceeded',
      updated_at = pg_catalog.now()
  where connection.steward_id = p_steward and connection.provider = p_provider;
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider, 'cleared', true);
end;
$function$;

-- An event-page or reconciliation failure is independent of the free/busy
-- refresh. Preserve the active connection, current busy windows, and any last
-- complete opaque event view; record only a bounded status and attempt time.
create function public.mark_calendar_import_error(
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
  set last_event_import_error_at = pg_catalog.now(),
      last_event_import_status = 'error',
      updated_at = pg_catalog.now()
  where connection.steward_id = p_steward
    and connection.provider = p_provider
    and connection.status = 'active';
  if not found then raise exception 'active connection required' using errcode = '42501'; end if;
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider);
end;
$function$;

create function public.get_my_calendar_import_status()
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
      'windowEndsAt', connection.last_event_import_window_end
    ) order by connection.provider)
    from public.member_calendar_connections connection
    where connection.steward_id = caller
  ), '[]'::jsonb);
end;
$function$;

-- Provider failure clears both availability suppression and the imported
-- reconciliation view so a stale import never presents as current.
create or replace function public.mark_calendar_connection_error(
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
  set status = 'error', updated_at = pg_catalog.now(),
      last_event_import_at = null, last_event_import_count = null,
      last_event_import_window_start = null, last_event_import_window_end = null,
      last_event_import_error_at = null,
      last_event_import_status = 'pending'
  where steward_id = p_steward and provider = p_provider;
  delete from public.member_calendar_busy
  where steward_id = p_steward and provider = p_provider;
  delete from public.member_calendar_import_events
  where steward_id = p_steward and provider = p_provider;
  return pg_catalog.jsonb_build_object('ok', true, 'provider', p_provider);
end;
$function$;

create or replace function public.remove_calendar_connection(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid());
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
  delete from public.member_calendar_import_events
  where steward_id = caller and provider = p_provider;
  delete from public.member_calendar_connections
  where steward_id = caller and provider = p_provider;
  delete from private.steward_calendar_oauth_tokens
  where steward_id = caller and provider = p_provider;
  return pg_catalog.jsonb_build_object('provider', p_provider, 'removed', true);
end;
$function$;

revoke all on function public.replace_calendar_import_events(uuid, text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.get_my_calendar_import_status()
  from public, anon, authenticated, service_role;
revoke all on function public.clear_calendar_import_events(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_calendar_import_error(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_calendar_import_events(uuid, text, timestamptz, timestamptz, jsonb)
  to service_role;
grant execute on function public.get_my_calendar_import_status() to authenticated;
grant execute on function public.clear_calendar_import_events(uuid, text) to service_role;
grant execute on function public.mark_calendar_import_error(uuid, text) to service_role;

comment on table public.member_calendar_import_events is
  'Owner-private opaque provider-event reconciliation; deliberately excludes titles, attendees, descriptions, and locations.';
