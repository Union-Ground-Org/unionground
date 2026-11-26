set local lock_timeout = '5s';

create index if not exists member_appointments_chapter_starts_id_idx
  on public.member_appointments (chapter_id, starts_at desc, id desc);

alter table public.member_appointment_events
  drop constraint if exists member_appointment_events_action_check;

alter table public.member_appointment_events
  add constraint member_appointment_events_action_check
  check (action = any (array['booked', 'rescheduled', 'reassigned', 'cancelled', 'completed', 'no_show', 'reminder_sent']));

insert into private.notification_copy (key, lang, title, body)
values
  ('appointment.reassigned.member', 'en', 'Your appointment assignment changed',
    'Open Appointments to review the current details.'),
  ('appointment.reassigned.member', 'es', 'Cambió la asignación de tu cita',
    'Abre Citas para revisar los detalles actuales.'),
  ('appointment.reassigned.previous_steward', 'en', 'An appointment moved off your schedule',
    'Open Appointments to review your current schedule.'),
  ('appointment.reassigned.previous_steward', 'es', 'Una cita salió de tu agenda',
    'Abre Citas para revisar tu agenda actual.'),
  ('appointment.reassigned.new_steward', 'en', 'An appointment was assigned to you',
    'Open Appointments to review your current schedule.'),
  ('appointment.reassigned.new_steward', 'es', 'Se te asignó una cita',
    'Abre Citas para revisar tu agenda actual.')
on conflict (key, lang) do update
set
  title = excluded.title,
  body = excluded.body;

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
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  bounded_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
begin
  if caller is null
    or not private.mfa_satisfied()
    or not public.member_has_role(array['coordinator', 'advisor', 'admin']) then
    raise exception 'appointment supervision unavailable' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;

  if caller_chapter is null
    or not exists (
      select 1
      from public.member_roles r
      where r.user_id = caller
        and r.role in ('coordinator', 'advisor', 'admin')
        and (r.chapter_id is null or r.chapter_id = caller_chapter)
    ) then
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
$$;

