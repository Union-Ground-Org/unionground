-- UB-MSG-01 / UB-MSG-04: restore the useful messaging primitives without
-- creating a second authorization boundary. Every reaction, save, reminder,
-- resource, and bridge is a reference to an already-authorized source row.
-- Contact notes are a separate staff-only record and never join member reads.

set local lock_timeout = '5s';

create table public.member_message_reactions (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  source_kind text not null check (source_kind in ('private','channel','task')),
  private_message_id uuid references public.member_messages(id) on delete cascade,
  channel_post_id uuid references public.chapter_thread_posts(id) on delete cascade,
  task_message_id uuid references public.chapter_task_messages(id) on delete cascade,
  reaction text not null check (reaction in ('like','support','celebrate')),
  created_at timestamptz not null default now(),
  constraint member_message_reactions_one_source check (
    (source_kind = 'private' and private_message_id is not null and channel_post_id is null and task_message_id is null)
    or (source_kind = 'channel' and private_message_id is null and channel_post_id is not null and task_message_id is null)
    or (source_kind = 'task' and private_message_id is null and channel_post_id is null and task_message_id is not null)
  )
);

create unique index member_message_reactions_private_key
  on public.member_message_reactions(actor_id, private_message_id, reaction)
  where source_kind = 'private';
create unique index member_message_reactions_channel_key
  on public.member_message_reactions(actor_id, channel_post_id, reaction)
  where source_kind = 'channel';
create unique index member_message_reactions_task_key
  on public.member_message_reactions(actor_id, task_message_id, reaction)
  where source_kind = 'task';

create table public.member_saved_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_kind text not null check (source_kind in ('private','channel','task')),
  private_message_id uuid references public.member_messages(id) on delete cascade,
  channel_post_id uuid references public.chapter_thread_posts(id) on delete cascade,
  task_message_id uuid references public.chapter_task_messages(id) on delete cascade,
  saved_at timestamptz not null default now(),
  constraint member_saved_messages_one_source check (
    (source_kind = 'private' and private_message_id is not null and channel_post_id is null and task_message_id is null)
    or (source_kind = 'channel' and private_message_id is null and channel_post_id is not null and task_message_id is null)
    or (source_kind = 'task' and private_message_id is null and channel_post_id is null and task_message_id is not null)
  )
);

create unique index member_saved_messages_private_key
  on public.member_saved_messages(owner_id, private_message_id)
  where source_kind = 'private';
create unique index member_saved_messages_channel_key
  on public.member_saved_messages(owner_id, channel_post_id)
  where source_kind = 'channel';
create unique index member_saved_messages_task_key
  on public.member_saved_messages(owner_id, task_message_id)
  where source_kind = 'task';

create table public.member_scheduled_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.member_conversations(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  sender_kind text not null check (sender_kind in ('member','steward')),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending','sent','cancelled','failed')),
  failure_reason text check (failure_reason is null or failure_reason in ('authorization-revoked','dispatch-error')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  sent_message_id uuid unique references public.member_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  constraint member_scheduled_messages_terminal_state check (
    (status = 'pending' and dispatched_at is null and failure_reason is null)
    or (status = 'cancelled' and dispatched_at is null)
    or (status = 'sent' and dispatched_at is not null and sent_message_id is not null and failure_reason is null)
    or (status = 'failed' and dispatched_at is not null and failure_reason is not null)
  )
);

alter table public.member_messages
  add column scheduled_message_id uuid unique
    references public.member_scheduled_messages(id) on delete set null;

create index member_scheduled_messages_due_idx
  on public.member_scheduled_messages(scheduled_for, id) where status = 'pending';

create table public.member_message_reminders (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_kind text not null check (source_kind in ('private','channel','task')),
  private_message_id uuid references public.member_messages(id) on delete cascade,
  channel_post_id uuid references public.chapter_thread_posts(id) on delete cascade,
  task_message_id uuid references public.chapter_task_messages(id) on delete cascade,
  note text not null default '' check (char_length(note) <= 500),
  remind_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','delivered','cancelled','failed')),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint member_message_reminders_one_source check (
    (source_kind = 'private' and private_message_id is not null and channel_post_id is null and task_message_id is null)
    or (source_kind = 'channel' and private_message_id is null and channel_post_id is not null and task_message_id is null)
    or (source_kind = 'task' and private_message_id is null and channel_post_id is null and task_message_id is not null)
  )
);

