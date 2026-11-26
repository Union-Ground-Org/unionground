-- REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030 (#6577).
--
-- The October 29-30, 2026 role-play run (findings 43, 45, 51, 52 and 54):
-- members could not put a private date on their own calendar or set a
-- one-off or repeating reminder of their own; booking hours had no title,
-- location, audience or start date; and a steward could not note how a
-- booking went.
--
-- 1. Personal reminders are a new kind of public.member_message_reminders
--    ('personal'): a title, an optional note, a time and a repeat rule
--    (none, daily, weekly, monthly). The existing every-minute workflow
--    dispatcher delivers them in the app; a repeating one inserts its next
--    occurrence as a new row, so each delivery keeps its own notification.
--    They are the member's private dates: the calendar feed adds them for
--    its owner only. No third-party calendar sync is added.
-- 2. Booking hours (member_appointment_schedules) gain a title, a location,
--    who they are for (descriptive) and a first date; the slot engine offers
--    nothing before that date.
-- 3. A steward's private note on a booking lives in its own table,
--    member_appointment_notes, which no member read or member export
--    reaches (appointment events are visible to the member, so they are not
--    used for it).

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Personal reminders
-- ---------------------------------------------------------------------------

alter table public.member_message_reminders
  add column title text,
  add column repeat_rule text,
  add column time_zone text;

alter table public.member_message_reminders
  drop constraint member_message_reminders_source_kind_check,
  drop constraint member_message_reminders_one_source,
  drop constraint member_message_reminders_status_by_kind;

alter table public.member_message_reminders
  add constraint member_message_reminders_source_kind_check
    check (source_kind in ('private', 'channel', 'task', 'task_item', 'event', 'space', 'personal')),
  add constraint member_message_reminders_one_source check (
    (source_kind = 'private' and private_message_id is not null and channel_post_id is null and task_message_id is null and source_ref is null)
    or (source_kind = 'channel' and private_message_id is null and channel_post_id is not null and task_message_id is null and source_ref is null)
    or (source_kind = 'task' and private_message_id is null and channel_post_id is null and task_message_id is not null and source_ref is null)
    or (source_kind in ('task_item', 'event', 'space') and private_message_id is null and channel_post_id is null and task_message_id is null
        and source_ref is not null and pg_catalog.char_length(source_ref) between 1 and 200)
    or (source_kind = 'personal' and private_message_id is null and channel_post_id is null and task_message_id is null and source_ref is null)
  ),
  add constraint member_message_reminders_status_by_kind check (
    case when source_kind in ('task_item', 'event', 'space', 'personal') then status <> 'pending' else status <> 'scheduled' end
  ),
  add constraint member_message_reminders_personal_shape check (
    case when source_kind = 'personal' then
      title is not null and pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'
      and repeat_rule in ('none', 'daily', 'weekly', 'monthly') and audience = 'me'
      and time_zone is not null and pg_catalog.char_length(time_zone) between 1 and 64
    else title is null and repeat_rule is null and time_zone is null end
  );

create index member_message_reminders_personal_owner_idx
  on public.member_message_reminders (owner_id, remind_at, id)
  where source_kind = 'personal' and status = 'scheduled';

comment on column public.member_message_reminders.title is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: a personal reminder''s title (source_kind personal only).';
comment on column public.member_message_reminders.repeat_rule is
  'A personal reminder''s repeat: none, daily, weekly or monthly (source_kind personal only).';
comment on column public.member_message_reminders.time_zone is
  'A personal reminder''s IANA time zone: a repeat keeps the same local wall-clock time across daylight-saving changes (source_kind personal only).';

-- The next occurrence keeps the reminder's local wall-clock time in its own
-- zone, whatever zone the dispatcher's session runs in.
create function private.next_personal_reminder_at(p_at timestamptz, p_rule text, p_zone text)
returns timestamptz
language sql
stable
set search_path = ''
as $function$
  select case p_rule
    when 'daily' then ((p_at at time zone p_zone) + interval '1 day') at time zone p_zone
    when 'weekly' then ((p_at at time zone p_zone) + interval '7 days') at time zone p_zone
    when 'monthly' then ((p_at at time zone p_zone) + interval '1 month') at time zone p_zone
    else null end
$function$;

revoke all on function private.next_personal_reminder_at(timestamptz, text, text) from public, anon, authenticated, service_role;

create function public.save_personal_reminder(
  p_id uuid, p_title text, p_note text, p_remind_at timestamptz, p_repeat text, p_time_zone text
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
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  rule text := coalesce(nullif(p_repeat, ''), 'none');
  saved public.member_message_reminders%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_title) not between 1 and 160 or clean_title ~ '[[:cntrl:]]' then
    raise exception 'title must be 1 to 160 characters' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_note) > 500 then
    raise exception 'note is too long' using errcode = '22023';
  end if;
  if rule not in ('none', 'daily', 'weekly', 'monthly') then
    raise exception 'invalid repeat' using errcode = '22023';
  end if;
  if p_time_zone is null
     or not exists (select 1 from private.iana_timezone_names zone where zone.name = p_time_zone) then
    raise exception 'invalid time zone' using errcode = '22023';
  end if;
  if p_remind_at is null or p_remind_at <= pg_catalog.now()
     or p_remind_at > pg_catalog.now() + interval '1 year' then
    raise exception 'invalid reminder time' using errcode = '22023';
  end if;
  if p_id is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-reminders:' || caller::text, 0));
    if (select pg_catalog.count(*) from public.member_message_reminders r
        where r.owner_id = caller and r.source_kind = 'personal' and r.status = 'scheduled') >= 200 then
      raise exception 'personal reminder limit reached' using errcode = '54000';
    end if;
    insert into public.member_message_reminders
      (owner_id, source_kind, title, note, remind_at, status, repeat_rule, audience, time_zone)
    values (caller, 'personal', clean_title, clean_note, p_remind_at, 'scheduled', rule, 'me', p_time_zone)
    returning * into saved;
  else
    update public.member_message_reminders r
    set title = clean_title, note = clean_note, remind_at = p_remind_at, repeat_rule = rule,
        time_zone = p_time_zone, updated_at = pg_catalog.now()
    where r.id = p_id and r.owner_id = caller and r.source_kind = 'personal' and r.status = 'scheduled'
    returning * into saved;
    if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'title', saved.title, 'note', saved.note, 'remindAt', saved.remind_at,
    'repeat', saved.repeat_rule, 'status', saved.status);
