-- REQ-UG-TASKS-STAFF-ONLY-20260727
--
-- Three owner decisions from the Work Coordination design pass, in the layer
-- that can actually enforce them:
--
--   1. STAFF ONLY. Routing the surface onto a staff plane hides it; it changes
--      no grant. Writes on chapter_tasks narrow to the five staff roles. READ
--      stays open to the whole chapter (decided: a member may see the board,
--      not touch it) -- so the Progress and Calendar views remain honest for
--      the people whose names are on the cards.
--   2. REASSIGNMENT NOTIFIES. Written inside the same trigger that resolves
--      the assignee name, so no caller can forget it, and localized per
--      RECIPIENT using the idiom approve_form/return_form already use.
--   3. LOCALE. The task-message body shipped as hardcoded English inside
--      20260727010153. Same fix: branch on the recipient's member_profiles
--      .language. No new columns; this repo localizes notifications in the
--      definer body.
--
-- Nothing here touches the client column grants from 20260727010153: the
-- browser still may not write chapter_id, created_by, assignee_name or
-- done_at, and assignee_id is still resolved server-side.

-- 1. Writes are staff-only. member_has_role() is the same helper the delete
--    policy already calls, so the role source of truth does not change.
drop policy if exists chapter_tasks_insert_chapter on public.chapter_tasks;
drop policy if exists chapter_tasks_update_chapter on public.chapter_tasks;
drop policy if exists chapter_tasks_delete_creator_or_staff on public.chapter_tasks;

create policy chapter_tasks_insert_staff on public.chapter_tasks
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  );

create policy chapter_tasks_update_staff on public.chapter_tasks
  for update to authenticated
  using (
    public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  )
  with check (
    public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  );

-- Creator-or-staff becomes staff-only: every creator is now staff by the
-- insert policy above, so the creator branch could only ever have admitted a
-- member who held a role at insert time and lost it since. That member should
-- not be able to delete chapter work either.
create policy chapter_tasks_delete_staff on public.chapter_tasks
  for delete to authenticated
  using (
    public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  );

-- chapter_tasks_select_chapter is deliberately left as it is: read-only for
-- every member of the chapter.

-- 2 + 3. The trigger. Body is 20260727010153's verbatim, plus the assignment
-- and un-assignment notices at the end. Ordering matters: the notices are
-- written AFTER the ownership/immutability checks, so a rejected write sends
-- nothing.
create or replace function private.prepare_chapter_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_name text;
  resolved_assignee_name text;
  previous_assignee uuid;
  recipient_lang text;
begin
  if caller is null then
    raise exception 'authentication required';
  end if;

  select p.chapter_id, p.full_name
    into caller_chapter, caller_name
  from public.member_profiles p
  where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required';
  end if;

  new.title := btrim(new.title);
  new.description := btrim(new.description);
  new.workstream := btrim(new.workstream);

  if new.assignee_id is null then
    new.assignee_name := '';
  elsif tg_op = 'INSERT'
     or new.assignee_id is distinct from old.assignee_id then
    select p.full_name
      into resolved_assignee_name
    from public.member_profiles p
    where p.id = new.assignee_id
      and p.chapter_id = caller_chapter;

    if resolved_assignee_name is null then
      raise exception 'assignee must be a member of your chapter'
        using errcode = '22023';
    end if;

    new.assignee_name := btrim(resolved_assignee_name);
  else
    new.assignee_name := old.assignee_name;
  end if;

  if tg_op = 'INSERT' then
    new.chapter_id := caller_chapter;
    new.created_by := caller;
    new.created_at := now();
  elsif new.chapter_id is distinct from old.chapter_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'task ownership fields are immutable';
  end if;

  new.updated_by := caller;
  new.updated_at := now();

  if new.status = 'done' then
    new.progress := 100;
    new.done_at := case
      when tg_op = 'UPDATE' then coalesce(old.done_at, now())
      else now()
    end;
  else
    new.done_at := null;
  end if;

  -- Assignment notices. Neither body names the task title: a lock screen on a
  -- break-room table must not disclose the work (the rule the push pass set).
  -- kind='general' keeps both in-app only, so no reassignment ever becomes
  -- outbound mail.
  previous_assignee := case when tg_op = 'UPDATE' then old.assignee_id else null end;

  if new.assignee_id is distinct from previous_assignee then
    if new.assignee_id is not null and new.assignee_id <> caller then
      select coalesce(p.language, 'en') into recipient_lang
      from public.member_profiles p where p.id = new.assignee_id;

      if recipient_lang = 'es' then
        insert into public.member_notifications (user_id, title, body, kind)
        values (new.assignee_id,
          coalesce(caller_name, 'Alguien') || ' te asignó una tarea',
          'Abre Tareas para ver tu lista.', 'general');
      else
        insert into public.member_notifications (user_id, title, body, kind)
        values (new.assignee_id,
          coalesce(caller_name, 'Someone') || ' assigned you a task',
          'Open Tasks to see what is on your list.', 'general');
      end if;
    end if;

    if previous_assignee is not null and previous_assignee <> caller then
      select coalesce(p.language, 'en') into recipient_lang
      from public.member_profiles p where p.id = previous_assignee;

      if recipient_lang = 'es' then
        insert into public.member_notifications (user_id, title, body, kind)
        values (previous_assignee,
          'Una tarea salió de tu lista',
          coalesce(caller_name, 'Alguien') || ' la reasignó. No te corresponde nada.', 'general');
      else
        insert into public.member_notifications (user_id, title, body, kind)
        values (previous_assignee,
          'A task moved off your list',
          coalesce(caller_name, 'Someone') || ' reassigned it. Nothing is owed by you.', 'general');
      end if;
    end if;
  end if;

  return new;
