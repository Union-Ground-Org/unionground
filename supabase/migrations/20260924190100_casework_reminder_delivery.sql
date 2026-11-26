-- BUG-UG-CASEWORK-REMINDERS-NEVER-FIRE-20260920
--
-- public.casework_reminders (CR-034) stored remind_at, recurrence and
-- last_fired_at, but nothing ever read the schedule. This migration adds the
-- delivery path:
--
--   * private.casework_fire_due_reminders(p_limit) is a bounded minute sweep.
--     Each due occurrence notifies its owner exactly once through
--     private.notify_member, records last_fired_at, and a recurring reminder
--     advances to its first occurrence in the future, so a reminder left
--     unattended for many intervals produces one notice, not one per interval.
--   * Access is re-evaluated for the owner at fire time. The RLS helpers read
--     auth.uid() and a live Auth session, neither of which exists under
--     pg_cron, so private.casework_reminder_owner_can_read(owner, case) states
--     the same ownership / staff-role / restriction / grant predicate for an
--     explicit user. An owner who lost access is notified of nothing; the
--     occurrence is still consumed so a denied row cannot pin the sweep queue.
--   * The notice carries no case reference, case title, case narrative or the
--     owner-written reminder title, in English and Spanish.
--   * Rows created before this migration are never backfilled or rewritten:
--     the sweep only considers reminders created at or after the delivery
--     epoch recorded when this migration is applied.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.casework_reminder_delivery_epoch (
  singleton boolean primary key default true check (singleton),
  delivers_from timestamptz not null default pg_catalog.now()
);

revoke all on table private.casework_reminder_delivery_epoch from public, anon, authenticated, service_role;

insert into private.casework_reminder_delivery_epoch (singleton) values (true)
on conflict (singleton) do nothing;

comment on table private.casework_reminder_delivery_epoch is
  'Reminder rows created before delivers_from predate reminder delivery and are never fired, backfilled or rewritten by private.casework_fire_due_reminders.';

create index casework_reminders_fire_due_idx
  on public.casework_reminders (remind_at)
  where status in ('scheduled', 'snoozed');

comment on index public.casework_reminders_fire_due_idx is
  'Due-occurrence scan for private.casework_fire_due_reminders.';

