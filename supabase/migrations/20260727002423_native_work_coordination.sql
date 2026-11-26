-- REQ-UG-NATIVE-WORK-COORDINATION-20260726
--
-- One chapter-scoped record powers the Board, Calendar, Timeline and Progress
-- views. The browser may change only task content; identity, chapter scope,
-- audit columns and completion timestamps are server-owned.

create table public.chapter_tasks (
  id uuid primary key default gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  title text not null,
  description text not null default '',
  status text not null default 'backlog',
  priority text not null default 'medium',
  workstream text not null default 'General',
  assignee_name text not null default '',
  start_date date not null default current_date,
  due_date date not null default current_date,
  progress smallint not null default 0,
  blocked boolean not null default false,
  milestone boolean not null default false,
  order_index integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chapter_tasks_title_bounded
    check (char_length(btrim(title)) between 1 and 160),
  constraint chapter_tasks_description_bounded
    check (char_length(description) <= 2000),
  constraint chapter_tasks_status_check
    check (status in ('backlog', 'in_progress', 'needs_review', 'done')),
  constraint chapter_tasks_priority_check
    check (priority in ('low', 'medium', 'high')),
  constraint chapter_tasks_workstream_bounded
    check (char_length(btrim(workstream)) between 1 and 60),
  constraint chapter_tasks_assignee_bounded
    check (char_length(assignee_name) <= 80),
  constraint chapter_tasks_dates_ordered
    check (due_date >= start_date),
  constraint chapter_tasks_progress_bounded
    check (progress between 0 and 100),
  constraint chapter_tasks_order_index_bounded
    check (order_index between 0 and 1000000)
);

create index chapter_tasks_chapter_status_order_idx
  on public.chapter_tasks (chapter_id, status, order_index, created_at);

create index chapter_tasks_chapter_due_idx
  on public.chapter_tasks (chapter_id, due_date, status);

alter table public.chapter_tasks enable row level security;

-- Stamp scope and identity after the client column list has passed PostgreSQL's
-- privilege check. SECURITY DEFINER is narrowly used so the trigger can read
-- the caller's chapter even when invoked inside policy evaluation.
create or replace function private.prepare_chapter_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
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
  new.assignee_name := btrim(new.assignee_name);

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
    new.done_at := coalesce(old.done_at, now());
  else
    new.done_at := null;
  end if;

  return new;
end
$$;

revoke all on function private.prepare_chapter_task() from public, anon, authenticated;

create trigger chapter_tasks_prepare
before insert or update on public.chapter_tasks
for each row execute function private.prepare_chapter_task();

-- Every permissive policy repeats the chapter membership check deliberately.
-- chapter_id is server-stamped and not client-writable, so there is no
-- cross-chapter move path hidden inside UPDATE.
create policy chapter_tasks_select_chapter on public.chapter_tasks
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  );

create policy chapter_tasks_insert_chapter on public.chapter_tasks
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  );

create policy chapter_tasks_update_chapter on public.chapter_tasks
  for update to authenticated
  using (
    exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  )
  with check (
    exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  );

create policy chapter_tasks_delete_creator_or_staff on public.chapter_tasks
  for delete to authenticated
  using (
    exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
    and (
      created_by = (select auth.uid())
      or public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    )
  );

-- This table is created after the platform-wide MFA migration's catalog loop,
-- so it needs its restrictive policy explicitly.
create policy mfa_assurance on public.chapter_tasks
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_tasks from public, anon, authenticated;
grant select, delete on table public.chapter_tasks to authenticated;
grant insert (
  title, description, status, priority, workstream, assignee_name,
  start_date, due_date, progress, blocked, milestone, order_index
) on public.chapter_tasks to authenticated;
grant update (
  title, description, status, priority, workstream, assignee_name,
  start_date, due_date, progress, blocked, milestone, order_index
) on public.chapter_tasks to authenticated;

comment on table public.chapter_tasks is
  'Chapter-scoped work shared by the Board, Calendar, Timeline and Progress views.';