alter table public.member_notifications
  add column message_reminder_id uuid unique
    references public.member_message_reminders(id) on delete set null;

create index member_message_reminders_due_idx
  on public.member_message_reminders(remind_at, id) where status = 'pending';

create table public.member_message_resources (
  id uuid primary key default extensions.gen_random_uuid(),
  message_id uuid not null unique references public.member_messages(id) on delete cascade,
  document_id uuid not null references public.chapter_documents(id) on delete restrict,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.member_contact_notes (
  id uuid primary key default extensions.gen_random_uuid(),
  conversation_id uuid not null references public.member_conversations(id) on delete cascade,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  author_id uuid references auth.users(id) on delete set null,
  source_message_id uuid references public.member_messages(id) on delete set null,
  note text not null check (char_length(btrim(note)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index member_contact_notes_conversation_created_idx
  on public.member_contact_notes(conversation_id, created_at desc);

-- Explicit-actor helpers are required for background dispatch. auth.uid()
-- describes cron, not the member who scheduled the send.
create function private.staff_actor_can_see_user(p_actor uuid, p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.member_roles r
    join public.member_profiles actor_profile on actor_profile.id = p_actor
    join public.member_profiles target_profile on target_profile.id = p_target
    where r.user_id = p_actor
      and r.role = 'steward'
      and (r.chapter_id is null or r.chapter_id = target_profile.chapter_id)
      and (
        not private.staff_mfa_required()
        or private.has_second_factor(p_actor)
      )
  )
$$;

create function private.actor_has_chapter_staff_role(p_actor uuid, p_chapter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.member_roles r
    join public.member_profiles p on p.id = p_actor and p.chapter_id = p_chapter
    where r.user_id = p_actor
      and r.role = any(array['steward','coordinator','advisor','admin','vp'])
      and (r.chapter_id is null or r.chapter_id = p_chapter)
      and (not private.staff_mfa_required() or private.has_second_factor(p_actor))
  )
$$;

create function private.can_actor_send_private_message(
  p_actor uuid,
  p_conversation uuid,
  p_sender_kind text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case p_sender_kind
      when 'member' then c.user_id = p_actor
        and exists (select 1 from public.member_profiles p where p.id = p_actor)
      when 'steward' then private.staff_actor_can_see_user(p_actor, c.user_id)
      else false
    end
    from public.member_conversations c
    join public.member_profiles recipient on recipient.id = c.user_id
    where c.id = p_conversation
  ), false)
$$;

create function private.can_read_message_source(
  p_actor uuid,
  p_source_kind text,
  p_private_message uuid,
  p_channel_post uuid,
  p_task_message uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_source_kind
    when 'private' then exists (
      select 1
      from public.member_messages m
      where m.id = p_private_message
        and (
          private.can_actor_send_private_message(p_actor, m.conversation_id, 'member')
          or private.can_actor_send_private_message(p_actor, m.conversation_id, 'steward')
        )
    )
    when 'channel' then exists (
      select 1
      from public.chapter_thread_posts post
      join public.chapter_threads thread on thread.id = post.thread_id
      join public.chapter_spaces space on space.id = thread.space_id
      join public.member_profiles actor on actor.id = p_actor and actor.chapter_id = post.chapter_id
      where post.id = p_channel_post
        and post.deleted_at is null
        and (
          space.visibility = 'chapter'
          or space.created_by = p_actor
          or exists (
            select 1 from public.chapter_space_members membership
            where membership.space_id = space.id and membership.user_id = p_actor
          )
          or (space.visibility = 'staff' and private.actor_has_chapter_staff_role(p_actor, post.chapter_id))
        )
    )
    when 'task' then exists (
      select 1
      from public.chapter_task_messages message
      join public.member_profiles actor on actor.id = p_actor and actor.chapter_id = message.chapter_id
      where message.id = p_task_message
        and p_actor in (message.sender_id, message.recipient_id)
    )
    else false
  end
$$;

create function private.actor_can_read_document(p_actor uuid, p_document uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chapter_documents document
    join public.member_profiles actor on actor.id = p_actor and actor.chapter_id = document.chapter_id
    where document.id = p_document
      and document.status = 'published'
      and (
        document.visibility = 'chapter'
        or private.actor_has_chapter_staff_role(p_actor, document.chapter_id)
      )
  )
$$;

-- Resolve navigation only after the same underlying-source check used by the
-- mutation RPCs. A caller who lost access gets NULL, never a durable target id
-- that could act as a cross-chapter or deleted-record oracle.
create function private.message_source_target(
  p_actor uuid,
  p_source_kind text,
  p_private_message uuid,
  p_channel_post uuid,
  p_task_message uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not private.can_read_message_source(
      p_actor, p_source_kind, p_private_message, p_channel_post, p_task_message
    ) then null
    when p_source_kind = 'private' then (
      select message.conversation_id from public.member_messages message
      where message.id = p_private_message
    )
    when p_source_kind = 'channel' then (
      select post.thread_id from public.chapter_thread_posts post
      where post.id = p_channel_post
    )
    when p_source_kind = 'task' then (
      select message.task_id from public.chapter_task_messages message
      where message.id = p_task_message
    )
    else null
  end
$$;

-- RLS policies execute as the querying role and therefore need callable
-- predicates. These no-actor wrappers pin the subject to auth.uid(); the
-- arbitrary-actor helpers remain non-executable so they cannot become
-- cross-user authorization oracles.
create function private.current_actor_can_read_message_source(
  p_source_kind text,
  p_private_message uuid,
  p_channel_post uuid,
  p_task_message uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_read_message_source(
    (select auth.uid()), p_source_kind,
    p_private_message, p_channel_post, p_task_message
  )
$$;

create function private.current_actor_can_send_private_message(
  p_conversation uuid,
  p_sender_kind text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_actor_send_private_message(
    (select auth.uid()), p_conversation, p_sender_kind
  )
$$;

create function private.current_actor_can_read_document(p_document uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.actor_can_read_document((select auth.uid()), p_document)
$$;

revoke all on function private.staff_actor_can_see_user(uuid, uuid) from public, anon, authenticated;
revoke all on function private.actor_has_chapter_staff_role(uuid, text) from public, anon, authenticated;
revoke all on function private.can_actor_send_private_message(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.can_read_message_source(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.actor_can_read_document(uuid, uuid) from public, anon, authenticated;
revoke all on function private.message_source_target(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.current_actor_can_read_message_source(text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.current_actor_can_send_private_message(uuid, text) from public, anon, authenticated;
revoke all on function private.current_actor_can_read_document(uuid) from public, anon, authenticated;
grant execute on function private.current_actor_can_read_message_source(text, uuid, uuid, uuid) to authenticated;
grant execute on function private.current_actor_can_send_private_message(uuid, text) to authenticated;
grant execute on function private.current_actor_can_read_document(uuid) to authenticated;

alter table public.member_message_reactions enable row level security;
alter table public.member_saved_messages enable row level security;
alter table public.member_scheduled_messages enable row level security;
alter table public.member_message_reminders enable row level security;
alter table public.member_message_resources enable row level security;
alter table public.member_contact_notes enable row level security;

create policy member_message_reactions_read on public.member_message_reactions
  for select to authenticated using (
    private.current_actor_can_read_message_source(source_kind,
      private_message_id, channel_post_id, task_message_id)
  );
create policy member_saved_messages_read on public.member_saved_messages
  for select to authenticated using (
    owner_id = (select auth.uid())
    and private.current_actor_can_read_message_source(source_kind,
      private_message_id, channel_post_id, task_message_id)
  );
create policy member_scheduled_messages_read on public.member_scheduled_messages
  for select to authenticated using (
    actor_id = (select auth.uid())
    and private.current_actor_can_send_private_message(conversation_id, sender_kind)
  );
create policy member_message_reminders_read on public.member_message_reminders
  for select to authenticated using (
    owner_id = (select auth.uid())
    and private.current_actor_can_read_message_source(source_kind,
      private_message_id, channel_post_id, task_message_id)
  );
create policy member_message_resources_read on public.member_message_resources
  for select to authenticated using (
    private.current_actor_can_read_message_source('private', message_id, null, null)
    and private.current_actor_can_read_document(document_id)
  );
create policy member_contact_notes_steward_read on public.member_contact_notes
  for select to authenticated using (
    public.member_has_role(array['steward'])
    and private.staff_actor_can_see_user((select auth.uid()), member_user_id)
  );

create policy mfa_assurance on public.member_message_reactions as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_saved_messages as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_scheduled_messages as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_message_reminders as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_message_resources as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_contact_notes as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

revoke all on public.member_message_reactions from public, anon, authenticated;
revoke all on public.member_saved_messages from public, anon, authenticated;
revoke all on public.member_scheduled_messages from public, anon, authenticated;
revoke all on public.member_message_reminders from public, anon, authenticated;
revoke all on public.member_message_resources from public, anon, authenticated;
revoke all on public.member_contact_notes from public, anon, authenticated;
grant select on public.member_message_reactions to authenticated;
grant select on public.member_saved_messages to authenticated;
grant select on public.member_scheduled_messages to authenticated;
grant select on public.member_message_reminders to authenticated;
grant select on public.member_message_resources to authenticated;

create function public.toggle_member_message_reaction(
  p_source_kind text,
  p_message_id uuid,
  p_reaction text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  removed integer;
  new_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_source_kind not in ('private','channel','task')
     or p_reaction not in ('like','support','celebrate')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('message-reaction:' || caller::text || ':' || p_message_id::text || ':' || p_reaction, 509));
  delete from public.member_message_reactions r
  where r.actor_id = caller and r.source_kind = p_source_kind and r.reaction = p_reaction
    and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id) = p_message_id;
  get diagnostics removed = row_count;
  if removed > 0 then
    return pg_catalog.jsonb_build_object('reacted', false);
  end if;

  insert into public.member_message_reactions(
    actor_id, source_kind, private_message_id, channel_post_id, task_message_id, reaction)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end,
    p_reaction)
  returning id into new_id;
  return pg_catalog.jsonb_build_object('reacted', true, 'id', new_id);
end;
$$;

create function public.toggle_member_saved_message(p_source_kind text, p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  removed integer;
  new_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_source_kind not in ('private','channel','task')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('saved-message:' || caller::text || ':' || p_message_id::text, 509));
  delete from public.member_saved_messages saved
  where saved.owner_id = caller and saved.source_kind = p_source_kind
    and coalesce(saved.private_message_id, saved.channel_post_id, saved.task_message_id) = p_message_id;
  get diagnostics removed = row_count;
  if removed > 0 then
    return pg_catalog.jsonb_build_object('saved', false);
  end if;
  insert into public.member_saved_messages(
    owner_id, source_kind, private_message_id, channel_post_id, task_message_id)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end)
  returning id into new_id;
  return pg_catalog.jsonb_build_object('saved', true, 'id', new_id);
end;
$$;

create function public.schedule_member_message(
  p_conversation_id uuid,
  p_body text,
  p_scheduled_for timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), E' \t\n\r\f\v');
  conversation public.member_conversations%rowtype;
  sender_kind text;
  new_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if p_scheduled_for <= now() or p_scheduled_for > now() + interval '1 year' then
    raise exception 'invalid schedule time' using errcode = '22023';
  end if;
  select * into conversation from public.member_conversations where id = p_conversation_id for update;
  if not found then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  if private.can_actor_send_private_message(caller, p_conversation_id, 'member') then
    sender_kind := 'member';
  elsif public.member_has_role(array['steward'])
        and private.can_actor_send_private_message(caller, p_conversation_id, 'steward') then
    sender_kind := 'steward';
  else
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  insert into public.member_scheduled_messages(
    actor_id, conversation_id, recipient_id, sender_kind, body, scheduled_for)
  values (caller, conversation.id, conversation.user_id, sender_kind, clean_body, p_scheduled_for)
  returning id into new_id;
  return pg_catalog.jsonb_build_object('id', new_id, 'status', 'pending');
end;
$$;

create function public.cancel_scheduled_member_message(p_scheduled_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  update public.member_scheduled_messages
  set status = 'cancelled'
  where id = p_scheduled_message_id and actor_id = caller and status = 'pending';
  get diagnostics updated = row_count;
  if updated = 0 then raise exception 'scheduled message unavailable' using errcode = '22023'; end if;
  return pg_catalog.jsonb_build_object('cancelled', true);
end;
$$;

create function public.create_member_message_reminder(
  p_source_kind text,
  p_message_id uuid,
  p_remind_at timestamptz,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  new_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_remind_at <= now() or p_remind_at > now() + interval '1 year' or pg_catalog.char_length(clean_note) > 500 then
    raise exception 'invalid reminder' using errcode = '22023';
  end if;
  if p_source_kind not in ('private','channel','task')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;
  insert into public.member_message_reminders(
    owner_id, source_kind, private_message_id, channel_post_id, task_message_id, note, remind_at)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end,
    clean_note, p_remind_at)
  returning id into new_id;
  return pg_catalog.jsonb_build_object('id', new_id, 'status', 'pending');
end;
$$;

create function public.cancel_member_message_reminder(p_reminder_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  update public.member_message_reminders set status = 'cancelled'
  where id = p_reminder_id and owner_id = caller and status = 'pending';
  get diagnostics updated = row_count;
  if updated = 0 then raise exception 'reminder unavailable' using errcode = '22023'; end if;
  return pg_catalog.jsonb_build_object('cancelled', true);
end;
$$;

create function public.send_member_resource(p_conversation_id uuid, p_document_id uuid, p_body text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  sent jsonb;
  message_id uuid;
begin
  if caller is null or not private.mfa_satisfied()
     or not private.can_actor_send_private_message(caller, p_conversation_id, 'member') then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  perform 1 from public.chapter_documents
  where id = p_document_id and status = 'published'
    and private.actor_can_read_document(caller, id);
  if not found then raise exception 'resource unavailable' using errcode = '22023'; end if;
  sent := public.send_member_message(
    p_conversation_id,
    coalesce(nullif(pg_catalog.btrim(coalesce(p_body, '')), ''), 'Shared resource'));
  message_id := (sent ->> 'messageId')::uuid;
  insert into public.member_message_resources(message_id, document_id, added_by)
  values (message_id, p_document_id, caller);
  return sent || pg_catalog.jsonb_build_object('documentId', p_document_id);
end;
$$;

create function public.send_steward_resource(
  p_conversation_id uuid,
  p_document_id uuid,
  p_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  conversation public.member_conversations%rowtype;
  clean_body text;
  message_id uuid;
begin
  if caller is null or not public.member_has_role(array['steward'])
     or not private.can_actor_send_private_message(caller, p_conversation_id, 'steward') then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  select * into conversation from public.member_conversations where id = p_conversation_id for update;
  perform 1 from public.chapter_documents
  where id = p_document_id and status = 'published'
    and private.actor_can_read_document(caller, id)
    -- A resource drop is an authorization grant only when both ends may read
    -- the record. The generic message body additionally keeps document
    -- metadata behind the resource renderer's own RLS check.
    and private.actor_can_read_document(conversation.user_id, id);
  if not found then raise exception 'resource unavailable' using errcode = '22023'; end if;
  clean_body := coalesce(nullif(pg_catalog.btrim(coalesce(p_body, '')), ''), 'Shared resource');
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then raise exception 'invalid message' using errcode = '22023'; end if;
  insert into public.member_messages(conversation_id, user_id, sender_kind, sender_name, body)
  values (conversation.id, conversation.user_id, 'steward', 'Chapter steward', clean_body)
  returning id into message_id;
  insert into public.member_message_resources(message_id, document_id, added_by)
  values (message_id, p_document_id, caller);
  update public.member_conversations set updated_at = now() where id = conversation.id;
  return pg_catalog.jsonb_build_object('messageId', message_id, 'documentId', p_document_id);
end;
$$;

create function public.create_member_contact_note(
  p_conversation_id uuid,
  p_note text,
  p_source_message_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  conversation public.member_conversations%rowtype;
  member_chapter text;
  new_id uuid;
begin
  if caller is null or not public.member_has_role(array['steward'])
     or not private.can_actor_send_private_message(caller, p_conversation_id, 'steward') then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_note, ''))) not between 1 and 2000 then
    raise exception 'note must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  select c.* into conversation from public.member_conversations c where c.id = p_conversation_id;
  select p.chapter_id into member_chapter from public.member_profiles p where p.id = conversation.user_id;
  if member_chapter is null then raise exception 'conversation unavailable' using errcode = '22023'; end if;
  if p_source_message_id is not null and not exists (
    select 1 from public.member_messages m
    where m.id = p_source_message_id and m.conversation_id = conversation.id
  ) then raise exception 'message unavailable' using errcode = '22023'; end if;
  insert into public.member_contact_notes(
    conversation_id, member_user_id, chapter_id, author_id, source_message_id, note)
  values (
    conversation.id, conversation.user_id, member_chapter, caller,
    p_source_message_id, pg_catalog.btrim(p_note))
  returning id into new_id;
  return pg_catalog.jsonb_build_object('id', new_id, 'created', true);
end;
$$;

create function public.list_member_contact_notes(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['steward'])
     or not private.can_actor_send_private_message(caller, p_conversation_id, 'steward') then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', note.id,
      'conversationId', note.conversation_id,
      'sourceMessageId', note.source_message_id,
      'note', note.note,
      'authorId', note.author_id,
      'createdAt', note.created_at) order by note.created_at desc)
    from public.member_contact_notes note
    where note.conversation_id = p_conversation_id
  ), '[]'::jsonb);
end;
$$;

create function public.create_event_from_member_message(p_message_id uuid, p_event_id text, p_title text, p_starts_at timestamptz, p_location text, p_summary text, p_check_in_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not private.can_read_message_source(caller, 'private', p_message_id, null, null) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;
  -- All event content is explicit caller input. The source message body is
  -- never selected or copied into the event or its immutable audit record.
  return public.create_member_event(
    p_event_id, p_title, p_starts_at, p_location, p_summary, p_check_in_code);
end;
$$;

-- The aggregate includes the caller's own inaccessible references as opaque
-- unavailable rows. The browser never receives their old ids or content; an
-- access change is visible without turning this resolver into an oracle.
create function public.list_member_message_activity()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'saved', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', saved.id,
      'sourceKind', saved.source_kind,
      'messageId', case when saved.target_id is not null
        then coalesce(saved.private_message_id, saved.channel_post_id, saved.task_message_id) else null end,
      'targetId', saved.target_id,
      'available', saved.target_id is not null,
      'savedAt', saved.saved_at) order by saved.saved_at desc)
      from (
        select candidate.*,
          private.message_source_target(
            caller, candidate.source_kind, candidate.private_message_id,
            candidate.channel_post_id, candidate.task_message_id
          ) as target_id
        from public.member_saved_messages candidate
        where candidate.owner_id = caller
        order by candidate.saved_at desc, candidate.id desc
        limit 100
      ) saved), '[]'::jsonb),
    'reminders', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', reminder.id,
      'sourceKind', reminder.source_kind,
      'messageId', case when reminder.target_id is not null
        then coalesce(reminder.private_message_id, reminder.channel_post_id, reminder.task_message_id) else null end,
      'targetId', reminder.target_id,
      'available', reminder.target_id is not null,
      'remindAt', reminder.remind_at) order by reminder.remind_at)
      from (
        select candidate.*,
          private.message_source_target(
            caller, candidate.source_kind, candidate.private_message_id,
            candidate.channel_post_id, candidate.task_message_id
          ) as target_id
        from public.member_message_reminders candidate
        where candidate.owner_id = caller and candidate.status = 'pending'
        order by candidate.remind_at, candidate.id
        limit 100
      ) reminder), '[]'::jsonb)
  );