end;
end;
$function$;

revoke all on function public.save_personal_reminder(uuid, text, text, timestamptz, text, text) from public, anon, authenticated, service_role;
grant execute on function public.save_personal_reminder(uuid, text, text, timestamptz, text, text) to authenticated;
comment on function public.save_personal_reminder(uuid, text, text, timestamptz, text, text) is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the caller creates or edits one of their own scheduled personal reminders (title, note, time within a year, repeat none, daily, weekly or monthly, IANA time zone for the repeat); at most 200 scheduled per member.';

create function public.cancel_personal_reminder(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  update public.member_message_reminders r
  set status = 'cancelled', updated_at = pg_catalog.now()
  where r.id = p_id and r.owner_id = caller and r.source_kind = 'personal' and r.status = 'scheduled';
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object('id', p_id, 'status', 'cancelled');
end;
end;
$function$;

revoke all on function public.cancel_personal_reminder(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_personal_reminder(uuid) to authenticated;
comment on function public.cancel_personal_reminder(uuid) is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the caller cancels one of their own scheduled personal reminders (a repeating one stops repeating).';

create function public.list_personal_reminders(
  p_after_remind_at timestamptz default null, p_after_id uuid default null, p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  rows_found jsonb;
  has_more boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if (p_after_remind_at is null) <> (p_after_id is null) then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  with page as (
    select r.id, r.title, r.note, r.remind_at, r.repeat_rule
    from public.member_message_reminders r
    where r.owner_id = caller and r.source_kind = 'personal' and r.status = 'scheduled'
      and (p_after_remind_at is null or (r.remind_at, r.id) > (p_after_remind_at, p_after_id))
    order by r.remind_at, r.id
    limit page_limit + 1
  ), numbered as (
    select page.*, pg_catalog.row_number() over (order by page.remind_at, page.id) as position from page
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', n.id, 'title', n.title, 'note', n.note, 'remindAt', n.remind_at, 'repeat', n.repeat_rule
    ) order by n.position) filter (where n.position <= page_limit), '[]'::jsonb),
    pg_catalog.count(*) > page_limit
  into rows_found, has_more
  from numbered n;
  return pg_catalog.jsonb_build_object(
    'items', rows_found,
    'nextCursor', case when has_more then pg_catalog.jsonb_build_object(
      'remindAt', rows_found -> (page_limit - 1) ->> 'remindAt',
      'id', rows_found -> (page_limit - 1) ->> 'id') else null end);
end;
$function$;

revoke all on function public.list_personal_reminders(timestamptz, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_personal_reminders(timestamptz, uuid, integer) to authenticated;
comment on function public.list_personal_reminders(timestamptz, uuid, integer) is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: one keyset page (1 to 50, default 20) of the caller''s own scheduled personal reminders, soonest first, with the next cursor.';

CREATE OR REPLACE FUNCTION private.dispatch_due_workflow_reminders(p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  reminder record;
  src jsonb;
  delivered_count integer := 0;
  failed_count integer := 0;
  delivery_error boolean := false;
begin
  if p_limit not between 1 and 500 then
    raise exception 'invalid dispatch limit' using errcode = '22023';
  end if;
  begin
    for reminder in
      select pending.*
      from public.member_message_reminders pending
      where pending.status = 'scheduled'
        and pending.source_kind in ('task_item', 'event', 'personal')
        and pending.remind_at <= pg_catalog.now()
      order by pending.remind_at, pending.id
      limit p_limit
      for update skip locked
    loop
      begin
        -- REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030:
        -- a personal reminder has no source to resolve. It is delivered in
        -- the app with its own title and note; a repeating one schedules its
        -- next occurrence as a new row (one notification per reminder row).
        if reminder.source_kind = 'personal' then
          insert into public.member_notifications (user_id, title, body, kind, message_reminder_id)
          values (reminder.owner_id, reminder.title,
                  coalesce(nullif(pg_catalog.btrim(reminder.note), ''), 'Open your reminders to review it.'),
                  'general', reminder.id)
          on conflict (message_reminder_id) do nothing;
          update public.member_message_reminders
          set status = 'delivered', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
          where id = reminder.id;
          if reminder.repeat_rule in ('daily', 'weekly', 'monthly') then
            insert into public.member_message_reminders
              (owner_id, source_kind, title, note, remind_at, status, repeat_rule, audience, time_zone)
            values (reminder.owner_id, 'personal', reminder.title, reminder.note,
                    private.next_personal_reminder_at(reminder.remind_at, reminder.repeat_rule, reminder.time_zone),
                    'scheduled', reminder.repeat_rule, 'me', reminder.time_zone);
          end if;
          delivered_count := delivered_count + 1;
          continue;
        end if;
        src := private.cw_resolve_source(
          reminder.owner_id, private.cw_reminder_api_kind(reminder.source_kind), reminder.source_ref);
        if not coalesce((src ->> 'ok')::boolean, false) or src ->> 'state' in ('cancelled', 'removed') then
          update public.member_message_reminders
          set status = 'failed', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
          where id = reminder.id;
          failed_count := failed_count + 1;
          continue;
        end if;
        insert into public.member_notifications (user_id, title, body, kind, message_reminder_id)
        values (reminder.owner_id, 'Reminder', 'Open your reminders to review it.', 'general', reminder.id)
        on conflict (message_reminder_id) do nothing;
        update public.member_message_reminders
        set status = 'delivered', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where id = reminder.id;
        delivered_count := delivered_count + 1;
      exception when others then
        -- Roll back only this reminder, preserving earlier successes and allowing
        -- later rows to run. Do not put source or notification content in logs.
        failed_count := failed_count + 1;
        delivery_error := true;
        raise warning 'workflow reminder delivery failed (%)', sqlstate;
        begin
          update public.member_message_reminders
          set status = 'failed', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
          where id = reminder.id;
        exception when others then
          -- A broken status write must not undo another reminder's delivery.
          null;
        end;
      end;
    end loop;
  exception when others then
    -- A delivery fault must never abort the surrounding cron transaction.
    raise warning 'workflow reminder dispatch failed (%)', sqlstate;
    return pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0, 'error', true);
  end;
  return pg_catalog.jsonb_build_object('delivered', delivered_count, 'failed', failed_count, 'error', delivery_error);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_message_reminders(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'owner_id', t.owner_id, 'source_kind', t.source_kind,
    'private_message_id', t.private_message_id, 'channel_post_id', t.channel_post_id,
    'task_message_id', t.task_message_id, 'source_ref', t.source_ref, 'audience', t.audience,
    'note', t.note, 'title', t.title, 'repeat_rule', t.repeat_rule, 'time_zone', t.time_zone, 'remind_at', t.remind_at, 'status', t.status, 'snooze_count', t.snooze_count,
    'completed_at', t.completed_at, 'created_at', t.created_at,
    'delivered_at', t.delivered_at, 'updated_at', t.updated_at)), '[]'::jsonb)
  from public.member_message_reminders t where t.owner_id = p_caller;
