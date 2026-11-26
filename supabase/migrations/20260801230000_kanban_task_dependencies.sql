-- REQ-UG-KANBAN-PHASE2-20260801
--
-- Task dependencies for the t0ggles-parity task modal: a task can DEPEND ON
-- other tasks in the same chapter, and the reverse read of the same edge is
-- the "blocking" list. One row is one directed edge (task_id depends on
-- depends_on_id). Edges are immutable: they are inserted and deleted, never
-- updated - there is no UPDATE grant and no UPDATE policy on purpose.
--
-- APPLY ORDER: single transaction; safe on a live database. The table is
-- new, so no backfill exists. Triggers attach after the table and functions
-- exist. Requires 20260801170000 (broadcast function + realtime.messages
-- read policy) to be live first - this migration reuses both.
--
-- ROLLBACK: drop trigger chapter_task_dependencies_broadcast, drop trigger
-- chapter_task_dependencies_prepare, drop function
-- private.prepare_chapter_task_dependency(), drop table
-- public.chapter_task_dependencies. Nothing else is touched: the broadcast
-- function, the realtime.messages policy and the supabase_realtime
-- publication (INSERT-only, two tables, pinned by
-- public.publication_contract_check()) are shared surfaces this migration
-- deliberately does not alter.

set local lock_timeout = '5s';

create table public.chapter_task_dependencies (
  id uuid primary key default extensions.gen_random_uuid(),
  -- Server-stamped from the two tasks' own chapter by the prepare trigger;
  -- the insert column grant excludes it, so a client can never name a
  -- chapter. It exists (rather than being derived per query) so the shared
  -- broadcast trigger can name the per-chapter topic from NEW/OLD alone,
  -- exactly like chapter_tasks and chapter_workstreams.
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  depends_on_id uuid not null references public.chapter_tasks(id) on delete cascade,
  -- default auth.uid(): same rationale as chapter_workstreams - the insert
  -- grant excludes the column, the default stamps the true caller, and the
  -- insert policy's created_by check passes.
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint chapter_task_dependencies_no_self
    check (task_id <> depends_on_id),
  unique (task_id, depends_on_id)
);

-- The unique constraint indexes the forward direction; the blocking list and
-- the ON DELETE CASCADE from the depended-on task both walk the reverse.
create index chapter_task_dependencies_depends_on_idx
  on public.chapter_task_dependencies (depends_on_id);

create index chapter_task_dependencies_chapter_idx
  on public.chapter_task_dependencies (chapter_id);

alter table public.chapter_task_dependencies enable row level security;

-- Chapter scope, endpoint validity and acyclicity are server truths. The
-- advisory lock serializes edge writes per chapter so two concurrent inserts
-- cannot each pass the cycle check and jointly close a loop; xact-scoped, so
-- it releases on commit or rollback with no cleanup path. The lock keys on
-- the CHAPTER (edges never cross chapters), mirroring the per-chapter
-- task_number lock in private.prepare_chapter_task().
create or replace function private.prepare_chapter_task_dependency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  task_chapter text;
  dep_chapter text;
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

  select t.chapter_id into task_chapter
  from public.chapter_tasks t
  where t.id = new.task_id and t.deleted_at is null;

  select t.chapter_id into dep_chapter
  from public.chapter_tasks t
  where t.id = new.depends_on_id and t.deleted_at is null;

  if task_chapter is null or dep_chapter is null then
    raise exception 'dependency endpoints must be live tasks'
      using errcode = '22023';
  end if;

  if task_chapter <> caller_chapter or dep_chapter <> caller_chapter then
    raise exception 'dependency endpoints must belong to your chapter'
      using errcode = '22023';
  end if;

  new.chapter_id := caller_chapter;
  new.created_by := caller;
  new.created_at := now();

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chapter_task_dependencies:' || caller_chapter, 0));

  -- Adding T -> D closes a loop exactly when D already reaches T through
  -- existing depends-on edges. UNION (not UNION ALL) dedupes visited nodes,
  -- so the walk terminates even if a cycle somehow already existed.
  if exists (
    with recursive reach(id) as (
      select new.depends_on_id
      union
      select d.depends_on_id
      from public.chapter_task_dependencies d
      join reach r on d.task_id = r.id
    )
    select 1 from reach where reach.id = new.task_id
  ) then
    raise exception 'dependency would create a cycle'
      using errcode = '22023';
  end if;

  return new;
end
$$;

revoke all on function private.prepare_chapter_task_dependency() from public, anon, authenticated;

create trigger chapter_task_dependencies_prepare
before insert on public.chapter_task_dependencies
for each row execute function private.prepare_chapter_task_dependency();

-- Board sync rides the existing per-chapter private broadcast topic
-- (chapter-tasks:<chapterId>) through the same AFTER-trigger function
-- chapter_tasks and chapter_workstreams use; the INSERT-only
-- supabase_realtime publication is not touched.
create trigger chapter_task_dependencies_broadcast
after insert or update or delete on public.chapter_task_dependencies
for each row execute function private.broadcast_chapter_task_change();

create policy chapter_task_dependencies_select_chapter on public.chapter_task_dependencies
  for select to authenticated
  using (
    exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_task_dependencies.chapter_id
    )
  );

create policy chapter_task_dependencies_insert_staff on public.chapter_task_dependencies
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_task_dependencies.chapter_id
    )
  );

create policy chapter_task_dependencies_delete_staff on public.chapter_task_dependencies
  for delete to authenticated
  using (
    public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1 from public.member_profiles p
      where p.id = (select auth.uid()) and p.chapter_id = chapter_task_dependencies.chapter_id
    )
  );

create policy mfa_assurance on public.chapter_task_dependencies
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_dependencies from public, anon, authenticated;
grant select on table public.chapter_task_dependencies to authenticated;
grant insert (task_id, depends_on_id) on public.chapter_task_dependencies to authenticated;
grant delete on table public.chapter_task_dependencies to authenticated;

comment on table public.chapter_task_dependencies is
  'Directed depends-on edges between chapter tasks (task_id depends on depends_on_id). Immutable rows: insert and delete only. Chapter scope, endpoint liveness and acyclicity enforced by prepare trigger under a per-chapter advisory lock.';

notify pgrst, 'reload schema';
