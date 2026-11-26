-- BUG-UG-NOTIFICATION-ITEMS-DO-NOT-OPEN-WHAT-THEY-ANNOUNCE-20261004
--
-- A notification such as "Meeting minutes published" could not open what it
-- announced: member_notifications kept only rendered title and body text, and
-- the minutes notice shares kind 'general' with unrelated notices, so the app
-- had nothing to route on.
--
-- Repair:
--   * member_notifications.copy_key (nullable text): the private
--     notification_copy key the row was rendered from. Existing rows keep
--     NULL and stay non-interactive; the app maps only keys it knows to a
--     destination (starting with institutional.minutes.published -> the
--     chapter record).
--   * member_notifications.source_chapter_id (nullable text): the caller's
--     selected chapter when the notice was written
--     (private.current_member_chapter(); NULL for scheduled and service
--     writers). institutional.minutes.published is written inside
--     save_institutional_record, whose context is exactly that chapter, so a
--     member in two chapters is sent to the minutes only while that chapter
--     is the one selected.
--   * authenticated may SELECT both new columns, beside the existing column
--     grants; it gains no UPDATE (read_at stays the only writable column).
--   * private.notify_member stores p_key in copy_key and the caller's chapter
--     in source_chapter_id. The body is the
--     installed definition read with pg_get_functiondef from a disposable
--     stack at Main 20261005061000; only the insert column list and values
--     change. Signature, SECURITY DEFINER, empty search_path, the case-graph
--     lock, the stress-ledger guard, copy resolution and EXECUTE (none for
--     client roles) are unchanged.

begin;

set local lock_timeout = '5s';

-- Refuse to replace anything but the reviewed predecessor body
-- (20260813022500_stress_notification_egress_guard.sql).
do $predecessor$
declare
  installed text;
begin
  select pg_catalog.md5(p.prosrc) into strict installed
    from pg_catalog.pg_proc p
   where p.oid = 'private.notify_member(uuid, text, jsonb, text)'::regprocedure;
  if installed is distinct from '7984201fd2abaa03f7b9820fbaa4fac1' then
    raise exception 'unreviewed notify_member predecessor: %', installed
      using errcode = '55000';
  end if;
end;
$predecessor$;

alter table public.member_notifications
  add column copy_key text
    constraint member_notifications_copy_key_length check (copy_key is null or pg_catalog.length(copy_key) between 1 and 120);

alter table public.member_notifications
  add column source_chapter_id text;

comment on column public.member_notifications.copy_key is
  'private.notification_copy key the row was rendered from; NULL for rows written before 20261005100000 or outside notify_member. The app routes only keys it knows.';
comment on column public.member_notifications.source_chapter_id is
  'The writing caller''s selected chapter (private.current_member_chapter()) when notify_member ran; NULL for scheduled or service writers. The app opens a chapter destination only while this is the member''s selected chapter.';

grant select (copy_key, source_chapter_id) on public.member_notifications to authenticated;

CREATE OR REPLACE FUNCTION private.notify_member(p_user_id uuid, p_key text, p_args jsonb DEFAULT '{}'::jsonb, p_kind text DEFAULT 'general'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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

  if p_kind in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments')
    and exists (
      select 1
      from private.member_stress_ledger l
      where l.user_id = p_user_id
    )
  then
    return;
  end if;

  select coalesce(p.language, 'en') into recipient_lang
  from public.member_profiles p where p.id = p_user_id;

  select * into copy_row
  from private.notification_copy c
  where c.key = p_key and c.lang = coalesce(recipient_lang, 'en');

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

  insert into public.member_notifications (user_id, title, body, kind, copy_key, source_chapter_id)
  values (p_user_id, rendered_title, rendered_body, p_kind, p_key, private.current_member_chapter());
end;
end;
$function$;

-- Account lifecycle trigger review. Replacing notify_member changes its
-- reviewed definition hash. The body still writes only the one
-- member_notifications row, now with the copy key and the caller's selected
-- chapter, so no account deletion or other referential action gains a new
-- effect. Reconcile the exact four-part review key from the installed surface
-- before the fail-closed assertion below.
update private.account_lifecycle_trigger_review review
set definition_hash = surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where surface.kind = review.kind
  and surface.schema_name = review.schema_name
  and surface.table_name = review.table_name
  and surface.object_name = review.object_name
  and review.kind = 'function'
  and review.schema_name = 'private'
  and review.table_name = ''
  and review.object_name = 'notify_member(p_user_id uuid, p_key text, p_args jsonb, p_kind text)';

do $assert_notify_member_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the notification copy key';
  end if;
end
$assert_notify_member_trigger_review$;

commit;
