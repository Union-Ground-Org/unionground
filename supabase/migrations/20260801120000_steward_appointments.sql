-- REQ-UG-STEWARD-APPOINTMENTS-20260801
--
-- Native steward-appointment booking. The booking UX and availability model
-- borrow Cal.com's concepts — event types with fixed durations, a weekly
-- schedule in the steward's own IANA timezone, date blackouts, minimum notice,
-- before/after buffers, and round-robin assignment for "any steward" — but the
-- capability is built natively on Union Ground RLS, roles, chapter boundaries and
-- the notification pipeline. Nothing third-party is deployed.
--
-- Privacy by schema: an appointment carries a TYPE and a bounded REASON
-- CATEGORY and nothing else. There is deliberately no narrative column
-- anywhere in this feature — a grievance follow-up in a calendar must never
-- carry the grievance — so the sensitive-detail leak the design brief warns
-- about is impossible to write, not merely discouraged.
--
-- Slot computation is server-side in Postgres, where timezone arithmetic is
-- real: a wall-clock window ("Tuesdays 09:00-12:00 in America/New_York")
-- converts per-date with `at time zone`, so DST weeks shift with the steward
-- instead of drifting an hour like client-side offset math would. Clients only
-- FORMAT instants, never compute them.
--
-- External calendars (Google/Microsoft free-busy) get a seam, not a deploy:
-- member_calendar_connections records a steward's intent, member_calendar_busy
-- caches opaque busy windows, and the slot engine subtracts them when present.
-- The write path (set_calendar_busy) is service-role-only; it stays inert
-- until the owner provisions OAuth credentials for a sync worker. No token
-- ever lands in these tables.

set local lock_timeout = '5s';

-- The overlap guard needs gist equality on uuid; btree_gist provides the
-- default uuid opclass for gist. Default opclasses resolve via the catalog,
-- not search_path, so the extensions schema placement is safe here.
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------- schedules

