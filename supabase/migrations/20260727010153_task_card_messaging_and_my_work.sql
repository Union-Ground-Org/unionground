-- REQ-UG-TASK-CARD-MESSAGING-MY-WORK-20260726
--
-- A task assignment must point at a real same-chapter member before the card
-- can address a private message. Task messages are immutable client-side and
-- readable only by their sender or recipient.

alter table public.chapter_tasks
  add column assignee_id uuid references auth.users(id) on delete set null;

create index chapter_tasks_chapter_assignee_status_idx
  on public.chapter_tasks (chapter_id, assignee_id, status, due_date);

create or replace function private.prepare_chapter_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  resolved_assignee_name text;
begin
  if caller is null then
    raise exception 'authentication required';
  end if;

  select p.chapter_id
    into caller_chapter
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
    -- A chapter transfer must not freeze unrelated task updates. The client
    -- cannot write assignee_name, so retaining the prior server-stamped copy
    -- is safe until an authorized editor deliberately changes the assignee.
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

  return new;
end
$$;

revoke insert (assignee_name) on public.chapter_tasks from authenticated;
revoke update (assignee_name) on public.chapter_tasks from authenticated;
grant insert (assignee_id) on public.chapter_tasks to authenticated;
grant update (assignee_id) on public.chapter_tasks to authenticated;

create or replace function public.list_chapter_task_assignees()
returns table (
  user_id uuid,
  full_name text,
  initials text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id
    into caller_chapter
  from public.member_profiles p
  where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;

  return query
  select p.id, p.full_name, p.initials
  from public.member_profiles p
  where p.chapter_id = caller_chapter
  order by p.full_name, p.id;
end
$$;

revoke all on function public.list_chapter_task_assignees() from public, anon, authenticated;
grant execute on function public.list_chapter_task_assignees() to authenticated;

create table public.chapter_task_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint chapter_task_messages_distinct_participants
    check (sender_id <> recipient_id),
  constraint chapter_task_messages_body_bounded
    check (char_length(btrim(body)) between 1 and 2000)
);

create index chapter_task_messages_task_participants_created_idx
  on public.chapter_task_messages (task_id, sender_id, recipient_id, created_at);

create index chapter_task_messages_recipient_created_idx
  on public.chapter_task_messages (recipient_id, created_at desc);

alter table public.chapter_task_messages enable row level security;

create policy chapter_task_messages_select_participant
  on public.chapter_task_messages
  for select
  to authenticated
  using (
    (
      sender_id = (select auth.uid())
      or recipient_id = (select auth.uid())
    )
    and exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_task_messages.chapter_id
    )
  );

create policy mfa_assurance
  on public.chapter_task_messages
  as restrictive
  for all
  to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_messages from public, anon, authenticated;
grant select on table public.chapter_task_messages to authenticated;

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

  -- In-app only: kind=general never enters the outbound delivery queue.
  -- Realtime makes the alert and message row visible without a reload.
  insert into public.member_notifications (user_id, title, body, kind)
  values (
    recipient,
    'New task message',
    'Open Tasks to read your private task conversation.',
    'general'
  );

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

comment on column public.chapter_tasks.assignee_id is
  'Same-chapter member identity used for My work filtering and task-card messaging.';

comment on table public.chapter_task_messages is
  'Private task-scoped messages readable only by their sender and recipient.';

-- The existing notification publication is deliberately INSERT-only. Task
-- messages need only INSERT events too, and participant RLS authorizes each
-- subscriber before Realtime releases a row.
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    return;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
      and (pubdelete or pubupdate or pubtruncate)
  ) then
    raise exception
      'supabase_realtime must remain insert-only before publishing chapter_task_messages';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and not (
        schemaname = 'public'
        and tablename in ('member_notifications', 'chapter_task_messages')
      )
  ) then
    raise exception
      'supabase_realtime contains an unexpected table; refusing to change its contract';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chapter_task_messages'
  ) then
    execute
      'alter publication supabase_realtime add table public.chapter_task_messages';
  end if;
end
$$;