revoke all on function public.list_chapter_appointments(timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_chapter_appointments(timestamptz, uuid, integer) to authenticated, service_role;

create or replace function public.list_chapter_appointment_reassignment_candidates(
  p_appointment_id uuid
)
returns table (
  steward_id uuid,
  steward_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  appt public.member_appointments%rowtype;
begin
  if caller is null
    or not private.mfa_satisfied()
    or not public.member_has_role(array['coordinator', 'advisor', 'admin']) then
    raise exception 'appointment supervision unavailable' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;

  if caller_chapter is null
    or not exists (
      select 1
      from public.member_roles r
      where r.user_id = caller
        and r.role in ('coordinator', 'advisor', 'admin')
        and (r.chapter_id is null or r.chapter_id = caller_chapter)
    ) then
    raise exception 'appointment supervision unavailable' using errcode = '42501';
  end if;

  select a.*
  into appt
  from public.member_appointments a
  where a.id = p_appointment_id
    and a.chapter_id = caller_chapter
    and a.status = 'confirmed'
    and a.starts_at > now();

  if not found then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;

  return query
  select distinct
    r.user_id as steward_id,
    coalesce(profile.full_name, 'Chapter steward')::text as steward_name
  from public.member_roles r
  join public.member_appointment_schedules s
    on s.steward_id = r.user_id
   and s.accepting
  left join public.member_profiles profile on profile.id = r.user_id
  where r.role = 'steward'
    and (r.chapter_id is null or r.chapter_id = appt.chapter_id)
    and r.user_id <> appt.steward_id
    and exists (
      select 1
      from private.appointment_slots_for(
        r.user_id,
        appt.duration_minutes,
        (appt.starts_at at time zone 'UTC')::date - 1,
        (appt.starts_at at time zone 'UTC')::date + 1
      ) slot
      where slot.slot_start = appt.starts_at
    )
  order by steward_name, steward_id;
end;
$$;

revoke all on function public.list_chapter_appointment_reassignment_candidates(uuid) from public, anon;
grant execute on function public.list_chapter_appointment_reassignment_candidates(uuid) to authenticated, service_role;

create or replace function public.reassign_chapter_appointment(
  p_appointment_id uuid,
  p_steward_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  appt public.member_appointments%rowtype;
  old_steward uuid;
  member_name text;
  steward_name text;
begin
  if caller is null
    or not private.mfa_satisfied()
    or not public.member_has_role(array['coordinator', 'advisor', 'admin']) then
    raise exception 'appointment supervision unavailable' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;

  if caller_chapter is null
    or not exists (
      select 1
      from public.member_roles r
      where r.user_id = caller
        and r.role in ('coordinator', 'advisor', 'admin')
        and (r.chapter_id is null or r.chapter_id = caller_chapter)
    ) then
    raise exception 'appointment supervision unavailable' using errcode = '42501';
  end if;

  select a.*
  into appt
  from public.member_appointments a
  where a.id = p_appointment_id
    and a.chapter_id = caller_chapter
    and a.status = 'confirmed'
    and a.starts_at > now()
  for update;

  if not found or p_steward_id is null or p_steward_id = appt.steward_id then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;

  old_steward := appt.steward_id;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_appointments:' || p_steward_id::text, 0)
  );

  if not exists (
    select 1
    from public.member_roles r
    join public.member_appointment_schedules s
      on s.steward_id = r.user_id
     and s.accepting
    where r.user_id = p_steward_id
      and r.role = 'steward'
      and (r.chapter_id is null or r.chapter_id = appt.chapter_id)
      and exists (
        select 1
        from private.appointment_slots_for(
          r.user_id,
          appt.duration_minutes,
          (appt.starts_at at time zone 'UTC')::date - 1,
          (appt.starts_at at time zone 'UTC')::date + 1
        ) slot
        where slot.slot_start = appt.starts_at
      )
  ) then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;

  begin
    update public.member_appointments
    set steward_id = p_steward_id, updated_at = now()
    where id = appt.id;
  exception
    when exclusion_violation then
      raise exception 'appointment unavailable' using errcode = '22023';
  end;

  insert into public.member_appointment_events (
    appointment_id,
    action,
    actor,
    detail
  )
  values (
    appt.id,
    'reassigned',
    caller,
    pg_catalog.jsonb_build_object(
      'appointmentId', appt.id,
      'fromStewardId', old_steward,
      'toStewardId', p_steward_id
    )
  );

  perform private.notify_member(appt.user_id, 'appointment.reassigned.member', '{}'::jsonb, 'appointments');

  if old_steward is not null then
    perform private.notify_member(old_steward, 'appointment.reassigned.previous_steward', '{}'::jsonb, 'appointments');
  end if;

  perform private.notify_member(p_steward_id, 'appointment.reassigned.new_steward', '{}'::jsonb, 'appointments');

  select coalesce(profile.full_name, 'Member')::text
  into member_name
  from public.member_profiles profile
  where profile.id = appt.user_id;

  select coalesce(profile.full_name, 'Chapter steward')::text
  into steward_name
  from public.member_profiles profile
  where profile.id = p_steward_id;

  return pg_catalog.jsonb_build_object(
    'id', appt.id,
    'memberName', coalesce(member_name, 'Member'),
    'appointmentType', appt.appointment_type,
    'durationMinutes', appt.duration_minutes,
    'startsAt', appt.starts_at,
    'endsAt', appt.ends_at,
    'status', appt.status,
    'stewardId', p_steward_id,
    'stewardName', coalesce(steward_name, 'Chapter steward')
  );
end;
$$;

revoke all on function public.reassign_chapter_appointment(uuid, uuid) from public, anon;
grant execute on function public.reassign_chapter_appointment(uuid, uuid) to authenticated, service_role;