create table public.member_appointment_schedules (
  steward_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'America/New_York',
  min_notice_minutes integer not null default 240
    check (min_notice_minutes between 0 and 20160),
  buffer_before_minutes integer not null default 10
    check (buffer_before_minutes between 0 and 120),
  buffer_after_minutes integer not null default 10
    check (buffer_after_minutes between 0 and 120),
  max_per_day integer not null default 6 check (max_per_day between 1 and 24),
  accepting boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Weekly recurring windows, stored as minutes-since-midnight in the schedule's
-- timezone. Minutes, not time columns: a time column invites reading it as a
-- UTC instant, and the whole point is that these are WALL CLOCK values whose
-- UTC meaning changes twice a year.
create table public.member_appointment_windows (
  id uuid primary key default extensions.gen_random_uuid(),
  steward_id uuid not null references public.member_appointment_schedules(steward_id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_minute smallint not null check (start_minute between 0 and 1425),
  end_minute smallint not null check (end_minute between 15 and 1440),
  constraint member_appointment_windows_ordered check (end_minute - start_minute >= 20)
);

-- Whole-day blocks in the schedule's timezone (vacations, trainings). Bounded
-- dates, no reason column: why a steward is away is not calendar data.
create table public.member_appointment_blackouts (
  id uuid primary key default extensions.gen_random_uuid(),
  steward_id uuid not null references auth.users(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  constraint member_appointment_blackouts_ordered check (end_date >= start_date),
  constraint member_appointment_blackouts_bounded check (end_date - start_date <= 370)
);

-- -------------------------------------------------------------- appointments

create table public.member_appointments (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  steward_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id),
  appointment_type text not null check (appointment_type in
    ('office_hours', 'grievance_followup', 'onboarding', 'contract_questions')),
  duration_minutes smallint not null check (duration_minutes in (20, 30, 45)),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed'
    check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  routed_via text not null check (routed_via in ('steward', 'chapter')),
  reason_category text not null default 'general' check (reason_category in
    ('general', 'pay', 'benefits', 'scheduling', 'safety', 'discipline', 'other')),
  rescheduled_from uuid references public.member_appointments(id) on delete set null,
  cancelled_by uuid references auth.users(id) on delete set null,
  reminder_day_sent_at timestamptz,
  reminder_hour_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_appointments_duration_agrees
    check (ends_at = starts_at + duration_minutes * interval '1 minute'),
  -- The hard double-booking guards. Buffers and caps live in the slot engine;
  -- these two are the invariants no race may break: one steward, one member,
  -- never two live appointments over the same instant.
  constraint member_appointments_steward_no_overlap
    exclude using gist (steward_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status = 'confirmed'),
  constraint member_appointments_member_no_overlap
    exclude using gist (user_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status = 'confirmed')
);

create index member_appointments_steward_idx
  on public.member_appointments (steward_id, starts_at) where status = 'confirmed';
create index member_appointments_user_idx
  on public.member_appointments (user_id, starts_at desc);

-- Feature-owned audit trail: every lifecycle transition, including the ones a
-- member never sees (reminders). member_admin_audit stays admin-plane-only;
-- this table is the participant-visible record.
create table public.member_appointment_events (
  id uuid primary key default extensions.gen_random_uuid(),
  appointment_id uuid not null references public.member_appointments(id) on delete cascade,
  actor uuid references auth.users(id) on delete set null,
  action text not null check (action in
    ('booked', 'rescheduled', 'cancelled', 'completed', 'no_show', 'reminder_sent')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index member_appointment_events_appointment_idx
  on public.member_appointment_events (appointment_id, created_at);

-- ------------------------------------------------- free-busy seam (inert)

create table public.member_calendar_connections (
  id uuid primary key default extensions.gen_random_uuid(),
  steward_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'error', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_calendar_connections_one_per_provider unique (steward_id, provider)
);

create table public.member_calendar_busy (
  id uuid primary key default extensions.gen_random_uuid(),
  steward_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  constraint member_calendar_busy_ordered check (ends_at > starts_at)
);

create index member_calendar_busy_steward_idx
  on public.member_calendar_busy (steward_id, starts_at);

-- ------------------------------------------------------------ RLS + grants

alter table public.member_appointment_schedules enable row level security;
alter table public.member_appointment_windows enable row level security;
alter table public.member_appointment_blackouts enable row level security;
alter table public.member_appointments enable row level security;
alter table public.member_appointment_events enable row level security;
alter table public.member_calendar_connections enable row level security;
alter table public.member_calendar_busy enable row level security;

-- Availability internals are steward-private: members never read schedules,
-- windows, blackouts or busy caches. They see SLOTS, through the definer RPC,
-- which is the free-busy privacy rule — bookable instants out, never why the
-- gaps exist.
create policy member_appointment_schedules_select_own on public.member_appointment_schedules
  for select to authenticated using ((select auth.uid()) = steward_id);
create policy member_appointment_windows_select_own on public.member_appointment_windows
  for select to authenticated using ((select auth.uid()) = steward_id);
create policy member_appointment_blackouts_select_own on public.member_appointment_blackouts
  for select to authenticated using ((select auth.uid()) = steward_id);
-- The steward arm re-checks the ROLE, not just the stored id (
-- HIGH): a revoked steward keeps their own bookings as a MEMBER only where
-- they are the booker — the assignment alone must stop answering once the
-- role is gone. The subquery reads the caller's own member_roles rows, which
-- member_roles_select_own already permits.
create policy member_appointments_select_participant on public.member_appointments
  for select to authenticated
  using ((select auth.uid()) = user_id
         or ((select auth.uid()) = steward_id and exists (
               select 1 from public.member_roles r
               where r.user_id = (select auth.uid()) and r.role = 'steward')));
create policy member_appointment_events_select_participant on public.member_appointment_events
  for select to authenticated using (exists (
    select 1 from public.member_appointments a
    where a.id = appointment_id
      and ((select auth.uid()) = a.user_id
           or ((select auth.uid()) = a.steward_id and exists (
                 select 1 from public.member_roles r
                 where r.user_id = (select auth.uid()) and r.role = 'steward')))));
create policy member_calendar_connections_select_own on public.member_calendar_connections
  for select to authenticated using ((select auth.uid()) = steward_id);
create policy member_calendar_busy_select_own on public.member_calendar_busy
  for select to authenticated using ((select auth.uid()) = steward_id);

-- These tables were born after the 20260724030000 mfa_assurance DO loop ran,
-- so each carries the restrictive step-up policy explicitly (the
-- 20260801040000 reward-tables precedent; the live contract sweep enforces it).
create policy mfa_assurance on public.member_appointment_schedules
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_appointment_windows
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_appointment_blackouts
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_appointments
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_appointment_events
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_calendar_connections
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_calendar_busy
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

-- RPC-only writes from day one (20260725120000 sole-writer contract): SELECT
-- is the only table privilege any client role holds on this feature.
revoke all on public.member_appointment_schedules from anon, authenticated;
revoke all on public.member_appointment_windows from anon, authenticated;
revoke all on public.member_appointment_blackouts from anon, authenticated;
revoke all on public.member_appointments from anon, authenticated;
revoke all on public.member_appointment_events from anon, authenticated;
revoke all on public.member_calendar_connections from anon, authenticated;
revoke all on public.member_calendar_busy from anon, authenticated;
grant select on public.member_appointment_schedules to authenticated;
grant select on public.member_appointment_windows to authenticated;
grant select on public.member_appointment_blackouts to authenticated;
grant select on public.member_appointments to authenticated;
grant select on public.member_appointment_events to authenticated;
grant select on public.member_calendar_connections to authenticated;
grant select on public.member_calendar_busy to authenticated;

create trigger member_appointment_schedules_touch
  before update on public.member_appointment_schedules
  for each row execute function private.touch_updated_at();
create trigger member_appointments_touch
  before update on public.member_appointments
  for each row execute function private.touch_updated_at();
create trigger member_calendar_connections_touch
  before update on public.member_calendar_connections
  for each row execute function private.touch_updated_at();

-- ------------------------------------------------------------ slot engine

-- Which stewards may this member book? Role row scoped to the member's
-- chapter (NULL chapter_id = org-wide steward), with an accepting schedule.
create function private.appointment_stewards_for_chapter(p_chapter text)
returns table (steward_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct r.user_id
  from public.member_roles r
  join public.member_appointment_schedules s
    on s.steward_id = r.user_id and s.accepting
  where r.role = 'steward'
    and (r.chapter_id is null or r.chapter_id = p_chapter)
$$;

revoke all on function private.appointment_stewards_for_chapter(text) from public, anon, authenticated;

-- One steward's open slots over a date span. Set-based and STABLE: expand the
-- weekly windows over the span's dates in the schedule's timezone, then
-- subtract minimum notice, blackout days, live bookings padded by the
-- steward's buffers, external busy windows, and full days.
create function private.appointment_slots_for(
  p_steward uuid,
  p_duration integer,
  p_from date,
  p_to date
)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with sched as (
    select s.steward_id, s.timezone, s.min_notice_minutes,
           s.buffer_before_minutes, s.buffer_after_minutes, s.max_per_day
    from public.member_appointment_schedules s
    where s.steward_id = p_steward and s.accepting
  ),
  candidate as (
    select
      ((d.slot_date::timestamp + pg_catalog.make_interval(mins => gs.m))
         at time zone sc.timezone) as slot_start,
      d.slot_date,
      gs.m as slot_minute,
      sc.steward_id, sc.timezone, sc.min_notice_minutes,
      sc.buffer_before_minutes, sc.buffer_after_minutes, sc.max_per_day
    from sched sc
    join public.member_appointment_windows w on w.steward_id = sc.steward_id
    join lateral (
      select gd::date as slot_date
      from pg_catalog.generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gd
    ) d on pg_catalog.date_part('dow', d.slot_date)::int = w.weekday
    cross join lateral pg_catalog.generate_series(
      w.start_minute::int, w.end_minute::int - p_duration, 15) gs(m)
  )
  select c.slot_start,
         c.slot_start + pg_catalog.make_interval(mins => p_duration) as slot_end
  from candidate c
  where c.slot_start >= now() + pg_catalog.make_interval(mins => c.min_notice_minutes)
    -- DST spring-forward guard ( HIGH): a wall time that does not
    -- exist on this date (02:30 on the jump day) normalizes forward when
    -- converted, landing OUTSIDE the declared window. A real wall time
    -- round-trips exactly; a normalized one does not — so demand the
    -- round-trip.
    and (c.slot_start at time zone c.timezone)
        = (c.slot_date::timestamp + pg_catalog.make_interval(mins => c.slot_minute))
    and not exists (
      select 1 from public.member_appointment_blackouts b
      where b.steward_id = c.steward_id
        and c.slot_date between b.start_date and b.end_date)
    and not exists (
      select 1 from public.member_appointments a
      where a.steward_id = c.steward_id and a.status = 'confirmed'
        and tstzrange(
              a.starts_at - pg_catalog.make_interval(mins => c.buffer_before_minutes),
              a.ends_at + pg_catalog.make_interval(mins => c.buffer_after_minutes))
            && tstzrange(c.slot_start,
                         c.slot_start + pg_catalog.make_interval(mins => p_duration)))
    and not exists (
      select 1 from public.member_calendar_busy z
      where z.steward_id = c.steward_id
        and tstzrange(z.starts_at, z.ends_at)
            && tstzrange(c.slot_start,
                         c.slot_start + pg_catalog.make_interval(mins => p_duration)))
    and (
      select pg_catalog.count(*) from public.member_appointments a2
      where a2.steward_id = c.steward_id and a2.status = 'confirmed'
        and (a2.starts_at at time zone c.timezone)::date = c.slot_date
    ) < c.max_per_day
  order by 1
$$;

revoke all on function private.appointment_slots_for(uuid, integer, date, date) from public, anon, authenticated;

-- Shared validation vocabulary. 22023 like every other input complaint.
create function private.assert_appointment_shape(p_type text, p_duration integer)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if p_type is null or p_type not in
    ('office_hours', 'grievance_followup', 'onboarding', 'contract_questions') then
    raise exception 'unknown appointment type' using errcode = '22023';
  end if;
  if p_duration is null or p_duration not in (20, 30, 45) then
    raise exception 'appointment length must be 20, 30 or 45 minutes' using errcode = '22023';
  end if;
end
$$;

revoke all on function private.assert_appointment_shape(text, integer) from public, anon, authenticated;

-- --------------------------------------------------------------- member RPCs

-- The stewards a member may book, with display names. A definer read, not a
-- profile-table widening: members get exactly (id, name, accepting) for the
-- stewards serving their chapter and nothing else.
create function public.get_bookable_stewards()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.steward_id,
      'name', coalesce(p.full_name, 'Chapter steward')) order by p.full_name)
    from private.appointment_stewards_for_chapter(caller_chapter) e
    left join public.member_profiles p on p.id = e.steward_id
  ), '[]'::jsonb);
end
$$;

revoke all on function public.get_bookable_stewards() from public, anon;
grant execute on function public.get_bookable_stewards() to authenticated;

-- Open slots for a type+duration over a date span, for one steward or for the
-- whole chapter ("any steward"). Returns bookable instants only — per-slot
-- steward identity and gap reasons deliberately stay server-side.
create function public.get_appointment_slots(
  p_type text,
  p_duration integer,
  p_from date,
  p_to date,
  p_steward uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.assert_appointment_shape(p_type, p_duration);
  -- One day of slack under "today" ( MEDIUM): the client sends the
  -- member's DEVICE-local date, and every US evening that date is already
  -- behind the session's UTC current_date. The min-notice filter inside the
  -- slot engine still refuses any instant in the past, so the slack cannot
  -- surface a bookable past slot.
  if p_from is null or p_to is null or p_from < current_date - 1
     or p_to < p_from or p_to > p_from + 31 then
    raise exception 'date span must start today or later and cover at most 31 days'
      using errcode = '22023';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  if p_steward is not null and not exists (
    select 1 from private.appointment_stewards_for_chapter(caller_chapter) e
    where e.steward_id = p_steward
  ) then
    raise exception 'steward unavailable' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('slots', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'startsAt', s.slot_start,
      'stewardCount', s.steward_count) order by s.slot_start)
    from (
      select f.slot_start, pg_catalog.count(distinct e.steward_id) as steward_count
      from private.appointment_stewards_for_chapter(caller_chapter) e
      cross join lateral private.appointment_slots_for(e.steward_id, p_duration, p_from, p_to) f
      where (p_steward is null or e.steward_id = p_steward)
        -- A member's own live bookings block the grid too: the member-side
        -- exclusion constraint would refuse the insert anyway, so the UI must
        -- not offer an instant the server is certain to bounce.
        and not exists (
          select 1 from public.member_appointments own
          where own.user_id = caller and own.status = 'confirmed'
            and tstzrange(own.starts_at, own.ends_at)
                && tstzrange(f.slot_start, f.slot_end))
      group by f.slot_start
      order by f.slot_start
      limit 750
    ) s
  ), '[]'::jsonb));
