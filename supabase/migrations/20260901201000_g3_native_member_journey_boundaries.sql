set local lock_timeout = '5s';

-- This unmerged repair is ordered after the 20:00 assurance migration already
-- present on Main so every environment receives the same forward-only lineage.

-- Appointment participation follows the currently selected chapter. A stored
-- steward assignment is not enough after that steward loses the active chapter
-- role or switches to another chapter.
drop policy if exists member_appointments_select_participant on public.member_appointments;
create policy member_appointments_select_participant on public.member_appointments
  for select to authenticated
  using (
    member_appointments.chapter_id = private.current_member_chapter()
    and (
      (select auth.uid()) = user_id
      or (
        (select auth.uid()) = steward_id
        and private.member_has_chapter_role(member_appointments.chapter_id, array['steward'])
      )
    )
  );

drop policy if exists member_appointment_events_select_participant on public.member_appointment_events;
create policy member_appointment_events_select_participant on public.member_appointment_events
  for select to authenticated
  using (exists (
    select 1
    from public.member_appointments a
    where a.id = appointment_id
      and a.chapter_id = private.current_member_chapter()
      and (
        (select auth.uid()) = a.user_id
        or (
          (select auth.uid()) = a.steward_id
          and private.member_has_chapter_role(a.chapter_id, array['steward'])
        )
      )
  ));

-- The supervisor report predates multi-chapter memberships. Keep its bounded,
-- privacy-safe projection while replacing the legacy global role checks with
-- the selected-chapter role helper.
create or replace function public.list_chapter_appointments(
  p_after_starts timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  member_name text,
  appointment_type text,
  duration_minutes smallint,
  starts_at timestamptz,
  ends_at timestamptz,
  status text,
  steward_id uuid,
  steward_name text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  bounded_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
begin
  if caller is null
    or not private.mfa_satisfied()
    or caller_chapter is null
    or not private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin']) then
    raise exception 'appointment supervision unavailable' using errcode = '42501';
  end if;

  if (p_after_starts is null) <> (p_after_id is null) then
    raise exception 'appointment cursor is incomplete' using errcode = '22023';
  end if;

  return query
  with chapter_total as (
    select pg_catalog.count(*)::bigint as total_count
    from public.member_appointments counted
    where counted.chapter_id = caller_chapter
  )
  select
    a.id,
    coalesce(member.full_name, 'Member')::text as member_name,
    a.appointment_type,
    a.duration_minutes,
    a.starts_at,
    a.ends_at,
    a.status,
    a.steward_id,
    coalesce(steward.full_name, 'Chapter steward')::text as steward_name,
    chapter_total.total_count
  from public.member_appointments a
  left join public.member_profiles member on member.id = a.user_id
  left join public.member_profiles steward on steward.id = a.steward_id
  cross join chapter_total
  where a.chapter_id = caller_chapter
    and (
      p_after_starts is null
      or (a.starts_at, a.id) < (p_after_starts, p_after_id)
    )
  order by a.starts_at desc, a.id desc
  limit bounded_limit;
end;
$function$;

revoke all on function public.list_chapter_appointments(timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_chapter_appointments(timestamptz, uuid, integer) to authenticated, service_role;

-- A participant can read their own history. An assigned steward must still
-- hold the active Steward role in this selected chapter. Broader chapter reads
-- belong only to the established supervisor roles.
create or replace function public.get_appointment_history(
  p_appointment_id uuid,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  appointment public.member_appointments%rowtype;
  history_items jsonb;
  history_count integer;
  next_before timestamptz;
  next_before_id uuid;
begin
  if caller is null or not private.mfa_satisfied()
     or p_appointment_id is null or p_limit not between 1 and 50
     or ((p_before is null) <> (p_before_id is null)) then
    raise exception 'history unavailable' using errcode = '22023';
  end if;

  select * into appointment
  from public.member_appointments
  where id = p_appointment_id;

  if not found or not (
    appointment.chapter_id = private.current_member_chapter()
    and (
      caller = appointment.user_id
      or (
          caller = appointment.steward_id
          and private.member_has_chapter_role(appointment.chapter_id, array['steward'])
      )
      or private.member_has_chapter_role(appointment.chapter_id, array['coordinator','advisor','admin'])
    )
  ) then
    raise exception 'history unavailable' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id, 'action', e.action, 'createdAt', e.created_at,
      'actorKind', case when e.actor is null then 'system'
                        when e.actor = appointment.user_id then 'member'
                        when e.actor = appointment.steward_id then 'steward'
                        else 'chapter-staff' end,
      'detail', e.detail - 'calendarReason' - 'busyReason'
    ) order by e.created_at desc, e.id desc), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    pg_catalog.min(e.created_at),
    (pg_catalog.array_agg(e.id order by e.created_at asc, e.id asc))[1]
  into history_items, history_count, next_before, next_before_id
  from (
    select *
    from public.member_appointment_events history
    where history.appointment_id = appointment.id
      and (p_before is null or (history.created_at, history.id) < (p_before, p_before_id))
    order by history.created_at desc, history.id desc
    limit p_limit
  ) e;

  return pg_catalog.jsonb_build_object(
    'appointment', pg_catalog.jsonb_build_object(
      'id', appointment.id, 'startsAt', appointment.starts_at, 'endsAt', appointment.ends_at,
      'status', appointment.status, 'appointmentType', appointment.appointment_type,
      'reasonCategory', appointment.reason_category
    ),
    'items', history_items,
    'nextBefore', case when history_count = p_limit then next_before else null end,
    'nextBeforeID', case when history_count = p_limit then next_before_id else null end
  );
end;
$function$;

revoke all on function public.get_appointment_history(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.get_appointment_history(uuid, timestamptz, uuid, integer) to authenticated, service_role;
