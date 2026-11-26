-- REQ-UG-STANDARD-TASK-CONTRACT-20260802
--
-- Standard Task keeps one inherited chapter boundary. Tasks, comments,
-- authorized-record links, and audit rows all use the board's chapter access;
-- no per-task visibility ACL is introduced. Sensitive content stays outside
-- task cards: attachments are same-origin app links, never copied records.

-- A. Task defaults and the five-stage workflow -----------------------------

alter table public.chapter_tasks
  drop constraint if exists chapter_tasks_status_check,
  drop constraint if exists chapter_tasks_dates_ordered;

alter table public.chapter_tasks
  alter column status set default 'to_do',
  alter column start_date drop default,
  alter column start_date drop not null,
  alter column due_date drop default,
  alter column due_date drop not null,
  add column task_type text not null default 'general';

alter table public.chapter_tasks
  add constraint chapter_tasks_status_check
    check (status in ('backlog', 'to_do', 'in_progress', 'needs_review', 'done')),
  add constraint chapter_tasks_type_check
    check (task_type in (
      'general', 'meeting_event', 'review_approval', 'member_follow_up',
      'document_request', 'issue_incident'
    )),
  add constraint chapter_tasks_dates_ordered
    check (start_date is null or due_date is null or due_date >= start_date);

grant insert (task_type) on public.chapter_tasks to authenticated;
grant update (task_type) on public.chapter_tasks to authenticated;

comment on column public.chapter_tasks.task_type is
  'Standard Task type. General is the quick-create default; specialized templates may prefill the other types later.';
comment on column public.chapter_tasks.start_date is
  'Optional scheduling boundary. Quick creation leaves it blank.';
comment on column public.chapter_tasks.due_date is
  'Optional scheduling boundary. Quick creation leaves it blank.';

-- B. Shared task comments with explicit mentions ---------------------------

create table public.chapter_task_comments (
  id uuid primary key default extensions.gen_random_uuid(),
  task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  author_id uuid references auth.users(id) on delete set null,
  body text not null,
  mentioned_user_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint chapter_task_comments_body_bounded
    check (char_length(btrim(body)) between 1 and 2000)
);

create index chapter_task_comments_task_created_idx
  on public.chapter_task_comments (task_id, created_at, id);
create index chapter_task_comments_chapter_created_idx
  on public.chapter_task_comments (chapter_id, created_at desc);

alter table public.chapter_task_comments enable row level security;

create policy chapter_task_comments_select_board
  on public.chapter_task_comments
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.chapter_tasks t
      join public.member_profiles p
        on p.id = (select auth.uid())
       and p.chapter_id = t.chapter_id
      where t.id = chapter_task_comments.task_id
        and t.chapter_id = chapter_task_comments.chapter_id
        and t.deleted_at is null
    )
  );

create policy mfa_assurance on public.chapter_task_comments
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_comments from public, anon, authenticated;
grant select on table public.chapter_task_comments to authenticated;