end
$$;

revoke all on function public.get_appointment_slots(text, integer, date, date, uuid) from public, anon;
grant execute on function public.get_appointment_slots(text, integer, date, date, uuid) to authenticated;

-- The member's own appointment record, with steward display names resolved
-- through the definer — the appointment is the relationship that justifies the
-- name, so member_profiles RLS never widens for it.
create function public.get_my_appointments()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', a.id,
      'stewardId', a.steward_id,
      'stewardName', coalesce(p.full_name, 'Chapter steward'),
      'type', a.appointment_type,
      'durationMinutes', a.duration_minutes,
      'startsAt', a.starts_at,
      'endsAt', a.ends_at,
      'status', a.status,
      'reasonCategory', a.reason_category,
      'routedVia', a.routed_via) order by a.starts_at desc)
    from (
      select * from public.member_appointments a0
      where a0.user_id = caller and a0.starts_at > now() - interval '90 days'
      order by a0.starts_at desc limit 100
    ) a
    left join public.member_profiles p on p.id = a.steward_id
  ), '[]'::jsonb);
end
$$;

revoke all on function public.get_my_appointments() from public, anon;
grant execute on function public.get_my_appointments() to authenticated;

-- Book. Chapter routing (p_steward null) assigns the least-loaded steward who
-- can honestly take the instant — Cal.com's round-robin, decided at booking
-- time so the slot is truly held. The advisory lock serialises rival bookings
-- per steward; the exclusion constraints are the backstop no race can pass.
create function public.book_appointment(
  p_type text,
  p_duration integer,
  p_starts_at timestamptz,
  p_steward uuid default null,
  p_reason text default 'general'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_name text;
  candidate record;
  chosen uuid;
  inserted public.member_appointments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.assert_appointment_shape(p_type, p_duration);
  if p_reason is null or p_reason not in
    ('general', 'pay', 'benefits', 'scheduling', 'safety', 'discipline', 'other') then
    raise exception 'unknown reason category' using errcode = '22023';
  end if;
  if p_starts_at is null or p_starts_at <= now() or p_starts_at > now() + interval '45 days' then
    raise exception 'appointment start is out of range' using errcode = '22023';
  end if;

  select p.chapter_id, p.full_name into caller_chapter, caller_name
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  -- Booking-volume cap: three live upcoming appointments per member. A bound,
  -- not a budget — cancel one to book another. The member-scoped advisory
  -- lock closes the race sol flagged (MEDIUM): two concurrent bookings at
  -- different stewards both counting 2 and both inserting. The gist
  -- constraints only stop OVERLAPPING rows; this cap needs its own
  -- serialisation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_appointments_cap:' || caller::text, 0));
  if (select pg_catalog.count(*) from public.member_appointments a
      where a.user_id = caller and a.status = 'confirmed' and a.ends_at > now()) >= 3 then
    raise exception 'you already have 3 upcoming appointments' using errcode = '22023';
  end if;

  -- Candidates who can honestly take this instant, least-loaded first. The
  -- per-steward advisory lock is taken BEFORE the slot is re-verified, so two
  -- rival bookings for the same steward serialise and the loser moves on to
  -- the next candidate (or an honest refusal) instead of a constraint bounce.
  for candidate in
    select e.steward_id,
           (select pg_catalog.count(*) from public.member_appointments a
            where a.steward_id = e.steward_id and a.status = 'confirmed'
              and a.ends_at > now()) as load
    from private.appointment_stewards_for_chapter(caller_chapter) e
    where (p_steward is null or e.steward_id = p_steward)
    order by 2, 1
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_appointments:' || candidate.steward_id::text, 0));
    if exists (
      select 1 from private.appointment_slots_for(
        candidate.steward_id, p_duration,
        (p_starts_at at time zone 'UTC')::date - 1,
        (p_starts_at at time zone 'UTC')::date + 1) f
      where f.slot_start = p_starts_at
    ) then
      chosen := candidate.steward_id;
      exit;
    end if;
  end loop;

  if chosen is null then
    raise exception 'that time is no longer available' using errcode = '22023';
  end if;

  begin
    insert into public.member_appointments (
      user_id, steward_id, chapter_id, appointment_type, duration_minutes,
      starts_at, ends_at, status, routed_via, reason_category
    ) values (
      caller, chosen, caller_chapter, p_type, p_duration,
      p_starts_at, p_starts_at + p_duration * interval '1 minute', 'confirmed',
      case when p_steward is null then 'chapter' else 'steward' end, p_reason
    ) returning * into inserted;
  exception when exclusion_violation then
    raise exception 'that time is no longer available' using errcode = '22023';
  end;

  insert into public.member_appointment_events (appointment_id, actor, action, detail)
  values (inserted.id, caller, 'booked', pg_catalog.jsonb_build_object(
    'type', inserted.appointment_type, 'durationMinutes', inserted.duration_minutes,
    'routedVia', inserted.routed_via));

  perform private.notify_member(caller, 'appointment.booked', '{}'::jsonb, 'appointments');
  perform private.notify_member(chosen, 'appointment.booked.steward',
    pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'A member')), 'appointments');

  return pg_catalog.jsonb_build_object(
    'id', inserted.id,
    'stewardId', inserted.steward_id,
    'stewardName', coalesce((select p.full_name from public.member_profiles p
                             where p.id = inserted.steward_id), 'Chapter steward'),
    'type', inserted.appointment_type,
    'durationMinutes', inserted.duration_minutes,
    'startsAt', inserted.starts_at,
    'endsAt', inserted.ends_at,
    'status', inserted.status,
    'reasonCategory', inserted.reason_category,
    'routedVia', inserted.routed_via);
