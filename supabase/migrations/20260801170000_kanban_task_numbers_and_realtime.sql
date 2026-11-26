-- REQ-UG-KANBAN-PHASE1-20260801
--
-- Two server-side foundations for the t0ggles-style board redesign:
--
--   A. Per-chapter task numbers. The board renders a stable mono key
--      (WOR-42) on every card and deep-links tasks by it, so the number must
--      be server-assigned, immutable, and unique per chapter — client-side
--      derivation would renumber existing cards on every insert.
--   B. Realtime board sync. Remote status moves and reorders are UPDATEs,
--      which the INSERT-only supabase_realtime publication deliberately does
--      not carry (see 20260728221416's publication contract: UPDATE rows
--      would broadcast to subscribers whose RLS was only evaluated at insert
--      time). Instead of widening the publication, an AFTER trigger sends
--      the change over a private per-chapter broadcast channel
--      (realtime.broadcast_changes writes realtime.messages directly — the
--      publication's shape is untouched); receiving it requires passing the
--      realtime.messages policy below, which restates the same chapter + MFA
--      boundary the table's own RLS enforces.
--
-- APPLY ORDER: one transaction (CLI-wrapped). Backfill precedes SET NOT NULL;
--   the trigger rewrite lands after both so no insert can race a null number.
-- ROLLBACK: drop policy chapter_tasks_broadcast_read on realtime.messages;
--   drop trigger chapter_tasks_broadcast on public.chapter_tasks;
--   drop trigger chapter_workstreams_broadcast on public.chapter_workstreams;
--   drop function private.broadcast_chapter_task_change();
--   restore private.prepare_chapter_task() from 20260728221658;
--   alter table public.chapter_tasks drop column task_number;
-- CONTRACT COORDINATION: db-contract.json gains the broadcast function +
--   two triggers + the chapter_tasks_chapter_number_key index; the
--   realtime.messages policy is created in a guarded DO block (absent on a
--   local stack whose realtime schema predates broadcast authorization) and
--   is recorded in the contract's knownGaps note rather than the public
--   policy list, which sweeps schema public only.

set local lock_timeout = '5s';

-- A. TASK NUMBERS -----------------------------------------------------------

alter table public.chapter_tasks
  add column if not exists task_number integer;

-- Backfill: oldest first within each chapter, ties broken by id so the
-- numbering is deterministic under re-runs. Soft-deleted rows are numbered
-- too — restore_chapter_task must bring a card back under its old key, and
-- a purge must never free a number for reuse (max()+1 allocation below keeps
-- counting past purged rows only while the max survives; the unique index
-- makes an accidental reuse loud rather than silent).
with numbered as (
  select t.id,
         row_number() over (partition by t.chapter_id order by t.created_at, t.id) as rn
  from public.chapter_tasks t
)
update public.chapter_tasks t
set task_number = numbered.rn
from numbered
where numbered.id = t.id
  and t.task_number is null;

alter table public.chapter_tasks
  alter column task_number set not null;

create unique index if not exists chapter_tasks_chapter_number_key
  on public.chapter_tasks (chapter_id, task_number);

-- task_number is deliberately absent from the insert/update column grants
-- (they enumerate columns; see 20260727002423) — the trigger below is the
-- only writer.

comment on column public.chapter_tasks.task_number is
  'Server-assigned, per-chapter, immutable. Rendered as the card key (e.g. WOR-42) and used in task deep links. Allocated under a per-chapter advisory lock in private.prepare_chapter_task().';

-- prepare_chapter_task: body is 20260728221658''s verbatim with TWO additions
-- — the task_number allocation in the INSERT branch and task_number joining
-- the immutable-fields check on UPDATE. Everything else (assignee resolution,
-- sg.refresh_names branch, done/progress semantics, notify_member topics) is
-- unchanged; this function has been rewritten five times and each rewrite
-- must carry the full current body forward.
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
    -- Task number: per-chapter, gap-tolerant, never reused while the maximum
    -- survives. The advisory lock serialises concurrent inserts within ONE
    -- chapter only; other chapters proceed in parallel. xact-scoped, so the
    -- lock releases on commit or rollback with no cleanup path.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('chapter_tasks.task_number:' || caller_chapter, 0));
    select coalesce(pg_catalog.max(t.task_number), 0) + 1
      into new.task_number
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter;
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

-- B. REALTIME BOARD SYNC ----------------------------------------------------
--
-- realtime.broadcast_changes() writes the change into realtime.messages under
-- this definer trigger's owner, so no client INSERT grant on that table
-- exists or is needed. Delivery is gated by the SELECT policy below.
-- Exception-guarded like private.enqueue_notification_deliveries: a realtime
-- outage must never fail the board write it is narrating.
create or replace function private.broadcast_chapter_task_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform realtime.broadcast_changes(
      'chapter-tasks:' || coalesce(new.chapter_id, old.chapter_id),
      tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  exception
    when others then
      raise warning 'chapter task broadcast failed: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end
$$;

revoke all on function private.broadcast_chapter_task_change() from public, anon, authenticated;

drop trigger if exists chapter_tasks_broadcast on public.chapter_tasks;
create trigger chapter_tasks_broadcast
after insert or update or delete on public.chapter_tasks
for each row execute function private.broadcast_chapter_task_change();

drop trigger if exists chapter_workstreams_broadcast on public.chapter_workstreams;
create trigger chapter_workstreams_broadcast
after insert or update or delete on public.chapter_workstreams
for each row execute function private.broadcast_chapter_task_change();

-- Receiving a board broadcast restates the exact boundary of reading the
-- table itself: same chapter, MFA satisfied. The topic is derived from the
-- SUBSCRIBER's own profile — a member cannot name another chapter's topic
-- into range. Guarded: a local stack whose realtime schema predates broadcast
-- authorization has no realtime.messages table, and this migration must not
-- fail there — the trigger above already degrades to a warning in that case.
do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'realtime' and c.relname = 'messages' and c.relkind in ('r', 'p')
  ) then
    execute 'drop policy if exists chapter_tasks_broadcast_read on realtime.messages';
    execute $policy$
      create policy chapter_tasks_broadcast_read on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension = 'broadcast'
          and realtime.topic() = 'chapter-tasks:' || (
            select p.chapter_id
            from public.member_profiles p
            where p.id = (select auth.uid())
          )
          and (select private.mfa_satisfied())
        )
    $policy$;
  end if;
end
$$;

comment on function private.broadcast_chapter_task_change() is
  'Narrates chapter_tasks / chapter_workstreams changes onto the private chapter-tasks:<chapter> broadcast channel. Chosen over widening the INSERT-only supabase_realtime publication, whose contract 20260728221416 pins.';

notify pgrst, 'reload schema';