insert into private.notification_copy (key, lang, title, body) values
  ('casework.reminder.due', 'en', 'A casework reminder is due', 'Open Casework to review your reminders.'),
  ('casework.reminder.due', 'es', 'Tienes un recordatorio de caso pendiente', 'Abre Casos para revisar tus recordatorios.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- private.casework_can_read(case) for an explicit user instead of auth.uid().
-- Session-only terms (AAL2 of the current JWT, the selected mobile staff
-- organization) have no meaning for a scheduled job and are not evaluated;
-- enrolled-second-factor policy is, because it is state of the user.
create function private.casework_reminder_owner_can_read(p_owner uuid, p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with org_staff as (
    select c.id as case_id,
      exists (
        select 1
        from public.organizations o
        join public.organization_memberships m
          on m.organization_id = o.id and m.user_id = p_owner and m.status = 'active'
        join public.organization_role_grants g
          on g.organization_id = o.id and g.user_id = p_owner and g.role in ('advisor', 'admin', 'vp')
        where o.id = c.organization_id
          and o.status = 'active'
          and (not private.staff_mfa_required(o.id) or private.has_second_factor(p_owner))
      ) as elevated
    from public.member_cases c
    where c.id = p_case_id
  )
  select p_owner is not null and exists (
    select 1
    from public.member_cases c
    join org_staff s on s.case_id = c.id
    where c.id = p_case_id
      and (
        c.user_id = p_owner
        or (
          c.organization_id is not null
          and c.chapter_id is not null
          and private.actor_has_chapter_staff_role(p_owner, c.chapter_id)
          and (
            c.steward_user_id = p_owner
            or c.coordinator_user_id = p_owner
            or s.elevated
            or exists (
              select 1
              from public.member_roles r
              join public.member_profiles target on target.id = c.user_id
              where r.user_id = p_owner
                and r.role = 'coordinator'
                and (
                  r.chapter_id is null
                  or exists (
                    select 1
                    from public.member_role_chapters rc
                    join public.member_chapter_memberships cm
                      on cm.user_id = rc.user_id and cm.chapter_id = rc.chapter_id
                    where rc.user_id = r.user_id
                      and rc.role = r.role
                      and rc.chapter_id = target.chapter_id
                      and cm.status = 'active'
                  )
                )
            )
          )
          and (
            not c.is_restricted
            or c.steward_user_id = p_owner
            or c.coordinator_user_id = p_owner
            or s.elevated
            or exists (
              select 1
              from public.casework_access_grants ag
              where ag.case_id = c.id
                and ag.grantee_user_id = p_owner
                and ag.revoked_at is null
            )
          )
        )
      )
  );
$function$;

revoke all on function private.casework_reminder_owner_can_read(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function private.casework_reminder_owner_can_read(uuid, uuid) is
  'Fire-time case access for a reminder owner: the private.casework_can_read predicate stated for an explicit user, without session-only terms.';

-- First occurrence strictly after p_now. Monthly steps are taken from the
-- original anchor so day-of-month clamping never drifts.
create function private.casework_reminder_next_occurrence(
  p_remind_at timestamptz,
  p_recurrence text,
  p_now timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_step interval;
  v_count bigint;
  v_next timestamptz;
begin
  if p_recurrence = 'monthly' then
    v_count := greatest(1, (
      (pg_catalog.date_part('year', p_now at time zone 'UTC') - pg_catalog.date_part('year', p_remind_at at time zone 'UTC')) * 12
      + pg_catalog.date_part('month', p_now at time zone 'UTC') - pg_catalog.date_part('month', p_remind_at at time zone 'UTC')
    )::bigint);
    v_step := interval '1 month';
  elsif p_recurrence in ('daily', 'weekly') then
    v_step := case p_recurrence when 'daily' then interval '1 day' else interval '7 days' end;
    v_count := greatest(1, pg_catalog.floor(
      pg_catalog.date_part('epoch', p_now - p_remind_at) / pg_catalog.date_part('epoch', v_step)
    )::bigint);
  else
    return null;
  end if;
  while v_count > 1 and p_remind_at + v_step * (v_count - 1) > p_now loop
    v_count := v_count - 1;
  end loop;
  v_next := p_remind_at + v_step * v_count;
  while v_next <= p_now loop
    v_count := v_count + 1;
    v_next := p_remind_at + v_step * v_count;
  end loop;
  return v_next;
end;
$function$;

revoke all on function private.casework_reminder_next_occurrence(timestamptz, text, timestamptz)
  from public, anon, authenticated, service_role;

create function private.casework_fire_due_reminders(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reminder public.casework_reminders%rowtype;
  v_now timestamptz;
  v_count integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  v_now := pg_catalog.now();
  v_count := 0;
  for v_reminder in
    select r.* from public.casework_reminders r
    where r.status in ('scheduled', 'snoozed')
      and r.remind_at <= v_now
      and (r.last_fired_at is null or r.last_fired_at < r.remind_at)
      and r.created_at >= (select e.delivers_from from private.casework_reminder_delivery_epoch e)
    order by r.remind_at, r.id
    for update of r skip locked
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  loop
    if private.casework_reminder_owner_can_read(v_reminder.owner_user_id, v_reminder.case_id) then
      perform private.notify_member(v_reminder.owner_user_id, 'casework.reminder.due', '{}'::jsonb, 'cases');
      v_count := v_count + 1;
    end if;
    if v_reminder.recurrence = 'none' then
      update public.casework_reminders
        set last_fired_at = v_now, updated_at = v_now
        where id = v_reminder.id;
    else
      update public.casework_reminders
        set last_fired_at = v_now,
          remind_at = private.casework_reminder_next_occurrence(v_reminder.remind_at, v_reminder.recurrence, v_now),
          status = 'scheduled',
          updated_at = v_now
        where id = v_reminder.id;
    end if;
  end loop;
  return v_count;
end;
$function$;

revoke all on function private.casework_fire_due_reminders(integer)
  from public, anon, authenticated, service_role;

comment on function private.casework_fire_due_reminders(integer) is
  'Bounded pg_cron target: notifies each due casework reminder owner once, re-checking case access at fire time, and advances recurring reminders to their next future occurrence.';

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'casework-reminder-delivery-tick';
  perform cron.schedule('casework-reminder-delivery-tick', '* * * * *', 'select private.casework_fire_due_reminders(200)');
end;
$block$;

commit;