create or replace function public.add_chapter_task_comment(
  p_task_id uuid,
  p_body text,
  p_mention_ids uuid[] default '{}'
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
  clean_mentions uuid[] := '{}';
  inserted public.chapter_task_comments%rowtype;
  recipient uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'comment must be between 1 and 2000 characters' using errcode = '22023';
  end if;

  select t.*
    into task_row
  from public.chapter_tasks t
  join public.member_profiles p
    on p.id = caller
   and p.chapter_id = t.chapter_id
  where t.id = p_task_id
    and t.deleted_at is null
  for update of t;

  select p.full_name
    into caller_name
  from public.member_profiles p
  where p.id = caller;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_mention_ids, '{}')) mention_id
    where not exists (
      select 1 from public.member_profiles p
      where p.id = mention_id and p.chapter_id = task_row.chapter_id
    )
  ) then
    raise exception 'mentioned member must belong to this chapter' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct mention_id order by mention_id), '{}')
    into clean_mentions
  from unnest(coalesce(p_mention_ids, '{}')) mention_id;

  insert into public.chapter_task_comments (
    task_id, chapter_id, author_id, body, mentioned_user_ids
  ) values (
    task_row.id, task_row.chapter_id, caller, btrim(p_body), clean_mentions
  ) returning * into inserted;

  for recipient in
    select distinct audience.user_id
    from (
      select task_row.created_by as user_id
      union all select task_row.assignee_id
      union all select unnest(clean_mentions)
    ) audience
    join public.member_profiles recipient_profile
      on recipient_profile.id = audience.user_id
     and recipient_profile.chapter_id = task_row.chapter_id
    where audience.user_id is not null and audience.user_id <> caller
  loop
    perform private.notify_member(
      recipient,
      'task.comment',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')),
      'tasks'
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'id', inserted.id,
    'taskId', inserted.task_id,
    'chapterId', inserted.chapter_id,
    'authorId', inserted.author_id,
    'body', inserted.body,
    'mentionedUserIds', inserted.mentioned_user_ids,
    'createdAt', inserted.created_at
  );
end
$$;

revoke all on function public.add_chapter_task_comment(uuid, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.add_chapter_task_comment(uuid, text, uuid[])
  to authenticated;

insert into private.notification_copy (key, lang, title, body) values
  ('task.comment', 'en', 'New task comment', '{name} added an update to a task you follow.'),
  ('task.comment', 'es', 'Nuevo comentario de tarea', '{name} agregó una actualización a una tarea que sigues.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

comment on table public.chapter_task_comments is
  'Task-specific updates inheriting the task board chapter boundary. Notifications fan out to creator, assignee, and explicit mentions.';

-- C. Attachments are authorized in-app record links ------------------------

create table public.chapter_task_attachments (
  id uuid primary key default extensions.gen_random_uuid(),
  task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  label text not null,
  record_url text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chapter_task_attachments_label_bounded
    check (char_length(btrim(label)) between 1 and 120),
  constraint chapter_task_attachments_url_bounded
    check (
      char_length(record_url) between 3 and 500
      and record_url ~ '^/m(/|$)'
      and record_url !~ '[[:space:]]'
    )
);

create index chapter_task_attachments_task_created_idx
  on public.chapter_task_attachments (task_id, created_at, id);

alter table public.chapter_task_attachments enable row level security;

create policy chapter_task_attachments_select_board
  on public.chapter_task_attachments
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.chapter_tasks t
      join public.member_profiles p
        on p.id = (select auth.uid())
       and p.chapter_id = t.chapter_id
      where t.id = chapter_task_attachments.task_id
        and t.chapter_id = chapter_task_attachments.chapter_id
        and t.deleted_at is null
    )
  );

create policy mfa_assurance on public.chapter_task_attachments
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_attachments from public, anon, authenticated;
grant select on table public.chapter_task_attachments to authenticated;

-- D. Immutable audit history -----------------------------------------------

create table public.chapter_task_activity (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  from_value text,
  to_value text,
  created_at timestamptz not null default now(),
  constraint chapter_task_activity_action_check
    check (action in (
      'created', 'status_changed', 'assignee_changed', 'type_changed',
      'blocked', 'unblocked', 'board_changed', 'deleted', 'restored',
      'attachment_added', 'attachment_removed'
    ))
);

create index chapter_task_activity_task_created_idx
  on public.chapter_task_activity (task_id, created_at desc, id desc);

alter table public.chapter_task_activity enable row level security;

create policy chapter_task_activity_select_board
  on public.chapter_task_activity
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.chapter_tasks t
      join public.member_profiles p
        on p.id = (select auth.uid())
       and p.chapter_id = t.chapter_id
      where t.id = chapter_task_activity.task_id
        and t.chapter_id = chapter_task_activity.chapter_id
        and t.deleted_at is null
    )
  );

create policy mfa_assurance on public.chapter_task_activity
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_activity from public, anon, authenticated;
grant select on table public.chapter_task_activity to authenticated;