end
$$;

revoke all on function public.book_appointment(text, integer, timestamptz, uuid, text) from public, anon;
grant execute on function public.book_appointment(text, integer, timestamptz, uuid, text) to authenticated;

-- Cancel: either participant, while the appointment is still live. The other
-- party is told — a quietly vanished appointment is a no-show factory.
create function public.cancel_appointment(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  appt public.member_appointments%rowtype;
  caller_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select a.* into appt from public.member_appointments a
  where a.id = p_id and a.status = 'confirmed'
    and (a.user_id = caller or a.steward_id = caller)
  for update;
  if appt.id is null then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  -- The steward arm requires the LIVE role ( HIGH): a revoked
  -- steward must not keep mutation authority over members' bookings.
  if caller <> appt.user_id and not public.member_has_role(array['steward']) then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  if appt.ends_at <= now() then
    raise exception 'this appointment already ended' using errcode = '22023';
  end if;

  update public.member_appointments
  set status = 'cancelled', cancelled_by = caller, updated_at = now()
  where id = appt.id;

  insert into public.member_appointment_events (appointment_id, actor, action)
  values (appt.id, caller, 'cancelled');

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;
  if caller = appt.user_id then
    perform private.notify_member(appt.steward_id, 'appointment.cancelled.steward',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'A member')), 'appointments');
  else
    perform private.notify_member(appt.user_id, 'appointment.cancelled', '{}'::jsonb, 'appointments');
  end if;

  return pg_catalog.jsonb_build_object('id', appt.id, 'status', 'cancelled');
end
$$;

revoke all on function public.cancel_appointment(uuid) from public, anon;
grant execute on function public.cancel_appointment(uuid) to authenticated;