end
$$;

revoke all on function private.prepare_chapter_task() from public, anon, authenticated;

-- 3b. The message notice, localized. Body is 20260727010153's verbatim with
-- the notification insert replaced; everything else -- the MFA gate, the row
-- lock, the participant checks, the recipient resolution -- is unchanged.
create or replace function public.send_chapter_task_message(
  p_task_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_name text;
  task_row public.chapter_tasks%rowtype;
  recipient uuid;
  recipient_lang text;
  inserted public.chapter_task_messages%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'message must be between 1 and 2000 characters'
      using errcode = '22023';
  end if;

  select t.*
    into task_row
  from public.chapter_tasks t
  join public.member_profiles caller_profile
    on caller_profile.id = caller
   and caller_profile.chapter_id = t.chapter_id
  where t.id = p_task_id
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  if caller is distinct from task_row.created_by
     and caller is distinct from task_row.assignee_id then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  if caller = task_row.assignee_id then
    recipient := task_row.created_by;
  else
    recipient := task_row.assignee_id;
  end if;

  if recipient is null or recipient = caller then
    raise exception 'task has no message recipient' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.member_profiles recipient_profile
    where recipient_profile.id = recipient
      and recipient_profile.chapter_id = task_row.chapter_id
  ) then
    raise exception 'message recipient is unavailable' using errcode = '22023';
  end if;

  insert into public.chapter_task_messages (
    task_id,
    chapter_id,
    sender_id,
    recipient_id,
    body
  )
  values (
    task_row.id,
    task_row.chapter_id,
    caller,
    recipient,
    btrim(p_body)
  )
  returning * into inserted;

  select p.full_name into caller_name
  from public.member_profiles p where p.id = caller;

  select coalesce(p.language, 'en') into recipient_lang
  from public.member_profiles p where p.id = recipient;

  -- In-app only: kind=general never enters the outbound delivery queue.
  -- Neither language quotes the message or names the task.
  if recipient_lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (recipient,
      coalesce(caller_name, 'Alguien') || ' escribió sobre una tarea tuya',
      'Abre Tareas para leer la conversación privada.', 'general');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (recipient,
      coalesce(caller_name, 'Someone') || ' wrote about a task you are on',
      'Open Tasks to read the private conversation.', 'general');
  end if;

  return jsonb_build_object(
    'id', inserted.id,
    'taskId', inserted.task_id,
    'chapterId', inserted.chapter_id,
    'senderId', inserted.sender_id,
    'recipientId', inserted.recipient_id,
    'body', inserted.body,
    'createdAt', inserted.created_at
  );
end
$$;

revoke all on function public.send_chapter_task_message(uuid, text)
  from public, anon, authenticated;
grant execute on function public.send_chapter_task_message(uuid, text)
  to authenticated;

comment on table public.chapter_tasks is
  'Chapter-scoped work shared by the Board, Calendar, Timeline and Progress views. Readable chapter-wide; writable by staff roles only (2026-07-27 decision).';

notify pgrst, 'reload schema';
