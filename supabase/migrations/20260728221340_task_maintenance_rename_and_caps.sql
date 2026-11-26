-- REQ-UG-TASK-MAINTENANCE-20260727
--
-- Four operational gaps in the patch set above, three of which nobody would
-- notice until the wrong week:
--
--   A. Nothing calls purge_deleted_chapter_tasks(). A 90-day purge that is
--      never scheduled is not a purge, it is a comment.
--   B. Workstreams could be added but never renamed, so a chapter that typed
--      "Contrct" was stuck with it forever.
--   C. chapter_tasks has no per-chapter ceiling. Any staff account (or a script
--      holding a staff token) can insert without bound.
--   D. assignee_name is stamped at assignment time and never refreshed, so a
--      member who corrects their own name stays misspelled on every card.
--
-- ADAPTED 2026-07-28 (design wire-in step 2). The package's section D was a
-- SILENT NO-OP: private.refresh_task_assignee_names() updates
-- chapter_tasks.assignee_name with assignee_id unchanged, and the BEFORE-UPDATE
-- prepare trigger's assignee-unchanged branch does
-- `new.assignee_name := old.assignee_name` -- reverting the refresh inside the
-- same statement while still churning updated_by / updated_at. Fixed here with
-- a transaction-local GUC handshake (section D) plus a re-emission of
-- private.prepare_chapter_task() whose revert branch honours it.
-- 20260728221658 re-emits prepare_chapter_task LAST and carries the same
-- branch, so the fix survives the final emitter.

-- A. SCHEDULING -------------------------------------------------------------

-- One entry point for periodic work on this feature, callable by the platform
-- scheduler and by nothing else. Returning counts (rather than void) means a
-- cron log is enough to tell whether it ran and what it did.
create or replace function private.run_task_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  purged integer;
begin
  purged := private.purge_deleted_chapter_tasks();
  return pg_catalog.jsonb_build_object('purgedTasks', purged, 'ranAt', now());
end
$$;

revoke all on function private.run_task_maintenance() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'task-maintenance-daily',
      '17 4 * * *',
      $job$select private.run_task_maintenance()$job$);
  else
    raise notice 'pg_cron not installed: schedule private.run_task_maintenance() from the platform scheduler (daily is enough).';
  end if;
end
$$;