-- Reschedule: cancel + rebook with the SAME steward in one transaction, linked
-- by rescheduled_from. Changing steward is a cancel and a fresh booking by
-- design — the link would lie about who agreed to what.
create function public.reschedule_appointment(p_id uuid, p_starts_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  appt public.member_appointments%rowtype;
  caller_name text;
  replacement public.member_appointments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_starts_at is null or p_starts_at <= now() or p_starts_at > now() + interval '45 days' then
    raise exception 'appointment start is out of range' using errcode = '22023';
  end if;

  select a.* into appt from public.member_appointments a
  where a.id = p_id and a.status = 'confirmed'
    and (a.user_id = caller or a.steward_id = caller)
  for update;
  if appt.id is null then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  -- Same live-role demand as cancel ( HIGH).
  if caller <> appt.user_id and not public.member_has_role(array['steward']) then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  if appt.starts_at <= now() then
    raise exception 'this appointment already started' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_appointments:' || appt.steward_id::text, 0));

  -- Cancel FIRST so the old row stops blocking its own window; if the new
  -- instant fails validation the whole transaction unwinds it.
  update public.member_appointments
  set status = 'cancelled', cancelled_by = caller, updated_at = now()
  where id = appt.id;

  if not exists (
    select 1 from private.appointment_slots_for(
      appt.steward_id, appt.duration_minutes,
      (p_starts_at at time zone 'UTC')::date - 1,
      (p_starts_at at time zone 'UTC')::date + 1) f
    where f.slot_start = p_starts_at
  ) then
    raise exception 'that time is no longer available' using errcode = '22023';
  end if;

  begin
    insert into public.member_appointments (
      user_id, steward_id, chapter_id, appointment_type, duration_minutes,
      starts_at, ends_at, status, routed_via, reason_category, rescheduled_from
    ) values (
      appt.user_id, appt.steward_id, appt.chapter_id, appt.appointment_type,
      appt.duration_minutes, p_starts_at,
      p_starts_at + appt.duration_minutes * interval '1 minute', 'confirmed',
      appt.routed_via, appt.reason_category, appt.id
    ) returning * into replacement;
  exception when exclusion_violation then
    raise exception 'that time is no longer available' using errcode = '22023';
  end;

  insert into public.member_appointment_events (appointment_id, actor, action, detail)
  values (appt.id, caller, 'rescheduled',
          pg_catalog.jsonb_build_object('replacementId', replacement.id)),
         (replacement.id, caller, 'booked',
          pg_catalog.jsonb_build_object('rescheduledFrom', appt.id));

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;
  if caller = appt.user_id then
    perform private.notify_member(appt.steward_id, 'appointment.rescheduled.steward',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'A member')), 'appointments');
  else
    perform private.notify_member(appt.user_id, 'appointment.rescheduled', '{}'::jsonb, 'appointments');
  end if;

  return pg_catalog.jsonb_build_object(
    'id', replacement.id,
    'startsAt', replacement.starts_at,
    'endsAt', replacement.ends_at,
    'status', replacement.status,
    'rescheduledFrom', appt.id);
end
$$;

revoke all on function public.reschedule_appointment(uuid, timestamptz) from public, anon;
grant execute on function public.reschedule_appointment(uuid, timestamptz) to authenticated;

-- --------------------------------------------------------------- steward RPCs

-- Outcome marking, the no-show tracker's write path: only the assigned
-- steward, only after the appointment ended, only from 'confirmed'.
create function public.mark_appointment_outcome(p_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  appt public.member_appointments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('completed', 'no_show') then
    raise exception 'outcome must be completed or no_show' using errcode = '22023';
  end if;

  select a.* into appt from public.member_appointments a
  where a.id = p_id and a.steward_id = caller and a.status = 'confirmed'
  for update;
  if appt.id is null then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  if appt.ends_at > now() then
    raise exception 'the appointment has not ended yet' using errcode = '22023';
  end if;

  update public.member_appointments
  set status = p_outcome, updated_at = now() where id = appt.id;

  insert into public.member_appointment_events (appointment_id, actor, action)
  values (appt.id, caller, p_outcome);

  return pg_catalog.jsonb_build_object('id', appt.id, 'status', p_outcome);
end
$$;

revoke all on function public.mark_appointment_outcome(uuid, text) from public, anon;
grant execute on function public.mark_appointment_outcome(uuid, text) to authenticated;

-- The steward desk payload: own schedule + windows + blackouts + connections,
-- the live upcoming list, the recent record, and the no-show count that makes
-- the tracking real. Names resolve through the definer — the appointment is
-- the relationship that justifies them.
create function public.get_steward_appointments()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'schedule', (
      select pg_catalog.jsonb_build_object(
        'timezone', s.timezone,
        'minNoticeMinutes', s.min_notice_minutes,
        'bufferBeforeMinutes', s.buffer_before_minutes,
        'bufferAfterMinutes', s.buffer_after_minutes,
        'maxPerDay', s.max_per_day,
        'accepting', s.accepting)
      from public.member_appointment_schedules s where s.steward_id = caller),
    'windows', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', w.id, 'weekday', w.weekday,
        'startMinute', w.start_minute, 'endMinute', w.end_minute)
        order by w.weekday, w.start_minute)
      from public.member_appointment_windows w where w.steward_id = caller), '[]'::jsonb),
    'blackouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', b.id, 'startDate', b.start_date, 'endDate', b.end_date)
        order by b.start_date)
      from public.member_appointment_blackouts b
      where b.steward_id = caller and b.end_date >= current_date), '[]'::jsonb),
    'connections', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'provider', c.provider, 'status', c.status) order by c.provider)
      from public.member_calendar_connections c where c.steward_id = caller), '[]'::jsonb),
    'upcoming', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Member'),
        'type', a.appointment_type,
        'durationMinutes', a.duration_minutes,
        'startsAt', a.starts_at,
        'endsAt', a.ends_at,
        'status', a.status,
        'reasonCategory', a.reason_category,
        'routedVia', a.routed_via) order by a.starts_at)
      from (
        -- ALL still-confirmed rows, including ended-but-unmarked ones (sol
        -- review HIGH): the desk's completed/no-show buttons unlock on rows
        -- whose end has passed, so an ended row filtered out here would make
        -- outcome marking unreachable in live data. The 30-day floor bounds
        -- the unmarked backlog.
        select * from public.member_appointments a0
        where a0.steward_id = caller and a0.status = 'confirmed'
          and a0.starts_at > now() - interval '30 days'
        order by a0.starts_at limit 100
      ) a
      left join public.member_profiles p on p.id = a.user_id), '[]'::jsonb),
    'recent', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Member'),
        'type', a.appointment_type,
        'durationMinutes', a.duration_minutes,
        'startsAt', a.starts_at,
        'status', a.status) order by a.starts_at desc)
      from (
        -- Settled rows only; ended-but-unmarked confirmed rows stay in
        -- 'upcoming' where the outcome buttons live.
        select * from public.member_appointments a0
        where a0.steward_id = caller
          and a0.status in ('completed', 'no_show', 'cancelled')
          and a0.starts_at > now() - interval '30 days'
        order by a0.starts_at desc limit 50
      ) a
      left join public.member_profiles p on p.id = a.user_id), '[]'::jsonb),
    'stats', pg_catalog.jsonb_build_object(
      'noShows30d', (
        select pg_catalog.count(*) from public.member_appointments a
        where a.steward_id = caller and a.status = 'no_show'
          and a.starts_at > now() - interval '30 days'),
      'completed30d', (
        select pg_catalog.count(*) from public.member_appointments a
        where a.steward_id = caller and a.status = 'completed'
          and a.starts_at > now() - interval '30 days')));
