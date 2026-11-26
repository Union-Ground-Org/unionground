-- BUG-UG-CHAPTER-TASK-WATCH-REFUSAL-REVEALS-ANOTHER-CHAPTERS-TASK-20261112
-- (#8508). private.prepare_chapter_task_watcher, the BEFORE INSERT trigger
-- behind public.watch_chapter_task, refused an id with no live task with
-- 22023 'watch target must be a live task' and another chapter's live task
-- with 22023 'task must belong to your chapter', so the refusal told the
-- caller that the other chapter's task exists (found by the non-interference
-- proof of #8359, PR #8505). Both now refuse with 'watch target must be a
-- live task'. The body is otherwise the live definition from 20260802041359;
-- ownership, ACL and the trigger are unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
  -- Another chapter's task is refused exactly as a missing one.
  if task_chapter is null or task_chapter <> caller_chapter then
    raise exception 'watch target must be a live task' using errcode = '22023';
  end if;
  new.user_id := caller;
  new.chapter_id := caller_chapter;
  new.created_at := now();
  return new;
end
$$;

revoke all on function private.prepare_chapter_task_watcher() from public, anon, authenticated;

-- Reviewed trigger surface (account lifecycle inventory): the redefined
-- trigger function, recorded after it exists.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private' and object_name = 'prepare_chapter_task_watcher()'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_task_watch_lifecycle$
begin
  if not exists (select 1 from private.account_lifecycle_trigger_surface()
      where kind = 'function' and schema_name = 'private' and object_name = 'prepare_chapter_task_watcher()') then
    raise exception 'account lifecycle trigger surface does not list the task watch trigger function';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the task watch refusal: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_task_watch_lifecycle$;

commit;