create or replace function private.audit_chapter_task_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := coalesce(new.updated_by, new.deleted_by, new.created_by, (select auth.uid()));
begin
  if tg_op = 'INSERT' then
    insert into public.chapter_task_activity (
      task_id, chapter_id, actor_id, action, to_value
    ) values (
      new.id, new.chapter_id, actor, 'created', new.status
    );
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (new.id, new.chapter_id, actor, 'status_changed', old.status, new.status);
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (new.id, new.chapter_id, actor, 'assignee_changed', old.assignee_id::text, new.assignee_id::text);
  end if;
  if new.task_type is distinct from old.task_type then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (new.id, new.chapter_id, actor, 'type_changed', old.task_type, new.task_type);
  end if;
  if new.blocked is distinct from old.blocked then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action)
    values (new.id, new.chapter_id, actor, case when new.blocked then 'blocked' else 'unblocked' end);
  end if;
  if new.workstream is distinct from old.workstream then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (new.id, new.chapter_id, actor, 'board_changed', old.workstream, new.workstream);
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action)
    values (new.id, new.chapter_id, actor, case when new.deleted_at is null then 'restored' else 'deleted' end);
  end if;
  return new;
end
$$;

revoke all on function private.audit_chapter_task_change() from public, anon, authenticated;

create trigger chapter_tasks_audit
after insert or update on public.chapter_tasks
for each row execute function private.audit_chapter_task_change();

comment on table public.chapter_task_activity is
  'Append-only audit history for task creation, status, assignment, type, blocked state, board moves, deletion/restoration, and authorized-record links.';

create or replace function public.add_chapter_task_attachment(
  p_task_id uuid,
  p_label text,
  p_record_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
  inserted public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_label, ''))) not between 1 and 120 then
    raise exception 'attachment label must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if coalesce(p_record_url, '') !~ '^/m(/|$)'
     or char_length(p_record_url) not between 3 and 500
     or p_record_url ~ '[[:space:]]' then
    raise exception 'attachment must be an authorized in-app record link' using errcode = '22023';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;
  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  insert into public.chapter_task_attachments (
    task_id, chapter_id, label, record_url, created_by
  ) values (
    task_row.id, task_row.chapter_id, btrim(p_label), p_record_url, caller
  ) returning * into inserted;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, task_row.chapter_id, caller, 'attachment_added', inserted.id::text
  );

  return pg_catalog.jsonb_build_object(
    'id', inserted.id,
    'taskId', inserted.task_id,
    'chapterId', inserted.chapter_id,
    'label', inserted.label,
    'recordUrl', inserted.record_url,
    'createdBy', inserted.created_by,
    'createdAt', inserted.created_at,
    'updatedAt', inserted.updated_at
  );
end
$$;

create or replace function public.remove_chapter_task_attachment(p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  attachment_row public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select a.* into attachment_row
  from public.chapter_task_attachments a
  join public.chapter_tasks t on t.id = a.task_id and t.deleted_at is null
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where a.id = p_attachment_id
  for update of a;
  if attachment_row.id is null then
    raise exception 'attachment unavailable' using errcode = '22023';
  end if;

  delete from public.chapter_task_attachments where id = attachment_row.id;
  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, from_value
  ) values (
    attachment_row.task_id, attachment_row.chapter_id, caller,
    'attachment_removed', attachment_row.id::text
  );

  return pg_catalog.jsonb_build_object('id', attachment_row.id, 'deleted', true);
end
$$;

revoke all on function public.add_chapter_task_attachment(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.remove_chapter_task_attachment(uuid)
  from public, anon, authenticated;
grant execute on function public.add_chapter_task_attachment(uuid, text, text)
  to authenticated;
grant execute on function public.remove_chapter_task_attachment(uuid)
  to authenticated;

comment on table public.chapter_task_attachments is
  'Authorized same-origin record links. Cards expose only the count; linked record permissions remain authoritative.';
