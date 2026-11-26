-- SEC-UG-APPOINTMENT-STEWARD-NOTICE-CHURN-20260920
--
-- book_appointment_without_place_legacy, cancel_appointment and
-- reschedule_appointment each wrote a steward-facing notice through
-- private.notify_member for every member-side action. Each insert fires
-- private.enqueue_notification_deliveries, whose per-recipient weekly nudge
-- cap (5 emails, shared with events, tasks, forms, votes, dues and other
-- appointment mail) one member could drain by repeatedly booking and
-- withdrawing.
--
-- The shared
-- budget stays as it is and the churn is coalesced at the source.
-- private.notify_appointment_steward keeps one steward-facing notice per
-- (steward, acting member) for a rolling window the length of the budget's
-- week. The first member-side action in the window inserts the notice through
-- private.notify_member unchanged (one delivery at most). Later actions in the
-- window rewrite that same notice in place with the newest action's copy and
-- mark it unread; an update fires no delivery trigger, so one member draws at
-- most one of the steward's weekly nudge emails. The notice always shows the
-- latest action, so a withdrawal is never hidden behind the request it
-- withdraws. Every action is still written to public.member_appointment_events,
-- member-facing notices are untouched, and steward-initiated actions,
-- reminders and reassignment notices are not coalesced.
--
-- The window table holds bare identifiers (no foreign keys, so the reviewed FK
-- catalogue is unchanged) and every write deletes windows older than the
-- rolling week, so no row outlives it.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table private.appointment_steward_notice_windows (
  steward_id uuid not null,
  member_id uuid not null,
  notification_id uuid not null,
  window_started_at timestamptz not null default pg_catalog.now(),
  coalesced_actions integer not null default 0 check (coalesced_actions >= 0),
  primary key (steward_id, member_id)
);

create index appointment_steward_notice_windows_started_idx
  on private.appointment_steward_notice_windows (window_started_at);

alter table private.appointment_steward_notice_windows enable row level security;
revoke all on table private.appointment_steward_notice_windows
  from public, anon, authenticated, service_role;

create function private.notify_appointment_steward(
  p_user_id uuid,
  p_key text,
  p_args jsonb default '{}'::jsonb,
  p_kind text default 'appointments'
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  actor uuid := (select auth.uid());
  coalesce_window constant interval := interval '7 days';
  open_window private.appointment_steward_notice_windows%rowtype;
  recipient_lang text;
  copy_row private.notification_copy;
  rendered_title text;
  rendered_body text;
  arg record;
  inserted_id uuid;
begin
  if p_user_id is null
     or actor is null
     or actor = p_user_id
     or p_kind is distinct from 'appointments'
     or p_key not in (
       'appointment.booked.steward',
       'appointment.cancelled.steward',
       'appointment.rescheduled.steward'
     )
  then
    perform private.notify_member(p_user_id, p_key, p_args, p_kind);
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'appointment_steward_notice:' || p_user_id::text || ':' || actor::text, 0));

  delete from private.appointment_steward_notice_windows w
   where w.window_started_at <= pg_catalog.now() - coalesce_window;

  select w.* into open_window
    from private.appointment_steward_notice_windows w
   where w.steward_id = p_user_id and w.member_id = actor
   for update;

  if open_window.notification_id is not null then
    select coalesce(p.language, 'en') into recipient_lang
      from public.member_profiles p where p.id = p_user_id;
    select * into copy_row from private.notification_copy c
     where c.key = p_key and c.lang = coalesce(recipient_lang, 'en');
    if copy_row.key is null then
      select * into copy_row from private.notification_copy c
       where c.key = p_key and c.lang = 'en';
    end if;
    if copy_row.key is null then
      raise exception 'unknown notification copy key: %', p_key;
    end if;
    rendered_title := copy_row.title;
    rendered_body := copy_row.body;
    for arg in select key, value from pg_catalog.jsonb_each_text(coalesce(p_args, '{}'::jsonb))
    loop
      rendered_title := pg_catalog.replace(rendered_title, '{' || arg.key || '}', arg.value);
      rendered_body := pg_catalog.replace(rendered_body, '{' || arg.key || '}', arg.value);
    end loop;

    update public.member_notifications n
       set title = rendered_title,
           body = rendered_body,
           read_at = null,
           created_at = pg_catalog.now()
     where n.id = open_window.notification_id
       and n.user_id = p_user_id;
    if found then
      update private.appointment_steward_notice_windows w
         set coalesced_actions = w.coalesced_actions + 1
       where w.steward_id = p_user_id and w.member_id = actor;
      return;
    end if;
    -- The steward deleted the notice; start a new window below.
    delete from private.appointment_steward_notice_windows w
     where w.steward_id = p_user_id and w.member_id = actor;
  end if;

  perform private.notify_member(p_user_id, p_key, p_args, p_kind);
  -- notify_member returns nothing; this pair's advisory lock is held and each
  -- appointment RPC writes one steward-facing notice, so the newest
  -- appointments notice this transaction wrote for the steward is ours. None
  -- exists when notify_member dropped it (stress ledger).
  select n.id into inserted_id
    from public.member_notifications n
   where n.user_id = p_user_id
     and n.kind = 'appointments'
     and n.created_at = pg_catalog.now()
     and not exists (
       select 1 from private.appointment_steward_notice_windows w
        where w.notification_id = n.id
     )
   order by n.id desc
   limit 1;
  if inserted_id is not null then
    insert into private.appointment_steward_notice_windows (steward_id, member_id, notification_id)
    values (p_user_id, actor, inserted_id);
  end if;
end;
end;
$function$;

revoke all on function private.notify_appointment_steward(uuid, text, jsonb, text)
  from public, anon, authenticated, service_role;

-- Re-emit the three member-side writers from their installed definitions
-- (pg_get_functiondef keeps the case-graph lock prologue and the 20260925030000
-- bodies) with only the steward-facing call changed; each call must occur
-- exactly once.
do $appointment_steward_notices$
declare
  target record;
  definition text;
  old_call text;
  occurrences integer;
begin
  for target in
    select * from (values
      ('public.book_appointment_without_place_legacy(text,integer,timestamp with time zone,uuid,text)',
       'perform private.notify_member(chosen, ''appointment.booked.steward'','),
      ('public.cancel_appointment(uuid)',
       'perform private.notify_member(appt.steward_id, ''appointment.cancelled.steward'','),
      ('public.reschedule_appointment(uuid,timestamp with time zone)',
       'perform private.notify_member(appt.steward_id, ''appointment.rescheduled.steward'',')
    ) writers(signature, call_text)
  loop
    old_call := target.call_text;
    select pg_catalog.pg_get_functiondef(p.oid) into strict definition
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(target.signature);
    occurrences := (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_call, ''))) / pg_catalog.length(old_call);
    if occurrences <> 1 then
      raise exception 'steward appointment notice call not found exactly once: %', target.signature
        using errcode = '55000';
    end if;
    definition := pg_catalog.replace(
      definition,
      old_call,
      pg_catalog.replace(old_call, 'private.notify_member(', 'private.notify_appointment_steward(')
    );
    execute definition;
  end loop;
end;
$appointment_steward_notices$;

commit;