end
$$;

revoke all on function public.get_steward_appointments() from public, anon;
grant execute on function public.get_steward_appointments() to authenticated;

-- Schedule settings. Timezone must be a real IANA name — the same
-- pg_timezone_names validation the quiet-hours trigger uses.
create function public.set_appointment_schedule(
  p_timezone text default null,
  p_min_notice_minutes integer default null,
  p_buffer_before_minutes integer default null,
  p_buffer_after_minutes integer default null,
  p_max_per_day integer default null,
  p_accepting boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  tz text;
  saved public.member_appointment_schedules%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  tz := coalesce(p_timezone,
    (select s.timezone from public.member_appointment_schedules s where s.steward_id = caller),
    (select p.quiet_hours_timezone from public.member_profiles p where p.id = caller),
    'America/New_York');
  if not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = tz) then
    raise exception 'unknown timezone' using errcode = '22023';
  end if;
  if p_min_notice_minutes is not null and (p_min_notice_minutes < 0 or p_min_notice_minutes > 20160) then
    raise exception 'minimum notice must be between 0 minutes and 14 days' using errcode = '22023';
  end if;
  if p_buffer_before_minutes is not null and (p_buffer_before_minutes < 0 or p_buffer_before_minutes > 120) then
    raise exception 'buffers must be between 0 and 120 minutes' using errcode = '22023';
  end if;
  if p_buffer_after_minutes is not null and (p_buffer_after_minutes < 0 or p_buffer_after_minutes > 120) then
    raise exception 'buffers must be between 0 and 120 minutes' using errcode = '22023';
  end if;
  if p_max_per_day is not null and (p_max_per_day < 1 or p_max_per_day > 24) then
    raise exception 'daily cap must be between 1 and 24' using errcode = '22023';
  end if;

  insert into public.member_appointment_schedules as s (
    steward_id, timezone, min_notice_minutes, buffer_before_minutes,
    buffer_after_minutes, max_per_day, accepting
  ) values (
    caller, tz, coalesce(p_min_notice_minutes, 240),
    coalesce(p_buffer_before_minutes, 10), coalesce(p_buffer_after_minutes, 10),
    coalesce(p_max_per_day, 6), coalesce(p_accepting, true)
  )
  on conflict (steward_id) do update set
    timezone = tz,
    min_notice_minutes = coalesce(p_min_notice_minutes, s.min_notice_minutes),
    buffer_before_minutes = coalesce(p_buffer_before_minutes, s.buffer_before_minutes),
    buffer_after_minutes = coalesce(p_buffer_after_minutes, s.buffer_after_minutes),
    max_per_day = coalesce(p_max_per_day, s.max_per_day),
    accepting = coalesce(p_accepting, s.accepting),
    updated_at = now()
  returning * into saved;

  return pg_catalog.jsonb_build_object(
    'timezone', saved.timezone,
    'minNoticeMinutes', saved.min_notice_minutes,
    'bufferBeforeMinutes', saved.buffer_before_minutes,
    'bufferAfterMinutes', saved.buffer_after_minutes,
    'maxPerDay', saved.max_per_day,
    'accepting', saved.accepting);
end
$$;

revoke all on function public.set_appointment_schedule(text, integer, integer, integer, integer, boolean) from public, anon;
grant execute on function public.set_appointment_schedule(text, integer, integer, integer, integer, boolean) to authenticated;

-- Replace-all weekly windows: the editor submits the whole week, the server
-- validates the whole week. Overlap inside a weekday is refused here — the
-- table CHECK cannot see across rows.
create function public.set_appointment_windows(p_windows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  n integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_windows is null or pg_catalog.jsonb_typeof(p_windows) <> 'array' then
    raise exception 'windows must be a list' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_windows) > 28 then
    raise exception 'at most 28 weekly windows' using errcode = '22023';
  end if;
  if not exists (select 1 from public.member_appointment_schedules s where s.steward_id = caller) then
    -- First save from a fresh steward: give them the default schedule so the
    -- windows have something to hang off.
    insert into public.member_appointment_schedules (steward_id, timezone)
    values (caller, coalesce(
      (select p.quiet_hours_timezone from public.member_profiles p where p.id = caller),
      'America/New_York'));
  end if;

  drop table if exists pg_temp._incoming_windows;
  create temp table _incoming_windows on commit drop as
  select (w.value ->> 'weekday')::int as weekday,
         (w.value ->> 'startMinute')::int as start_minute,
         (w.value ->> 'endMinute')::int as end_minute
  from pg_catalog.jsonb_array_elements(p_windows) w;

  if exists (
    select 1 from _incoming_windows i
    where i.weekday is null or i.weekday not between 0 and 6
       or i.start_minute is null or i.start_minute not between 0 and 1425
       or i.end_minute is null or i.end_minute not between 15 and 1440
       or i.end_minute - i.start_minute < 20
  ) then
    raise exception 'each window needs a weekday and an end at least 20 minutes after its start'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from _incoming_windows a
    join _incoming_windows b
      on a.weekday = b.weekday
     and (a.start_minute, a.end_minute) <> (b.start_minute, b.end_minute)
     and a.start_minute < b.end_minute and b.start_minute < a.end_minute
  ) or exists (
    select 1 from _incoming_windows a
    group by a.weekday, a.start_minute, a.end_minute
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'windows on the same day must not overlap' using errcode = '22023';
  end if;

  delete from public.member_appointment_windows where steward_id = caller;
  insert into public.member_appointment_windows (steward_id, weekday, start_minute, end_minute)
  select caller, i.weekday, i.start_minute, i.end_minute from _incoming_windows i;
  get diagnostics n = row_count;

  return pg_catalog.jsonb_build_object('count', n);
end
$$;

revoke all on function public.set_appointment_windows(jsonb) from public, anon;
grant execute on function public.set_appointment_windows(jsonb) to authenticated;

create function public.add_appointment_blackout(p_start_date date, p_end_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  saved public.member_appointment_blackouts%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date
     or p_end_date < current_date or p_end_date - p_start_date > 370 then
    raise exception 'blackout dates are out of range' using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from public.member_appointment_blackouts b
      where b.steward_id = caller and b.end_date >= current_date) >= 60 then
    raise exception 'too many blackout spans' using errcode = '22023';
  end if;

  insert into public.member_appointment_blackouts (steward_id, start_date, end_date)
  values (caller, p_start_date, p_end_date)
  returning * into saved;

  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'startDate', saved.start_date, 'endDate', saved.end_date);
