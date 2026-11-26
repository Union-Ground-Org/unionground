-- REQ-UG-LEARNING-PERIOD-TASKS-20261103 (#6941), slice 2 of 9 of
-- #6805, first part: the task row itself. Built on the engine
-- (20261103163000_learning_period_engine.sql, #6940).
--
-- While an organization's learning period runs, a staff member's own task
-- creations, edits, moves, deletes, restores and assignee changes are
-- journalled in the same transaction as the change, and can be undone by
-- that person through undo_my_learning_action:
--   task_create   undone by tombstoning the task (deleted_at), never deleting it
--   task_edit     field and content edits, restored to the earlier values
--   task_move     workstream, status and place, restored
--   task_assign   assignees restored; notices already sent stay sent
--   task_delete   undone by restoring the task (the 90-day purge still applies)
--   task_restore  undone by deleting it again
-- Each undo is checked against the task as the later undo would leave it, so
-- another person's later change refuses the undo with a reason. The task's
-- own triggers write the usual activity rows on every reversal; nothing is
-- removed from the task history or the audit trail.
--
-- The two direct client writes on public.chapter_tasks (column INSERT and
-- UPDATE grants) become definer RPCs, create_chapter_task and
-- update_chapter_task_fields, with the same staff and chapter rules the RLS
-- policies apply, so no write path on a task row escapes the journal.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A 2,000-character task description can exceed 8 KB in multibyte text, and
-- a before-image that does not fit must never block the person's action.
alter table private.learning_action_journal
  drop constraint learning_action_journal_image,
  add constraint learning_action_journal_image check (
    before_image is null or (pg_catalog.jsonb_typeof(before_image) = 'object' and pg_catalog.octet_length(before_image::text) <= 16384));

insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('task_create', 'tasks', 'reverse', 'public.chapter_tasks', true, 'private.learning_undo_task', array[]::text[], 'Creating a task; undo tombstones it.'),
  ('task_edit', 'tasks', 'reverse', 'public.chapter_tasks', false, 'private.learning_undo_task',
    array['title', 'description', 'status', 'priority', 'workstream', 'assignee_id', 'start_date', 'due_date', 'progress', 'blocked', 'milestone', 'task_type', 'order_index', 'live', 'assignee_ids']::text[],
    'Editing a task''s fields or content.'),
  ('task_move', 'tasks', 'reverse', 'public.chapter_tasks', false, 'private.learning_undo_task',
    array['title', 'description', 'status', 'priority', 'workstream', 'assignee_id', 'start_date', 'due_date', 'progress', 'blocked', 'milestone', 'task_type', 'order_index', 'live', 'assignee_ids']::text[],
    'Moving a task on the board.'),
  ('task_assign', 'tasks', 'reverse', 'public.chapter_tasks', false, 'private.learning_undo_task',
    array['title', 'description', 'status', 'priority', 'workstream', 'assignee_id', 'start_date', 'due_date', 'progress', 'blocked', 'milestone', 'task_type', 'order_index', 'live', 'assignee_ids']::text[],
    'Changing a task''s assignees. Notices already sent stay sent.'),
  ('task_delete', 'tasks', 'reverse', 'public.chapter_tasks', false, 'private.learning_undo_task',
    array['title', 'description', 'status', 'priority', 'workstream', 'assignee_id', 'start_date', 'due_date', 'progress', 'blocked', 'milestone', 'task_type', 'order_index', 'live', 'assignee_ids']::text[],
    'Deleting a task (soft delete); undo restores it.'),
  ('task_restore', 'tasks', 'reverse', 'public.chapter_tasks', false, 'private.learning_undo_task',
    array['title', 'description', 'status', 'priority', 'workstream', 'assignee_id', 'start_date', 'due_date', 'progress', 'blocked', 'milestone', 'task_type', 'order_index', 'live', 'assignee_ids']::text[],
    'Restoring a deleted task; undo deletes it again.'),
  ('task_template_update', 'tasks', 'permanent', 'public.chapter_tasks', false, null, array[]::text[],
    'A template step on a task. Recorded and kept; not undone in this slice.');

-- A task's undo state: its editable columns, whether it is live, and its
-- assignees in order. order_index is kept for the restore but left out of
-- every comparison, so someone else's move in the same column never blocks
-- an undo.
create function private.learning_task_state(p_task_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when t.id is null then null else pg_catalog.jsonb_build_object(
    'title', t.title, 'description', t.description, 'status', t.status, 'priority', t.priority,
    'workstream', t.workstream, 'assignee_id', t.assignee_id, 'start_date', t.start_date, 'due_date', t.due_date,
    'progress', t.progress, 'blocked', t.blocked, 'milestone', t.milestone, 'task_type', t.task_type,
    'order_index', t.order_index, 'live', t.deleted_at is null,
    'assignee_ids', coalesce((
      select pg_catalog.jsonb_agg(a.assignee_id order by a.position)
      from public.chapter_task_assignments a where a.task_id = t.id), '[]'::jsonb)
  ) end
  from (select 1) one
  left join public.chapter_tasks t on t.id = p_task_id;
$function$;
revoke all on function private.learning_task_state(uuid) from public, anon, authenticated, service_role;

-- The one journal call every task writer makes after its change.
create function private.learning_task_journal(p_kind text, p_task_id uuid, p_before jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  return private.learning_journal_append(
    p_kind, 'public.chapter_tasks', p_task_id::text, null,
    private.learning_fingerprint(private.learning_task_state(p_task_id) - 'order_index'),
    null,
    case when p_kind = 'task_create' then '{}'::jsonb else p_before end);
end;
$function$;
revoke all on function private.learning_task_journal(text, uuid, jsonb) from public, anon, authenticated, service_role;

-- The reversing handler for every task kind (see the interface in
-- 20261103163000). It writes the task row directly, so the reversal is not
-- itself journalled, and the task's own triggers record it in the history.
create function private.learning_undo_task(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  task_row public.chapter_tasks%rowtype;
  wanted uuid[];
  current_ids uuid[];
  was_live boolean;
  caller_name text;
  recipient uuid;
begin
  if p_mode = 'lock' then
    perform 1 from public.chapter_tasks t where t.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_task_state(target) - 'order_index';
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'task_create' then return null; end if;
    return image - 'order_index';
  elsif p_mode = 'check' then
    -- Today's rule for changing a task: staff of the task's own chapter.
    select t.* into task_row
    from public.chapter_tasks t
    join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
    where t.id = target;
    if task_row.id is null or not private.member_has_chapter_role(task_row.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'you can no longer change this task' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;
  if p_entry ->> 'action_kind' = 'task_create' then
    update public.chapter_tasks t
    set deleted_at = pg_catalog.now(), deleted_by = caller
    where t.id = target and t.deleted_at is null
    returning t.* into task_row;
    -- The task goes away as a deletion does, and its assignee hears so.
    if task_row.assignee_id is not null and task_row.assignee_id <> caller then
      perform private.notify_member(task_row.assignee_id, 'task.deleted',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
    return null;
  end if;

  select t.deleted_at is null into was_live from public.chapter_tasks t where t.id = target;

  update public.chapter_tasks t
  set title = image ->> 'title',
      description = image ->> 'description',
      status = image ->> 'status',
      priority = image ->> 'priority',
      workstream = image ->> 'workstream',
      start_date = (image ->> 'start_date')::date,
      due_date = (image ->> 'due_date')::date,
      progress = (image ->> 'progress')::smallint,
      blocked = (image ->> 'blocked')::boolean,
      milestone = (image ->> 'milestone')::boolean,
      task_type = image ->> 'task_type',
      order_index = coalesce((image ->> 'order_index')::integer, t.order_index),
      deleted_at = case when (image ->> 'live')::boolean then null else coalesce(t.deleted_at, pg_catalog.now()) end,
      deleted_by = case when (image ->> 'live')::boolean then null else coalesce(t.deleted_by, caller) end
  where t.id = target
  returning t.* into task_row;

  -- Assignees as they were, in order, the way set_chapter_task_assignees
  -- writes them, and told the way it tells them: the task's own trigger
  -- notifies the primary assignee it gains or loses, and each co-assignee
  -- added or removed hears so here. What was already sent stays sent; each
  -- person's newest notice matches the task again.
  select coalesce(pg_catalog.array_agg(e.id::uuid order by e.position), '{}') into wanted
  from pg_catalog.jsonb_array_elements_text(coalesce(image -> 'assignee_ids', '[]'::jsonb)) with ordinality as e(id, position);
  select coalesce(pg_catalog.array_agg(a.assignee_id order by a.position), '{}') into current_ids
  from public.chapter_task_assignments a where a.task_id = target;
  if wanted is distinct from current_ids then
    delete from public.chapter_task_assignments a where a.task_id = target;
    insert into public.chapter_task_assignments (task_id, chapter_id, assignee_id, position, assigned_by)
    select target, task_row.chapter_id, ids.assignee_id, ids.ordinality - 1, caller
    from pg_catalog.unnest(wanted) with ordinality as ids(assignee_id, ordinality);
  end if;
  if task_row.assignee_id is distinct from wanted[1] then
    perform pg_catalog.set_config('sg.setting_task_assignees', '1', true);
    update public.chapter_tasks t set assignee_id = wanted[1] where t.id = target;
    -- Only this update skips the assignment sync; later writes in the same
    -- undo (or transaction) get it again.
    perform pg_catalog.set_config('sg.setting_task_assignees', '', true);
  end if;
  for recipient in
    select id from pg_catalog.unnest(wanted) id
    where not (id = any(current_ids)) and id is distinct from wanted[1] and id <> caller
  loop
    perform private.notify_member(recipient, 'task.assigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;
  for recipient in
    select id from pg_catalog.unnest(current_ids) id
    where not (id = any(wanted)) and id is distinct from task_row.assignee_id and id <> caller
  loop
    perform private.notify_member(recipient, 'task.unassigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;
  -- Putting a deleted task back, or taking a restored one away, tells its
  -- assignee the way soft_delete_chapter_task and restore_chapter_task do,
  -- so the last notice they hold matches the task.
  if was_live is distinct from (image ->> 'live')::boolean
     and wanted[1] is not null and wanted[1] <> caller then
    perform private.notify_member(wanted[1],
      case when (image ->> 'live')::boolean then 'task.restored' else 'task.deleted' end,
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_task(text, jsonb) from public, anon, authenticated, service_role;

-- The dispatcher gains the four task handlers (re-emitted from 20261103163000).
create or replace function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- Handlers write graph tables, so the dispatcher takes the lock first too.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if p_mode is null or p_mode not in ('lock', 'state', 'before', 'check', 'apply') or p_entry is null then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  case p_handler
    when 'private.learning_undo_task' then return private.learning_undo_task(p_mode, p_entry);
    when 'private.learning_undo_task_edge' then return private.learning_undo_task_edge(p_mode, p_entry);
    when 'private.learning_undo_task_file' then return private.learning_undo_task_file(p_mode, p_entry);
    when 'private.learning_undo_task_checkoff' then return private.learning_undo_task_checkoff(p_mode, p_entry);
    else raise exception 'learning undo handler unavailable: %', p_handler using errcode = '55000';
  end case;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Creating and editing a task: the direct table writes become RPCs
-- ---------------------------------------------------------------------------
-- The same rule the insert policy applied: staff of the caller's chapter.
-- prepare_chapter_task still sets the chapter, creator and number.
create function public.create_chapter_task(p_fields jsonb)
returns setof public.chapter_tasks
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  created public.chapter_tasks%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_fields is null or pg_catalog.jsonb_typeof(p_fields) <> 'object' or not (p_fields ? 'title')
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_fields) k(name) where not (k.name = any(array[
       'title', 'description', 'status', 'priority', 'workstream', 'assignee_id', 'start_date', 'due_date',
       'progress', 'blocked', 'milestone', 'order_index', 'task_type']::text[]))) then
    raise exception 'invalid task fields' using errcode = '22023';
  end if;
  insert into public.chapter_tasks
    (title, description, status, priority, workstream, assignee_id, start_date, due_date,
     progress, blocked, milestone, order_index, task_type)
  values
    (p_fields ->> 'title', coalesce(p_fields ->> 'description', ''), coalesce(p_fields ->> 'status', 'to_do'),
     coalesce(p_fields ->> 'priority', 'medium'), coalesce(p_fields ->> 'workstream', 'General'),
     (p_fields ->> 'assignee_id')::uuid, (p_fields ->> 'start_date')::date, (p_fields ->> 'due_date')::date,
     coalesce((p_fields ->> 'progress')::smallint, 0), coalesce((p_fields ->> 'blocked')::boolean, false),
     coalesce((p_fields ->> 'milestone')::boolean, false), coalesce((p_fields ->> 'order_index')::integer, 0),
     coalesce(p_fields ->> 'task_type', 'general'))
  returning * into created;
  perform private.learning_task_journal('task_create', created.id, null);
  return query select t.* from public.chapter_tasks t where t.id = created.id;
end;
end;
$function$;
revoke all on function public.create_chapter_task(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_chapter_task(jsonb) to authenticated;

-- Field edits other than title and description (update_chapter_task_content
-- keeps those). The same rule the update policy applied; a supplied
-- p_expected_updated_at is the conflict check.
create function public.update_chapter_task_fields(p_task_id uuid, p_fields jsonb, p_expected_updated_at timestamptz default null)
returns setof public.chapter_tasks
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  current_task public.chapter_tasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_fields is null or pg_catalog.jsonb_typeof(p_fields) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_fields) k(name) where not (k.name = any(array[
       'title', 'description', 'status', 'priority', 'workstream', 'assignee_id', 'start_date', 'due_date',
       'progress', 'blocked', 'milestone', 'order_index', 'task_type']::text[]))) then
    raise exception 'invalid task fields' using errcode = '22023';
  end if;
  select t.* into current_task
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;
  if current_task.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  if p_expected_updated_at is not null and current_task.updated_at is distinct from p_expected_updated_at then
    raise exception 'task changed; reload before saving' using errcode = '40001';
  end if;
  learning_before := private.learning_task_state(current_task.id);
  -- assignee_id is written only when asked for: naming it in an UPDATE fires
  -- chapter_tasks_sync_primary_assignment, which would reset the task's
  -- assignees to the primary alone and drop every co-assignee.
  if p_fields ? 'assignee_id' then
    update public.chapter_tasks t
    set title = case when p_fields ? 'title' then p_fields ->> 'title' else t.title end,
        description = case when p_fields ? 'description' then p_fields ->> 'description' else t.description end,
        status = case when p_fields ? 'status' then p_fields ->> 'status' else t.status end,
        priority = case when p_fields ? 'priority' then p_fields ->> 'priority' else t.priority end,
        workstream = case when p_fields ? 'workstream' then p_fields ->> 'workstream' else t.workstream end,
        assignee_id = (p_fields ->> 'assignee_id')::uuid,
        start_date = case when p_fields ? 'start_date' then (p_fields ->> 'start_date')::date else t.start_date end,
        due_date = case when p_fields ? 'due_date' then (p_fields ->> 'due_date')::date else t.due_date end,
        progress = case when p_fields ? 'progress' then (p_fields ->> 'progress')::smallint else t.progress end,
        blocked = case when p_fields ? 'blocked' then (p_fields ->> 'blocked')::boolean else t.blocked end,
        milestone = case when p_fields ? 'milestone' then (p_fields ->> 'milestone')::boolean else t.milestone end,
        order_index = case when p_fields ? 'order_index' then (p_fields ->> 'order_index')::integer else t.order_index end,
        task_type = case when p_fields ? 'task_type' then p_fields ->> 'task_type' else t.task_type end
    where t.id = current_task.id;
  else
    update public.chapter_tasks t
    set title = case when p_fields ? 'title' then p_fields ->> 'title' else t.title end,
        description = case when p_fields ? 'description' then p_fields ->> 'description' else t.description end,
        status = case when p_fields ? 'status' then p_fields ->> 'status' else t.status end,
        priority = case when p_fields ? 'priority' then p_fields ->> 'priority' else t.priority end,
        workstream = case when p_fields ? 'workstream' then p_fields ->> 'workstream' else t.workstream end,
        start_date = case when p_fields ? 'start_date' then (p_fields ->> 'start_date')::date else t.start_date end,
        due_date = case when p_fields ? 'due_date' then (p_fields ->> 'due_date')::date else t.due_date end,
        progress = case when p_fields ? 'progress' then (p_fields ->> 'progress')::smallint else t.progress end,
        blocked = case when p_fields ? 'blocked' then (p_fields ->> 'blocked')::boolean else t.blocked end,
        milestone = case when p_fields ? 'milestone' then (p_fields ->> 'milestone')::boolean else t.milestone end,
        order_index = case when p_fields ? 'order_index' then (p_fields ->> 'order_index')::integer else t.order_index end,
        task_type = case when p_fields ? 'task_type' then p_fields ->> 'task_type' else t.task_type end
    where t.id = current_task.id;
  end if;
  perform private.learning_task_journal('task_edit', current_task.id, learning_before);
  return query select t.* from public.chapter_tasks t where t.id = current_task.id;
end;
end;
$function$;
revoke all on function public.update_chapter_task_fields(uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.update_chapter_task_fields(uuid, jsonb, timestamptz) to authenticated;

-- Every remaining client write on a task row now goes through a journalled RPC.
revoke insert, update on public.chapter_tasks from authenticated;
revoke insert (title, description, status, priority, workstream, assignee_id, start_date, due_date, progress, blocked, milestone, order_index, task_type)
  on public.chapter_tasks from authenticated;
revoke update (title, description, status, priority, workstream, assignee_id, start_date, due_date, progress, blocked, milestone, order_index, task_type)
  on public.chapter_tasks from authenticated;

-- ---------------------------------------------------------------------------
-- The existing task writers, each journalling its own change
-- ---------------------------------------------------------------------------
-- Re-emitted from their latest bodies with the case-graph lock first, the
-- task state taken after the row lock, and one journal call after the write.
create or replace function public.move_chapter_task(
  p_task_id uuid,
  p_workstream text,
  p_status text,
  p_before_id uuid default null,
  p_expected_updated_at timestamptz default null
)
returns setof public.chapter_tasks
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  moving public.chapter_tasks%rowtype;
  before_task public.chapter_tasks%rowtype;
  previous_index integer;
  next_index integer;
  candidate integer;
  partition_count integer;
  spacing integer;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into moving
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;

  if moving.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  learning_before := private.learning_task_state(moving.id);
  if p_expected_updated_at is not null and moving.updated_at is distinct from p_expected_updated_at then
    raise exception 'task changed; retry move' using errcode = '40001';
  end if;
  if p_workstream is null or btrim(p_workstream) = '' or p_status is null then
    raise exception 'target partition required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chapter_tasks.move:' || moving.chapter_id, 0));

  if p_before_id is not null then
    select t.* into before_task
    from public.chapter_tasks t
    where t.id = p_before_id
      and t.id <> moving.id
      and t.chapter_id = moving.chapter_id
      and t.deleted_at is null
      and t.workstream = btrim(p_workstream)
      and t.status = p_status
    for update;
    if before_task.id is null then
      raise exception 'before task is outside target partition' using errcode = '22023';
    end if;
    next_index := before_task.order_index;
    select max(t.order_index) into previous_index
    from public.chapter_tasks t
    where t.chapter_id = moving.chapter_id and t.deleted_at is null
      and t.workstream = btrim(p_workstream) and t.status = p_status
      and t.id not in (moving.id, before_task.id)
      and (t.order_index, t.created_at, t.id) < (before_task.order_index, before_task.created_at, before_task.id);
  else
    select max(t.order_index) into previous_index
    from public.chapter_tasks t
    where t.chapter_id = moving.chapter_id and t.deleted_at is null
      and t.workstream = btrim(p_workstream) and t.status = p_status
      and t.id <> moving.id;
    next_index := null;
  end if;

  candidate := case
    when previous_index is null and next_index is null then 1000
    when previous_index is null then greatest(next_index / 2, 0)
    when next_index is null then previous_index + 1000
    else (previous_index + next_index) / 2
  end;

  if candidate between 0 and 1000000
     and (previous_index is null or candidate > previous_index)
     and (next_index is null or candidate < next_index) then
    return query
    update public.chapter_tasks t
       set workstream = btrim(p_workstream), status = p_status, order_index = candidate
     where t.id = moving.id
     returning t.*;
    perform private.learning_task_journal('task_move', moving.id, learning_before);
    return;
  end if;

  select count(*) + 1 into partition_count
  from public.chapter_tasks t
  where t.chapter_id = moving.chapter_id and t.deleted_at is null
    and t.workstream = btrim(p_workstream) and t.status = p_status
    and t.id <> moving.id;
  spacing := greatest(1, floor(1000000.0 / (partition_count + 1))::integer);

  return query
  with existing as (
    select t.id,
           row_number() over (order by t.order_index, t.created_at, t.id)::numeric as sort_position
    from public.chapter_tasks t
    where t.chapter_id = moving.chapter_id and t.deleted_at is null
      and t.workstream = btrim(p_workstream) and t.status = p_status
      and t.id <> moving.id
  ), desired as (
    select e.id, e.sort_position from existing e
    union all
    select moving.id,
           coalesce((select e.sort_position - 0.5 from existing e where e.id = p_before_id), partition_count::numeric + 0.5)
  ), ranked as (
    select d.id, row_number() over (order by d.sort_position, d.id)::integer as rank
    from desired d
  ), changed as (
    update public.chapter_tasks t
       set workstream = btrim(p_workstream),
           status = p_status,
           order_index = ranked.rank * spacing
      from ranked
     where t.id = ranked.id
     returning t.*
  )
  select * from changed;
  perform private.learning_task_journal('task_move', moving.id, learning_before);
end;
end
$$;

create or replace function public.update_chapter_task_content(
  p_task_id uuid,
  p_expected_updated_at timestamptz,
  p_title text default null,
  p_description text default null
)
returns setof public.chapter_tasks
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  current_task public.chapter_tasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_title is null and p_description is null then
    raise exception 'title or description required' using errcode = '22023';
  end if;

  select t.* into current_task
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;

  if current_task.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  if p_expected_updated_at is null or current_task.updated_at is distinct from p_expected_updated_at then
    raise exception 'task changed; reload before saving'
      using errcode = '40001';
  end if;
  learning_before := private.learning_task_state(current_task.id);

  return query
  update public.chapter_tasks t
     set title = coalesce(p_title, t.title),
         description = coalesce(p_description, t.description)
   where t.id = current_task.id
   returning t.*;
  perform private.learning_task_journal('task_edit', current_task.id, learning_before);
end;
end
$$;

create or replace function public.soft_delete_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  task_row public.chapter_tasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;
  if caller_chapter is null or not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  where t.id = p_task_id
    and t.chapter_id = caller_chapter
    and t.deleted_at is null
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  learning_before := private.learning_task_state(task_row.id);

  update public.chapter_tasks
    set deleted_at = pg_catalog.now(), deleted_by = caller
    where id = task_row.id;
  perform private.learning_task_journal('task_delete', task_row.id, learning_before);

  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.deleted',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')),
      'tasks');
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'deletedAt', pg_catalog.now());
end;
end
$function$;

create or replace function public.restore_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  task_row public.chapter_tasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;
  if caller_chapter is null or not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  where t.id = p_task_id
    and t.chapter_id = caller_chapter
    and t.deleted_at is not null
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  learning_before := private.learning_task_state(task_row.id);

  update public.chapter_tasks
    set deleted_at = null, deleted_by = null
    where id = task_row.id;
  perform private.learning_task_journal('task_restore', task_row.id, learning_before);

  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.restored',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')),
      'tasks');
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'restored', true);
end;
end
$function$;

