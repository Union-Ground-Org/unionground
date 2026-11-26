-- REQ-UG-TASKS-SOFT-DELETE-WORKSTREAMS-20260727
--
-- Two recommendations from the Work Coordination pass:
--
--   A. Delete becomes recoverable. Hard delete cascades chapter_task_messages
--      away -- two people's private conversation destroyed by one person's
--      tidy-up, with no notice to the other. A soft delete keeps the record and
--      the thread, and makes the confirm dialog a smaller promise.
--   B. workstream stops being free text. A 60-char unconstrained string
--      guarantees "Contract" / "contract" / "Contract campaign" as three
--      filters and three Progress rows within a week of real use.

-- A. SOFT DELETE ------------------------------------------------------------

alter table public.chapter_tasks
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

-- Live-board reads only ever want the undeleted rows, and every index that
-- serves them should skip the rest.
create index if not exists chapter_tasks_chapter_status_live_idx
  on public.chapter_tasks (chapter_id, status, order_index, created_at)
  where deleted_at is null;

-- The client loses DELETE entirely: a definer RPC is the only path, so a
-- deletion cannot happen without the audit columns being stamped.
revoke delete on table public.chapter_tasks from authenticated;
drop policy if exists chapter_tasks_delete_staff on public.chapter_tasks;

-- Reads hide deleted rows from everyone. Restore is by reference (the RPC
-- below takes an id), which is deliberate: a "trash" screen was not designed,
-- and a list of deleted work is a surface with its own privacy questions.
drop policy if exists chapter_tasks_select_chapter on public.chapter_tasks;
create policy chapter_tasks_select_chapter on public.chapter_tasks
  for select to authenticated
  using (
    deleted_at is null
    and (select auth.uid()) is not null
    and exists (
      select 1
      from public.member_profiles p
      where p.id = (select auth.uid())
        and p.chapter_id = chapter_tasks.chapter_id
    )
  );

create or replace function public.soft_delete_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  update public.chapter_tasks
    set deleted_at = now(), deleted_by = caller
    where id = task_row.id;

  -- The other participant is told, because the card disappearing from their
  -- list is otherwise indistinguishable from a bug.
  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.deleted',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')));
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'deletedAt', now());
end
$$;

create or replace function public.restore_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is not null
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  update public.chapter_tasks
    set deleted_at = null, deleted_by = null
    where id = task_row.id;

  -- The delete told the assignee their task was removed; a restore that says
  -- nothing leaves that message standing as the last word - permanently
  -- false. Same audience rule as the delete notice: the actor is not told
  -- about their own action.
  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.restored',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')));
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'restored', true);
end
$$;

revoke all on function public.soft_delete_chapter_task(uuid) from public, anon, authenticated;
revoke all on function public.restore_chapter_task(uuid) from public, anon, authenticated;
grant execute on function public.soft_delete_chapter_task(uuid) to authenticated;
grant execute on function public.restore_chapter_task(uuid) to authenticated;

insert into private.notification_copy (key, lang, title, body) values
  ('task.deleted', 'en', 'A task was removed', '{name} deleted a task that was on your list.'),
  ('task.deleted', 'es', 'Se eliminó una tarea', '{name} eliminó una tarea que estaba en tu lista.'),
  ('task.restored', 'en', 'A task is back on your list', '{name} restored a task that had been removed.'),
  ('task.restored', 'es', 'Una tarea volvió a tu lista', '{name} restauró una tarea que había sido eliminada.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- Purge: deleted rows leave for real after 90 days, and the cascade finally
-- takes the thread with them. Same clock the rest of the product uses for
-- irreversible removal, and long enough that "undo last week" always works.
create or replace function private.purge_deleted_chapter_tasks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.chapter_tasks
  where deleted_at is not null and deleted_at < now() - interval '90 days';
  get diagnostics removed = row_count;
  return removed;
end
$$;

revoke all on function private.purge_deleted_chapter_tasks() from public, anon, authenticated, service_role;

-- B. WORKSTREAMS ------------------------------------------------------------

create table if not exists public.chapter_workstreams (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  name text not null,
  -- default auth.uid(): the insert column grant deliberately excludes this
  -- column, so a client can never claim another author - the default stamps
  -- the true caller and the insert policy's created_by = auth.uid() check
  -- passes. Without the default every client insert is fail-closed dead
  -- (found when the add-workstream affordance shipped against this table).
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint chapter_workstreams_name_bounded
    check (char_length(btrim(name)) between 1 and 60),
  unique (chapter_id, name)
);

alter table public.chapter_workstreams enable row level security;

create policy chapter_workstreams_select_chapter on public.chapter_workstreams
  for select to authenticated
  using (
    exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_workstreams.chapter_id
    )
  );

create policy chapter_workstreams_insert_staff on public.chapter_workstreams
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_workstreams.chapter_id
    )
  );

create policy mfa_assurance on public.chapter_workstreams
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_workstreams from public, anon, authenticated;
grant select on table public.chapter_workstreams to authenticated;
grant insert (chapter_id, name) on public.chapter_workstreams to authenticated;

-- Seed from what chapters already typed, case-folded to one canonical spelling
-- per chapter: the first spelling by name order wins, which is stable and
-- reviewable rather than whichever row the planner happened to hit first.
insert into public.chapter_workstreams (chapter_id, name)
select distinct on (t.chapter_id, lower(btrim(t.workstream)))
  t.chapter_id, btrim(t.workstream)
from public.chapter_tasks t
where btrim(coalesce(t.workstream, '')) <> ''
order by t.chapter_id, lower(btrim(t.workstream)), btrim(t.workstream)
on conflict (chapter_id, name) do nothing;

-- Every chapter starts able to file work. The assert trigger below refuses
-- any task whose workstream is not on the chapter's list, and the typed-
-- history seed above inserts nothing for a chapter with no tasks yet - which
-- in production today is every chapter. Without this row the FIRST task of
-- every chapter is impossible to create. 'General' matches the
-- chapter_tasks.workstream column default, so an untouched editor still
-- names a real workstream.
insert into public.chapter_workstreams (chapter_id, name)
select c.id, 'General'
from public.chapters c
where not exists (
  select 1 from public.chapter_workstreams w where w.chapter_id = c.id
)
on conflict (chapter_id, name) do nothing;

-- The task's workstream must now name one of the chapter's own. Enforced in
-- the prepare trigger rather than as an FK, so the column stays a readable
-- string in every existing query and the error can say something useful.
create or replace function private.assert_chapter_workstream()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.chapter_workstreams w
    where w.chapter_id = new.chapter_id
      and w.name = new.workstream
  ) then
    raise exception 'unknown workstream for this chapter: %', new.workstream
      using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function private.assert_chapter_workstream() from public, anon, authenticated;

-- Runs AFTER chapter_tasks_prepare, which is the trigger that stamps
-- chapter_id and trims the name: alphabetical order on the trigger name is
-- what Postgres uses, and 'chapter_tasks_prepare' < 'chapter_tasks_workstream'.
drop trigger if exists chapter_tasks_workstream on public.chapter_tasks;
create trigger chapter_tasks_workstream
before insert or update of workstream on public.chapter_tasks
for each row execute function private.assert_chapter_workstream();

comment on table public.chapter_workstreams is
  'The chapter''s own list of workstreams. Staff may add; every chapter_tasks.workstream must name one.';

notify pgrst, 'reload schema';