end
$$;

revoke all on function public.add_appointment_blackout(date, date) from public, anon;
grant execute on function public.add_appointment_blackout(date, date) to authenticated;

create function public.remove_appointment_blackout(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  n integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  delete from public.member_appointment_blackouts
  where id = p_id and steward_id = caller;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'blackout unavailable' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('id', p_id, 'removed', true);
end
$$;

revoke all on function public.remove_appointment_blackout(uuid) from public, anon;
grant execute on function public.remove_appointment_blackout(uuid) to authenticated;

-- Free-busy connection intent. 'pending' is an honest state: it records that
-- the steward asked, and stays pending until the owner provisions the OAuth
-- application that lets a sync worker call set_calendar_busy.
create function public.request_calendar_connection(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  saved public.member_calendar_connections%rowtype;
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

  insert into public.member_calendar_connections as c (steward_id, provider)
  values (caller, p_provider)
  on conflict (steward_id, provider) do update
    set status = case when c.status = 'revoked' then 'pending' else c.status end,
        updated_at = now()
  returning * into saved;

  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'provider', saved.provider, 'status', saved.status);
end
$$;

revoke all on function public.request_calendar_connection(text) from public, anon;
grant execute on function public.request_calendar_connection(text) to authenticated;

create function public.remove_calendar_connection(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

  return pg_catalog.jsonb_build_object('provider', p_provider, 'removed', true);
end
$$;

revoke all on function public.remove_calendar_connection(text) from public, anon;
grant execute on function public.remove_calendar_connection(text) to authenticated;

-- The sync worker's write path (service-role only; no client can reach it).
-- Replaces the provider's cached busy windows wholesale — opaque instants in,
-- nothing about what fills them.
create function public.set_calendar_busy(
  p_steward uuid,
  p_provider text,
  p_windows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_provider is null or p_provider not in ('google', 'microsoft') then
    raise exception 'provider must be google or microsoft' using errcode = '22023';
  end if;
  if p_windows is null or pg_catalog.jsonb_typeof(p_windows) <> 'array'
     or pg_catalog.jsonb_array_length(p_windows) > 500 then
    raise exception 'windows must be a list of at most 500 spans' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.member_calendar_connections c
    where c.steward_id = p_steward and c.provider = p_provider and c.status <> 'revoked'
  ) then
    raise exception 'no connection for this steward and provider' using errcode = '22023';
  end if;

  delete from public.member_calendar_busy
  where steward_id = p_steward and provider = p_provider;

  insert into public.member_calendar_busy (steward_id, provider, starts_at, ends_at)
  select p_steward, p_provider,
         (w.value ->> 'startsAt')::timestamptz,
         (w.value ->> 'endsAt')::timestamptz
  from pg_catalog.jsonb_array_elements(p_windows) w
  where (w.value ->> 'startsAt') is not null
    and (w.value ->> 'endsAt') is not null
    and (w.value ->> 'endsAt')::timestamptz > (w.value ->> 'startsAt')::timestamptz
    and (w.value ->> 'endsAt')::timestamptz > now() - interval '1 day'
    and (w.value ->> 'startsAt')::timestamptz < now() + interval '60 days';
  get diagnostics n = row_count;

  update public.member_calendar_connections
  set status = 'active', updated_at = now()
  where steward_id = p_steward and provider = p_provider;

  return pg_catalog.jsonb_build_object('count', n);
end
$$;

revoke all on function public.set_calendar_busy(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_calendar_busy(uuid, text, jsonb) to service_role;

-- ------------------------------------------------------- reminders (sweep)

-- No future-dated send exists in the pipeline, so reminders are a sweep: every
-- tick, stamp-and-notify the confirmed appointments entering the 24h and 1h
-- windows. The stamp is what makes overlapping ticks idempotent; SKIP LOCKED
-- keeps two ticks from racing the same row.
create function private.appointment_reminder_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select a.id, a.user_id from public.member_appointments a
    where a.status = 'confirmed' and a.reminder_day_sent_at is null
      and a.starts_at > now() and a.starts_at <= now() + interval '24 hours'
    for update skip locked
  loop
    update public.member_appointments
    set reminder_day_sent_at = now() where id = r.id;
    perform private.notify_member(r.user_id, 'appointment.reminder.day', '{}'::jsonb, 'appointments');
    insert into public.member_appointment_events (appointment_id, actor, action, detail)
    values (r.id, null, 'reminder_sent', pg_catalog.jsonb_build_object('window', '24h'));
  end loop;

  for r in
    select a.id, a.user_id, a.steward_id from public.member_appointments a
    where a.status = 'confirmed' and a.reminder_hour_sent_at is null
      and a.starts_at > now() and a.starts_at <= now() + interval '1 hour'
    for update skip locked
  loop
    update public.member_appointments
    set reminder_hour_sent_at = now() where id = r.id;
    perform private.notify_member(r.user_id, 'appointment.reminder.hour', '{}'::jsonb, 'appointments');
    perform private.notify_member(r.steward_id, 'appointment.reminder.hour.steward', '{}'::jsonb, 'appointments');
    insert into public.member_appointment_events (appointment_id, actor, action, detail)
    values (r.id, null, 'reminder_sent', pg_catalog.jsonb_build_object('window', '1h'));
  end loop;
end
$$;

revoke all on function private.appointment_reminder_sweep() from public, anon, authenticated, service_role;

-- Same guard shape as 20260723204000: environments without pg_cron (local
-- shadow DBs, CI) skip scheduling without failing the apply.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    return;
  end if;
  execute 'create extension if not exists pg_cron';

  perform cron.unschedule(jobid) from cron.job where jobname = 'appointment-reminders-tick';
  perform cron.schedule(
    'appointment-reminders-tick',
    '*/10 * * * *',
    $job$ select private.appointment_reminder_sweep(); $job$);
end
$$;

-- --------------------------------------------- notification topic + copy

-- Eighth topic: 'appointments'. Same NOT VALID swap + executable VALIDATE as
-- the 'tasks' topic (20260728221658) — the new list strictly contains the old
-- one, so validation provably succeeds.
alter table public.member_notifications
  drop constraint if exists member_notifications_kind_check;
alter table public.member_notifications
  add constraint member_notifications_kind_check
  check (kind in ('general', 'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments'))
  not valid;

-- Re-emit the single outbound enforcement point with 'appointments' added to
-- the ONE topic list. Body is 20260728221658's verbatim otherwise: the
-- control-flag read, the no-cast prefs rule, the per-recipient advisory lock,
-- the three caps, the visible 'skipped' suppression rows, the sharded org
-- counter, and both exception branches.
create or replace function private.enqueue_notification_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefs jsonb;
  pref_value jsonb;
  outbound_on boolean;
  recent_hour integer;
  recent_day integer;
  org_today integer;
  limit_reason text;
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_org_day constant integer := 20000;
begin
  -- 'general' is in-app only and must never reach a provider. Short-circuit
  -- before the control flag, before prefs, before anything. 'appointments'
  -- joins the topical kinds (2026-08-01, steward appointments).
  if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments') then
    return new;
  end if;

  begin
    select c.outbound_enabled into outbound_on
      from private.notification_controls c where c.id;
    if not coalesce(outbound_on, false) then
      return new;
    end if;

    select p.notification_prefs into prefs
      from public.member_profiles p where p.id = new.user_id;

    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then
      return new;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0));

    select pg_catalog.count(*) into recent_hour
      from public.member_notification_deliveries d
      where d.user_id = new.user_id
        and d.created_at > pg_catalog.now() - interval '1 hour';

    select pg_catalog.count(*) into recent_day
      from public.member_notification_deliveries d
      where d.user_id = new.user_id
        and d.created_at > pg_catalog.now() - interval '24 hours';

    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.notification_outbound_counters c
      where c.day = current_date;

    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;

    if limit_reason is not null then
      insert into public.member_notification_deliveries (notification_id, user_id, channel, status, last_error)
      values (new.id, new.user_id, 'email', 'skipped', limit_reason)
      on conflict (notification_id, channel) do nothing;
      return new;
    end if;

    insert into private.notification_outbound_counters (day, shard, enqueued)
    values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
    on conflict (day, shard) do update
      set enqueued = private.notification_outbound_counters.enqueued + 1;

    insert into public.member_notification_deliveries (notification_id, user_id, channel)
    values (new.id, new.user_id, 'email')
    on conflict (notification_id, channel) do nothing;

    insert into public.member_notification_deliveries (notification_id, user_id, channel)
    select new.id, new.user_id, 'push'
    where exists (select 1 from public.member_push_subscriptions s where s.user_id = new.user_id)
    on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;

  return new;
end;
$$;

revoke all on function private.enqueue_notification_deliveries() from public, anon, authenticated, service_role;

-- Spell the topic into the default prefs shape (absent keys already mean
-- enabled, so no backfill).
alter table public.member_profiles
  alter column notification_prefs
  set default '{"deadlines": true, "cases": true, "forms": true, "votes": true, "events": true, "tasks": true, "appointments": true}'::jsonb;

comment on constraint member_notifications_kind_check on public.member_notifications is
  'Topic classification. general = in-app only, never outbound. appointments added 2026-08-01: booking lifecycle + reminders; no notice names an appointment type or any case detail, which is what makes it safe on a lock screen.';

-- Copy, EN + ES. Shoulder rule throughout: no notice names the appointment
-- TYPE (a lock screen must not say "grievance"), a member, or a time — the
-- app holds the details.
insert into private.notification_copy (key, lang, title, body) values
  ('appointment.booked', 'en', 'Appointment confirmed', 'Your appointment is booked. Open Appointments for the details.'),
  ('appointment.booked', 'es', 'Cita confirmada', 'Tu cita quedó reservada. Abre Citas para ver los detalles.'),
  ('appointment.booked.steward', 'en', '{name} booked time with you', 'Open your steward desk to see your schedule.'),
  ('appointment.booked.steward', 'es', '{name} reservó tiempo contigo', 'Abre tu mesa de delegado para ver tu agenda.'),
  ('appointment.cancelled', 'en', 'An appointment was cancelled', 'Open Appointments to see your updated schedule.'),
  ('appointment.cancelled', 'es', 'Se canceló una cita', 'Abre Citas para ver tu agenda actualizada.'),
  ('appointment.cancelled.steward', 'en', '{name} cancelled an appointment', 'Open your steward desk to see your updated schedule.'),
  ('appointment.cancelled.steward', 'es', '{name} canceló una cita', 'Abre tu mesa de delegado para ver tu agenda actualizada.'),
  ('appointment.rescheduled', 'en', 'An appointment was rescheduled', 'Open Appointments to see the new time.'),
  ('appointment.rescheduled', 'es', 'Se reprogramó una cita', 'Abre Citas para ver el nuevo horario.'),
  ('appointment.rescheduled.steward', 'en', '{name} rescheduled an appointment', 'Open your steward desk to see the new time.'),
  ('appointment.rescheduled.steward', 'es', '{name} reprogramó una cita', 'Abre tu mesa de delegado para ver el nuevo horario.'),
  ('appointment.reminder.day', 'en', 'Appointment coming up', 'You have an appointment within the next day. Open Appointments for the details.'),
  ('appointment.reminder.day', 'es', 'Cita próxima', 'Tienes una cita dentro del próximo día. Abre Citas para ver los detalles.'),
  ('appointment.reminder.hour', 'en', 'Appointment soon', 'Your appointment starts within the hour. Open Appointments for the details.'),
  ('appointment.reminder.hour', 'es', 'Cita en breve', 'Tu cita comienza dentro de una hora. Abre Citas para ver los detalles.'),
  ('appointment.reminder.hour.steward', 'en', 'Member appointment soon', 'An appointment on your steward schedule starts within the hour.'),
  ('appointment.reminder.hour.steward', 'es', 'Cita de miembro en breve', 'Una cita de tu agenda de delegado comienza dentro de una hora.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- Validate the swapped CHECK as an executable statement (house style).
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.member_notifications'::regclass
      and conname = 'member_notifications_kind_check'
      and not convalidated
  ) then
    alter table public.member_notifications
      validate constraint member_notifications_kind_check;
  end if;
end
$$;

do $$
declare
  unvalidated integer;
begin
  select pg_catalog.count(*) into unvalidated
  from pg_constraint
  where conname = 'member_notifications_kind_check'
    and not convalidated;
  if unvalidated > 0 then
    raise exception 'appointments topic: member_notifications_kind_check still NOT VALID after validation';
  end if;
end
$$;

notify pgrst, 'reload schema';