create or replace function public.set_chapter_task_assignees(
  p_task_id uuid,
  p_assignee_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_name text;
  task_row public.chapter_tasks%rowtype;
  clean_ids uuid[] := '{}';
  old_ids uuid[] := '{}';
  recipient uuid;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_assignee_ids), 0) > 12 then
    raise exception 'a task may have at most 12 assignees' using errcode = '22023';
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

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  learning_before := private.learning_task_state(task_row.id);

  select coalesce(array_agg(d.assignee_id order by d.first_position), '{}')
    into clean_ids
  from (
    select u.assignee_id, min(u.ordinality) as first_position
    from unnest(coalesce(p_assignee_ids, '{}')) with ordinality as u(assignee_id, ordinality)
    where u.assignee_id is not null
    group by u.assignee_id
  ) d;

  if cardinality(clean_ids) > 12 then
    raise exception 'a task may have at most 12 assignees' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(clean_ids) assignee_id
    where not exists (
      select 1 from public.member_profiles p
      where p.id = assignee_id and p.chapter_id = task_row.chapter_id
    )
  ) then
    raise exception 'assignee must be a member of your chapter' using errcode = '22023';
  end if;

  select coalesce(array_agg(a.assignee_id order by a.position), '{}')
    into old_ids
  from public.chapter_task_assignments a
  where a.task_id = task_row.id;

  delete from public.chapter_task_assignments a where a.task_id = task_row.id;
  insert into public.chapter_task_assignments (
    task_id, chapter_id, assignee_id, position, assigned_by
  )
  select task_row.id, task_row.chapter_id, ids.assignee_id, ids.ordinality - 1, caller
  from unnest(clean_ids) with ordinality as ids(assignee_id, ordinality);

  -- The current trigger resolves the display name, updates audit metadata,
  -- broadcasts the task, and owns primary-assignee notifications.
  perform pg_catalog.set_config('sg.setting_task_assignees', '1', true);
  update public.chapter_tasks
  set assignee_id = clean_ids[1]
  where id = task_row.id;
  perform private.learning_task_journal('task_assign', task_row.id, learning_before);

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;

  for recipient in
    select id from unnest(clean_ids) id
    where not (id = any(old_ids))
      and id is distinct from clean_ids[1]
      and id <> caller
  loop
    perform private.notify_member(
      recipient, 'task.assigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;

  for recipient in
    select id from unnest(old_ids) id
    where not (id = any(clean_ids))
      and id is distinct from task_row.assignee_id
      and id <> caller
  loop
    perform private.notify_member(
      recipient, 'task.unassigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;

  return pg_catalog.jsonb_build_object(
    'taskId', task_row.id,
    'assigneeIds', clean_ids
  );
end;
end
$$;


-- Creating a task from a template, a source record or a connected workflow
-- journals the new task once, after everything the call writes, so undo
-- tombstones the task with its template details and links in one step.
create or replace function public.create_chapter_task_from_template(
  p_template_key text,
  p_title text,
  p_workstream text,
  p_fields jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  locked_caller_role text;
  locked_reviewer_role text;
  selected_template private.chapter_task_template_catalog%rowtype;
  initial_step private.chapter_task_template_flow_steps%rowtype;
  clean_workstream text;
  checklist_body text := '';
  scheduled_value date;
  start_value time;
  end_value time;
  venue_value text;
  review_value text;
  reviewer_value uuid;
  contact_value text;
  follow_up_value date;
  category_value text;
  source_value text;
  occurred_value date;
  severity_value text;
  task_start date;
  task_due date;
  inserted_task public.chapter_tasks%rowtype;
  inserted_detail public.chapter_task_template_details%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Preserve the organization policy that requires an enrolled, verified
  -- second factor before any staff grant is effective. The scoped row lock
  -- below is still required to keep that effective grant stable through the
  -- write; member_has_role is the policy gate, not a substitute for the lock.
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 160 then
    raise exception 'task title invalid' using errcode = '22023';
  end if;

  -- Hold the exact profile and one deterministic eligible staff grant through
  -- the write. FOR SHARE conflicts with both revoke's DELETE and any scope
  -- change to chapter_id, closing the authorization-check/write race.
  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller
  for share of p;
  select staff_role.role into locked_caller_role
  from public.member_roles staff_role
  where staff_role.user_id = caller
    and staff_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and (staff_role.chapter_id is null or staff_role.chapter_id = caller_chapter)
  order by (staff_role.chapter_id = caller_chapter) desc, staff_role.role
  limit 1
  for share of staff_role;
  if caller_chapter is null or locked_caller_role is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select c.* into selected_template
  from private.chapter_task_template_catalog c
  where c.template_key = p_template_key and c.active;
  if selected_template.template_key is null then
    raise exception 'template unavailable' using errcode = '22023';
  end if;

  select w.name into clean_workstream
  from public.chapter_workstreams w
  where w.chapter_id = caller_chapter
    and lower(w.name) = lower(btrim(coalesce(p_workstream, '')))
  order by w.id
  limit 1
  for share of w;
  if clean_workstream is null then
    raise exception 'workstream unavailable' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(coalesce(p_fields, 'null'::jsonb)) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_fields) submitted(field_key)
       where not exists (
         select 1 from private.chapter_task_template_fields f
         where f.template_key = selected_template.template_key
           and f.field_key = submitted.field_key
       )
     )
     or exists (
       select 1 from private.chapter_task_template_fields f
       where f.template_key = selected_template.template_key and f.required
         and (not p_fields ? f.field_key or nullif(btrim(p_fields ->> f.field_key), '') is null)
     ) then
    raise exception 'template fields invalid' using errcode = '22023';
  end if;

  begin
    if selected_template.template_key = 'meeting_event' then
      if pg_catalog.jsonb_typeof(p_fields->'scheduled_on') <> 'string'
         or (p_fields->>'scheduled_on') !~ '^\d{4}-\d{2}-\d{2}$'
         or pg_catalog.jsonb_typeof(p_fields->'venue_mode') <> 'string' then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      scheduled_value := (p_fields->>'scheduled_on')::date;
      venue_value := p_fields->>'venue_mode';
      if venue_value not in ('in_person','phone','video','hybrid') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      if nullif(p_fields->>'starts_at', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'starts_at') <> 'string'
           or (p_fields->>'starts_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        start_value := (p_fields->>'starts_at')::time;
      end if;
      if nullif(p_fields->>'ends_at', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'ends_at') <> 'string'
           or (p_fields->>'ends_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        end_value := (p_fields->>'ends_at')::time;
      end if;
      if end_value is not null and (start_value is null or end_value <= start_value) then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      task_start := scheduled_value;
      task_due := scheduled_value;
    elsif selected_template.template_key = 'review_approval' then
      review_value := p_fields->>'review_kind';
      if pg_catalog.jsonb_typeof(p_fields->'review_kind') <> 'string'
         or review_value not in ('document','publication','decision','other') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      if nullif(p_fields->>'reviewer_id', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'reviewer_id') <> 'string' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        reviewer_value := (p_fields->>'reviewer_id')::uuid;
        locked_reviewer_role := null;
        select reviewer_role.role into locked_reviewer_role
          from public.member_profiles p
          join public.member_roles reviewer_role
            on reviewer_role.user_id = p.id
           and reviewer_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
           and (reviewer_role.chapter_id is null or reviewer_role.chapter_id = caller_chapter)
          where p.id = reviewer_value and p.chapter_id = caller_chapter
          order by (reviewer_role.chapter_id = caller_chapter) desc, reviewer_role.role
          limit 1
          for share of p, reviewer_role;
        if locked_reviewer_role is null then
          raise exception 'reviewer must belong to this chapter' using errcode = '22023';
        end if;
      end if;
    elsif selected_template.template_key = 'member_follow_up' then
      contact_value := p_fields->>'contact_method';
      if pg_catalog.jsonb_typeof(p_fields->'contact_method') <> 'string'
         or contact_value not in ('phone','email','in_person','message','other')
         or pg_catalog.jsonb_typeof(p_fields->'follow_up_on') <> 'string'
         or (p_fields->>'follow_up_on') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      follow_up_value := (p_fields->>'follow_up_on')::date;
      task_due := follow_up_value;
    elsif selected_template.template_key = 'document_request' then
      category_value := p_fields->>'record_category';
      source_value := p_fields->>'record_source';
      if pg_catalog.jsonb_typeof(p_fields->'record_category') <> 'string'
         or category_value not in ('workplace_record','policy','correspondence','other')
         or pg_catalog.jsonb_typeof(p_fields->'record_source') <> 'string'
         or source_value not in ('member','employer','union','third_party') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
    elsif selected_template.template_key = 'issue_incident' then
      severity_value := p_fields->>'incident_severity';
      if pg_catalog.jsonb_typeof(p_fields->'occurred_on') <> 'string'
         or (p_fields->>'occurred_on') !~ '^\d{4}-\d{2}-\d{2}$'
         or pg_catalog.jsonb_typeof(p_fields->'incident_severity') <> 'string'
         or severity_value not in ('low','medium','high','urgent') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      occurred_value := (p_fields->>'occurred_on')::date;
      task_start := occurred_value;
    end if;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception 'template fields invalid' using errcode = '22023';
  end;

  select s.* into initial_step
  from private.chapter_task_template_flow_steps s
  where s.template_key = selected_template.template_key
  order by s.position
  limit 1;

  select coalesce(pg_catalog.string_agg('- [ ] ' || item.label_en, pg_catalog.chr(10) order by item.position), '')
    into checklist_body
  from private.chapter_task_template_checklist_items item
  where item.template_key = selected_template.template_key;

  perform pg_catalog.set_config('sg.creating_template_task', '1', true);
  insert into public.chapter_tasks (
    chapter_id, title, description, status, priority, workstream,
    assignee_name, start_date, due_date, task_type, created_by, updated_by
  ) values (
    caller_chapter, btrim(p_title), checklist_body, selected_template.default_status,
    selected_template.default_priority, clean_workstream, '', task_start, task_due,
    selected_template.template_key, caller, caller
  ) returning * into inserted_task;

  insert into public.chapter_task_template_details (
    task_id, chapter_id, template_key, flow_step,
    scheduled_on, starts_at, ends_at, venue_mode,
    review_kind, reviewer_id, contact_method, follow_up_on,
    record_category, record_source, occurred_on, incident_severity,
    created_by, updated_by
  ) values (
    inserted_task.id, inserted_task.chapter_id, selected_template.template_key, initial_step.step_key,
    scheduled_value, start_value, end_value, venue_value,
    review_value, reviewer_value, contact_value, follow_up_value,
    category_value, source_value, occurred_value, severity_value,
    caller, caller
  ) returning * into inserted_detail;

  perform private.notify_chapter_task_template_change(
    inserted_task.id, caller, selected_template.notification_copy_key
  );

  perform private.learning_task_journal('task_create', inserted_task.id, null);
  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(inserted_task),
    'details', pg_catalog.to_jsonb(inserted_detail)
  );
end;
end
$$;

create or replace function public.create_chapter_task_from_source(
  p_source_kind text,
  p_source_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  learning_parent uuid;
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid;
  clean_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_kind, '')));
  clean_source_id text := pg_catalog.btrim(coalesce(p_source_id, ''));
  source_uuid uuid;
  source_found boolean := false;
  source_is_current boolean := true;
  task_title text;
  attachment_label text;
  record_url text;
  task_workstream text;
  message_owner uuid;
  message_conversation uuid;
  case_row public.member_cases%rowtype;
  task_row public.chapter_tasks%rowtype;
  attachment_row public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_kind not in ('message', 'broadcast', 'notification', 'survey', 'case')
     or clean_source_id = ''
     or pg_catalog.char_length(clean_source_id) > 200 then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  if clean_kind in ('message', 'notification', 'case') then
    begin
      source_uuid := clean_source_id::uuid;
      clean_source_id := source_uuid::text;
    exception when invalid_text_representation then
      raise exception 'source unavailable' using errcode = '22023';
    end;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id, c.organization_id into caller_chapter, caller_org
  from public.member_profiles p
  left join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null then
    raise exception 'source unavailable' using errcode = '22023';
  end if;
  if not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  case clean_kind
    when 'message' then
      select m.user_id, m.conversation_id into message_owner, message_conversation
      from public.member_messages m
      where m.id = source_uuid
        and m.sender_kind = 'member'
        and (
          m.user_id = caller
          or public.staff_can_see_user(m.user_id, 'steward')
        );
      source_found := found;
      task_title := 'Follow up on member message';
      attachment_label := 'Authorized member message';
      record_url := case when message_owner = caller
        then '/m/messages?conversation=' || message_conversation::text
        else '/m/steward?thread=' || message_conversation::text
      end;
    when 'broadcast' then
      select b.retracted_at is null into source_is_current
      from public.member_broadcasts b
      where b.id = clean_source_id
        and b.organization_id is not null
        and caller_org is not null
        and b.organization_id = caller_org
        and private.can_read_member_broadcast(b.id);
      source_found := found;
      task_title := 'Review chapter broadcast';
      attachment_label := 'Authorized chapter broadcast';
      record_url := '/m/messages?broadcast=' || clean_source_id;
    when 'notification' then
      select true into source_found
      from public.member_notifications n
      where n.id = source_uuid
        and n.user_id = caller;
      source_found := found;
      task_title := 'Review notification';
      attachment_label := 'Authorized notification';
      record_url := '/m/messages?notification=' || clean_source_id;
    when 'survey' then
      select s.active into source_is_current
      from public.member_surveys s
      where s.id = clean_source_id
        and s.chapter_id is not null
        and s.chapter_id = caller_chapter;
      source_found := found;
      task_title := 'Follow up on survey';
      attachment_label := 'Authorized survey';
      record_url := '/m/voting?survey=' || clean_source_id;
    when 'case' then
      select c.* into case_row
      from public.member_cases c
      where c.id = source_uuid
        and (
          c.user_id = caller
          or (
            c.steward_user_id = caller
            and private.member_has_chapter_role(caller_chapter, array['steward'])
          )
          or public.staff_can_see_user(c.user_id, 'coordinator')
        );
      source_found := found;
      source_is_current := case_row.status = 'active';
      task_title := 'Follow up on grievance';
      attachment_label := 'Authorized grievance';
      record_url := case
        when case_row.user_id = caller then '/m/cases?case=' || clean_source_id
        when case_row.steward_user_id = caller
          and private.member_has_chapter_role(caller_chapter, array['steward'])
          then '/m/steward?case=' || clean_source_id
        else '/m/coordinator?case=' || clean_source_id
      end;
  end case;

  if not source_found then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_chapter || pg_catalog.chr(31) || clean_kind || pg_catalog.chr(31) || clean_source_id,
      0
    )
  );

  select a.* into attachment_row
  from public.chapter_task_attachments a
  where a.chapter_id = caller_chapter
    and a.source_kind = clean_kind
    and a.source_id = clean_source_id;
  if found then
    select t.* into task_row
    from public.chapter_tasks t
    where t.id = attachment_row.task_id;
    return pg_catalog.jsonb_build_object(
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', pg_catalog.to_jsonb(attachment_row),
      'created', false
    );
  end if;

  if not source_is_current then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  select w.name into task_workstream
  from public.chapter_workstreams w
  where w.chapter_id = caller_chapter
  order by
    (pg_catalog.lower(pg_catalog.btrim(w.name)) = 'general') desc,
    pg_catalog.lower(pg_catalog.btrim(w.name)),
    w.name,
    w.id
  limit 1
  for key share of w;
  if task_workstream is null then
    raise exception 'chapter has no available task workstream' using errcode = '22023';
  end if;

  insert into public.chapter_tasks (
    title, description, status, priority, task_type, workstream,
    assignee_id, start_date, due_date, progress, blocked, milestone, order_index
  ) values (
    task_title, '', 'to_do', 'medium', 'general', task_workstream,
    null, null, null, 0, false, false, 0
  ) returning * into task_row;

  insert into public.chapter_task_attachments (
    task_id, chapter_id, label, record_url, created_by, source_kind, source_id
  ) values (
    task_row.id, caller_chapter, attachment_label, record_url, caller,
    clean_kind, clean_source_id
  ) returning * into attachment_row;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, caller_chapter, caller, 'attachment_added', attachment_row.id::text
  );

  learning_parent := private.learning_task_journal('task_create', task_row.id, null);
  perform private.learning_journal_append('task_link_add', 'public.chapter_task_attachments', attachment_row.id::text, learning_parent,
    private.learning_fingerprint(private.learning_task_edge_state('public.chapter_task_attachments', attachment_row.id::text)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(task_row),
    'attachment', pg_catalog.to_jsonb(attachment_row),
    'created', true
  );
end;
end
$function$;

create or replace function public.create_connected_workflow_task(
  p_kind text,
  p_id text,
  p_chapter_id text default null,
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  learning_parent uuid;
  caller uuid := (select auth.uid());
  caller_chapter text;
  src jsonb;
  src_id text;
  storage_kind text;
  task_title text;
  attachment_label text;
  task_workstream text;
  task_row public.chapter_tasks%rowtype;
  attachment_row public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_kind is null or p_kind not in ('private_message', 'channel_post', 'event', 'task_message') then
    perform private.cw_fail('capability_unavailable', '22023', 'task creation is not offered for this source', 'not_offered');
  end if;

  -- Same serialization the chapter switcher uses, so the caller's chapter is
  -- authorized and used under one lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));
  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
  end if;
  if not private.member_has_chapter_role(
       caller_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    perform private.cw_fail('not_authorized', '42501', 'staff role required', 'staff_grant_required');
  end if;

  src := private.cw_resolve_source(caller, p_kind, p_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
  end if;
  if not private.cw_scope_matches(src, p_chapter_id, p_organization_id) then
    perform private.cw_fail('scope_changed', '22023', 'source scope changed');
  end if;
  -- A task is created in the caller's CURRENT chapter for a source of that same
  -- chapter. A stale reference (the caller switched chapter after opening it)
  -- never lands work in a different chapter than the source belongs to.
  if src ->> 'chapterId' is distinct from caller_chapter then
    perform private.cw_fail('scope_changed', '22023', 'source is not in your current chapter', 'chapter_mismatch');
  end if;
  if p_kind = 'task_message' then
    -- The message already belongs to a task. Open that task (never create a
    -- second one) for staff of this chapter, under the ordinary task read predicate.
    select t.* into task_row from public.chapter_tasks t
    where t.id = (src ->> 'taskId')::uuid and t.deleted_at is null;
    if not found or not private.cw_task_readable(caller, task_row.id) then
      perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false,
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', null,
      'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
      'href', '/m/tasks?task=' || task_row.id::text);
  end if;
  src_id := src ->> 'id';
  storage_kind := case p_kind when 'private_message' then 'message' else p_kind end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_chapter || pg_catalog.chr(31) || storage_kind || pg_catalog.chr(31) || src_id, 0));

  select a.* into attachment_row
  from public.chapter_task_attachments a
  where a.chapter_id = caller_chapter and a.source_kind = storage_kind and a.source_id = src_id;
  if found then
    select t.* into task_row from public.chapter_tasks t
    where t.id = attachment_row.task_id and t.deleted_at is null;
    if not found then
      perform private.cw_fail('capability_unavailable', '22023', 'linked task was deleted', 'linked_task_deleted');
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false,
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', pg_catalog.to_jsonb(attachment_row),
      'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
      'href', '/m/tasks?task=' || task_row.id::text);
  end if;

  if src ->> 'state' = 'removed' then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable', 'source_removed');
  end if;

  task_title := case p_kind
    when 'private_message' then case when src ->> 'senderKind' = 'member' then 'Follow up on member message' else 'Follow up on message' end
    when 'channel_post' then 'Follow up on channel post'
    else 'Follow up on event' end;
  attachment_label := case p_kind
    when 'private_message' then case when src ->> 'senderKind' = 'member' then 'Authorized member message' else 'Authorized message' end
    when 'channel_post' then 'Authorized channel post'
    else 'Authorized event' end;

  select w.name into task_workstream
  from public.chapter_workstreams w
  where w.chapter_id = caller_chapter
  order by
    (pg_catalog.lower(pg_catalog.btrim(w.name)) = 'general') desc,
    pg_catalog.lower(pg_catalog.btrim(w.name)),
    w.name,
    w.id
  limit 1
  for key share of w;
  if task_workstream is null then
    perform private.cw_fail('capability_unavailable', '22023', 'chapter has no available task workstream', 'no_workstream');
  end if;

  insert into public.chapter_tasks (
    title, description, status, priority, task_type, workstream,
    assignee_id, start_date, due_date, progress, blocked, milestone, order_index
  ) values (
    task_title, '', 'to_do', 'medium', 'general', task_workstream,
    null, null, null, 0, false, false, 0
  ) returning * into task_row;

  insert into public.chapter_task_attachments (
    task_id, chapter_id, label, record_url, created_by, source_kind, source_id
  ) values (
    task_row.id, caller_chapter, attachment_label, src ->> 'href', caller, storage_kind, src_id
  ) returning * into attachment_row;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, caller_chapter, caller, 'attachment_added', attachment_row.id::text
  );

  learning_parent := private.learning_task_journal('task_create', task_row.id, null);
  perform private.learning_journal_append('task_link_add', 'public.chapter_task_attachments', attachment_row.id::text, learning_parent,
    private.learning_fingerprint(private.learning_task_edge_state('public.chapter_task_attachments', attachment_row.id::text)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'created', true,
    'task', pg_catalog.to_jsonb(task_row),
    'attachment', pg_catalog.to_jsonb(attachment_row),
    'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
    'href', '/m/tasks?task=' || task_row.id::text);
end;
end;
$function$;

create or replace function public.update_chapter_task_template_details(
  p_task_id uuid,
  p_fields jsonb,
  p_next_flow_step text,
  p_apply_recommended_status boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  locked_caller_role text;
  locked_reviewer_role text;
  task_row public.chapter_tasks%rowtype;
  detail_row public.chapter_task_template_details%rowtype;
  target_step private.chapter_task_template_flow_steps%rowtype;
  scheduled_value date;
  start_value time;
  end_value time;
  venue_value text;
  review_value text;
  reviewer_value uuid;
  contact_value text;
  follow_up_value date;
  category_value text;
  source_value text;
  occurred_value date;
  severity_value text;
  changed_flow boolean := false;
  old_flow_step text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller
  for share of p;
  select t.* into task_row
  from public.chapter_tasks t
  join public.chapter_task_template_details d on d.task_id = t.id and d.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
    and t.chapter_id = caller_chapter
  for update of t, d;
  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  select staff_role.role into locked_caller_role
  from public.member_roles staff_role
  where staff_role.user_id = caller
    and staff_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and (staff_role.chapter_id is null or staff_role.chapter_id = task_row.chapter_id)
  order by (staff_role.chapter_id = task_row.chapter_id) desc, staff_role.role
  limit 1
  for share of staff_role;
  if locked_caller_role is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select d.* into detail_row
  from public.chapter_task_template_details d
  where d.task_id = task_row.id;
  old_flow_step := detail_row.flow_step;

  scheduled_value := detail_row.scheduled_on;
  start_value := detail_row.starts_at;
  end_value := detail_row.ends_at;
  venue_value := detail_row.venue_mode;
  review_value := detail_row.review_kind;
  reviewer_value := detail_row.reviewer_id;
  contact_value := detail_row.contact_method;
  follow_up_value := detail_row.follow_up_on;
  category_value := detail_row.record_category;
  source_value := detail_row.record_source;
  occurred_value := detail_row.occurred_on;
  severity_value := detail_row.incident_severity;

  if pg_catalog.jsonb_typeof(coalesce(p_fields, 'null'::jsonb)) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_fields) submitted(field_key)
       where not exists (
         select 1 from private.chapter_task_template_fields f
         where f.template_key = detail_row.template_key and f.field_key = submitted.field_key
       )
     ) then
    raise exception 'template fields invalid' using errcode = '22023';
  end if;

  begin
    if detail_row.template_key = 'meeting_event' then
      if p_fields ? 'scheduled_on' then
        if pg_catalog.jsonb_typeof(p_fields->'scheduled_on') <> 'string'
           or (p_fields->>'scheduled_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        scheduled_value := (p_fields->>'scheduled_on')::date;
      end if;
      if p_fields ? 'venue_mode' then
        if pg_catalog.jsonb_typeof(p_fields->'venue_mode') <> 'string'
           or (p_fields->>'venue_mode') not in ('in_person','phone','video','hybrid') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        venue_value := p_fields->>'venue_mode';
      end if;
      if p_fields ? 'starts_at' then
        if p_fields->'starts_at' = 'null'::jsonb or nullif(p_fields->>'starts_at', '') is null then
          start_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'starts_at') <> 'string'
              or (p_fields->>'starts_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          start_value := (p_fields->>'starts_at')::time;
        end if;
      end if;
      if p_fields ? 'ends_at' then
        if p_fields->'ends_at' = 'null'::jsonb or nullif(p_fields->>'ends_at', '') is null then
          end_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'ends_at') <> 'string'
              or (p_fields->>'ends_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          end_value := (p_fields->>'ends_at')::time;
        end if;
      end if;
      if end_value is not null and (start_value is null or end_value <= start_value) then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
    elsif detail_row.template_key = 'review_approval' then
      if p_fields ? 'review_kind' then
        if pg_catalog.jsonb_typeof(p_fields->'review_kind') <> 'string'
           or (p_fields->>'review_kind') not in ('document','publication','decision','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        review_value := p_fields->>'review_kind';
      end if;
      if p_fields ? 'reviewer_id' then
        if p_fields->'reviewer_id' = 'null'::jsonb or nullif(p_fields->>'reviewer_id', '') is null then
          reviewer_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'reviewer_id') <> 'string' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          reviewer_value := (p_fields->>'reviewer_id')::uuid;
        end if;
        locked_reviewer_role := null;
        if reviewer_value is not null then
          select reviewer_role.role into locked_reviewer_role
          from public.member_profiles p
          join public.member_roles reviewer_role
            on reviewer_role.user_id = p.id
           and reviewer_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
           and (reviewer_role.chapter_id is null or reviewer_role.chapter_id = task_row.chapter_id)
          where p.id = reviewer_value and p.chapter_id = task_row.chapter_id
          order by (reviewer_role.chapter_id = task_row.chapter_id) desc, reviewer_role.role
          limit 1
          for share of p, reviewer_role;
        end if;
        if reviewer_value is not null and locked_reviewer_role is null then
          raise exception 'reviewer must belong to this chapter' using errcode = '22023';
        end if;
      end if;
    elsif detail_row.template_key = 'member_follow_up' then
      if p_fields ? 'contact_method' then
        if pg_catalog.jsonb_typeof(p_fields->'contact_method') <> 'string'
           or (p_fields->>'contact_method') not in ('phone','email','in_person','message','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        contact_value := p_fields->>'contact_method';
      end if;
      if p_fields ? 'follow_up_on' then
        if pg_catalog.jsonb_typeof(p_fields->'follow_up_on') <> 'string'
           or (p_fields->>'follow_up_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        follow_up_value := (p_fields->>'follow_up_on')::date;
      end if;
    elsif detail_row.template_key = 'document_request' then
      if p_fields ? 'record_category' then
        if pg_catalog.jsonb_typeof(p_fields->'record_category') <> 'string'
           or (p_fields->>'record_category') not in ('workplace_record','policy','correspondence','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        category_value := p_fields->>'record_category';
      end if;
      if p_fields ? 'record_source' then
        if pg_catalog.jsonb_typeof(p_fields->'record_source') <> 'string'
           or (p_fields->>'record_source') not in ('member','employer','union','third_party') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        source_value := p_fields->>'record_source';
      end if;
    elsif detail_row.template_key = 'issue_incident' then
      if p_fields ? 'occurred_on' then
        if pg_catalog.jsonb_typeof(p_fields->'occurred_on') <> 'string'
           or (p_fields->>'occurred_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        occurred_value := (p_fields->>'occurred_on')::date;
      end if;
      if p_fields ? 'incident_severity' then
        if pg_catalog.jsonb_typeof(p_fields->'incident_severity') <> 'string'
           or (p_fields->>'incident_severity') not in ('low','medium','high','urgent') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        severity_value := p_fields->>'incident_severity';
      end if;
    end if;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception 'template fields invalid' using errcode = '22023';
  end;

  if p_next_flow_step is not null and p_next_flow_step <> detail_row.flow_step then
    select s.* into target_step
    from private.chapter_task_template_flow_steps s
    where s.template_key = detail_row.template_key and s.step_key = p_next_flow_step;
    if target_step.step_key is null
       or not (target_step.predecessor_keys @> array[detail_row.flow_step]) then
      raise exception 'template flow transition invalid' using errcode = '22023';
    end if;
    changed_flow := true;
  end if;

  update public.chapter_task_template_details set
    flow_step = case when changed_flow then target_step.step_key else detail_row.flow_step end,
    scheduled_on = scheduled_value,
    starts_at = start_value,
    ends_at = end_value,
    venue_mode = venue_value,
    review_kind = review_value,
    reviewer_id = reviewer_value,
    contact_method = contact_value,
    follow_up_on = follow_up_value,
    record_category = category_value,
    record_source = source_value,
    occurred_on = occurred_value,
    incident_severity = severity_value,
    updated_by = caller,
    updated_at = now()
  where task_id = task_row.id
  returning * into detail_row;

  update public.chapter_tasks set
    start_date = case
      when detail_row.template_key = 'meeting_event' then scheduled_value
      when detail_row.template_key = 'issue_incident' then occurred_value
      else null
    end,
    due_date = case
      when detail_row.template_key = 'meeting_event' then scheduled_value
      when detail_row.template_key = 'member_follow_up' then follow_up_value
      else null
    end,
    updated_by = caller
  where id = task_row.id;

  if changed_flow then
    if coalesce(p_apply_recommended_status, false) then
      update public.chapter_tasks
      set status = target_step.recommended_status, updated_by = caller
      where id = task_row.id;
    end if;
  end if;

  if changed_flow then
    insert into public.chapter_task_activity (
      task_id, chapter_id, actor_id, action, from_value, to_value
    ) values (
      task_row.id, task_row.chapter_id, caller, 'template_flow_changed',
      old_flow_step, target_step.step_key
    );
    perform private.notify_chapter_task_template_change(
      task_row.id, caller, 'task.template.flow_changed'
    );
  end if;

  select t.* into task_row from public.chapter_tasks t where t.id = task_row.id;
  -- Recorded, not undoable: the template's own steps are not reversed in this slice.
  perform private.learning_journal_append('task_template_update', 'public.chapter_tasks', task_row.id::text);
  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(task_row),
    'details', pg_catalog.to_jsonb(detail_row)
  );
end;
end
$$;


-- ---------------------------------------------------------------------------
-- Everything else on a task: links, files, check-offs, dependencies,
-- subtasks, watching, comments and task messages
-- ---------------------------------------------------------------------------
insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('task_link_add', 'tasks', 'reverse', 'public.chapter_task_attachments', true, 'private.learning_undo_task_edge', array[]::text[], 'Adding a link to a task; undo removes it.'),
  ('task_link_remove', 'tasks', 'reverse', 'public.chapter_task_attachments', false, 'private.learning_undo_task_edge',
    array['live', 'task_id', 'label', 'record_url', 'created_by', 'source_kind', 'source_id']::text[], 'Removing a link; undo adds the same link back.'),
  ('task_dependency_add', 'tasks', 'reverse', 'public.chapter_task_dependencies', true, 'private.learning_undo_task_edge', array[]::text[], 'Adding a dependency; undo removes it.'),
  ('task_dependency_remove', 'tasks', 'reverse', 'public.chapter_task_dependencies', false, 'private.learning_undo_task_edge',
    array['live', 'task_id', 'depends_on_id', 'created_by']::text[], 'Removing a dependency; undo adds it back.'),
  ('task_subtask_add', 'tasks', 'reverse', 'public.chapter_task_subtasks', true, 'private.learning_undo_task_edge', array[]::text[], 'Linking a subtask; undo unlinks it.'),
  ('task_subtask_remove', 'tasks', 'reverse', 'public.chapter_task_subtasks', false, 'private.learning_undo_task_edge',
    array['live', 'parent_task_id', 'subtask_id', 'created_by']::text[], 'Unlinking a subtask; undo links it back.'),
  ('task_watch', 'tasks', 'reverse', 'public.chapter_task_watchers', true, 'private.learning_undo_task_edge', array[]::text[], 'Watching a task (your own preference).'),
  ('task_unwatch', 'tasks', 'reverse', 'public.chapter_task_watchers', false, 'private.learning_undo_task_edge',
    array['live', 'task_id', 'user_id']::text[], 'Stopping watching a task (your own preference).'),
  ('task_file_upload', 'tasks', 'reverse', 'public.chapter_task_files', true, 'private.learning_undo_task_file', array[]::text[],
    'Uploading your own file to a task; undo requests its removal, which the reconciler finishes.'),
  ('task_file_remove', 'tasks', 'permanent', 'public.chapter_task_files', false, null, array[]::text[],
    'Removing a task file. The bytes are destroyed, so it is never undone.'),
  ('task_checkoff_create', 'tasks', 'reverse', 'private.task_checkoff_lists', true, 'private.learning_undo_task_checkoff', array[]::text[],
    'Creating a member check-off list; undo closes it.'),
  ('task_checkoff_status', 'tasks', 'reverse', 'private.task_checkoff_lists', false, 'private.learning_undo_task_checkoff',
    array['status']::text[], 'Opening or closing a check-off list.'),
  ('task_checkoff_entry_create', 'tasks', 'reverse', 'private.task_checkoff_entries', true, 'private.learning_undo_task_checkoff', array[]::text[],
    'A member placed on a list by creating it; undone together with the list.'),
  ('task_checkoff_entry', 'tasks', 'reverse', 'private.task_checkoff_entries', false, 'private.learning_undo_task_checkoff',
    array['status', 'note', 'actioned_by', 'actioned_at']::text[], 'Checking off a member on a list.'),
  ('task_comment', 'tasks', 'permanent', 'public.chapter_task_comments', true, null, array[]::text[],
    'A task comment. Others were notified, so it stays.'),
  ('task_message', 'tasks', 'permanent', 'public.chapter_task_messages', true, null, array[]::text[],
    'A task message. Others were notified, so it stays.');

-- The state of one link, dependency, subtask link or watch: it exists with
-- these values, or it does not.
create function private.learning_task_edge_state(p_table text, p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(case p_table
    when 'public.chapter_task_attachments' then (
      select pg_catalog.jsonb_build_object('live', true, 'task_id', a.task_id, 'label', a.label, 'record_url', a.record_url,
        'created_by', a.created_by, 'source_kind', a.source_kind, 'source_id', a.source_id)
      from public.chapter_task_attachments a where a.id::text = p_id)
    when 'public.chapter_task_dependencies' then (
      select pg_catalog.jsonb_build_object('live', true, 'task_id', d.task_id, 'depends_on_id', d.depends_on_id, 'created_by', d.created_by)
      from public.chapter_task_dependencies d where d.id::text = p_id)
    when 'public.chapter_task_subtasks' then (
      select pg_catalog.jsonb_build_object('live', true, 'parent_task_id', s.parent_task_id, 'subtask_id', s.subtask_id, 'created_by', s.created_by)
      from public.chapter_task_subtasks s where s.id::text = p_id)
    when 'public.chapter_task_watchers' then (
      select pg_catalog.jsonb_build_object('live', true, 'task_id', w.task_id, 'user_id', w.user_id)
      from public.chapter_task_watchers w where w.task_id::text || ':' || w.user_id::text = p_id)
  end, '{"live": false}'::jsonb);
$function$;
revoke all on function private.learning_task_edge_state(text, text) from public, anon, authenticated, service_role;

-- A writer journals an edge change after it, with the edge's earlier state.
create function private.learning_edge_journal(p_kind text, p_table text, p_id text, p_before jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  return private.learning_journal_append(
    p_kind, p_table, p_id, null,
    private.learning_fingerprint(private.learning_task_edge_state(p_table, p_id)),
    null,
    case when p_before is null or p_before ->> 'live' = 'false' then '{}'::jsonb else p_before end);
end;
$function$;
revoke all on function private.learning_edge_journal(text, text, text, jsonb) from public, anon, authenticated, service_role;

-- Undo for links, dependencies, subtask links and watches: an added edge is
-- removed, a removed one is put back as it was. The caller must still be
-- allowed to make that change today.
create function private.learning_undo_task_edge(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_table text := p_entry ->> 'target_table';
  target text := p_entry ->> 'target_id';
  image jsonb := p_entry -> 'before_image';
  adding boolean := p_entry ->> 'action_kind' in ('task_link_add', 'task_dependency_add', 'task_subtask_add', 'task_watch');
  state jsonb;
  task uuid;
begin
  if p_mode = 'lock' then
    if target_table = 'public.chapter_task_attachments' then perform 1 from public.chapter_task_attachments a where a.id::text = target for update;
    elsif target_table = 'public.chapter_task_dependencies' then perform 1 from public.chapter_task_dependencies d where d.id::text = target for update;
    elsif target_table = 'public.chapter_task_subtasks' then perform 1 from public.chapter_task_subtasks s where s.id::text = target for update;
    else perform 1 from public.chapter_task_watchers w where w.task_id::text || ':' || w.user_id::text = target for update;
    end if;
    return null;
  elsif p_mode = 'state' then
    return private.learning_task_edge_state(target_table, target);
  elsif p_mode = 'before' then
    return case when adding then '{"live": false}'::jsonb else image end;
  end if;

  -- An added edge is judged as it stood after the add: in check mode the
  -- engine passes that projected state, since a later removal in the same
  -- chain has already taken the row away.
  state := case when adding then coalesce(
      case when p_mode = 'check' then nullif(p_entry -> 'projected_state', 'null'::jsonb) end,
      private.learning_task_edge_state(target_table, target))
    else image end;
  task := coalesce(state ->> 'task_id', state ->> 'parent_task_id')::uuid;
  if p_mode = 'check' then
    if target_table = 'public.chapter_task_watchers' then
      if (state ->> 'user_id')::uuid is distinct from caller or not exists (
        select 1 from public.chapter_tasks t join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
        where t.id = task and t.deleted_at is null) then
        raise exception 'you can no longer change this task' using errcode = '42501';
      end if;
    elsif not exists (
        select 1 from public.chapter_tasks t join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
        where t.id = task and t.deleted_at is null)
      or not private.member_has_chapter_role((select t.chapter_id from public.chapter_tasks t where t.id = task),
        array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'you can no longer change this task' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if adding then
    if target_table = 'public.chapter_task_attachments' then
      delete from public.chapter_task_attachments a where a.id::text = target;
      insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value)
      select t.id, t.chapter_id, caller, 'attachment_removed', target from public.chapter_tasks t where t.id = task;
    elsif target_table = 'public.chapter_task_dependencies' then
      delete from public.chapter_task_dependencies d where d.id::text = target;
    elsif target_table = 'public.chapter_task_subtasks' then
      delete from public.chapter_task_subtasks s where s.id::text = target;
    else
      delete from public.chapter_task_watchers w where w.task_id::text || ':' || w.user_id::text = target;
    end if;
  elsif target_table = 'public.chapter_task_attachments' then
    insert into public.chapter_task_attachments (id, task_id, chapter_id, label, record_url, created_by, source_kind, source_id)
    select target::uuid, t.id, t.chapter_id, image ->> 'label', image ->> 'record_url', (image ->> 'created_by')::uuid,
      image ->> 'source_kind', image ->> 'source_id'
    from public.chapter_tasks t where t.id = task;
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, to_value)
    select t.id, t.chapter_id, caller, 'attachment_added', target from public.chapter_tasks t where t.id = task;
  elsif target_table = 'public.chapter_task_dependencies' then
    insert into public.chapter_task_dependencies (id, task_id, depends_on_id, created_by)
    values (target::uuid, task, (image ->> 'depends_on_id')::uuid, (image ->> 'created_by')::uuid);
  elsif target_table = 'public.chapter_task_subtasks' then
    insert into public.chapter_task_subtasks (id, parent_task_id, subtask_id, created_by)
    values (target::uuid, task, (image ->> 'subtask_id')::uuid, (image ->> 'created_by')::uuid);
  else
    insert into public.chapter_task_watchers (task_id, user_id) values (task, caller);
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_task_edge(text, jsonb) from public, anon, authenticated, service_role;

-- Undo for your own upload: request its removal exactly as
-- request_chapter_task_file_removal does; the reconciler destroys the bytes.
create function private.learning_undo_task_file(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  file_row public.chapter_task_files%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.chapter_task_files f where f.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_task_file_state(target);
  elsif p_mode = 'before' then
    return '{"live": false}'::jsonb;
  end if;
  select f.* into file_row from public.chapter_task_files f where f.id = target;
  if p_mode = 'check' then
    -- Your own upload, under the rule request_chapter_task_file_removal
    -- applies now: staff of the file's live task's chapter.
    if file_row.id is null or file_row.uploaded_by is distinct from caller
       or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
       or not exists (
      select 1 from public.chapter_tasks t join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
      where t.id = file_row.task_id and t.chapter_id = file_row.chapter_id and t.deleted_at is null) then
      raise exception 'you can no longer remove this file' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  update public.chapter_task_files f
  set removal_id = extensions.gen_random_uuid(), removal_requested_at = pg_catalog.now(), removal_requested_by = caller
  where f.id = target and f.removal_id is null;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_task_file(text, jsonb) from public, anon, authenticated, service_role;

-- A task file is live while it is confirmed and nobody asked to remove it.
create function private.learning_task_file_state(p_file_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_build_object('live', true, 'task_id', f.task_id, 'filename', f.filename)
    from public.chapter_task_files f
    where f.id = p_file_id and f.confirmed_at is not null and f.removal_id is null and f.cleanup_requested_at is null
  ), '{"live": false}'::jsonb);
$function$;
revoke all on function private.learning_task_file_state(uuid) from public, anon, authenticated, service_role;

-- Check-off lists and entries.
create function private.learning_task_checkoff_state(p_table text, p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case p_table
    when 'private.task_checkoff_lists' then (
      select pg_catalog.jsonb_build_object('status', l.status) from private.task_checkoff_lists l where l.task_id::text = p_id)
    else (
      select pg_catalog.jsonb_build_object('status', e.status, 'note', e.note, 'actioned_by', e.actioned_by, 'actioned_at', e.actioned_at)
      from private.task_checkoff_entries e where e.id::text = p_id)
  end;
$function$;
revoke all on function private.learning_task_checkoff_state(text, text) from public, anon, authenticated, service_role;

create function private.learning_checkoff_journal(p_kind text, p_table text, p_id text, p_before jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  return private.learning_journal_append(
    p_kind, p_table, p_id, null,
    private.learning_fingerprint(private.learning_task_checkoff_state(p_table, p_id) - 'actioned_at'),
    null, coalesce(p_before, '{}'::jsonb));
end;
$function$;
revoke all on function private.learning_checkoff_journal(text, text, text, jsonb) from public, anon, authenticated, service_role;

-- Undo for check-offs: a created list is closed (its entries and history
-- stay), a list status or an entry goes back to what it was. The caller
-- must still be the list's manager, or the entry's assigned steward.
create function private.learning_undo_task_checkoff(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_table text := p_entry ->> 'target_table';
  target text := p_entry ->> 'target_id';
  image jsonb := p_entry -> 'before_image';
  list private.task_checkoff_lists%rowtype;
  entry private.task_checkoff_entries%rowtype;
begin
  if p_mode = 'lock' then
    if target_table = 'private.task_checkoff_lists' then perform 1 from private.task_checkoff_lists l where l.task_id::text = target for update;
    else perform 1 from private.task_checkoff_entries e where e.id::text = target for update;
    end if;
    return null;
  elsif p_mode = 'state' then
    return private.learning_task_checkoff_state(target_table, target) - 'actioned_at';
  elsif p_mode = 'before' then
    return case when p_entry ->> 'action_kind' in ('task_checkoff_create', 'task_checkoff_entry_create') then null else image - 'actioned_at' end;
  end if;
  if target_table = 'private.task_checkoff_lists' then
    select * into list from private.task_checkoff_lists l where l.task_id::text = target;
  else
    select * into entry from private.task_checkoff_entries e where e.id::text = target;
    select * into list from private.task_checkoff_lists l where l.task_id = entry.task_id;
  end if;
  if p_mode = 'check' then
    -- The check-off RPCs' own scope first: a live task the caller still
    -- reads as chapter staff, in a verified session.
    if list.task_id is null or not exists (select 1 from private.task_checkoff_scope(list.task_id)) or not (
      coalesce(list.created_by = caller, false)
      or coalesce(private.has_organization_role(list.organization_id, array['admin', 'vp']), false)
      -- Chapter staff may act on an open list's entry that is unassigned or
      -- assigned to them, as set_task_checkoff_entry allows; so they may undo
      -- their own change to it.
      or (entry.id is not null and list.status <> 'closed'
          and (entry.assigned_steward_id is null or entry.assigned_steward_id = caller))) then
      raise exception 'you can no longer change this check-off' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if p_entry ->> 'action_kind' = 'task_checkoff_entry_create' then
    -- The member stays on the list; closing the list (its parent) undoes it.
    return null;
  elsif p_entry ->> 'action_kind' = 'task_checkoff_create' then
    update private.task_checkoff_lists l set status = 'closed', updated_at = pg_catalog.now() where l.task_id = list.task_id;
  elsif target_table = 'private.task_checkoff_lists' then
    update private.task_checkoff_lists l set status = image ->> 'status', updated_at = pg_catalog.now() where l.task_id = list.task_id;
  else
    update private.task_checkoff_entries e
    set status = image ->> 'status', note = image ->> 'note', actioned_by = (image ->> 'actioned_by')::uuid,
        actioned_at = (image ->> 'actioned_at')::timestamptz, updated_at = pg_catalog.now()
    where e.id = entry.id;
  end if;
  insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
  values (list.task_id, list.chapter_id, caller,
    case when target_table = 'private.task_checkoff_lists' then 'checkoff_list_status_changed' else 'checkoff_entry_changed' end,
    null, 'undone');
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_task_checkoff(text, jsonb) from public, anon, authenticated, service_role;

-- Dependencies, subtask links and watching move from direct client writes
-- to RPCs with the same rules the RLS policies applied; the prepare
-- triggers still stamp the chapter. A remove answers the removed id, or null
-- when there was nothing to remove, as the direct delete did.
create function public.add_chapter_task_dependency(p_task_id uuid, p_depends_on_id uuid)
returns setof public.chapter_task_dependencies
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  added public.chapter_task_dependencies%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  insert into public.chapter_task_dependencies (task_id, depends_on_id, created_by)
  values (p_task_id, p_depends_on_id, caller)
  returning * into added;
  if not exists (select 1 from public.member_profiles p where p.id = caller and p.chapter_id = added.chapter_id) then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  perform private.learning_edge_journal('task_dependency_add', 'public.chapter_task_dependencies', added.id::text, null);
  return next added;
end;
end;
$function$;
revoke all on function public.add_chapter_task_dependency(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.add_chapter_task_dependency(uuid, uuid) to authenticated;

create function public.remove_chapter_task_dependency(p_dependency_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  removed public.chapter_task_dependencies%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select d.* into removed from public.chapter_task_dependencies d
  join public.member_profiles p on p.id = caller and p.chapter_id = d.chapter_id
  where d.id = p_dependency_id for update of d;
  if removed.id is null then
    return null;
  end if;
  learning_before := private.learning_task_edge_state('public.chapter_task_dependencies', removed.id::text);
  delete from public.chapter_task_dependencies d where d.id = removed.id;
  perform private.learning_edge_journal('task_dependency_remove', 'public.chapter_task_dependencies', removed.id::text, learning_before);
  return pg_catalog.jsonb_build_object('id', removed.id);
end;
end;
$function$;
revoke all on function public.remove_chapter_task_dependency(uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_chapter_task_dependency(uuid) to authenticated;

create function public.add_chapter_task_subtask(p_parent_task_id uuid, p_subtask_id uuid)
returns setof public.chapter_task_subtasks
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  added public.chapter_task_subtasks%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  insert into public.chapter_task_subtasks (parent_task_id, subtask_id, created_by)
  values (p_parent_task_id, p_subtask_id, caller)
  returning * into added;
  if not exists (select 1 from public.member_profiles p where p.id = caller and p.chapter_id = added.chapter_id) then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  perform private.learning_edge_journal('task_subtask_add', 'public.chapter_task_subtasks', added.id::text, null);
  return next added;
end;
end;
$function$;
revoke all on function public.add_chapter_task_subtask(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.add_chapter_task_subtask(uuid, uuid) to authenticated;

create function public.remove_chapter_task_subtask(p_subtask_link_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  removed public.chapter_task_subtasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select s.* into removed from public.chapter_task_subtasks s
  join public.member_profiles p on p.id = caller and p.chapter_id = s.chapter_id
  where s.id = p_subtask_link_id for update of s;
  if removed.id is null then
    return null;
  end if;
  learning_before := private.learning_task_edge_state('public.chapter_task_subtasks', removed.id::text);
  delete from public.chapter_task_subtasks s where s.id = removed.id;
  perform private.learning_edge_journal('task_subtask_remove', 'public.chapter_task_subtasks', removed.id::text, learning_before);
  return pg_catalog.jsonb_build_object('id', removed.id);
end;
end;
$function$;
revoke all on function public.remove_chapter_task_subtask(uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_chapter_task_subtask(uuid) to authenticated;

-- Watching is your own preference: any member of the task's chapter.
create function public.watch_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  added public.chapter_task_watchers%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  insert into public.chapter_task_watchers (task_id, user_id) values (p_task_id, caller)
  returning * into added;
  if not exists (select 1 from public.member_profiles p where p.id = caller and p.chapter_id = added.chapter_id) then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  perform private.learning_edge_journal('task_watch', 'public.chapter_task_watchers', added.task_id::text || ':' || caller::text, null);
  return pg_catalog.jsonb_build_object('task_id', added.task_id);
end;
end;
$function$;
revoke all on function public.watch_chapter_task(uuid) from public, anon, authenticated, service_role;
grant execute on function public.watch_chapter_task(uuid) to authenticated;

create function public.unwatch_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  watch_key text := p_task_id::text || ':' || (select auth.uid())::text;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  learning_before := private.learning_task_edge_state('public.chapter_task_watchers', watch_key);
  -- Only a watch in the caller's selected chapter, as the policy this
  -- replaces required.
  delete from public.chapter_task_watchers w
  where w.task_id = p_task_id and w.user_id = caller
    and w.chapter_id = (select p.chapter_id from public.member_profiles p where p.id = caller);
  if not found then
    return null;
  end if;
  perform private.learning_edge_journal('task_unwatch', 'public.chapter_task_watchers', watch_key, learning_before);
  return pg_catalog.jsonb_build_object('task_id', p_task_id);
end;
end;
$function$;
revoke all on function public.unwatch_chapter_task(uuid) from public, anon, authenticated, service_role;
grant execute on function public.unwatch_chapter_task(uuid) to authenticated;

revoke insert, update, delete on public.chapter_task_dependencies, public.chapter_task_subtasks, public.chapter_task_watchers from authenticated;
revoke insert (task_id, depends_on_id) on public.chapter_task_dependencies from authenticated;
revoke insert (parent_task_id, subtask_id) on public.chapter_task_subtasks from authenticated;
revoke insert (task_id) on public.chapter_task_watchers from authenticated;

-- Re-emitted from their latest bodies with the lock first and one journal call.
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
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
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

  perform private.learning_edge_journal('task_link_add', 'public.chapter_task_attachments', inserted.id::text, null);
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
end;
end
$$;

create or replace function public.remove_chapter_task_attachment(p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  learning_before jsonb;
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
  learning_before := private.learning_task_edge_state('public.chapter_task_attachments', attachment_row.id::text);

  delete from public.chapter_task_attachments where id = attachment_row.id;
  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, from_value
  ) values (
    attachment_row.task_id, attachment_row.chapter_id, caller,
    'attachment_removed', attachment_row.id::text
  );

  perform private.learning_edge_journal('task_link_remove', 'public.chapter_task_attachments', attachment_row.id::text, learning_before);
  return pg_catalog.jsonb_build_object('id', attachment_row.id, 'deleted', true);
end;
end
$$;

create or replace function public.confirm_chapter_task_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
  object storage.objects%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select f.* into file_row from public.chapter_task_files f
  join public.chapter_tasks t on t.id = f.task_id and t.chapter_id = f.chapter_id and t.deleted_at is null
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where f.id = p_file_id and f.uploaded_by = caller
    and f.cleanup_requested_at is null
    and f.removal_requested_at is null
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  select o.* into object from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name
      and coalesce(o.metadata ->> 'mimetype', '') = file_row.mime_type
      and coalesce(o.metadata ->> 'size', '') = file_row.size_bytes::text
    for update;
  if object.id is null then
    raise exception 'uploaded file was not found' using errcode = '22023';
  end if;
  if not private.private_upload_is_current(file_row.bucket_id, file_row.object_name) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  if file_row.confirmed_at is null then
    update public.chapter_task_files set confirmed_at = coalesce(confirmed_at, now())
      where id = file_row.id returning * into file_row;
    insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, to_value)
    values (file_row.task_id, file_row.chapter_id, caller, 'file_added', file_row.id::text);
    perform private.learning_journal_append('task_file_upload', 'public.chapter_task_files', file_row.id::text, null, private.learning_fingerprint(private.learning_task_file_state(file_row.id)), null, '{}'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'taskId', file_row.task_id, 'chapterId', file_row.chapter_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at);
end;
end
$function$;

create or replace function public.register_chapter_task_file(
  p_task_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
  file_id uuid := extensions.gen_random_uuid();
  clean_name text := pg_catalog.btrim(coalesce(p_filename, ''));
  inserted public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_name) not between 1 and 160
     or clean_name ~ '[/\\]' or clean_name ~ '[[:cntrl:]]' then
    raise exception 'file name must be 1-160 characters without path separators' using errcode = '22023';
  end if;
  if coalesce(p_size_bytes, 0) not between 1 and 10485760 then
    raise exception 'file must be between 1 byte and 10 MB' using errcode = '22023';
  end if;
  if p_mime_type not in (
    'application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception 'file type is not accepted' using errcode = '22023'; end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;
  if task_row.id is null then raise exception 'task unavailable' using errcode = '22023'; end if;

  insert into public.chapter_task_files(
    id, task_id, chapter_id, object_name, filename, mime_type, size_bytes,
    uploaded_by, confirmed_at, cleanup_requested_at
  ) values (
    file_id, task_row.id, task_row.chapter_id,
    task_row.chapter_id || '/' || task_row.id || '/' || file_id || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller, now(), null
  ) returning * into inserted;
  -- Before the 'file_added' activity row: that row is visible to every chapter
  -- member, so an ungated registration published an unscanned attachment into
  -- the shared task timeline exactly the way an ungated confirm did.
  if not private.private_upload_is_current(inserted.bucket_id, inserted.object_name) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, to_value)
  values (task_row.id, task_row.chapter_id, caller, 'file_added', inserted.id::text);
  perform private.learning_journal_append('task_file_upload', 'public.chapter_task_files', inserted.id::text, null, private.learning_fingerprint(private.learning_task_file_state(inserted.id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'taskId', inserted.task_id, 'chapterId', inserted.chapter_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end;
end
$function$;

create or replace function public.request_chapter_task_file_removal(p_file_id uuid, p_removal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_file_id is null or p_removal_id is null then
    raise exception 'file and removal ids required' using errcode = '22023';
  end if;

  select f.* into file_row from public.chapter_task_files f
  where f.id = p_file_id
    and (
      (f.removal_id = p_removal_id and f.removal_requested_by = caller)
      or (
        f.removal_id is null
        and f.confirmed_at is not null
        and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
        and exists (
          select 1
          from public.chapter_tasks t
          join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
          where t.id = f.task_id
            and t.chapter_id = f.chapter_id
            and t.deleted_at is null
        )
      )
    )
  for update;
  if file_row.id is null then
    if exists (
      select 1 from private.attachment_removal_receipts r
      where r.file_kind = 'chapter_task'
        and r.file_id = p_file_id
        and r.removal_id = p_removal_id
        and r.requested_by = caller
    ) then
      return pg_catalog.jsonb_build_object(
        'deleted', false, 'absent', true, 'id', p_file_id, 'removalId', p_removal_id);
    end if;
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if file_row.confirmed_at is null then
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if file_row.removal_id is not null then
    if file_row.removal_id <> p_removal_id or file_row.removal_requested_by <> caller then
      raise exception 'file unavailable' using errcode = '22023';
    end if;
  else
    update public.chapter_task_files
    set removal_id = p_removal_id,
        removal_requested_at = now(),
        removal_requested_by = caller
    where id = file_row.id and removal_id is null
    returning * into file_row;
    perform private.learning_journal_append('task_file_remove', 'public.chapter_task_files', file_row.id::text);
  end if;

  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'taskId', file_row.task_id, 'chapterId', file_row.chapter_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at,
    'removalId', file_row.removal_id,
    'removalRequestedAt', file_row.removal_requested_at);
end;
end
$$;

create or replace function public.remove_chapter_task_file(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select f.* into file_row
  from public.chapter_task_files f
  join public.member_profiles p on p.id = caller and p.chapter_id = f.chapter_id
  where f.id = p_file_id and f.confirmed_at is not null
    and f.removal_requested_at is null
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    raise exception 'uploaded object still exists' using errcode = '22023';
  end if;
  delete from public.chapter_task_files where id = file_row.id;
  insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, from_value)
  values (file_row.task_id, file_row.chapter_id, caller, 'file_removed', file_row.filename);
  perform private.learning_journal_append('task_file_remove', 'public.chapter_task_files', file_row.id::text);
  return pg_catalog.jsonb_build_object('deleted', true, 'id', file_row.id);
end;
end
$$;

create or replace function public.create_task_checkoff_list(
  p_task_id uuid,
  p_mode text,
  p_member_ids uuid[],
  p_steward_ids uuid[],
  p_manual jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  learning_parent uuid;
  caller uuid;
  scope record;
  members uuid[];
  stewards uuid[];
  steward_count integer;
  bad_id uuid;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(p_task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  if p_mode is null or p_mode not in ('manual', 'split_even', 'split_random', 'shared') then
    raise exception 'invalid check-off mode' using errcode = '22023';
  end if;
  -- First occurrence wins, order kept (the even split is order-preserving).
  select coalesce(pg_catalog.array_agg(item.id order by item.first_at), array[]::uuid[])
    into members
  from (
    select ids.id, pg_catalog.min(ids.ordinality) as first_at
    from pg_catalog.unnest(coalesce(p_member_ids, array[]::uuid[])) with ordinality as ids(id, ordinality)
    where ids.id is not null
    group by ids.id
  ) item;
  select coalesce(pg_catalog.array_agg(item.id order by item.first_at), array[]::uuid[])
    into stewards
  from (
    select ids.id, pg_catalog.min(ids.ordinality) as first_at
    from pg_catalog.unnest(coalesce(p_steward_ids, array[]::uuid[])) with ordinality as ids(id, ordinality)
    where ids.id is not null
    group by ids.id
  ) item;
  if pg_catalog.cardinality(members) not between 1 and 500 then
    raise exception 'pick between 1 and 500 members' using errcode = '22023';
  end if;
  if pg_catalog.cardinality(stewards) > 50 then
    raise exception 'pick at most 50 stewards' using errcode = '22023';
  end if;
  select ids.id into bad_id
  from pg_catalog.unnest(members) as ids(id)
  where not exists (
    select 1
    from public.member_chapter_memberships cm
    join public.organization_memberships om
      on om.user_id = cm.user_id and om.organization_id = scope.organization_id and om.status = 'active'
    where cm.user_id = ids.id and cm.chapter_id = scope.chapter_id and cm.status = 'active'
  )
  limit 1;
  if bad_id is not null then
    raise exception 'one or more members are not active in this chapter' using errcode = '22023';
  end if;
  if p_mode = 'manual' then
    if p_manual is null or pg_catalog.jsonb_typeof(p_manual) <> 'object' then
      raise exception 'every member needs a steward in manual mode' using errcode = '22023';
    end if;
    select pg_catalog.array_agg(distinct (p_manual ->> ids.id::text)::uuid)
      into stewards
    from pg_catalog.unnest(members) as ids(id)
    where coalesce(p_manual ->> ids.id::text, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    if exists (
      select 1 from pg_catalog.unnest(members) as ids(id)
      where coalesce(p_manual ->> ids.id::text, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      raise exception 'every member needs a steward in manual mode' using errcode = '22023';
    end if;
    stewards := coalesce(stewards, array[]::uuid[]);
  elsif p_mode in ('split_even', 'split_random') then
    if pg_catalog.cardinality(stewards) = 0 then
      raise exception 'pick at least one steward to split the list across' using errcode = '22023';
    end if;
  else
    stewards := array[]::uuid[];
  end if;
  select ids.id into bad_id
  from pg_catalog.unnest(stewards) as ids(id)
  where not private.actor_has_chapter_staff_role(ids.id, scope.chapter_id)
  limit 1;
  if bad_id is not null then
    raise exception 'one or more stewards do not hold a staff role in this chapter' using errcode = '22023';
  end if;

  insert into private.task_checkoff_lists (task_id, organization_id, chapter_id, assignment_mode, created_by)
  values (p_task_id, scope.organization_id, scope.chapter_id, p_mode, caller)
  on conflict (task_id) do nothing;
  if not found then
    raise exception 'this task already has a check-off list' using errcode = '23505';
  end if;

  steward_count := pg_catalog.cardinality(stewards);
  insert into private.task_checkoff_entries (task_id, member_user_id, assigned_steward_id, position)
  select p_task_id, ordered.id,
    case
      when p_mode = 'shared' then null
      when p_mode = 'manual' then (p_manual ->> ordered.id::text)::uuid
      else stewards[((ordered.slot - 1) % steward_count) + 1]
    end,
    ordered.slot - 1
  from (
    select ids.id,
      pg_catalog.row_number() over (
        order by case when p_mode = 'split_random' then pg_catalog.random() else ids.ordinality::double precision end
      )::integer as slot
    from pg_catalog.unnest(members) with ordinality as ids(id, ordinality)
  ) ordered;

  insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
  values (p_task_id, scope.chapter_id, caller, 'checkoff_list_created', null, p_mode);

  learning_parent := private.learning_checkoff_journal('task_checkoff_create', 'private.task_checkoff_lists', p_task_id::text, null);
  -- Each member the list created is a child of that one entry.
  perform private.learning_journal_append('task_checkoff_entry_create', 'private.task_checkoff_entries', e.id::text, learning_parent,
    private.learning_fingerprint(private.learning_task_checkoff_state('private.task_checkoff_entries', e.id::text) - 'actioned_at'), null, '{}'::jsonb)
  from private.task_checkoff_entries e where e.task_id = p_task_id order by e.id;
  return private.task_checkoff_payload(p_task_id, scope.organization_id);
end;
$function$;

create or replace function public.set_task_checkoff_entry(
  p_entry_id uuid,
  p_status text,
  p_note text,
  p_expected_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  learning_before jsonb;
  caller uuid;
  entry private.task_checkoff_entries%rowtype;
  list private.task_checkoff_lists%rowtype;
  scope record;
  is_manager boolean;
  next_note text;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  -- Line breaks are kept; other control characters are dropped.
  next_note := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_note, ''), '[^[:print:][:space:]]', '', 'g'));
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_entry_id is null or p_status is null or p_status not in ('pending', 'done', 'unreachable', 'follow_up') then
    raise exception 'invalid check-off status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(next_note) > 500 then
    raise exception 'note must be 500 characters or fewer' using errcode = '22023';
  end if;
  select * into entry from private.task_checkoff_entries where id = p_entry_id for update;
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(entry.task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  select * into list from private.task_checkoff_lists where task_id = entry.task_id for update;
  if p_expected_status is distinct from entry.status then
    raise exception 'checkoff:stale' using errcode = '40001';
  end if;
  is_manager := coalesce(list.created_by = caller, false)
    or coalesce(private.has_organization_role(scope.organization_id, array['admin', 'vp']), false);
  if not is_manager then
    if list.status = 'closed' then
      raise exception 'checkoff:list_closed' using errcode = '42501';
    end if;
    if p_status = 'pending' and entry.status <> 'pending' then
      raise exception 'checkoff:reset_requires_manager' using errcode = '42501';
    end if;
    if entry.assigned_steward_id is not null and entry.assigned_steward_id <> caller then
      raise exception 'checkoff:assigned_to_other' using errcode = '42501';
    end if;
    if entry.status in ('done', 'unreachable') then
      raise exception 'checkoff:already_actioned' using errcode = '42501';
    end if;
    if entry.status = 'follow_up' and entry.actioned_by is distinct from caller then
      raise exception 'checkoff:follow_up_owned_by_other' using errcode = '42501';
    end if;
  end if;
  learning_before := private.learning_task_checkoff_state('private.task_checkoff_entries', entry.id::text);
  update private.task_checkoff_entries
  set status = p_status,
      note = next_note,
      actioned_by = case when p_status = 'pending' then null
        when p_status <> entry.status then caller else entry.actioned_by end,
      actioned_at = case when p_status = 'pending' then null
        when p_status <> entry.status then pg_catalog.now() else entry.actioned_at end,
      updated_at = pg_catalog.now()
  where id = entry.id;
  if p_status <> entry.status then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (entry.task_id, scope.chapter_id, caller, 'checkoff_entry_changed', entry.status, p_status);
  end if;
  perform private.learning_checkoff_journal('task_checkoff_entry', 'private.task_checkoff_entries', entry.id::text, learning_before);
  return private.task_checkoff_payload(entry.task_id, scope.organization_id);
end;
$function$;

create or replace function public.set_task_checkoff_list_status(p_task_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  scope record;
  list private.task_checkoff_lists%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  if p_status is null or p_status not in ('open', 'closed') then
    raise exception 'invalid list status' using errcode = '22023';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(p_task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  select * into list from private.task_checkoff_lists where task_id = p_task_id for update;
  if not found then
    raise exception 'this task has no check-off list' using errcode = '22023';
  end if;
  if not (coalesce(list.created_by = caller, false)
      or coalesce(private.has_organization_role(scope.organization_id, array['admin', 'vp']), false)) then
    raise exception 'checkoff:manager_required' using errcode = '42501';
  end if;
  if list.status <> p_status then
    update private.task_checkoff_lists set status = p_status, updated_at = pg_catalog.now() where task_id = p_task_id;
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (p_task_id, scope.chapter_id, caller, 'checkoff_list_status_changed', list.status, p_status);
    perform private.learning_checkoff_journal('task_checkoff_status', 'private.task_checkoff_lists', p_task_id::text, pg_catalog.jsonb_build_object('status', list.status));
  end if;
  return private.task_checkoff_payload(p_task_id, scope.organization_id);
end;
$function$;

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
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
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
      -- UB-CW-05: watchers join the comment audience.
      union all select w.user_id from public.chapter_task_watchers w where w.task_id = task_row.id
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

  perform private.learning_journal_append('task_comment', 'public.chapter_task_comments', inserted.id::text);
  return pg_catalog.jsonb_build_object(
    'id', inserted.id,
    'taskId', inserted.task_id,
    'chapterId', inserted.chapter_id,
    'authorId', inserted.author_id,
    'body', inserted.body,
    'mentionedUserIds', inserted.mentioned_user_ids,
    'createdAt', inserted.created_at
  );
end;
end
$$;

create or replace function public.send_chapter_task_message(
  p_task_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_name text;
  task_row public.chapter_tasks%rowtype;
  recipient uuid;
  inserted public.chapter_task_messages%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'message must be between 1 and 2000 characters'
      using errcode = '22023';
  end if;

  select t.*
    into task_row
  from public.chapter_tasks t
  join public.member_profiles caller_profile
    on caller_profile.id = caller
   and caller_profile.chapter_id = t.chapter_id
  where t.id = p_task_id
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  if caller is distinct from task_row.created_by
     and caller is distinct from task_row.assignee_id then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  if caller = task_row.assignee_id then
    recipient := task_row.created_by;
  else
    recipient := task_row.assignee_id;
  end if;

  if recipient is null or recipient = caller then
    raise exception 'task has no message recipient' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.member_profiles recipient_profile
    where recipient_profile.id = recipient
      and recipient_profile.chapter_id = task_row.chapter_id
  ) then
    raise exception 'message recipient is unavailable' using errcode = '22023';
  end if;

  insert into public.chapter_task_messages (
    task_id, chapter_id, sender_id, recipient_id, body
  )
  values (
    task_row.id, task_row.chapter_id, caller, recipient, btrim(p_body)
  )
  returning * into inserted;

  select p.full_name into caller_name
  from public.member_profiles p where p.id = caller;

  perform private.notify_member(
    recipient, 'task.message',
    pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');

  perform private.learning_journal_append('task_message', 'public.chapter_task_messages', inserted.id::text);
  return jsonb_build_object(
    'id', inserted.id,
    'taskId', inserted.task_id,
    'chapterId', inserted.chapter_id,
    'senderId', inserted.sender_id,
    'recipientId', inserted.recipient_id,
    'body', inserted.body,
    'createdAt', inserted.created_at
  );
end;
end
$$;
revoke all on function public.send_chapter_task_message(uuid, text)
  from public, anon, authenticated;
grant execute on function public.send_chapter_task_message(uuid, text)
  to authenticated;

-- The engine's undo (20261103163000), re-emitted with one change: check mode
-- also receives the projected state the entry was just validated against.
create or replace function public.undo_my_learning_action(p_entry_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  requested private.learning_action_journal%rowtype;
  chain_ids uuid[];
  item record;
  target_key text;
  current_state jsonb;
  projected jsonb := '{}'::jsonb;
  undone integer := 0;
begin
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into requested from private.learning_action_journal j
  where j.id = p_entry_id and j.actor_user_id = caller and j.organization_id = org
  for update;
  if not found then
    raise exception 'learning entry not found' using errcode = 'P0002';
  end if;
  if requested.state = 'undone' then
    return pg_catalog.jsonb_build_object('status', 'already_undone', 'entryId', requested.id, 'version', requested.version);
  end if;
  if requested.state = 'kept' then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  if p_expected_version is distinct from requested.version then
    raise exception 'learning entry changed' using errcode = '40001';
  end if;

  -- The chain: this entry, your later active entries on the same targets,
  -- and every entry of a bulk action any of them belongs to (its parent and
  -- all its children), so a bulk action is never partly reversed. A parent
  -- joins whatever its state, and one no longer active refuses the undo.
  with recursive chain(id) as (
    select requested.id
    union
    select j.id
    from chain c
    join private.learning_action_journal cj on cj.id = c.id
    join private.learning_action_journal j
      on j.organization_id = org and j.period_id = requested.period_id
     and j.actor_user_id = caller
     and ((j.state = 'active'
           and ((j.target_table = cj.target_table and j.target_id = cj.target_id
                 and (j.created_at, j.id) > (cj.created_at, cj.id))
                or j.parent_entry_id = cj.id))
          or j.id = cj.parent_entry_id)
  )
  select pg_catalog.array_agg(chain.id order by chain.id) into chain_ids from chain;
  perform 1 from private.learning_action_journal j where j.id = any(chain_ids) order by j.id for update;

  if exists (
    select 1 from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids) and (j.state <> 'active' or k.disposition not in ('reverse', 'simulate'))
  ) then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  -- Someone else changed one of these targets after you: undo would take
  -- their work with it. What they sent on it stays sent and does not block.
  if exists (
    select 1
    from private.learning_action_journal c
    join private.learning_action_journal o
      on o.target_table = c.target_table and o.target_id = c.target_id
     and (o.created_at, o.id) > (c.created_at, c.id)
     and o.actor_user_id is distinct from caller and o.state <> 'undone'
    join private.learning_action_kinds ok on ok.action_kind = o.action_kind and ok.disposition <> 'permanent'
    where c.id = any(chain_ids)
  ) then
    raise exception 'someone else has changed this since' using errcode = '40001';
  end if;

  for item in
    select distinct j.target_table, j.target_id, k.handler
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids) and k.disposition = 'reverse'
    order by j.target_table, j.target_id
  loop
    perform private.learning_dispatch(item.handler, 'lock',
      pg_catalog.jsonb_build_object('target_table', item.target_table, 'target_id', item.target_id));
  end loop;

  -- Every lock is held: only now read the clock.
  if private.learning_period_running(org) is distinct from requested.period_id then
    raise exception 'the learning period has ended' using errcode = '55000';
  end if;

  for item in
    select j.*, k.handler, k.disposition
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids)
    order by j.created_at desc, j.id desc
  loop
    if item.disposition = 'reverse' then
      target_key := item.target_table || ':' || item.target_id;
      if projected ? target_key then
        current_state := projected -> target_key;
      else
        current_state := private.learning_dispatch(item.handler, 'state',
          pg_catalog.jsonb_build_object('target_table', item.target_table, 'target_id', item.target_id));
      end if;
      if private.learning_fingerprint(current_state) is distinct from item.after_fingerprint then
        raise exception 'this has changed since your practice action' using errcode = '40001';
      end if;
      projected := projected || pg_catalog.jsonb_build_object(target_key,
        coalesce(private.learning_dispatch(item.handler, 'before', pg_catalog.to_jsonb(item)), 'null'::jsonb));
      -- The handler authorizes against the state this entry is validated
      -- against: an edge a later step removed is judged as it stood.
      perform private.learning_dispatch(item.handler, 'check',
        pg_catalog.to_jsonb(item) || pg_catalog.jsonb_build_object('projected_state', current_state));
    end if;
  end loop;

  for item in
    select j.*, k.handler, k.disposition
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids)
    order by j.created_at desc, j.id desc
  loop
    if item.disposition = 'reverse' then
      perform private.learning_dispatch(item.handler, 'apply', pg_catalog.to_jsonb(item));
    end if;
    update private.learning_action_journal j
    set state = 'undone', undone_at = pg_catalog.clock_timestamp(), version = j.version + 1
    where j.id = item.id;
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'administration', 'learning_action_undone', 'update', caller,
      'learning_action', item.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('entryId', item.id, 'actionKind', item.action_kind, 'periodId', item.period_id)
    );
    undone := undone + 1;
  end loop;

  return pg_catalog.jsonb_build_object('status', 'undone', 'entryId', requested.id,
    'version', requested.version + 1, 'undoneCount', undone);
end;
end;
$function$;

notify pgrst, 'reload schema';
commit;
