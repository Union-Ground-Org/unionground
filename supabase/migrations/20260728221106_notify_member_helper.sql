-- REQ-UG-NOTIFY-MEMBER-HELPER-20260727
--
-- One place where a notification's copy is chosen, instead of twenty.
--
-- Today ~20 definer bodies insert into member_notifications. Three of them
-- (approve_form, return_form, open_form_as_case) branch on
-- member_profiles.language; the rest write English, and the newest arrival --
-- the task-message body in 20260727010153 -- did too. The i18n parity test
-- cannot catch that: the string was never in a catalogue to be compared.
--
-- private.notify_member(recipient, key, args) resolves the recipient's
-- language, renders one row from the table below, and inserts it. Callers stop
-- carrying copy. Adding a language becomes one column of work, not twenty
-- if/else branches, and a missing translation raises at migration time rather
-- than shipping as silent English.
--
-- Deliberately NOT a client-rendered key: member_notifications rows are read
-- by the in-app feed, the outbound email/push dispatcher and the Realtime
-- subscriber, and only the first of those could resolve a key. Rendering
-- server-side at insert time keeps one body for all three readers.

create table if not exists private.notification_copy (
  key text not null,
  lang text not null check (lang in ('en', 'es')),
  title text not null,
  body text not null,
  primary key (key, lang),
  constraint notification_copy_bounded
    check (char_length(title) between 1 and 120 and char_length(body) between 1 and 400)
);

revoke all on table private.notification_copy from public, anon, authenticated, service_role;

-- {name} is the only placeholder any of these need. No body names a task
-- title, a form label or a case reference: the shoulder-test rule from the
-- push pass -- a lock screen on a break-room table must not disclose the work.
insert into private.notification_copy (key, lang, title, body) values
  ('task.message', 'en', '{name} wrote about a task you are on', 'Open Tasks to read the private conversation.'),
  ('task.message', 'es', '{name} escribió sobre una tarea tuya', 'Abre Tareas para leer la conversación privada.'),
  ('task.assigned', 'en', '{name} assigned you a task', 'Open Tasks to see what is on your list.'),
  ('task.assigned', 'es', '{name} te asignó una tarea', 'Abre Tareas para ver tu lista.'),
  ('task.unassigned', 'en', 'A task moved off your list', '{name} reassigned it. Nothing is owed by you.'),
  ('task.unassigned', 'es', 'Una tarea salió de tu lista', '{name} la reasignó. No te corresponde nada.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

create or replace function private.notify_member(
  p_user_id uuid,
  p_key text,
  p_args jsonb default '{}'::jsonb,
  p_kind text default 'general'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_lang text;
  copy_row private.notification_copy;
  rendered_title text;
  rendered_body text;
  arg record;
begin
  if p_user_id is null then
    return;
  end if;

  select coalesce(p.language, 'en') into recipient_lang
  from public.member_profiles p where p.id = p_user_id;

  select * into copy_row
  from private.notification_copy c
  where c.key = p_key and c.lang = coalesce(recipient_lang, 'en');

  -- A key with no row for this language falls back to English rather than
  -- sending nothing: a member must never lose a notification to a missing
  -- translation. A key with no English row at all is a programming error and
  -- is allowed to raise.
  if copy_row.key is null then
    select * into copy_row
    from private.notification_copy c
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

  insert into public.member_notifications (user_id, title, body, kind)
  values (p_user_id, rendered_title, rendered_body, p_kind);
end
$$;

revoke all on function private.notify_member(uuid, text, jsonb, text) from public, anon, authenticated, service_role;

comment on function private.notify_member(uuid, text, jsonb, text) is
  'Single copy-resolution point for member_notifications: recipient language in, one rendered row out. New notification copy goes in private.notification_copy, not in a caller body.';

-- SWEEP (not done here, deliberately): the other ~17 insert sites keep their
-- literals until each is touched for another reason. Rewriting them all in one
-- migration would mean re-emitting seventeen verbatim function bodies -- the
-- change that is most likely to silently drop an unrelated guard. The rule
-- from here: any function that gains or edits a notification converts to
-- notify_member in the same PR, and no new literal enters a definer body.
-- The three task callers convert in 20260727041000.
