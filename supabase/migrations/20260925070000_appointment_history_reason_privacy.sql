-- SEC-UG-APPOINTMENT-HISTORY-REASON-PRIVACY-20260921
--
-- Appointment history remains readable by the booking member, the assigned
-- steward who still holds the Steward role, and chapter supervisors. The
-- reason category stays on the participant projection and is omitted from
-- chapter-wide supervisor access, matching the privacy-preserving chapter
-- appointment report.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
  reason_visible boolean;
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

  reason_visible := caller = appointment.user_id
    or (
      caller = appointment.steward_id
      and private.member_has_chapter_role(appointment.chapter_id, array['steward'])
    );

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
      'status', appointment.status, 'appointmentType', appointment.appointment_type
    ) || case
      when reason_visible then pg_catalog.jsonb_build_object('reasonCategory', appointment.reason_category)
      else '{}'::jsonb
    end,
    'items', history_items,
    'nextBefore', case when history_count = p_limit then next_before else null end,
    'nextBeforeID', case when history_count = p_limit then next_before_id else null end
  );
end;
$function$;

revoke all on function public.get_appointment_history(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.get_appointment_history(uuid, timestamptz, uuid, integer) to authenticated, service_role;

comment on function public.get_appointment_history(uuid, timestamptz, uuid, integer) is
  'Paginated appointment lifecycle history for the booking member, the assigned steward who still holds Steward, and chapter supervisors. Reason category is present only for the member and that assigned steward; supervisor access omits the key.';

notify pgrst, 'reload schema';

commit;