$function$;

update private.account_lifecycle_manifest
set export_columns = array['id', 'owner_id', 'source_kind', 'private_message_id', 'channel_post_id',
  'task_message_id', 'source_ref', 'audience', 'note', 'title', 'repeat_rule', 'time_zone', 'remind_at', 'status',
  'snooze_count', 'completed_at', 'created_at', 'delivered_at', 'updated_at']
where schema_name = 'public' and table_name = 'member_message_reminders' and user_column = 'owner_id';

CREATE OR REPLACE FUNCTION public.get_calendar_feed_events(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'calendar feed RPC requires service_role' using errcode = '42501';
  end if;
  if p_token is null or pg_catalog.length(p_token) < 32 or pg_catalog.length(p_token) > 128 then
    return pg_catalog.jsonb_build_object('valid', false);
  end if;
  select user_id into target from public.member_calendar_feed_tokens
  where token_hash = private.calendar_feed_token_hash(p_token);
  if not found then
    return pg_catalog.jsonb_build_object('valid', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'valid', true,
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'title', e.title, 'startsAt', e.starts_at,
        'endsAt', e.ends_at, 'eventKind', e.event_kind, 'eventDate', e.event_date,
        'location', e.location, 'summary', e.summary
      ) order by e.starts_at)
      from public.member_events e
      join public.member_event_rsvps r on r.event_id = e.id
      where r.user_id = target and r.status = 'going'
        and e.cancelled_at is null
        and private.member_can_access_event_scope_for_user(
          target, e.chapter_id, e.is_public, e.is_public_across_agencies
        )
    ), '[]'::jsonb),
    -- REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
    -- member's own private dates (personal reminders, scheduled or already
    -- delivered) from 30 days ago to a year ahead, at most 500, so a date
    -- stays on the calendar after its reminder fires. Scheduled dates take
    -- the 500 first (a member holds at most 200), then the most recent
    -- deliveries, so old history never pushes an upcoming date out. Only the
    -- feed's owner ever reads them.
    'personalDates', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', d.id, 'title', d.title, 'note', d.note, 'startsAt', d.remind_at
      ) order by d.remind_at, d.id)
      from (
        select r.id, r.title, r.note, r.remind_at
        from public.member_message_reminders r
        where r.owner_id = target and r.source_kind = 'personal' and r.status in ('scheduled', 'delivered')
          and r.remind_at >= pg_catalog.now() - interval '30 days'
          and r.remind_at <= pg_catalog.now() + interval '1 year'
        order by (r.status = 'scheduled') desc, r.remind_at desc, r.id
        limit 500
      ) d
    ), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_connected_workflow_reminders(p_cursor text DEFAULT NULL::text, p_limit integer DEFAULT 25, p_status text DEFAULT 'open'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  filter_status text := coalesce(p_status, 'open');
  statuses text[];
  cursor_json jsonb;
  cursor_at timestamptz;
  cursor_id uuid;
  row_data public.member_message_reminders%rowtype;
  collected jsonb := '[]'::jsonb;
  fetched integer := 0;
  next_cursor text := null;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  statuses := case filter_status
    when 'open' then array['pending', 'scheduled', 'delivered']
    when 'scheduled' then array['pending', 'scheduled']
    when 'delivered' then array['delivered']
    when 'completed' then array['completed']
    when 'cancelled' then array['cancelled']
    when 'failed' then array['failed']
    when 'all' then array['pending', 'scheduled', 'delivered', 'completed', 'cancelled', 'failed'] end;
  if statuses is null then
    perform private.cw_fail('invalid_input', '22023', 'invalid status filter', 'status');
  end if;
  if p_cursor is not null then
    begin
      cursor_json := p_cursor::jsonb;
      cursor_at := (cursor_json ->> 0)::timestamptz;
      cursor_id := (cursor_json ->> 1)::uuid;
      if cursor_at is null or cursor_id is null then raise exception 'bad cursor'; end if;
    exception when others then
      perform private.cw_fail('invalid_input', '22023', 'invalid cursor', 'cursor');
    end;
  end if;

  for row_data in
    select r.*
    from public.member_message_reminders r
    where r.owner_id = caller
      -- Personal reminders have their own list (list_personal_reminders).
      and r.source_kind <> 'personal'
      and r.status = any(statuses)
      and (cursor_at is null or (r.remind_at, r.id) > (cursor_at, cursor_id))
    order by r.remind_at, r.id
    limit lim + 1
  loop
    fetched := fetched + 1;
    if fetched <= lim then
      collected := collected || pg_catalog.jsonb_build_array(private.cw_reminder_json(row_data, caller));
    else
      next_cursor := pg_catalog.jsonb_build_array(
        (collected -> (lim - 1)) ->> 'remindAt', (collected -> (lim - 1)) ->> 'id')::text;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('items', collected, 'nextCursor', next_cursor);
end;
$function$;

CREATE OR REPLACE FUNCTION public.act_on_connected_workflow_reminder(p_reminder_id uuid, p_action text, p_remind_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  reminder_row public.member_message_reminders%rowtype;
  src jsonb;
  api_kind text;
  shown jsonb;
  replayed boolean := false;
  active boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_reminder_id is null or p_action is null or p_action not in ('open', 'snooze', 'complete', 'cancel') then
    perform private.cw_fail('invalid_input', '22023', 'invalid reminder action', 'action');
  end if;

  select r.* into reminder_row
  from public.member_message_reminders r
  where r.id = p_reminder_id and r.owner_id = caller
    -- Personal reminders are cancelled through cancel_personal_reminder.
    and r.source_kind <> 'personal'
  for update;
  if not found then
    perform private.cw_fail('source_unavailable', '22023', 'reminder unavailable', 'reminder');
  end if;
  active := reminder_row.status in ('pending', 'scheduled', 'delivered');
  api_kind := private.cw_reminder_api_kind(reminder_row.source_kind);

  if p_action = 'open' then
    shown := private.cw_reminder_json(reminder_row, caller);
    return pg_catalog.jsonb_build_object(
      'reminder', shown,
      'available', coalesce((shown ->> 'available')::boolean, false),
      'href', shown -> 'href',
      'replayed', false);
  end if;

  if p_action = 'complete' then
    if reminder_row.status = 'completed' then
      replayed := true;
    elsif active then
      update public.member_message_reminders
      set status = 'completed', completed_at = pg_catalog.now(), updated_at = pg_catalog.now()
      where id = reminder_row.id returning * into reminder_row;
    else
      perform private.cw_fail('capability_unavailable', '22023', 'reminder is closed', 'reminder_closed');
    end if;
  elsif p_action = 'cancel' then
    if reminder_row.status = 'cancelled' then
      replayed := true;
    elsif active then
      update public.member_message_reminders
      set status = 'cancelled', updated_at = pg_catalog.now()
      where id = reminder_row.id returning * into reminder_row;
    else
      perform private.cw_fail('capability_unavailable', '22023', 'reminder is closed', 'reminder_closed');
    end if;
  else
    if p_remind_at is null or p_remind_at <= pg_catalog.now()
       or p_remind_at > pg_catalog.now() + interval '1 year' then
      perform private.cw_fail('invalid_input', '22023', 'invalid reminder time', 'remind_at');
    end if;
    if not active then
      perform private.cw_fail('capability_unavailable', '22023', 'reminder is closed', 'reminder_closed');
    end if;
    src := private.cw_resolve_source(caller, api_kind, private.cw_reminder_source_id(reminder_row));
    if not coalesce((src ->> 'ok')::boolean, false) or private.current_member_organization() is null then
      perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
    end if;
    if src ->> 'state' = 'removed' then
      perform private.cw_fail('capability_unavailable', '22023', 'source removed', 'source_removed');
    end if;
    if src ->> 'state' = 'cancelled' then
      perform private.cw_fail('event_cancelled', '22023', 'this event was cancelled', 'event_cancelled');
    end if;
    if reminder_row.status in ('pending', 'scheduled') and reminder_row.remind_at = p_remind_at then
      replayed := true;
    else
      -- A delivered reminder owns its notification slot; free it so the
      -- snoozed reminder can notify again.
      update public.member_notifications set message_reminder_id = null
      where message_reminder_id = reminder_row.id;
      update public.member_message_reminders
      set remind_at = p_remind_at,
          status = case when source_kind in ('task_item', 'event') then 'scheduled' else 'pending' end,
          delivered_at = null,
          snooze_count = least(snooze_count + 1, 1000),
          updated_at = pg_catalog.now()
      where id = reminder_row.id returning * into reminder_row;
    end if;
  end if;

  shown := private.cw_reminder_json(reminder_row, caller);
  return pg_catalog.jsonb_build_object(
    'reminder', shown,
    'available', coalesce((shown ->> 'available')::boolean, false),
    'href', shown -> 'href',
    'replayed', replayed);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Booking hours: title, location, audience, first date
-- ---------------------------------------------------------------------------

alter table public.member_appointment_schedules
  add column title text,
  add column location text,
  add column audience_note text,
  add column starts_on date;

alter table public.member_appointment_schedules
  add constraint member_appointment_schedules_details_bounded check (
    (title is null or (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 120 and title !~ '[[:cntrl:]]'))
    and (location is null or (pg_catalog.char_length(pg_catalog.btrim(location)) between 1 and 200 and location !~ '[[:cntrl:]]'))
    and (audience_note is null or (pg_catalog.char_length(pg_catalog.btrim(audience_note)) between 1 and 200 and audience_note !~ '[[:cntrl:]]'))
  );

comment on column public.member_appointment_schedules.title is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: what the booking hours are called (for example "Office hours"). Set through set_appointment_schedule_details.';
comment on column public.member_appointment_schedules.location is 'Where the booking hours are held.';
comment on column public.member_appointment_schedules.audience_note is 'Who the booking hours are for, in the steward''s words (descriptive; eligibility is unchanged).';
comment on column public.member_appointment_schedules.starts_on is 'The first date the booking hours offer slots; the slot engine offers none earlier.';

create function public.set_appointment_schedule_details(
  p_title text, p_location text, p_audience text, p_starts_on date
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
  saved public.member_appointment_schedules%rowtype;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  update public.member_appointment_schedules s
  set title = nullif(pg_catalog.btrim(coalesce(p_title, '')), ''),
      location = nullif(pg_catalog.btrim(coalesce(p_location, '')), ''),
      audience_note = nullif(pg_catalog.btrim(coalesce(p_audience, '')), ''),
      starts_on = p_starts_on,
      updated_at = pg_catalog.now()
  where s.steward_id = caller
  returning * into saved;
  if not found then raise exception 'set your weekly hours first' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object('title', saved.title, 'location', saved.location,
    'audience', saved.audience_note, 'startsOn', saved.starts_on);
end;
end;
$function$;

revoke all on function public.set_appointment_schedule_details(text, text, text, date) from public, anon, authenticated, service_role;
grant execute on function public.set_appointment_schedule_details(text, text, text, date) to authenticated;
comment on function public.set_appointment_schedule_details(text, text, text, date) is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: a steward sets the title, location, who-it-is-for note and first date of their own booking hours.';

create function public.get_appointment_schedule_details(p_steward_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.cardinality(p_steward_ids) > 100 then
    raise exception 'between 0 and 100 stewards' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'stewardId', s.steward_id, 'title', s.title, 'location', s.location,
      'audience', s.audience_note, 'startsOn', s.starts_on
    ) order by s.steward_id)
    from public.member_appointment_schedules s
    -- No list asks for the caller's own booking hours.
    where (case when p_steward_ids is null then s.steward_id = caller else s.steward_id = any(p_steward_ids) end)
      and (s.steward_id = caller
           or (chapter is not null and s.steward_id in (
             select bookable.steward_id from private.appointment_stewards_for_chapter(chapter) bookable)))
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_appointment_schedule_details(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_appointment_schedule_details(uuid[]) to authenticated;
comment on function public.get_appointment_schedule_details(uuid[]) is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the title, location, audience note and first date of the caller''s own booking hours (null list) and of the stewards the caller''s chapter can book (at most 100).';

CREATE OR REPLACE FUNCTION private.appointment_slots_for(p_steward uuid, p_duration integer, p_from date, p_to date)
 RETURNS TABLE(slot_start timestamp with time zone, slot_end timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with sched as (
    select s.steward_id, s.timezone, s.min_notice_minutes,
           s.buffer_before_minutes, s.buffer_after_minutes, s.max_per_day, s.starts_on
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
      -- REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030:
      -- booking hours that start on a later date offer no earlier slot.
      and (sc.starts_on is null or d.slot_date >= sc.starts_on)
    cross join lateral pg_catalog.generate_series(
      w.start_minute::int, w.end_minute::int - p_duration, 15) gs(m)
  )
  select c.slot_start,
         c.slot_start + pg_catalog.make_interval(mins => p_duration) as slot_end
  from candidate c
  where c.slot_start >= now() + pg_catalog.make_interval(mins => c.min_notice_minutes)
    -- DST spring-forward guard: a wall time that does not
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
$function$;

-- ---------------------------------------------------------------------------
-- 3. A steward's private note on a booking
-- ---------------------------------------------------------------------------

create table public.member_appointment_notes (
  appointment_id uuid primary key references public.member_appointments(id) on delete cascade,
  steward_id uuid not null references auth.users(id) on delete cascade,
  note text not null,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint member_appointment_notes_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(note)) between 1 and 2000
    and pg_catalog.translate(note, pg_catalog.chr(10) || pg_catalog.chr(13), '') !~ '[[:cntrl:]]'
  )
);

alter table public.member_appointment_notes enable row level security;
revoke all on table public.member_appointment_notes from public, anon, authenticated, service_role;
create policy mfa_assurance on public.member_appointment_notes
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.member_appointment_notes is
  'Restrictive two-step assurance carried by every RLS table in public. No client role holds a grant on this table, so this is defence in depth: booking notes are read and written only through set_appointment_note and get_appointment_notes.';

comment on table public.member_appointment_notes is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the booked steward''s private note on how a booking went. No client table grant; read and written only by that steward through set_appointment_note and get_appointment_notes. Never in the member''s history or export.';

create trigger a00_case_graph_lock before insert or update or delete on public.member_appointment_notes
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_appointment_notes
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');

create function public.set_appointment_note(p_appointment_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_appointments a
    where a.id = p_appointment_id and a.steward_id = caller
      and a.chapter_id = private.current_member_chapter()
      and private.member_has_chapter_role(a.chapter_id, array['steward'])
  ) then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if clean is null then
    delete from public.member_appointment_notes where appointment_id = p_appointment_id;
    return pg_catalog.jsonb_build_object('appointmentId', p_appointment_id, 'note', null);
  end if;
  insert into public.member_appointment_notes (appointment_id, steward_id, note)
  values (p_appointment_id, caller, clean)
  on conflict (appointment_id) do update
    set note = excluded.note, steward_id = excluded.steward_id, updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('appointmentId', p_appointment_id, 'note', clean);
end;
end;
$function$;

revoke all on function public.set_appointment_note(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_appointment_note(uuid, text) to authenticated;
comment on function public.set_appointment_note(uuid, text) is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the booked steward writes, replaces or clears (blank) their private note on one of their own bookings in their chapter.';

create function public.get_appointment_notes(p_appointment_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_appointment_ids is null or pg_catalog.cardinality(p_appointment_ids) > 200 then
    raise exception 'between 0 and 200 appointments' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'appointmentId', n.appointment_id, 'note', n.note, 'updatedAt', n.updated_at
    ) order by n.appointment_id)
    from public.member_appointment_notes n
    join public.member_appointments a on a.id = n.appointment_id
    where n.appointment_id = any(p_appointment_ids)
      and a.steward_id = caller and n.steward_id = caller
      and a.chapter_id = private.current_member_chapter()
      -- The reader holds the writer's bar: a steward whose Steward grant is
      -- removed stops seeing their notes, though the rows stay theirs.
      and private.member_has_chapter_role(a.chapter_id, array['steward'])
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_appointment_notes(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_appointment_notes(uuid[]) to authenticated;
comment on function public.get_appointment_notes(uuid[]) is
  'REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the caller''s own private notes on their own bookings in their chapter (at most 200 ids), while the caller still holds the Steward role there.';

-- ---------------------------------------------------------------------------
-- Account lifecycle: the new auth.users column
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_inventory_basis,
   exclusion_reason, note, reviewed_at)
values
  ('public', 'member_appointment_notes', 'steward_id', 'cascade', 'excluded_with_reason', 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'A steward''s private note on a booking; deleted with the steward''s account, and with the booking.', date '2026-10-30');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'public'
  and table_name = 'member_appointment_notes' and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_calendar_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after calendar: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after calendar';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after calendar';
  end if;
end;
$assert_calendar_lifecycle$;

notify pgrst, 'reload schema';

commit;
