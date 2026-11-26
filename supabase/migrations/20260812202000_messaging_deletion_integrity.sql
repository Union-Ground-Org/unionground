-- REQ-UG-UNIFIED-MESSAGING-RESTORATION-20260812
--
-- Messaging's task-source proof exposed an older cross-feature deletion bug:
-- chapter_tasks declares its actor FKs ON DELETE SET NULL, but its normal
-- authoring trigger rejected the unauthenticated FK-maintenance update. Permit
-- only a content-neutral identity detachment so account deletion preserves the
-- task, while every browser-authored update keeps the full validation path.
--
-- ROLLBACK: restore private.prepare_chapter_task() from
-- 20260803213833_kanban_sol_deferrals.sql after verifying no account deletion
-- is in progress. This migration changes no stored rows.

set local lock_timeout = '5s';

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
  -- ON DELETE SET NULL updates are nested trigger writes. They may still see
  -- stale ambient JWT claims for the identity being deleted, so trigger depth
  -- participates in the gate. Match only the exact FK-detach shape: no
  -- business field may change and identities only stay unchanged or become
  -- NULL. This runs before user-edit normalization, notification, and audit.
  if (caller is null or pg_catalog.pg_trigger_depth() > 1)
     and tg_op = 'UPDATE'
     and (pg_catalog.to_jsonb(new) - array[
       'created_by', 'updated_by', 'assignee_id', 'assignee_name', 'deleted_by'
     ]::text[]) = (pg_catalog.to_jsonb(old) - array[
       'created_by', 'updated_by', 'assignee_id', 'assignee_name', 'deleted_by'
     ]::text[])
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.updated_by is null or new.updated_by is not distinct from old.updated_by)
     and (new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id)
     and (new.deleted_by is null or new.deleted_by is not distinct from old.deleted_by)
     and (
       new.created_by is distinct from old.created_by
       or new.updated_by is distinct from old.updated_by
       or new.assignee_id is distinct from old.assignee_id
       or new.deleted_by is distinct from old.deleted_by
     ) then
    if new.assignee_id is null and new.assignee_id is distinct from old.assignee_id then
      new.assignee_name := '';
    else
      new.assignee_name := old.assignee_name;
    end if;
    return new;
  end if;

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
  elsif coalesce(pg_catalog.current_setting('sg.refresh_names', true), '') = '1' then
    new.assignee_name := btrim(new.assignee_name);
  else
    new.assignee_name := old.assignee_name;
  end if;

  if tg_op = 'INSERT' then
    new.chapter_id := caller_chapter;
    new.created_by := caller;
    new.created_at := now();
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('chapter_tasks.task_number:' || caller_chapter, 0));

    insert into private.chapter_task_number_counters (chapter_id, last_number)
    select caller_chapter, coalesce(pg_catalog.max(t.task_number), 0)
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
    on conflict (chapter_id) do nothing;

    update private.chapter_task_number_counters c
       set last_number = c.last_number + 1
     where c.chapter_id = caller_chapter
     returning c.last_number into new.task_number;
  elsif new.chapter_id is distinct from old.chapter_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.task_number is distinct from old.task_number then
    raise exception 'task ownership fields are immutable';
  end if;

  new.updated_by := caller;
  new.updated_at := now();

  if new.status = 'done' then
    new.progress := 100;
    new.done_at := case when tg_op = 'UPDATE' then coalesce(old.done_at, now()) else now() end;
  else
    if tg_op = 'UPDATE' and old.done_at is not null
       and new.progress = 100 and old.progress = 100 then
      new.progress := 99;
    end if;
    new.done_at := null;
  end if;

  previous_assignee := case when tg_op = 'UPDATE' then old.assignee_id else null end;
  if new.assignee_id is distinct from previous_assignee then
    if new.assignee_id is not null and new.assignee_id <> caller then
      perform private.notify_member(
        new.assignee_id, 'task.assigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
    if previous_assignee is not null and previous_assignee <> caller then
      perform private.notify_member(
        previous_assignee, 'task.unassigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
  end if;
  return new;
end
$$;

revoke all on function private.prepare_chapter_task() from public, anon, authenticated;

comment on function private.prepare_chapter_task() is
  'Validates chapter task writes and permits only content-neutral nested ON DELETE SET NULL identity detachment, independent of ambient JWT claims.';