end;
$$;

-- Enrich the existing bounded steward pager in place. The base thread access
-- remains its invoker-RLS boundary; every correlated metadata read carries
-- the same RLS and MFA checks.
drop function public.list_steward_thread_messages(uuid, timestamptz, uuid, integer);
create function public.list_steward_thread_messages(
  p_conversation_id uuid,
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  sender_kind text,
  sender_name text,
  body text,
  created_at timestamptz,
  reactions jsonb,
  saved boolean,
  reminder jsonb,
  resource jsonb,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  total bigint;
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_conversation_id is null then raise exception 'conversation required' using errcode = '22023'; end if;
  if (p_before_id is null) <> (p_before_created is null) then raise exception 'incomplete cursor' using errcode = '22023'; end if;
  select count(*) into total from public.member_messages message where message.conversation_id = p_conversation_id;
  return query
  select message.id, message.sender_kind, message.sender_name, message.body, message.created_at,
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(reaction) order by reaction.created_at)
      from public.member_message_reactions reaction where reaction.private_message_id = message.id), '[]'::jsonb),
    exists (select 1 from public.member_saved_messages saved where saved.owner_id = caller and saved.private_message_id = message.id),
    (select pg_catalog.jsonb_build_object('id', reminder.id, 'remind_at', reminder.remind_at, 'status', reminder.status)
      from public.member_message_reminders reminder where reminder.owner_id = caller and reminder.private_message_id = message.id and reminder.status = 'pending' order by reminder.created_at desc limit 1),
    (select pg_catalog.jsonb_build_object('documentId', link.document_id, 'title', document.title, 'documentType', document.document_type)
      from public.member_message_resources link join public.chapter_documents document on document.id = link.document_id
      where link.message_id = message.id limit 1),
    total
  from public.member_messages message
  where message.conversation_id = p_conversation_id
    and (p_before_id is null or (message.created_at, message.id) < (p_before_created, p_before_id))
  order by message.created_at desc, message.id desc
  limit page_limit;
