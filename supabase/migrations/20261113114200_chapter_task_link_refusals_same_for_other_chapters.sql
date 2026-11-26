-- SEC-UG-CHAPTER-TASK-LINK-REFUSALS-REVEAL-ANOTHER-CHAPTERS-TASK-20261112
-- (#8523). private.prepare_chapter_task_dependency and
-- private.prepare_chapter_task_subtask, the BEFORE INSERT triggers behind
-- public.add_chapter_task_dependency and public.add_chapter_task_subtask,
-- refused a task id with no live task with 22023 '... endpoints must be live
-- tasks' and another chapter's live task with 22023 '... endpoints must
-- belong to your chapter', so the refusal told a staff caller that the other
-- chapter's task exists (the same leak as #8508 in the watch trigger). Both
-- now refuse another chapter's task with the live-task refusal. Each body
-- below is the live definition on a stack built from Main, including the
-- case-graph lock wrapper 20260907151000 installs, with only that check
-- changed; ownership, ACL and the triggers are unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

CREATE OR REPLACE FUNCTION private.prepare_chapter_task_dependency()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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

  -- Another chapter's task is refused exactly as a missing one.
  if task_chapter is null or dep_chapter is null
    or task_chapter <> caller_chapter or dep_chapter <> caller_chapter then
    raise exception 'dependency endpoints must be live tasks'
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
end;
end;
$function$;

revoke all on function private.prepare_chapter_task_dependency() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION private.prepare_chapter_task_subtask()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
  -- Another chapter's task is refused exactly as a missing one.
  if parent_chapter is null or child_chapter is null
    or parent_chapter <> caller_chapter or child_chapter <> caller_chapter then
    raise exception 'subtask endpoints must be live tasks' using errcode = '22023';
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
end;
end;
$function$;

revoke all on function private.prepare_chapter_task_subtask() from public, anon, authenticated;

-- Reviewed trigger surface (account lifecycle inventory): both redefined
-- trigger functions, recorded after they exist.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private'
  and object_name in ('prepare_chapter_task_dependency()', 'prepare_chapter_task_subtask()')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_task_link_lifecycle$
begin
  if (select pg_catalog.count(*) from private.account_lifecycle_trigger_surface()
      where kind = 'function' and schema_name = 'private'
        and object_name in ('prepare_chapter_task_dependency()', 'prepare_chapter_task_subtask()')) <> 2 then
    raise exception 'account lifecycle trigger surface does not list both task link trigger functions';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the task link refusals: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_task_link_lifecycle$;

commit;
