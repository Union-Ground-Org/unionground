-- Appointment authorization consolidation.
--
-- SEC-UG-APPOINTMENT-MUTATION-AUTHORIZATION-EVALUATES-THE-CALLER-CHAPTER-INSTEAD-OF-THE-APPOINTMENT-CHAPTER-20260921
-- SEC-UG-APPOINTMENT-AUTHORIZATION-IGNORES-ORGANIZATION-LEVEL-STEWARD-GRANTS-20260921
-- BUG-UG-CHAPTER-APPOINTMENT-SUPERVISION-IS-HALF-MIGRATED-LIST-CHAPTER-APPOINTMENTS-USES-THE-ORG-20260921
--
-- Supersedes the three separate drafts (PRs #2330, #2363, #2344), which
-- re-emitted overlapping appointment functions.
--
-- 1. private.appointment_stewards_for_chapter keeps the organization boundary
--    from 20260924170100_appointment_organization_boundary.sql (PR #2865): the
--    legacy member_roles arm is still read through
--    private.member_stewards_for_chapter, the one function that owns that
--    chapter predicate. It adds the canonical organization_role_grants steward
--    hat, bounded by an active, unrevoked membership and an active
--    organization, so booking, slot listing, assignment and reassignment read
--    one resolver over both role sources. The predecessor guard admits either
--    the 20260801120000 body or the PR #2865 body; this migration must be
--    applied after PR #2865's migration.
-- 2. list_chapter_appointment_reassignment_candidates and
--    reassign_chapter_appointment gate the caller with the same
--    private.member_has_chapter_role(caller_chapter, ...) predicate as
--    list_chapter_appointments, so an organization-granted coordinator can
--    load candidates and reassign, and resolve eligible stewards through the
--    shared helper. The reassign writer keeps the installation case-graph
--    lock wrapper.
-- 3. cancel_appointment, reschedule_appointment and mark_appointment_outcome
--    bind the steward arm to private.member_has_chapter_role(appt.chapter_id,
--    array['steward']) instead of the caller's selected chapter. The member
--    arm (caller = appt.user_id) is unchanged.
--
-- No table, policy or RPC signature change; grants are re-stated unchanged.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Only the reviewed predecessors may be superseded. The three mutation bodies
-- and the reassign writer are the 20260907151000-wrapped sources.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'private.appointment_stewards_for_chapter(text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '1f9d977091e29636e180d694aa2d10ae714fc60ebb14b9a0dd5ad23910d1d3a4' and digest is distinct from 'ad557bca261f2dccb42eff10d58c440cdd290c45f3f91149bdcf968dd1e0ca9a' then
    raise exception 'unreviewed appointment_stewards_for_chapter predecessor: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.list_chapter_appointment_reassignment_candidates(uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '43fda5b8de182ab571979894cc462052bf81f98e87aa730c533dd80d902d4688' then
    raise exception 'unreviewed list_chapter_appointment_reassignment_candidates predecessor: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.reassign_chapter_appointment(uuid, uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'a00eb8e4f07b3901651a20beccf8cf3545895ba91fe7983b07c3c4155885bbd6' then
    raise exception 'unreviewed reassign_chapter_appointment predecessor: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.cancel_appointment(uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '6e55d3c81b3e386ba78fd88e236dcac1cf1f75f73e47449d5cf9ebce67d7115f' then
    raise exception 'unreviewed cancel_appointment predecessor: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.reschedule_appointment(uuid, timestamp with time zone)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '3e0719424e7425d5c18cfb94d04d3164d999b3116f996bfa532701befeccae31' then
    raise exception 'unreviewed reschedule_appointment predecessor: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.mark_appointment_outcome(uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '6bab40787bc945f8f82abb7d0b72711240bc3df9b9f342d5d4e1876ca64453e2' then
    raise exception 'unreviewed mark_appointment_outcome predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function private.appointment_stewards_for_chapter(p_chapter text)
returns table (steward_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  select e.steward_id
  from (
    select m.steward_id
    from private.member_stewards_for_chapter(p_chapter) m
    union
    select g.user_id as steward_id
    from public.organization_role_grants g
    join public.chapters c
      on c.id = p_chapter
     and c.organization_id = g.organization_id
    join public.organizations o
      on o.id = g.organization_id
     and o.status = 'active'
    join public.organization_memberships om
      on om.organization_id = g.organization_id
     and om.user_id = g.user_id
     and om.status = 'active'
     and om.revoked_at is null
    where g.role = 'steward'
  ) e
  where exists (
    select 1 from public.member_appointment_schedules s
    where s.steward_id = e.steward_id and s.accepting
  )
$function$;

revoke all on function private.appointment_stewards_for_chapter(text) from public, anon, authenticated;

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
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  appt public.member_appointments%rowtype;
begin
  if caller is null
    or not private.mfa_satisfied()
    or caller_chapter is null
    or not private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin']) then
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
    e.steward_id,
    coalesce(profile.full_name, 'Chapter steward')::text as steward_name
  from private.appointment_stewards_for_chapter(appt.chapter_id) e
  left join public.member_profiles profile on profile.id = e.steward_id
  where e.steward_id <> appt.steward_id
    and exists (
      select 1
      from private.appointment_slots_for(
        e.steward_id,
        appt.duration_minutes,
        (appt.starts_at at time zone 'UTC')::date - 1,
        (appt.starts_at at time zone 'UTC')::date + 1
      ) slot
      where slot.slot_start = appt.starts_at
    )
  order by steward_name, steward_id;
end;
$function$;

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
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  appt public.member_appointments%rowtype;
  old_steward uuid;
  member_name text;
  steward_name text;
begin
  if caller is null
    or not private.mfa_satisfied()
    or caller_chapter is null
    or not private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin']) then
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
    from private.appointment_stewards_for_chapter(appt.chapter_id) e
    where e.steward_id = p_steward_id
      and exists (
        select 1
        from private.appointment_slots_for(
          e.steward_id,
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
end;
$function$;

revoke all on function public.reassign_chapter_appointment(uuid, uuid) from public, anon;
grant execute on function public.reassign_chapter_appointment(uuid, uuid) to authenticated, service_role;

create or replace function public.cancel_appointment(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
  -- The steward arm requires a live steward grant in the appointment chapter.
  if caller <> appt.user_id and not private.member_has_chapter_role(appt.chapter_id, array['steward']) then
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
end;
end;
$function$;

create or replace function public.reschedule_appointment(p_id uuid, p_starts_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
  -- Same appointment-chapter live-role demand as cancel.
  if caller <> appt.user_id and not private.member_has_chapter_role(appt.chapter_id, array['steward']) then
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
end;
end;
$function$;

create or replace function public.mark_appointment_outcome(p_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  appt public.member_appointments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
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
  -- Outcome marking binds to a live steward grant in the appointment chapter.
  if not private.member_has_chapter_role(appt.chapter_id, array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if appt.ends_at > now() then
    raise exception 'the appointment has not ended yet' using errcode = '22023';
  end if;

  update public.member_appointments
  set status = p_outcome, updated_at = now() where id = appt.id;

  insert into public.member_appointment_events (appointment_id, actor, action)
  values (appt.id, caller, p_outcome);

  return pg_catalog.jsonb_build_object('id', appt.id, 'status', p_outcome);
end;
end;
$function$;

do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'private.appointment_stewards_for_chapter(text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '1d287c891e69e9df12761726958c1a53ce74b36830c5ca6e702aaf45791e5d0a' then
    raise exception 'appointment_stewards_for_chapter source hash drifted: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.list_chapter_appointment_reassignment_candidates(uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '5ef8bd7aaa7b9eed4a7397303dd2296adf887243a703500a2feaf559e22637c0' then
    raise exception 'list_chapter_appointment_reassignment_candidates source hash drifted: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.reassign_chapter_appointment(uuid, uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'e42de195c1b32c306bba6ea8dc4b4298bd93d1a5a66dd74041e19b9e5925152a' then
    raise exception 'reassign_chapter_appointment source hash drifted: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.cancel_appointment(uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '048c985837bf45ec6495955399f857f29c14d311372cf91604880df4eb1acac4' then
    raise exception 'cancel_appointment source hash drifted: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.reschedule_appointment(uuid, timestamp with time zone)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'c8a7502db198a3eded8b5d8afb06326f49303bb0208f68a4ce37964918153acb' then
    raise exception 'reschedule_appointment source hash drifted: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.mark_appointment_outcome(uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'eebd538cafcd12fdd17cf68dc2e6c9de8233925ce70f8fed1e7c64318bdc5674' then
    raise exception 'mark_appointment_outcome source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;
notify pgrst, 'reload schema';

commit;