end;
$$;

create function private.dispatch_due_member_messaging(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job record;
  reminder record;
  sender_name text;
  new_message_id uuid;
  sent_count integer := 0;
  reminder_count integer := 0;
  failed_count integer := 0;
begin
  if p_limit not between 1 and 500 then raise exception 'invalid dispatch limit' using errcode = '22023'; end if;

  for job in
    select scheduled.* from public.member_scheduled_messages scheduled
    where scheduled.status = 'pending' and scheduled.scheduled_for <= now()
    order by scheduled.scheduled_for, scheduled.id
    limit p_limit
    for update skip locked
  loop
    if not private.can_actor_send_private_message(job.actor_id, job.conversation_id, job.sender_kind)
       or not exists (select 1 from public.member_profiles recipient where recipient.id = job.recipient_id)
       or not exists (
         select 1 from public.member_conversations conversation
         where conversation.id = job.conversation_id and conversation.user_id = job.recipient_id
       ) then
      update public.member_scheduled_messages
      set status = 'failed', failure_reason = 'authorization-revoked',
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      failed_count := failed_count + 1;
      continue;
    end if;
    begin
      if job.sender_kind = 'member' then
        select coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Member') into sender_name
        from public.member_profiles profile where profile.id = job.actor_id;
      else
        sender_name := 'Chapter steward';
      end if;
      insert into public.member_messages(
        conversation_id, user_id, sender_kind, sender_name, body, scheduled_message_id)
      values (
        job.conversation_id, job.recipient_id, job.sender_kind, sender_name, job.body, job.id)
      on conflict (scheduled_message_id) do nothing
      returning id into new_message_id;
      if new_message_id is null then
        select id into new_message_id from public.member_messages where scheduled_message_id = job.id;
      end if;
      if job.sender_kind = 'member' then
        insert into public.member_action_log(user_id, action_key, action_kind)
        values (job.actor_id, 'message-' || new_message_id::text, 'message')
        on conflict (user_id, action_key) do nothing;
      end if;
      update public.member_conversations set updated_at = now() where id = job.conversation_id;
      update public.member_scheduled_messages
      set status = 'sent', sent_message_id = new_message_id, failure_reason = null,
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      sent_count := sent_count + 1;
    exception when others then
      update public.member_scheduled_messages
      set status = 'failed', failure_reason = 'dispatch-error',
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      failed_count := failed_count + 1;
    end;
  end loop;

  for reminder in
    select pending.* from public.member_message_reminders pending
    where pending.status = 'pending' and pending.remind_at <= now()
    order by pending.remind_at, pending.id
    limit p_limit
    for update skip locked
  loop
    if not private.can_read_message_source(reminder.owner_id, reminder.source_kind,
      reminder.private_message_id, reminder.channel_post_id, reminder.task_message_id) then
      update public.member_message_reminders
      set status = 'failed', delivered_at = now() where id = reminder.id;
      failed_count := failed_count + 1;
      continue;
    end if;
    insert into public.member_notifications(user_id, title, body, kind, message_reminder_id)
    values (reminder.owner_id, 'Message reminder', 'Open Messages to review your reminder.', 'general', reminder.id)
    on conflict (message_reminder_id) do nothing;
    update public.member_message_reminders
    set status = 'delivered', delivered_at = now() where id = reminder.id;
    reminder_count := reminder_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'sent', sent_count, 'reminders', reminder_count, 'failed', failed_count);
