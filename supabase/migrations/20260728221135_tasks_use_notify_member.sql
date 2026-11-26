-- REQ-UG-TASKS-NOTIFY-MEMBER-20260727
--
-- Converts the three task notification sites onto private.notify_member.
-- Bodies are 20260727033000's verbatim; only the notification inserts change,
-- so the copy now lives in private.notification_copy and both languages are
-- guaranteed by a primary key rather than by an if/else a reviewer has to spot.

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

  previous_assignee := case when tg_op = 'UPDATE' then old.assignee_id else null end;

  if new.assignee_id is distinct from previous_assignee then
    if new.assignee_id is not null and new.assignee_id <> caller then
      perform private.notify_member(
        new.assignee_id, 'task.assigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')));
    end if;

    if previous_assignee is not null and previous_assignee <> caller then
      perform private.notify_member(
        previous_assignee, 'task.unassigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')));
    end if;
  end if;

  return new;
end
$$;

revoke all on function private.prepare_chapter_task() from public, anon, authenticated;

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
    task_id, chapter_id, sender_id, recipient_id, body
  )
  values (
    task_row.id, task_row.chapter_id, caller, recipient, btrim(p_body)
  )
  returning * into inserted;

  select p.full_name into caller_name
  from public.member_profiles p where p.id = caller;

  perform private.notify_member(
    recipient, 'task.message',
    pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')));

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

notify pgrst, 'reload schema';