-- B. RENAME ----------------------------------------------------------------
--
-- The rename has to move the list row AND every card that references it, in
-- one transaction, in that order: the assert trigger on chapter_tasks checks
-- the name against the list, so cards can only be updated after the new name
-- exists. Both statements are in one function so there is no window where a
-- card names something the list does not have.
create or replace function public.rename_chapter_workstream(
  p_workstream_id uuid,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  clean_name text := btrim(coalesce(p_name, ''));
  row_before public.chapter_workstreams;
  moved integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if char_length(clean_name) not between 1 and 60 then
    raise exception 'a workstream name must be 1 to 60 characters' using errcode = '22023';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;

  select w.* into row_before
  from public.chapter_workstreams w
  where w.id = p_workstream_id and w.chapter_id = caller_chapter
  for update;

  if row_before.id is null then
    raise exception 'workstream unavailable' using errcode = '22023';
  end if;
  if row_before.name = clean_name then
    return pg_catalog.jsonb_build_object('id', row_before.id, 'name', clean_name, 'movedTasks', 0);
  end if;

  begin
    update public.chapter_workstreams set name = clean_name where id = row_before.id;
  exception when unique_violation then
    -- Merging two workstreams is a different, lossier operation than renaming
    -- one, and it needs its own confirmation. Refuse rather than silently
    -- merging someone's reporting history.
    raise exception 'that name is already in use in this chapter' using errcode = '23505';
  end;

  update public.chapter_tasks
    set workstream = clean_name
    where chapter_id = caller_chapter and workstream = row_before.name;
  get diagnostics moved = row_count;

  return pg_catalog.jsonb_build_object('id', row_before.id, 'name', clean_name, 'movedTasks', moved);
end
$$;

revoke all on function public.rename_chapter_workstream(uuid, text) from public, anon, authenticated;
grant execute on function public.rename_chapter_workstream(uuid, text) to authenticated;

-- C. A CEILING -------------------------------------------------------------
--
-- Not a rate limit: a bound on live rows per chapter, checked only on INSERT,
-- so ordinary editing is never affected. 2,000 open-or-recent tasks is roughly
-- forty times the busiest plausible chapter and still small enough that a
-- runaway loop stops being a database problem.
create or replace function private.assert_chapter_task_ceiling()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  live_count integer;
begin
  select pg_catalog.count(*) into live_count
  from public.chapter_tasks t
  where t.chapter_id = new.chapter_id
    and t.deleted_at is null;

  if live_count >= 2000 then
    raise exception 'this chapter has reached the task limit; remove finished work first'
      using errcode = '22023';
  end if;

  return new;
end
$$;

revoke all on function private.assert_chapter_task_ceiling() from public, anon, authenticated;

-- Name sorts after chapter_tasks_prepare (which stamps chapter_id) and after
-- chapter_tasks_workstream; alphabetical order is what Postgres uses.
drop trigger if exists chapter_tasks_zz_ceiling on public.chapter_tasks;
create trigger chapter_tasks_zz_ceiling
before insert on public.chapter_tasks
for each row execute function private.assert_chapter_task_ceiling();

-- D. NAME DRIFT ------------------------------------------------------------
--
-- assignee_name is a denormalized copy, on purpose: the board must render a
-- name without a join, and a member who leaves the chapter should still appear
-- on the work they did. The cost is drift when someone corrects their own
-- name. Refresh the live copies; historical rows (done, or deleted) keep the
-- name as it was, which is what a report of past work should say.
--
-- MECHANISM (the part the package got wrong). The refresh UPDATE fires the
-- BEFORE-UPDATE prepare trigger, whose assignee-unchanged branch deliberately
-- reverts assignee_name to old.assignee_name -- the right call against a
-- client smuggling a name past the resolver, fatal here: it turned this
-- refresh into a silent no-op that still stamped updated_by / updated_at. The
-- refresh now marks itself with a TRANSACTION-LOCAL GUC, set immediately
-- before its UPDATE and cleared immediately after, and the prepare trigger
-- keeps the refreshed value only while the flag is up.
--
-- Why a GUC and not pg_trigger_depth(): today the refresh runs inside the
-- member_profiles trigger, so the inner BEFORE trigger would see depth 2 and a
-- `pg_trigger_depth() <= 1` revert guard would work -- but only by accident of
-- call topology. If the refresh ever moves into a plain function (say, batched
-- into the cron-called private.run_task_maintenance() above), the inner
-- trigger sees depth 1 -- exactly what a direct client UPDATE sees -- and the
-- depth guard fails SILENTLY, reintroducing the very no-op this fix closes.
-- The GUC names the operation rather than the call stack. set_config(..., is_local
-- => true) cannot leak past commit or rollback (GUC writes are transactional,
-- and a subtransaction abort rolls them back too), and the explicit clear
-- right after the UPDATE narrows the window to that one statement, so no later
-- write in the same transaction can ride it.
create or replace function private.refresh_task_assignee_names()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.full_name is distinct from old.full_name then
    perform pg_catalog.set_config('sg.refresh_names', '1', true);
    update public.chapter_tasks
      set assignee_name = btrim(new.full_name)
      where assignee_id = new.id
        and deleted_at is null
        and status <> 'done';
    perform pg_catalog.set_config('sg.refresh_names', '', true);
  end if;
  return new;
end
$$;

revoke all on function private.refresh_task_assignee_names() from public, anon, authenticated;

drop trigger if exists member_profiles_refresh_task_names on public.member_profiles;
create trigger member_profiles_refresh_task_names
after update of full_name on public.member_profiles
for each row execute function private.refresh_task_assignee_names();

-- D (other half). prepare_chapter_task's revert branch honours the flag. Body
-- is 20260728221135's verbatim with ONLY that branch changed, so the refresh
-- above is effective from the moment its trigger exists rather than only after
-- 20260728221658 lands.
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
    -- Server-side name refresh (private.refresh_task_assignee_names): keep the
    -- corrected copy. The flag is transaction-local, raised for exactly one
    -- UPDATE statement, and that statement writes only assignee_name.
    new.assignee_name := btrim(new.assignee_name);
  else
    -- Direct write with the assignee unchanged: assignee_name is not
    -- client-writable, so retain the prior server-stamped copy.
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
    -- Reopening a card the done-branch forced to 100: the client deliberately
    -- sends status only (it never rewrites a typed progress), so without this
    -- a reopened card reads as finished forever. Only the forced value is
    -- walked back - a progress the client actually typed is left alone.
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
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')));
    end if;

    if previous_assignee is not null and previous_assignee <> caller then
      perform private.notify_member(
        previous_assignee, 'task.unassigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')));
    end if;
  end if;

  return new;
end
$$;

revoke all on function private.prepare_chapter_task() from public, anon, authenticated;

notify pgrst, 'reload schema';
