-- REQ-UG-KANBAN-PHASE3-20260801
-- Full-task parent/child links plus a private, self-owned watch preference.
-- Subtask links broadcast with the board. Watch rows deliberately do not:
-- another member's watch identity is never part of the chapter topic.
-- Rows in both tables are immutable; clients insert and delete only.

set local lock_timeout = '5s';

create table public.chapter_task_subtasks (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  parent_task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  subtask_id uuid not null references public.chapter_tasks(id) on delete cascade,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint chapter_task_subtasks_no_self check (parent_task_id <> subtask_id),
  constraint chapter_task_subtasks_one_parent unique (subtask_id),
  unique (parent_task_id, subtask_id)
);

create index chapter_task_subtasks_parent_idx on public.chapter_task_subtasks (parent_task_id);
create index chapter_task_subtasks_chapter_idx on public.chapter_task_subtasks (chapter_id);
alter table public.chapter_task_subtasks enable row level security;

create or replace function private.prepare_chapter_task_subtask()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  parent_chapter text;
  child_chapter text;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;

  select t.chapter_id into parent_chapter
  from public.chapter_tasks t
  where t.id = new.parent_task_id and t.deleted_at is null;
  select t.chapter_id into child_chapter
  from public.chapter_tasks t
  where t.id = new.subtask_id and t.deleted_at is null;
  if parent_chapter is null or child_chapter is null then
    raise exception 'subtask endpoints must be live tasks' using errcode = '22023';
  end if;
  if parent_chapter <> caller_chapter or child_chapter <> caller_chapter then
    raise exception 'subtask endpoints must belong to your chapter' using errcode = '22023';
  end if;

  new.chapter_id := caller_chapter;
  new.created_by := caller;
  new.created_at := now();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chapter_task_subtasks:' || caller_chapter, 0));

  -- parent -> child closes a loop when child already reaches parent.
  if exists (
    with recursive descendants(id) as (
      select new.subtask_id
      union
      select s.subtask_id
      from public.chapter_task_subtasks s
      join descendants d on s.parent_task_id = d.id
    )
    select 1 from descendants where id = new.parent_task_id
  ) then
    raise exception 'subtask link would create a cycle' using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function private.prepare_chapter_task_subtask() from public, anon, authenticated;
create trigger chapter_task_subtasks_prepare
before insert on public.chapter_task_subtasks
for each row execute function private.prepare_chapter_task_subtask();
create trigger chapter_task_subtasks_broadcast
after insert or update or delete on public.chapter_task_subtasks
for each row execute function private.broadcast_chapter_task_change();

create policy chapter_task_subtasks_select_chapter on public.chapter_task_subtasks
  for select to authenticated
  using (exists (
    select 1 from public.member_profiles p
    where p.id = (select auth.uid()) and p.chapter_id = chapter_task_subtasks.chapter_id
  ));
create policy chapter_task_subtasks_insert_staff on public.chapter_task_subtasks
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_task_subtasks.chapter_id
    )
  );
create policy chapter_task_subtasks_delete_staff on public.chapter_task_subtasks
  for delete to authenticated
  using (
    public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_task_subtasks.chapter_id
    )
  );
create policy mfa_assurance on public.chapter_task_subtasks
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_subtasks from public, anon, authenticated;
grant select on table public.chapter_task_subtasks to authenticated;
grant insert (parent_task_id, subtask_id) on public.chapter_task_subtasks to authenticated;
grant delete on table public.chapter_task_subtasks to authenticated;
comment on table public.chapter_task_subtasks is
  'Immutable parent-child links between full chapter_tasks. A task has at most one parent; links are same-chapter, live-endpoint and acyclic.';

create table public.chapter_task_watchers (
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
create index chapter_task_watchers_task_idx on public.chapter_task_watchers (task_id);
create index chapter_task_watchers_chapter_idx on public.chapter_task_watchers (chapter_id);
alter table public.chapter_task_watchers enable row level security;

create or replace function private.prepare_chapter_task_watcher()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  task_chapter text;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;
  select t.chapter_id into task_chapter
  from public.chapter_tasks t
  where t.id = new.task_id and t.deleted_at is null;
  if task_chapter is null then
    raise exception 'watch target must be a live task' using errcode = '22023';
  end if;
  if task_chapter <> caller_chapter then
    raise exception 'task must belong to your chapter' using errcode = '22023';
  end if;
  new.user_id := caller;
  new.chapter_id := caller_chapter;
  new.created_at := now();
  return new;
end
$$;

revoke all on function private.prepare_chapter_task_watcher() from public, anon, authenticated;
create trigger chapter_task_watchers_prepare
before insert on public.chapter_task_watchers
for each row execute function private.prepare_chapter_task_watcher();

create policy chapter_task_watchers_select_own on public.chapter_task_watchers
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_task_watchers.chapter_id
    )
  );
create policy chapter_task_watchers_insert_own on public.chapter_task_watchers
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_task_watchers.chapter_id
    )
  );
create policy chapter_task_watchers_delete_own on public.chapter_task_watchers
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_task_watchers.chapter_id
    )
  );
create policy mfa_assurance on public.chapter_task_watchers
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_watchers from public, anon, authenticated;
grant select (task_id) on public.chapter_task_watchers to authenticated;
grant insert (task_id) on public.chapter_task_watchers to authenticated;
grant delete on table public.chapter_task_watchers to authenticated;
comment on table public.chapter_task_watchers is
  'Private self-watch preference. Rows, counts and identities are never chapter-visible and do not generate notifications or realtime broadcasts.';

notify pgrst, 'reload schema';
