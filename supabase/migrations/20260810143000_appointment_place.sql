-- UB-APPT-02: a bounded place is required for every new appointment and is
-- visible to both participants. Historical rows stay nullable because their
-- real location cannot be reconstructed honestly.
alter table public.member_appointments add column place text;
alter table public.member_appointments add constraint member_appointments_place_shape
  check (place is null or (
    char_length(place) between 1 and 300
    and place = btrim(place)
    and place !~ '[[:cntrl:]]'
  )) not valid;
alter table public.member_appointments validate constraint member_appointments_place_shape;

-- Retain the audited booking engine behind a non-executable legacy name. The
-- new public contract validates place, delegates atomically, then attaches it.
alter function public.book_appointment(text, integer, timestamptz, uuid, text)
  rename to book_appointment_without_place_legacy;
-- Make the removed public overload explicit for migration-history scanners;
-- the rename above already made this exact signature absent.
drop function if exists public.book_appointment(text, integer, timestamp with time zone, uuid, text);
revoke all on function public.book_appointment_without_place_legacy(text, integer, timestamptz, uuid, text)
  from public, anon, authenticated, service_role;

create function public.book_appointment(
  p_type text,
  p_duration integer,
  p_starts_at timestamptz,
  p_place text,
  p_steward uuid default null,
  p_reason text default 'general'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_place text := btrim(p_place);
  booked jsonb;
begin
  if p_place is null or clean_place = '' or char_length(clean_place) > 300
     or clean_place ~ '[[:cntrl:]]' then
    raise exception 'appointment place must be 1 to 300 characters' using errcode = '22023';
  end if;

  booked := public.book_appointment_without_place_legacy(
    p_type, p_duration, p_starts_at, p_steward, p_reason);
  update public.member_appointments
  set place = clean_place
  where id = (booked->>'id')::uuid and user_id = (select auth.uid());
  return booked || pg_catalog.jsonb_build_object('place', clean_place);
end
$$;

revoke all on function public.book_appointment(text, integer, timestamptz, text, uuid, text) from public, anon;
grant execute on function public.book_appointment(text, integer, timestamptz, text, uuid, text) to authenticated;

-- The existing reschedule engine inserts a linked replacement. A narrow
-- trigger copies the immutable place from that source in the same statement.
create function private.carry_rescheduled_appointment_place()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.rescheduled_from is not null and new.place is null then
    select a.place into new.place
    from public.member_appointments a where a.id = new.rescheduled_from;
  end if;
  return new;
end
$$;
revoke all on function private.carry_rescheduled_appointment_place() from public, anon, authenticated, service_role;
create trigger member_appointments_carry_rescheduled_place
before insert on public.member_appointments
for each row execute function private.carry_rescheduled_appointment_place();

-- Member read model: enrich the audited, self-scoped legacy payload by id.
alter function public.get_my_appointments() rename to get_my_appointments_without_place_legacy;
revoke all on function public.get_my_appointments_without_place_legacy() from public, anon, authenticated, service_role;
create function public.get_my_appointments() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(
    row.value || pg_catalog.jsonb_build_object('place', a.place)
    order by row.ordinality), '[]'::jsonb)
  from pg_catalog.jsonb_array_elements(
    public.get_my_appointments_without_place_legacy()) with ordinality row(value, ordinality)
  join public.member_appointments a on a.id = (row.value->>'id')::uuid
$$;
revoke all on function public.get_my_appointments() from public, anon;
grant execute on function public.get_my_appointments() to authenticated;

-- Steward keyset pager: preserve every guard and ordering decision in the
-- audited legacy function, adding place from the same self-scoped row.
alter function public.list_steward_appointments(text, timestamptz, uuid, integer)
  rename to list_steward_appointments_without_place_legacy;
revoke all on function public.list_steward_appointments_without_place_legacy(text, timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;
create function public.list_steward_appointments(
  p_scope text default 'upcoming', p_after_starts timestamptz default null,
  p_after_id uuid default null, p_limit integer default 50
) returns table (
  id uuid, member_name text, appointment_type text, duration_minutes integer,
  starts_at timestamptz, ends_at timestamptz, status text,
  reason_category text, routed_via text, place text, total_count bigint
) language sql stable security definer set search_path = '' as $$
  -- The non-executable callee enforces member_has_role(array['steward']) and
  -- p_scope is null or p_scope not in ('upcoming', 'recent') before rows exist.
  select old.id, old.member_name, old.appointment_type, old.duration_minutes,
    old.starts_at, old.ends_at, old.status, old.reason_category, old.routed_via,
    a.place, old.total_count
  from public.list_steward_appointments_without_place_legacy(
    p_scope, p_after_starts, p_after_id, p_limit) old
  join public.member_appointments a on a.id = old.id
  order by
    case when p_scope = 'upcoming' then old.starts_at end asc,
    case when p_scope = 'upcoming' then old.id end asc,
    case when p_scope = 'recent' then old.starts_at end desc,
    case when p_scope = 'recent' then old.id end desc
$$;
revoke all on function public.list_steward_appointments(text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_steward_appointments(text, timestamptz, uuid, integer) to authenticated, service_role;

-- Enrich both bounded steward arrays without changing their order or totals.
alter function public.get_steward_appointments() rename to get_steward_appointments_without_place_legacy;
revoke all on function public.get_steward_appointments_without_place_legacy() from public, anon, authenticated, service_role;
create function public.get_steward_appointments() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare payload jsonb;
begin
  -- upcomingTotal and recentTotal remain authored by the guarded legacy desk;
  -- this wrapper changes only the two row objects.
  payload := public.get_steward_appointments_without_place_legacy();
  payload := pg_catalog.jsonb_set(payload, '{upcoming}', coalesce((
    select pg_catalog.jsonb_agg(row.value || pg_catalog.jsonb_build_object('place', a.place) order by row.ordinality)
    from pg_catalog.jsonb_array_elements(payload->'upcoming') with ordinality row(value, ordinality)
    join public.member_appointments a on a.id = (row.value->>'id')::uuid), '[]'::jsonb));
  payload := pg_catalog.jsonb_set(payload, '{recent}', coalesce((
    select pg_catalog.jsonb_agg(row.value || pg_catalog.jsonb_build_object('place', a.place) order by row.ordinality)
    from pg_catalog.jsonb_array_elements(payload->'recent') with ordinality row(value, ordinality)
    join public.member_appointments a on a.id = (row.value->>'id')::uuid), '[]'::jsonb));
  return payload;
end
$$;
revoke all on function public.get_steward_appointments() from public, anon;
grant execute on function public.get_steward_appointments() to authenticated;