end;
$$;

revoke all on function public.toggle_member_message_reaction(text, uuid, text) from public, anon, authenticated;
revoke all on function public.toggle_member_saved_message(text, uuid) from public, anon, authenticated;
revoke all on function public.schedule_member_message(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_scheduled_member_message(uuid) from public, anon, authenticated;
revoke all on function public.create_member_message_reminder(text, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.cancel_member_message_reminder(uuid) from public, anon, authenticated;
revoke all on function public.send_member_resource(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.send_steward_resource(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.create_member_contact_note(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.list_member_contact_notes(uuid) from public, anon, authenticated;
revoke all on function public.create_event_from_member_message(uuid, text, text, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.list_member_message_activity() from public, anon, authenticated;
revoke all on function public.list_steward_thread_messages(uuid, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function private.dispatch_due_member_messaging(integer) from public, anon, authenticated;

grant execute on function public.toggle_member_message_reaction(text, uuid, text) to authenticated;
grant execute on function public.toggle_member_saved_message(text, uuid) to authenticated;
grant execute on function public.schedule_member_message(uuid, text, timestamptz) to authenticated;
grant execute on function public.cancel_scheduled_member_message(uuid) to authenticated;
grant execute on function public.create_member_message_reminder(text, uuid, timestamptz, text) to authenticated;
grant execute on function public.cancel_member_message_reminder(uuid) to authenticated;
grant execute on function public.send_member_resource(uuid, uuid, text) to authenticated;
grant execute on function public.send_steward_resource(uuid, uuid, text) to authenticated;
grant execute on function public.create_member_contact_note(uuid, text, uuid) to authenticated;
grant execute on function public.list_member_contact_notes(uuid) to authenticated;
grant execute on function public.create_event_from_member_message(uuid, text, text, timestamptz, text, text, text) to authenticated;
grant execute on function public.list_member_message_activity() to authenticated;
grant execute on function public.list_steward_thread_messages(uuid, timestamptz, uuid, integer) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'member-messaging-dispatch';
  perform cron.schedule('member-messaging-dispatch', '* * * * *',
    $job$ select private.dispatch_due_member_messaging(); $job$);
end
$$;

do $$ begin perform pg_catalog.pg_notify('pgrst', 'reload schema'); end $$;
