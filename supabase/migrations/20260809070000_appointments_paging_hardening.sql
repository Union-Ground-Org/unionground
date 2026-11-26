-- Appointments paging hardening ( two MED findings on
-- 20260809060000, which is already applied and therefore immutable):
--
--   1. p_scope NULL slipped past the closed-set check — SQL `null not in
--      (...)` evaluates to NULL, so the IF never fired and a NULL scope fell
--      through to the recent branch instead of raising 22023. The guard now
--      names null explicitly. (Still gated and self-scoped either way; this
--      is contract honesty, not a leak.)
--   2. The blob's jsonb_agg display order carried no id tiebreak. Page
--      BOUNDARIES were already deterministic (the inner selects order by
--      (starts_at, id)), but settled rows can tie on starts_at, so the
--      rendered order of a tie could disagree with the pager's continuation
--      order. Both aggregates now tiebreak on id like everything else.
--
-- Full re-creates: CREATE OR REPLACE keeps only the body, so every attribute
-- (definer + empty search_path) is restated.
create or replace function public.list_steward_appointments(
  p_scope text default 'upcoming',
  p_after_starts timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  member_name text,
  appointment_type text,
  duration_minutes integer,
  starts_at timestamptz,
  ends_at timestamptz,
  status text,
  reason_category text,
  routed_via text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  total bigint;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('upcoming', 'recent') then
    raise exception 'unknown scope' using errcode = '22023';
  end if;
  if (p_after_id is null) <> (p_after_starts is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;

  if p_scope = 'upcoming' then
    -- ALL still-confirmed rows, including ended-but-unmarked ones: the desk's
    -- completed/no-show buttons unlock on rows whose end has passed, and
    -- ascending order puts exactly those rows on page one. The 30-day floor
    -- bounds the unmarked backlog, same window as the blob.
    select count(*) into total
    from public.member_appointments a
    where a.steward_id = caller and a.status = 'confirmed'
      and a.starts_at > now() - interval '30 days';

    return query
    select a.id, coalesce(p.full_name, 'Member'), a.appointment_type,
           (a.duration_minutes)::integer, a.starts_at, a.ends_at, a.status,
           a.reason_category, a.routed_via, total
    from public.member_appointments a
    left join public.member_profiles p on p.id = a.user_id
    where a.steward_id = caller and a.status = 'confirmed'
      and a.starts_at > now() - interval '30 days'
      and (p_after_id is null or (a.starts_at, a.id) > (p_after_starts, p_after_id))
    order by a.starts_at asc, a.id asc
    limit page_limit;
  else
    -- Settled rows only; ended-but-unmarked confirmed rows stay in
    -- 'upcoming' where the outcome buttons live.
    select count(*) into total
    from public.member_appointments a
    where a.steward_id = caller
      and a.status in ('completed', 'no_show', 'cancelled')
      and a.starts_at > now() - interval '30 days';

    return query
    select a.id, coalesce(p.full_name, 'Member'), a.appointment_type,
           (a.duration_minutes)::integer, a.starts_at, a.ends_at, a.status,
           a.reason_category, a.routed_via, total
    from public.member_appointments a
    left join public.member_profiles p on p.id = a.user_id
    where a.steward_id = caller
      and a.status in ('completed', 'no_show', 'cancelled')
      and a.starts_at > now() - interval '30 days'
      and (p_after_id is null or (a.starts_at, a.id) < (p_after_starts, p_after_id))
    order by a.starts_at desc, a.id desc
    limit page_limit;
  end if;
end;
$$;

revoke all on function public.list_steward_appointments(text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_steward_appointments(text, timestamptz, uuid, integer) to authenticated, service_role;

create or replace function public.get_steward_appointments()
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
        'routedVia', a.routed_via) order by a.starts_at, a.id)
      from (
        -- ALL still-confirmed rows, including ended-but-unmarked ones (sol
        -- review HIGH): the desk's completed/no-show buttons unlock on rows
        -- whose end has passed, so an ended row filtered out here would make
        -- outcome marking unreachable in live data. The 30-day floor bounds
        -- the unmarked backlog. One pager page (50): list_steward_appointments
        -- walks the rest, and upcomingTotal below discloses the cut.
        select * from public.member_appointments a0
        where a0.steward_id = caller and a0.status = 'confirmed'
          and a0.starts_at > now() - interval '30 days'
        order by a0.starts_at, a0.id limit 50
      ) a
      left join public.member_profiles p on p.id = a.user_id), '[]'::jsonb),
    'upcomingTotal', (
      select pg_catalog.count(*) from public.member_appointments a
      where a.steward_id = caller and a.status = 'confirmed'
        and a.starts_at > now() - interval '30 days'),
    'recent', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Member'),
        'type', a.appointment_type,
        'durationMinutes', a.duration_minutes,
        'startsAt', a.starts_at,
        'status', a.status) order by a.starts_at desc, a.id desc)
      from (
        -- Settled rows only; ended-but-unmarked confirmed rows stay in
        -- 'upcoming' where the outcome buttons live. One pager page (20).
        select * from public.member_appointments a0
        where a0.steward_id = caller
          and a0.status in ('completed', 'no_show', 'cancelled')
          and a0.starts_at > now() - interval '30 days'
        order by a0.starts_at desc, a0.id desc limit 20
      ) a
      left join public.member_profiles p on p.id = a.user_id), '[]'::jsonb),
    'recentTotal', (
      select pg_catalog.count(*) from public.member_appointments a
      where a.steward_id = caller
        and a.status in ('completed', 'no_show', 'cancelled')
        and a.starts_at > now() - interval '30 days'),
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
