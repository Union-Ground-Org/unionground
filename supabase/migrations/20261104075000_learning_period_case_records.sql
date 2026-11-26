-- REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103 (#6942), slice 3 of 9
-- of #6805. Built on the engine (20261103163000, #6940) and the task slice
-- (20261103183000, #6941).
--
-- Section 0 carries the task slice's four round-5 follow-ups:
--   r5g2  a field edit names assignee_id only when it changes the primary,
--         so repeating the current primary keeps every co-assignee
--   r5s1  undo hands check mode the whole projected state, so an edge whose
--         task this chain puts back is judged on the projection
--   r5g1  putting a dependency or subtask link back needs its other end live
--   r5s2  a task's creation is not undone while someone else's check-off
--         work hangs off it

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Carried from #6979 round 5: the task slice's four follow-ups
-- ---------------------------------------------------------------------------
create or replace function public.update_chapter_task_fields(p_task_id uuid, p_fields jsonb, p_expected_updated_at timestamptz default null)
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
  -- assignee_id is written only when it changes the primary: naming it in an
  -- UPDATE fires chapter_tasks_sync_primary_assignment, which resets the
  -- task's assignees to the primary alone and drops every co-assignee, even
  -- when the payload repeats the current primary.
  if p_fields ? 'assignee_id' and (p_fields ->> 'assignee_id')::uuid is distinct from current_task.assignee_id then
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
      -- against (an edge a later step removed is judged as it stood) and
      -- sees what the newer steps already projected (a task this chain
      -- puts back is judged live).
      perform private.learning_dispatch(item.handler, 'check',
        pg_catalog.to_jsonb(item) || pg_catalog.jsonb_build_object('projected_state', current_state, 'projected', projected));
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

create or replace function private.learning_undo_task_edge(p_mode text, p_entry jsonb)
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
  other uuid;
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
    -- Each end is judged as this undo leaves it: a task a newer step in the
    -- chain puts back is live, one it takes away is not.
    other := case when not adding then coalesce(state ->> 'depends_on_id', state ->> 'subtask_id')::uuid end;
    if not exists (
        select 1 from public.chapter_tasks t join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
        where t.id = task
          and case when p_entry -> 'projected' ? ('public.chapter_tasks:' || t.id::text)
            then coalesce((p_entry -> 'projected' -> ('public.chapter_tasks:' || t.id::text) ->> 'live')::boolean, false)
            else t.deleted_at is null end)
      or (target_table = 'public.chapter_task_watchers' and (state ->> 'user_id')::uuid is distinct from caller)
      or (target_table <> 'public.chapter_task_watchers' and not private.member_has_chapter_role(
        (select t.chapter_id from public.chapter_tasks t where t.id = task), array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
      -- Putting a dependency or subtask link back needs its other end live,
      -- as the edge triggers require; refuse here instead of failing there.
      or (other is not null and not exists (
        select 1 from public.chapter_tasks t
        where t.id = other
          and case when p_entry -> 'projected' ? ('public.chapter_tasks:' || t.id::text)
            then coalesce((p_entry -> 'projected' -> ('public.chapter_tasks:' || t.id::text) ->> 'live')::boolean, false)
            else t.deleted_at is null end)) then
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

create or replace function private.learning_undo_task(p_mode text, p_entry jsonb)
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
    -- Undoing a creation hides the task; refuse when someone else's
    -- check-off work hangs off it, which would be hidden with it.
    if p_entry ->> 'action_kind' = 'task_create' and (
        exists (select 1 from private.task_checkoff_lists l where l.task_id = target and l.created_by is distinct from caller)
        or exists (select 1 from private.task_checkoff_entries e
          where e.task_id = target and e.actioned_by is not null and e.actioned_by is distinct from caller)) then
      raise exception 'someone else has changed this since' using errcode = '40001';
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

-- ---------------------------------------------------------------------------
-- 1. Case records under learning (part 1 of 2): the case, its notes, its files
-- ---------------------------------------------------------------------------
-- An undone case or note is a tombstone: learning_undone_at is set, it leaves
-- every list and screen, and nothing is deleted, so the case history
-- (private.casework_record_versions) keeps every version. Its reference is
-- never reused.
alter table public.member_cases add column learning_undone_at timestamptz;
alter table public.member_case_updates add column learning_undone_at timestamptz;
comment on column public.member_cases.learning_undone_at is
  'REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103: set when the person who opened this case during a learning period undid it. The case is hidden everywhere and kept in case history.';
comment on column public.member_case_updates.learning_undone_at is
  'REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103: set when the note''s author undid it during a learning period. The note no longer shows on the case.';

insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('case_create', 'cases', 'reverse', 'public.member_cases', true, 'private.learning_undo_case', array[]::text[],
    'Opening a case. Undo tombstones it (hidden everywhere, kept in case history); refused once someone else has worked on it.'),
  ('case_edit', 'cases', 'reverse', 'public.member_cases', false, 'private.learning_undo_case', array[]::text[],
    'Changing a case''s fields or status. Undo restores them from the case history row the change captured.'),
  ('case_bulk_update', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'One bulk update of cases: the parent of one case_edit entry per case, undone all or nothing.'),
  ('case_outcome', 'cases', 'reverse', 'public.member_case_outcomes', false, 'private.learning_undo_case_outcome',
    array['existed', 'outcome', 'summary', 'recorded_by']::text[],
    'Recording a case outcome. Undo puts back the earlier outcome, or none.'),
  ('case_outcome_kept', 'cases', 'permanent', 'public.member_case_outcomes', false, null, array[]::text[],
    'Recording a case outcome whose earlier outcome is too large for a before-image. Kept as recorded, so the whole action is not undone rather than partly undone.'),
  ('case_note_add', 'cases', 'reverse', 'public.member_case_updates', true, 'private.learning_undo_case_note', array[]::text[],
    'Adding a case note. Undo tombstones it so it no longer shows on the case.'),
  ('case_file_upload', 'cases', 'reverse', 'public.member_case_files', true, 'private.learning_undo_case_file', array[]::text[],
    'Uploading your own case file. Undo requests its removal; the reconciler destroys the bytes. Undoing an upload is final.'),
  ('case_file_remove', 'cases', 'permanent', 'public.member_case_files', false, null, array[]::text[],
    'Removing a case file is a privacy removal: the bytes are gone and Undo cannot bring them back.');

-- The case fields this slice reverses, from a row as jsonb (a live row or a
-- case history row). Assignment and restriction belong to slice 4 (#6943).
create function private.learning_case_state_from(p_row jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $function$
  select case when p_row is null then null else pg_catalog.jsonb_build_object(
    'title', p_row -> 'title', 'deadline', p_row -> 'deadline', 'case_type', p_row -> 'case_type',
    'articles', p_row -> 'articles', 'step', p_row -> 'step', 'status', p_row -> 'status',
    'description', p_row -> 'description', 'filing_status', p_row -> 'filing_status',
    'incident_date', p_row -> 'incident_date', 'remedy_sought', p_row -> 'remedy_sought',
    'live', (p_row ->> 'learning_undone_at') is null) end;
$function$;
revoke all on function private.learning_case_state_from(jsonb) from public, anon, authenticated, service_role;

create function private.learning_case_state(p_case_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.learning_case_state_from((select pg_catalog.to_jsonb(c) from public.member_cases c where c.id = p_case_id));
$function$;
revoke all on function private.learning_case_state(uuid) from public, anon, authenticated, service_role;

-- Journal a case write in the writer's own transaction. An edit points at the
-- case history row this transaction captured for it; an edit that changed
-- nothing captured none and has nothing to undo, so it journals nothing.
create function private.learning_case_journal(p_kind text, p_case_id uuid, p_parent_entry_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  now_state jsonb := private.learning_case_state(p_case_id);
  version_row private.casework_record_versions%rowtype;
begin
  if now_state is null then return null; end if;
  if p_kind = 'case_create' then
    return private.learning_journal_append(p_kind, 'public.member_cases', p_case_id::text, p_parent_entry_id,
      private.learning_fingerprint(now_state), null, '{}'::jsonb);
  end if;
  select v.* into version_row from private.casework_record_versions v
  where v.record_table = 'member_cases' and v.record_id = p_case_id::text and v.op = 'UPDATE'
    and v.at >= pg_catalog.now() and v.actor is not distinct from (select auth.uid())
  order by v.id desc limit 1;
  -- A repeat that changed nothing captured no new row; the row it finds is
  -- the earlier change's, already journalled.
  if version_row.id is null
     or private.learning_case_state_from(version_row.new_row) is distinct from now_state
     or private.learning_case_state_from(version_row.old_row) is not distinct from now_state
     or exists (select 1 from private.learning_action_journal j
       where j.target_table = 'public.member_cases' and j.before_ref = version_row.id) then
    return null;
  end if;
  return private.learning_journal_append(p_kind, 'public.member_cases', p_case_id::text, p_parent_entry_id,
    private.learning_fingerprint(now_state), version_row.id, null);
end;
end;
$function$;
revoke all on function private.learning_case_journal(text, uuid, uuid) from public, anon, authenticated, service_role;

create function private.learning_case_note_state(p_note_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select (select pg_catalog.jsonb_build_object('live', u.learning_undone_at is null, 'body', u.body, 'occurred_on', u.occurred_on)
    from public.member_case_updates u where u.id = p_note_id);
$function$;
revoke all on function private.learning_case_note_state(uuid) from public, anon, authenticated, service_role;

create function private.learning_case_outcome_state(p_case_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select pg_catalog.jsonb_build_object('existed', true, 'outcome', o.outcome, 'summary', o.summary, 'recorded_by', o.recorded_by)
     from public.member_case_outcomes o where o.case_id = p_case_id),
    '{"existed": false}'::jsonb);
$function$;
revoke all on function private.learning_case_outcome_state(uuid) from public, anon, authenticated, service_role;

-- A case file is live while it is confirmed and nobody asked to remove it.
create function private.learning_case_file_state(p_file_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select (select pg_catalog.jsonb_build_object('live', f.confirmed_at is not null and f.removal_id is null)
    from public.member_case_files f where f.id = p_file_id);
$function$;
revoke all on function private.learning_case_file_state(uuid) from public, anon, authenticated, service_role;

-- The reversing handler for a case (interface in 20261103163000).
create function private.learning_undo_case(p_mode text, p_entry jsonb)
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
  case_row public.member_cases%rowtype;
  earlier jsonb;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_state(target);
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'case_create' then return null; end if;
    return private.learning_case_state_from(
      (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  end if;
  select c.* into case_row from public.member_cases c where c.id = target;
  if p_mode = 'check' then
    -- Today's rule for changing the case: its owner, or staff who can work on it.
    if case_row.id is null or not private.mfa_satisfied() or not (
        (case_row.user_id = caller and private.chapter_case_readable(case_row))
        or private.casework_staff_can_access(case_row.id)
        -- Whoever opened the case at intake may undo that, under the same
        -- intake rule open_member_case applies, assigned or not.
        or (p_entry ->> 'action_kind' = 'case_create' and (
          private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
          or private.chapter_case_intake_role_allows(case_row.user_id, 'coordinator')
          or private.chapter_case_intake_role_allows(case_row.user_id, 'admin')))) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    -- A step this edit moved cannot go back by hand once a procedure governs
    -- the case: the procedure's own transition is the only way to move it.
    if p_entry ->> 'action_kind' = 'case_edit'
       and case_row.step is distinct from (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)
       and private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null then
      raise exception 'this case now follows a procedure; move its step there' using errcode = '55000';
    end if;
    -- Opening a case is undone only while nobody else has worked on it:
    -- no one else's note, contact, file, outcome, audited action or change
    -- in its history.
    if p_entry ->> 'action_kind' = 'case_create' and (
        exists (select 1 from public.member_case_updates u
          where u.case_id = target and u.learning_undone_at is null and u.author_user_id is distinct from caller)
        or exists (select 1 from public.member_case_files f
          where f.case_id = target and f.removal_requested_at is null and f.uploaded_by is distinct from caller)
        or exists (select 1 from public.member_case_outcomes o where o.case_id = target and o.recorded_by is distinct from caller)
        or exists (select 1 from public.member_case_contacts k where k.case_id = target and k.coordinator_id is distinct from caller)
        or exists (select 1 from public.coordinator_case_audit a where a.case_id = target and a.actor_id is distinct from caller)
        -- A President's review and a steward's identity-privacy decision
        -- leave no case history row, so they are checked here (#7000 r2s2, r2g1).
        or exists (select 1 from public.member_vp_case_reviews r where r.case_id = target and r.reviewed_by is distinct from caller)
        -- An administrator's Action Lab action on the case (#7000 r3s3).
        or exists (select 1 from public.organization_object_action_runs a
          where a.target_kind = 'member_case' and a.target_id = target and a.actor_user_id is distinct from caller)
        or exists (select 1 from public.member_admin_audit a
          where a.action = 'grievance_identity_visibility_updated' and a.detail ->> 'caseId' = target::text
            and a.actor is distinct from caller)
        or exists (select 1 from private.casework_record_versions v
          where v.case_id = target and v.actor is not null and v.actor is distinct from caller)) then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if p_entry ->> 'action_kind' = 'case_create' then
    update public.member_cases c set learning_undone_at = pg_catalog.clock_timestamp()
    where c.id = target and c.learning_undone_at is null;
    return null;
  end if;
  earlier := private.learning_case_state_from(
    (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  if earlier is null then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  update public.member_cases c
  set title = earlier ->> 'title', deadline = (earlier ->> 'deadline')::date, case_type = earlier ->> 'case_type',
      articles = earlier ->> 'articles', status = earlier ->> 'status', description = earlier ->> 'description',
      filing_status = earlier ->> 'filing_status', incident_date = (earlier ->> 'incident_date')::date,
      remedy_sought = earlier ->> 'remedy_sought'
  where c.id = target;
  -- The step guard fires only on a real change; a step the edit did not
  -- move is left alone.
  if case_row.step is distinct from earlier ->> 'step' then
    update public.member_cases c set step = earlier ->> 'step' where c.id = target;
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_case(text, jsonb) from public, anon, authenticated, service_role;

create function private.learning_undo_case_note(p_mode text, p_entry jsonb)
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
  note_row public.member_case_updates%rowtype;
  case_row public.member_cases%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_case_updates u where u.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_note_state(target);
  elsif p_mode = 'before' then
    return null;
  end if;
  select u.* into note_row from public.member_case_updates u where u.id = target;
  if p_mode = 'check' then
    select c.* into case_row from public.member_cases c where c.id = note_row.case_id;
    if note_row.id is null or note_row.author_user_id is distinct from caller or case_row.id is null
       or not private.mfa_satisfied() or not (
        (case_row.user_id = caller and private.chapter_case_readable(case_row))
        or private.casework_staff_can_access(case_row.id)) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  update public.member_case_updates u set learning_undone_at = pg_catalog.clock_timestamp()
  where u.id = target and u.learning_undone_at is null;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_case_note(text, jsonb) from public, anon, authenticated, service_role;

create function private.learning_undo_case_outcome(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    perform 1 from public.member_case_outcomes o where o.case_id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_outcome_state(target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    -- Today's rule for recording an outcome: staff who can work on the case.
    if not private.mfa_satisfied() or not private.casework_staff_can_access(target) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if not coalesce((image ->> 'existed')::boolean, false) then
    delete from public.member_case_outcomes o where o.case_id = target;
  else
    update public.member_case_outcomes o
    set outcome = image ->> 'outcome', summary = image ->> 'summary',
        recorded_by = (image ->> 'recorded_by')::uuid, updated_at = pg_catalog.now()
    where o.case_id = target;
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_case_outcome(text, jsonb) from public, anon, authenticated, service_role;

-- Undo for your own upload: request its removal under the rule
-- request_member_case_file_removal applies now; the reconciler destroys the bytes.
create function private.learning_undo_case_file(p_mode text, p_entry jsonb)
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
  file_row public.member_case_files%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_case_files f where f.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_file_state(target);
  elsif p_mode = 'before' then
    return '{"live": false}'::jsonb;
  end if;
  select f.* into file_row from public.member_case_files f where f.id = target;
  if p_mode = 'check' then
    if file_row.id is null or file_row.uploaded_by is distinct from caller
       or file_row.confirmed_at is null or file_row.removal_id is not null
       or not (file_row.user_id = caller
         or (public.staff_can_see_user(file_row.user_id, 'coordinator')
           and private.member_case_visible_to_caller(file_row.case_id))) then
      raise exception 'you can no longer remove this file' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  update public.member_case_files f
  set removal_id = extensions.gen_random_uuid(), removal_requested_at = pg_catalog.now(), removal_requested_by = caller
  where f.id = target and f.removal_id is null;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_case_file(text, jsonb) from public, anon, authenticated, service_role;

-- Whether a case is live (not undone). Used by the file policy and the
-- Storage object check, so an undone case's attachments go with it.
create function private.member_case_is_live(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (select 1 from public.member_cases c where c.id = p_case_id and c.learning_undone_at is null);
$function$;
revoke all on function private.member_case_is_live(uuid) from public, anon, authenticated, service_role;
grant execute on function private.member_case_is_live(uuid) to authenticated;

create policy member_case_files_learning_undone on public.member_case_files
  as restrictive for select to authenticated using (private.member_case_is_live(case_id));
comment on policy member_case_files_learning_undone on public.member_case_files is
  'REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103: restrictive, so the owner branch cannot show the attachments of a case its creator undid during a learning period.';

-- An undone note is hidden from every client read, as an undone case is.
create policy member_case_updates_learning_undone on public.member_case_updates
  as restrictive for select to authenticated using (learning_undone_at is null);
comment on policy member_case_updates_learning_undone on public.member_case_updates is
  'REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103: restrictive, so no read path shows a note its author undid during a learning period. The row stays for case history.';

-- The two direct client writes on cases become RPCs with the same rules the
-- policies applied, so no case write escapes the journal.
create function public.update_my_member_case(p_case_id uuid, p_status text, p_deadline date, p_step text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  case_row public.member_cases%rowtype;
begin
  if caller is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'resolved') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select c.* into case_row from public.member_cases c where c.id = p_case_id and c.user_id = caller for update;
  if case_row.id is null or not private.chapter_case_readable(case_row) then
    raise exception 'case unavailable' using errcode = '42501';
  end if;
  if p_step is null then
    update public.member_cases c set status = p_status, deadline = p_deadline where c.id = case_row.id
    returning * into case_row;
  else
    update public.member_cases c set status = p_status, deadline = p_deadline, step = p_step where c.id = case_row.id
    returning * into case_row;
  end if;
  perform private.learning_case_journal('case_edit', case_row.id, null);
  return pg_catalog.jsonb_build_object('id', case_row.id, 'status', case_row.status,
    'deadline', case_row.deadline, 'step', case_row.step);
end;
end;
$function$;
revoke all on function public.update_my_member_case(uuid, text, date, text) from public, anon, authenticated, service_role;
grant execute on function public.update_my_member_case(uuid, text, date, text) to authenticated;

create function public.add_my_case_update(p_case_id uuid, p_body text, p_occurred_on date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  case_row public.member_cases%rowtype;
  inserted public.member_case_updates%rowtype;
begin
  if caller is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'note must be 1-4000 characters' using errcode = '22023';
  end if;
  select c.* into case_row from public.member_cases c where c.id = p_case_id and c.user_id = caller;
  if case_row.id is null or not private.chapter_case_readable(case_row) then
    raise exception 'case unavailable' using errcode = '42501';
  end if;
  -- An undated note takes the column default (the Eastern day), as the
  -- direct insert did.
  if p_occurred_on is null then
    insert into public.member_case_updates (case_id, user_id, body)
    values (case_row.id, caller, clean_body)
    returning * into inserted;
  else
    insert into public.member_case_updates (case_id, user_id, body, occurred_on)
    values (case_row.id, caller, clean_body, p_occurred_on)
    returning * into inserted;
  end if;
  perform private.learning_journal_append('case_note_add', 'public.member_case_updates', inserted.id::text, null,
    private.learning_fingerprint(private.learning_case_note_state(inserted.id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('id', inserted.id, 'caseId', inserted.case_id, 'body', inserted.body,
    'occurredOn', inserted.occurred_on, 'createdAt', inserted.created_at);
end;
end;
$function$;
revoke all on function public.add_my_case_update(uuid, text, date) from public, anon, authenticated, service_role;
grant execute on function public.add_my_case_update(uuid, text, date) to authenticated;

revoke update on public.member_cases from authenticated;
-- UPDATE and DELETE too: the recorded hosted ACL still carries them, and the
-- contract pins SELECT only.
revoke insert, update, delete on public.member_case_updates from authenticated;

-- The dispatcher gains the case handlers (re-emitted from 20261103183000).
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
    when 'private.learning_undo_case' then return private.learning_undo_case(p_mode, p_entry);
    when 'private.learning_undo_case_note' then return private.learning_undo_case_note(p_mode, p_entry);
    when 'private.learning_undo_case_outcome' then return private.learning_undo_case_outcome(p_mode, p_entry);
    when 'private.learning_undo_case_file' then return private.learning_undo_case_file(p_mode, p_entry);
    else raise exception 'learning undo handler unavailable: %', p_handler using errcode = '55000';
  end case;
end;
$function$;

-- Every case read behind the case visibility gate (the RLS policies, the
-- staff and member helpers and their callers) now skips an undone case.
create or replace function private.case_scope_and_identity_allowed(p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  select p_case.learning_undone_at is null
    and private.actor_case_scope_and_identity_allowed((select auth.uid()),p_case);
$function$;

CREATE OR REPLACE FUNCTION private.automation_v2_case_visible(p_actor uuid, p_org uuid, p_case uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select exists(select 1 from public.member_cases c
 join public.member_profiles subject on subject.id=c.user_id
 join public.chapters ch on ch.id=subject.chapter_id and ch.organization_id=p_org
 where c.id=p_case and c.learning_undone_at is null and c.organization_id=p_org and private.actor_case_scope_and_identity_allowed(p_actor,c)
 and (c.user_id=p_actor or
   (c.steward_user_id=p_actor and exists(select 1 from public.member_role_chapters g where g.user_id=p_actor and g.chapter_id=c.chapter_id and g.role='steward')) or
   exists(select 1 from public.organization_role_grants g where g.user_id=p_actor and g.organization_id=p_org and g.role='coordinator') or
   exists(select 1 from public.member_role_chapters g join public.member_chapter_memberships m on m.user_id=g.user_id and m.chapter_id=g.chapter_id and m.status='active' where g.user_id=p_actor and g.chapter_id=subject.chapter_id and g.role='coordinator')));
$function$
;

CREATE OR REPLACE FUNCTION private.casework_reminder_owner_can_read(p_owner uuid, p_case_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with org_staff as (
    select c.id as case_id,
      exists (
        select 1
        from public.organizations o
        join public.organization_memberships m
          on m.organization_id = o.id and m.user_id = p_owner and m.status = 'active'
        join public.organization_role_grants g
          on g.organization_id = o.id and g.user_id = p_owner and g.role in ('advisor', 'admin', 'vp')
        where o.id = c.organization_id
          and o.status = 'active'
          and (not private.staff_mfa_required(o.id) or private.has_second_factor(p_owner))
      ) as elevated
    from public.member_cases c
    where c.id = p_case_id and c.learning_undone_at is null and private.actor_case_scope_and_identity_allowed(p_owner,c)
  )
  select p_owner is not null and exists (
    select 1
    from public.member_cases c
    join org_staff s on s.case_id = c.id
    where c.id = p_case_id and c.learning_undone_at is null and private.actor_case_scope_and_identity_allowed(p_owner,c)
      and (
        c.user_id = p_owner
        or (
          c.organization_id is not null
          and c.chapter_id is not null
          and private.actor_has_chapter_staff_role(p_owner, c.chapter_id)
          and (
            c.steward_user_id = p_owner
            or c.coordinator_user_id = p_owner
            or s.elevated
            or exists (
              select 1
              from public.member_roles r
              join public.member_profiles target on target.id = c.user_id
              where r.user_id = p_owner
                and r.role = 'coordinator'
                and (
                  r.chapter_id is null
                  or exists (
                    select 1
                    from public.member_role_chapters rc
                    join public.member_chapter_memberships cm
                      on cm.user_id = rc.user_id and cm.chapter_id = rc.chapter_id
                    where rc.user_id = r.user_id
                      and rc.role = r.role
                      and rc.chapter_id = target.chapter_id
                      and cm.status = 'active'
                  )
                )
            )
          )
          and (
            not c.is_restricted
            or c.steward_user_id = p_owner
            or c.coordinator_user_id = p_owner
            or s.elevated
            or exists (
              select 1
              from public.casework_access_grants ag
              where ag.case_id = c.id
                and ag.grantee_user_id = p_owner
                and ag.revoked_at is null
            )
          )
        )
      )
  );
$function$
;

create or replace function private.chapter_case_leadership_readable(p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  select p_case.learning_undone_at is null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and p_case.organization_id=private.current_member_organization()
    and (not private.staff_mfa_required(p_case.organization_id) or private.has_second_factor((select auth.uid())))
    and (private.member_has_chapter_role(p_case.chapter_id,array['admin','vp'])
      or private.has_organization_role(p_case.organization_id,array['admin','vp']))
    and private.actor_case_scope_and_identity_allowed((select auth.uid()),p_case);
$function$;

-- Case and note readers outside that gate skip undone rows too.
create or replace function private.member_data_export_without_peer_contact()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid;
  exported jsonb;
  records integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  records := 0;
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select pg_catalog.jsonb_build_object('schemaVersion', 1,
    'generatedAt', now(),
    'account', pg_catalog.jsonb_build_object(
      'userId', caller,
      'email', (select u.email from auth.users u where u.id = caller),
      'profile', coalesce((
        select pg_catalog.jsonb_build_object(
          'firstName', p.first_name, 'fullName', p.full_name,
          'initials', p.initials, 'roleLine', p.role_line,
          'memberSince', p.member_since, 'language', p.language,
          'chapterId', p.chapter_id, 'createdAt', p.created_at,
          'updatedAt', p.updated_at)
        from public.member_profiles p where p.id = caller
      ), '{}'::jsonb),
      'roles', coalesce((select pg_catalog.jsonb_agg(r.role order by r.role)
        from public.member_roles r where r.user_id = caller), '[]'::jsonb)
    ),
    'notifications', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', n.id, 'title', n.title, 'body', n.body, 'kind', n.kind,
      'readAt', n.read_at, 'createdAt', n.created_at) order by n.created_at)
      from public.member_notifications n where n.user_id = caller), '[]'::jsonb),
    'conversations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'title', c.title, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'stewardUserId', c.steward_user_id,
      'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'senderKind', m.sender_kind, 'senderName', m.sender_name,
        'body', m.body, 'redactedAt', m.redacted_at, 'redactionReason', m.redaction_reason,
        'bodySha256', m.body_sha256, 'originalLength', m.original_length,
        'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)
        from public.member_messages m
        where m.conversation_id = c.id
          and (m.user_id = caller or m.sender_id = caller)), '[]'::jsonb)
      ) order by c.created_at) from public.member_conversations c where c.user_id = caller), '[]'::jsonb),
    'cases', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'reference', c.reference, 'title', c.title, 'deadline', c.deadline,
      'caseType', c.case_type, 'articles', c.articles, 'step', c.step,
      'status', c.status, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'updates', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'body', u.body, 'occurredOn', u.occurred_on, 'createdAt', u.created_at) order by u.created_at)
        from public.member_case_updates u where u.case_id = c.id and u.user_id = caller and u.learning_undone_at is null), '[]'::jsonb)
      ) order by c.created_at) from public.member_cases c where c.user_id = caller and c.learning_undone_at is null), '[]'::jsonb),
    'forms', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'templateKey', f.template_key, 'templateVersion', f.template_version,
      'status', f.status, 'answers', f.answers, 'step', f.step,
      'reviewNote', f.review_note, 'reviewedAt', f.reviewed_at,
      'submittedAt', f.submitted_at, 'createdAt', f.created_at, 'updatedAt', f.updated_at,
      'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'status', c.status, 'invitedAt', c.invited_at, 'respondedAt', c.responded_at)
        order by c.invited_at) from public.member_form_cosigners c where c.form_id = f.id), '[]'::jsonb)
      ) order by f.created_at) from public.member_forms f where f.user_id = caller), '[]'::jsonb),
    'participation', pg_catalog.jsonb_build_object(
      'ballotReceipts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ballotId', r.ballot_id, 'receiptCode', r.receipt_code,
        'counted', r.counted, 'issuedAt', r.issued_at) order by r.issued_at)
        from public.member_ballot_receipts r where r.user_id = caller), '[]'::jsonb),
      'surveyResponses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'surveyId', s.survey_id, 'optionId', s.option_id, 'submittedAt', s.submitted_at)
        order by s.submitted_at) from public.member_survey_responses s where s.user_id = caller), '[]'::jsonb),
      'rightsProgress', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'lessonId', r.lesson_id, 'completedSteps', r.completed_steps, 'updatedAt', r.updated_at)
        order by r.updated_at) from public.member_rights_progress r where r.user_id = caller), '[]'::jsonb),
      'eventRsvps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', r.event_id, 'status', r.status, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_event_rsvps r where r.user_id = caller), '[]'::jsonb),
      'eventCheckins', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', c.event_id, 'checkedInAt', c.checked_in_at) order by c.checked_in_at)
        from public.member_event_checkins c where c.user_id = caller), '[]'::jsonb)
    ),
    'support', pg_catalog.jsonb_build_object(
      'stewardRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'lessonId', r.lesson_id, 'status', r.status,
        'createdAt', r.created_at, 'acknowledgedAt', r.acknowledged_at, 'closedAt', r.closed_at)
        order by r.created_at) from public.member_steward_requests r where r.user_id = caller), '[]'::jsonb),
      'appointments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'chapterId', a.chapter_id, 'appointmentType', a.appointment_type,
        'durationMinutes', a.duration_minutes, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
        'status', a.status, 'routedVia', a.routed_via, 'reasonCategory', a.reason_category,
        'createdAt', a.created_at, 'updatedAt', a.updated_at) order by a.created_at)
        from public.member_appointments a where a.user_id = caller), '[]'::jsonb),
      'intakeReports', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id, 'chapterId', i.chapter_id, 'category', i.category, 'title', i.title,
        'details', i.details, 'status', i.status, 'createdAt', i.created_at, 'updatedAt', i.updated_at)
        order by i.created_at) from public.member_intake_reports i where i.reporter_id = caller), '[]'::jsonb),
      'dataRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', g.id, 'chapterId', g.chapter_id, 'requestType', g.request_type,
        'details', g.details, 'status', g.status, 'response', g.response,
        'createdAt', g.created_at, 'updatedAt', g.updated_at) order by g.created_at)
        from public.chapter_governance_requests g where g.requester_id = caller), '[]'::jsonb)
    ),
    'compass', pg_catalog.jsonb_build_object(
      'threads', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', t.id, 'title', t.title, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
        'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', m.id, 'role', m.role, 'body', m.body, 'sources', m.sources, 'createdAt', m.created_at)
          order by m.created_at) from public.member_guide_messages m
          where m.thread_id = t.id and m.user_id = caller), '[]'::jsonb)) order by t.created_at)
        from public.member_guide_threads t where t.user_id = caller), '[]'::jsonb),
      'requestHistory', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'createdAt', r.created_at, 'role', r.compass_role,
        'limit', r.compass_limit, 'dispatchAuthorizedAt', r.dispatch_authorized_at)
        order by r.created_at) from public.member_ai_requests r where r.user_id = caller), '[]'::jsonb)
    ),
    'activity', pg_catalog.jsonb_build_object(
      'points', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', p.action_key, 'actionKind', p.action_kind,
        'points', p.points, 'occurredAt', p.occurred_at) order by p.occurred_at)
        from public.member_point_events p where p.user_id = caller), '[]'::jsonb),
      'rewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'itemKey', r.item_key, 'status', r.status, 'source', r.source,
        'reason', r.reason, 'note', r.note, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_reward_grants r where r.user_id = caller), '[]'::jsonb),
      'workload', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(w) - 'user_id' order by w.created_at)
        from public.member_workload_logs w where w.user_id = caller), '[]'::jsonb),
      'actions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', a.action_key, 'actionKind', a.action_kind, 'occurredAt', a.occurred_at)
        order by a.occurred_at) from public.member_action_log a where a.user_id = caller), '[]'::jsonb)
    ),
    'chapterParticipation', pg_catalog.jsonb_build_object(
      'spaceMemberships', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', m.space_id, 'role', m.role,
        'joinedAt', m.joined_at) order by m.joined_at)
        from public.chapter_space_members m where m.user_id = caller), '[]'::jsonb),
      'taskAssignments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'taskId', a.task_id, 'chapterId', a.chapter_id, 'position', a.position, 'assignedAt', a.assigned_at)
        order by a.assigned_at) from public.chapter_task_assignments a where a.assignee_id = caller), '[]'::jsonb),
      'taskComments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'taskId', c.task_id, 'chapterId', c.chapter_id,
        'body', c.body, 'createdAt', c.created_at) order by c.created_at)
        from public.chapter_task_comments c where c.author_id = caller), '[]'::jsonb),
      'taskMessages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'taskId', m.task_id, 'chapterId', m.chapter_id,
        'direction', case when m.sender_id = caller then 'sent' else 'received' end,
        'body', m.body, 'createdAt', m.created_at) order by m.created_at)
        from public.chapter_task_messages m where m.sender_id = caller or m.recipient_id = caller), '[]'::jsonb)
    )
  ) into exported;

  select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(value)), 0)::integer
    into records
  from pg_catalog.jsonb_each(exported) section
  where pg_catalog.jsonb_typeof(value) = 'array';

  insert into private.member_account_lifecycle_audit (subject_hash, event_type, record_count)
  values (private.member_lifecycle_subject_hash(caller), 'export_generated', records);

  return exported || pg_catalog.jsonb_build_object('topLevelRecordCount', records);
end;
$$;

create or replace function private.casework_sweep_ulp_deadlines(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer;
  v_count integer;
  v_report record;
  v_flag public.casework_retaliation_flags%rowtype;
  v_case public.member_cases%rowtype;
  v_warning integer;
  v_critical integer;
  v_days integer;
  v_level text;
  v_staff uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  v_limit := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_count := 0;

  -- 1. A member's retaliation report attached to a case is a flagged incident.
  for v_report in
    select r.id, r.case_id, r.organization_id, r.chapter_id, r.incident_at
    from public.casework_retaliation_reports r
    where r.case_id is not null
      and r.status <> 'withdrawn'
      and private.member_case_is_live(r.case_id)
      and not exists (
        select 1 from public.casework_retaliation_flags f
        where f.source = 'member_report' and f.source_id = r.id)
      and private.organization_feature_enabled(r.organization_id, 'features.casework.ulp_deadline')
    order by r.created_at, r.id
    limit v_limit
  loop
    insert into public.casework_retaliation_flags
      (case_id, organization_id, chapter_id, source, source_id, incident_on, ulp_window_days)
    values (v_report.case_id, v_report.organization_id, v_report.chapter_id, 'member_report', v_report.id,
      (v_report.incident_at at time zone 'UTC')::date,
      private.organization_limit(v_report.organization_id, 'limits.casework.ulp_window_days'))
    on conflict (case_id, source, source_id) where source_id is not null do nothing
    returning * into v_flag;
    if v_flag.id is not null then
      insert into public.casework_audit_events
        (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
      values (v_flag.organization_id, v_flag.chapter_id, v_flag.case_id, null,
        'pattern_detected', 'retaliation_flag', v_flag.id,
        pg_catalog.jsonb_build_object('source', 'member_report', 'ulpWindowDays', v_flag.ulp_window_days));
      v_count := v_count + 1;
    end if;
    v_flag := null;
  end loop;

  -- 2. A withdrawn report withdraws its flag.
  with withdrawn as (
    select f.id from public.casework_retaliation_flags f
    join public.casework_retaliation_reports r on r.id = f.source_id
    where f.source = 'member_report' and r.status = 'withdrawn' and f.status <> 'withdrawn'
    order by f.id
    limit v_limit
    for update of f skip locked
  )
  update public.casework_retaliation_flags f
    set status = 'withdrawn', updated_at = pg_catalog.now()
    from withdrawn w where f.id = w.id;

  -- 3. Warn once at the first threshold and once more at the urgent one.
  for v_flag in
    select f.* from public.casework_retaliation_flags f
    where f.status in ('open', 'confirmed')
      and private.member_case_is_live(f.case_id)
      and f.ulp_deadline >= current_date
      and f.urgent_sent_at is null
      and f.ulp_deadline <= current_date + 120
    order by f.ulp_deadline, f.id
    for update of f skip locked
    limit v_limit
  loop
    if not private.organization_feature_enabled(v_flag.organization_id, 'features.casework.ulp_deadline') then
      continue;
    end if;
    select t.warning_days, t.critical_days into v_warning, v_critical
    from private.casework_ulp_thresholds(v_flag.organization_id) t;
    v_days := v_flag.ulp_deadline - current_date;
    v_level := case
      when v_days <= v_critical then 'urgent'
      when v_days <= v_warning and v_flag.warning_sent_at is null then 'warning'
    end;
    continue when v_level is null;
    select * into v_case from public.member_cases where id = v_flag.case_id and learning_undone_at is null;
    continue when not found;
    perform private.notify_member(v_case.user_id, 'casework.ulp.member_' || v_level, '{}'::jsonb, 'deadlines');
    for v_staff in
      select distinct u from unnest(array[v_case.steward_user_id, v_case.coordinator_user_id]) u
      where u is not null and u is distinct from v_case.user_id
    loop
      if private.casework_reminder_owner_can_read(v_staff, v_case.id) then
        perform private.notify_member(v_staff, 'casework.ulp.staff_' || v_level, '{}'::jsonb, 'deadlines');
      end if;
    end loop;
    update public.casework_retaliation_flags
      set warning_sent_at = coalesce(warning_sent_at, pg_catalog.now()),
        urgent_sent_at = case when v_level = 'urgent' then pg_catalog.now() else urgent_sent_at end,
        updated_at = pg_catalog.now()
      where id = v_flag.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_administrative_evidence_desk(p_page integer DEFAULT 0, p_query text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_org uuid := private.require_administrative_evidence_staff();
  page_offset integer;
  -- p_query is kept so clients cached before October 3, 2026 keep resolving
  -- this signature; it is still length-bounded but no longer searches anything.
  search_query text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
begin
  if p_page < 0 or p_page > 10000 then raise exception 'invalid evidence page' using errcode='22023'; end if;
  if pg_catalog.char_length(search_query) > 200 then raise exception 'evidence search is too long' using errcode='22023'; end if;
  page_offset := p_page * 25;
  return pg_catalog.jsonb_build_object(
    'fieldNoteBlocks', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', b.id, 'sourceId', b.source_id, 'sourceTitle', s.title, 'sourceType', s.source_type,
      'provenance', s.provenance, 'issueKey', b.issue_key, 'body', b.body,
      'annotation', b.annotation, 'packetState', b.packet_state, 'updatedAt', b.updated_at
    ) order by b.updated_at desc, b.id desc) from (select * from public.organization_field_note_blocks where organization_id = caller_org order by updated_at desc, id desc limit 25 offset page_offset) b join public.organization_field_note_sources s on s.id = b.source_id and s.organization_id = caller_org), '[]'::jsonb),
    'packets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', p.id, 'issueKey', p.issue_key, 'title', p.title, 'body', p.body,
      'status', p.status, 'updatedAt', p.updated_at
    ) order by p.updated_at desc, p.id desc) from (select * from public.organization_field_note_packets where organization_id = caller_org order by updated_at desc, id desc limit 25 offset page_offset) p), '[]'::jsonb),
    'actions', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('targetKind','field_note_block','actionKey','include','label','Include evidence in packet'),
      pg_catalog.jsonb_build_object('targetKind','field_note_block','actionKey','exclude','label','Exclude evidence from packet'),
      pg_catalog.jsonb_build_object('targetKind','field_note_packet','actionKey','mark_review_ready','label','Mark packet review ready'),
      pg_catalog.jsonb_build_object('targetKind','member_case','actionKey','case_record_review','label','Record case review'),
      pg_catalog.jsonb_build_object('targetKind','chapter_task','actionKey','task_record_review','label','Record task review'),
      pg_catalog.jsonb_build_object('targetKind','member_profile','actionKey','member_record_review','label','Record member review')
    ),
    'actionTargets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'targetKind', t.target_kind, 'id', t.id, 'label', t.label
    ) order by t.target_kind, t.label, t.id) from (
      (select 'member_case'::text as target_kind, cs.id, cs.reference || ' · ' || cs.title as label
       from public.member_cases cs
       where cs.organization_id=caller_org and cs.learning_undone_at is null
       order by cs.updated_at desc, cs.id desc limit 25 offset page_offset)
      union all
      (select 'chapter_task'::text, task.id, task.title
       from public.chapter_tasks task join public.chapters chapter on chapter.id=task.chapter_id
       where chapter.organization_id=caller_org and task.deleted_at is null
         and exists (select 1 from public.member_profiles caller_profile where caller_profile.id=auth.uid() and caller_profile.chapter_id=task.chapter_id)
       order by task.updated_at desc, task.id desc limit 25 offset page_offset)
      union all
      (select 'member_profile'::text, profile.id, profile.full_name
       from public.organization_memberships membership join public.member_profiles profile on profile.id=membership.user_id
       where membership.organization_id=caller_org and membership.status='active' order by profile.full_name, profile.id limit 25 offset page_offset)
    ) t), '[]'::jsonb),
    'history', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'targetKind', r.target_kind, 'targetId', r.target_id,
      'targetLabel', r.target_label, 'actionKey', r.action_key, 'note', r.note, 'previousState', r.previous_state,
      'resultingState', r.resulting_state, 'createdAt', r.created_at,
      'actorLabel', coalesce(nullif(pg_catalog.btrim(actor.full_name),''), case when r.actor_user_id is null then 'Deleted user' else 'User ' || pg_catalog.substr(r.actor_user_id::text,1,8) end)
    ) order by r.created_at desc, r.id desc)
    from (select * from public.organization_object_action_runs where organization_id = caller_org order by created_at desc, id desc limit 25 offset page_offset) r
    left join public.member_profiles actor on actor.id=r.actor_user_id), '[]'::jsonb),
    'page', p_page,
    'pageSize', 25,
    'hasNext', pg_catalog.jsonb_build_object(
      'notes', greatest((select pg_catalog.count(*) from public.organization_field_note_blocks where organization_id=caller_org), (select pg_catalog.count(*) from public.organization_field_note_packets where organization_id=caller_org)) > page_offset + 25,
      'actions', greatest(
        (select pg_catalog.count(*) from public.organization_object_action_runs where organization_id=caller_org),
        (select pg_catalog.count(*) from public.organization_field_note_blocks where organization_id=caller_org),
        (select pg_catalog.count(*) from public.organization_field_note_packets where organization_id=caller_org),
        (select pg_catalog.count(*) from public.member_cases cs where cs.organization_id=caller_org and cs.learning_undone_at is null),
        (select pg_catalog.count(*) from public.chapter_tasks task join public.chapters chapter on chapter.id=task.chapter_id
          where chapter.organization_id=caller_org and task.deleted_at is null
            and exists (select 1 from public.member_profiles caller_profile where caller_profile.id=auth.uid() and caller_profile.chapter_id=task.chapter_id)),
        (select pg_catalog.count(*) from public.organization_memberships where organization_id=caller_org and status='active')
      ) > page_offset + 25
    )
  );
end;
$function$;

create or replace function private.case_deadline_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  r record;
begin
  for r in
    select c.id, c.user_id, (c.deadline - current_date) as days_left
    from public.member_cases c
    where c.status = 'active' and c.learning_undone_at is null
      and c.deadline is not null
      and (c.deadline - current_date) between 0 and 7
      and (
        ((c.deadline - current_date) <= 1 and c.deadline_notice_1_sent_at is null)
        or ((c.deadline - current_date) between 2 and 3 and c.deadline_notice_3_sent_at is null)
        or ((c.deadline - current_date) between 4 and 7 and c.deadline_notice_7_sent_at is null)
      )
    for update skip locked
  loop
    if r.days_left <= 1 then
      update public.member_cases
        set deadline_notice_1_sent_at = now(),
            deadline_notice_3_sent_at = coalesce(deadline_notice_3_sent_at, now()),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id,
        case when r.days_left <= 0 then 'deadline.case.today' else 'deadline.case.tomorrow' end,
        '{}'::jsonb, 'deadlines');
    elsif r.days_left <= 3 then
      update public.member_cases
        set deadline_notice_3_sent_at = now(),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    else
      update public.member_cases
        set deadline_notice_7_sent_at = now()
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    end if;
  end loop;
  begin
    perform private.staff_deadline_notice_sweep();
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'staff_deadline_notice_sweep failed: % (%)', sqlerrm, sqlstate;
  end;
end;
end;
$function$;

create or replace function private.can_read_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select not private.member_pin_session_restricted() and exists (
    select 1 from public.member_case_files f where f.bucket_id=p_bucket and f.object_name=p_name and f.confirmed_at is not null and f.removal_requested_at is null
      and private.member_case_is_live(f.case_id) and (f.user_id=(select auth.uid()) or exists(select 1 from public.member_cases c where c.id=f.case_id and private.chapter_case_readable(c))));
$function$;

create or replace function public.list_private_grievance_summaries()
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',entry.id,'status',entry.status)),'[]'::jsonb)
  from (
    select c.id,c.status from public.member_cases c
    join private.case_identity_privacy privacy on privacy.case_id=c.id
    where private.mfa_satisfied() and c.organization_id=private.current_member_organization()
      and private.chapter_grievance_steward_scope(c.chapter_id,c.user_id)
      and not c.is_restricted and c.learning_undone_at is null
      and coalesce((select p.steward_grievances from private.chapter_access_policies p where p.chapter_id=c.chapter_id),true)
      and not private.chapter_case_readable(c)
    order by c.id limit 100
  ) entry;
$function$;

create or replace function private.chapter_case_staff_readable(p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  select p_case.learning_undone_at is null and private.mfa_satisfied() and (p_case.user_id=(select auth.uid())
    or private.casework_staff_can_read(p_case.id));
$function$;

create or replace function private.casework_member_owns(p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.member_cases c
    where c.id = p_case_id and c.learning_undone_at is null and c.user_id = (select auth.uid())
  );
$function$;

create or replace function private.can_read_restricted_case(p_organization_id uuid, p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (select auth.uid()) is not null
    and p_organization_id is not null
    and p_case_id is not null
    and private.is_organization_member(p_organization_id)
    and exists (
      select 1 from public.member_cases mc
      where mc.id = p_case_id and mc.learning_undone_at is null and mc.organization_id = p_organization_id
        and (
          private.has_organization_role(p_organization_id, array['admin', 'vp'])
          or (
            mc.steward_user_id = (select auth.uid())
            and (
              private.has_organization_role(p_organization_id, array['steward'])
              or exists (
                select 1 from public.member_role_chapters rc
                where rc.user_id = (select auth.uid()) and rc.chapter_id = mc.chapter_id
                  and rc.role = 'steward'
              )
            )
          )
          or private.has_organization_role(p_organization_id, array['coordinator'])
          or exists (
            select 1 from public.member_role_chapters rc
            where rc.user_id = (select auth.uid()) and rc.chapter_id = mc.chapter_id
              and rc.role = 'coordinator'
          )
        )
        and (
          not mc.is_restricted
          or mc.steward_user_id = (select auth.uid())
          or mc.coordinator_user_id = (select auth.uid())
          or private.has_organization_role(p_organization_id, array['advisor', 'admin', 'vp'])
          or exists (
            select 1 from public.casework_access_grants g
            where g.case_id = mc.id and g.organization_id = mc.organization_id
              and g.grantee_user_id = (select auth.uid()) and g.revoked_at is null
          )
        )
    )
$function$;

create or replace function private.casework_scope_matches(
  p_case_id uuid,
  p_organization_id uuid,
  p_chapter_id text
)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.member_cases c
    where c.id = p_case_id and c.learning_undone_at is null
      and c.organization_id = p_organization_id
      and c.chapter_id = p_chapter_id
  );
$function$;

create or replace function private.mi1_w2_case_organization(p_case_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select mc.organization_id
  from public.member_cases mc
  where mc.id = p_case_id and mc.learning_undone_at is null
    and mc.organization_id is not null
$function$;

create or replace function public.get_my_case_ulp_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', s.case_id,
      'ulpDeadline', case when s.enabled then s.ulp_deadline end,
      'retaliationFlagged', true,
      'stewardNotified', s.steward_notified,
      'ulpWarningDays', s.warning_days,
      'ulpCriticalDays', s.critical_days,
      'ulpSource', case when s.enabled then (
        select r.provenance
        from (
          select d.ulp_window_basis
          from public.casework_retaliation_flags d
          where d.case_id = s.case_id and d.status in ('open', 'confirmed')
            and d.ulp_deadline = s.ulp_deadline
          order by d.created_at, d.id
          limit 1
        ) b
        join private.reference_ulp_limitation_periods r
          on b.ulp_window_basis = 'jurisdiction:' || r.jurisdiction) end)
      || case when s.enabled and s.safety_deadline is not null
        then pg_catalog.jsonb_build_object(
          'safetyDeadline', s.safety_deadline,
          'safetyRoute', private.casework_safety_retaliation_route(s.organization_id))
        else '{}'::jsonb end
      order by s.ulp_deadline, s.case_id)
    from (
      select c.id as case_id,
        c.organization_id,
        private.organization_feature_enabled(c.organization_id, 'features.casework.ulp_deadline') as enabled,
        coalesce(
          min(f.ulp_deadline) filter (where f.ulp_deadline >= current_date),
          max(f.ulp_deadline)) as ulp_deadline,
        coalesce(
          min(f.safety_deadline) filter (where f.safety_deadline >= current_date),
          max(f.safety_deadline)) as safety_deadline,
        bool_or(f.staff_notified_at is not null) as steward_notified,
        t.warning_days,
        t.critical_days
      from public.member_cases c
      join public.casework_retaliation_flags f on f.case_id = c.id and f.status in ('open', 'confirmed')
      cross join lateral private.casework_ulp_thresholds(c.organization_id) t
      where c.user_id = caller and c.learning_undone_at is null
      group by c.id, c.organization_id, t.warning_days, t.critical_days
    ) s
  ), '[]'::jsonb);
end;

end;
$function$;

create or replace function public.mark_vp_case_reviewed(p_case_id uuid)
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
  result_row public.member_vp_case_reviews%rowtype;
begin
  if caller is null or not public.member_has_role(array['vp']) or not (select private.mfa_satisfied()) then
    raise exception 'president role with MFA required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'vp'
  order by r.chapter_id
  limit 1;

  if caller_chapter is null or not exists (
    select 1
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where c.id = p_case_id and c.learning_undone_at is null
      and p.chapter_id = caller_chapter
      and c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
  ) then
    raise exception 'attention case not found' using errcode = 'P0002';
  end if;

  insert into public.member_vp_case_reviews (chapter_id, case_id, reviewed_by)
  values (caller_chapter, p_case_id, caller)
  on conflict (chapter_id, case_id) do nothing;

  select * into strict result_row
  from public.member_vp_case_reviews r
  where r.chapter_id = caller_chapter and r.case_id = p_case_id;

  return pg_catalog.jsonb_build_object(
    'caseId', result_row.case_id,
    'reviewedAt', result_row.reviewed_at,
    'reviewedBy', result_row.reviewed_by);
end;
end;
$$;

create or replace function public.reserve_google_drive_filing_folder(
  p_organization_id uuid, p_root_folder_id text, p_parent_folder_id text,
  p_target_key text, p_folder_name text, p_proposed_folder_id text default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  reserved_id text;
  expected_parent text;
  target_id text;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_root_folder_id is null or p_parent_folder_id is null or p_target_key is null or p_folder_name is null
     or p_root_folder_id !~ '^[A-Za-z0-9_-]+$' or char_length(p_root_folder_id) > 256
     or p_parent_folder_id !~ '^[A-Za-z0-9_-]+$' or char_length(p_parent_folder_id) > 256
     or char_length(p_folder_name) not between 1 and 200
     or (p_proposed_folder_id is not null and (p_proposed_folder_id !~ '^[A-Za-z0-9_-]+$' or char_length(p_proposed_folder_id) > 256)) then
    raise exception 'invalid folder reservation' using errcode = '22023';
  end if;
  if not private.organization_feature_enabled(p_organization_id, 'features.integrations.drive_case_meeting_folders')
     or not exists (select 1 from public.organization_integrations i where i.organization_id = p_organization_id
       and i.provider = 'google_drive' and i.status = 'connected' and i.credential_ref is not null
       and i.default_settings ->> 'rootFolderId' = p_root_folder_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_target_key in ('group:Cases', 'group:Meetings') then
    expected_parent := p_root_folder_id;
  else
    target_id := substring(p_target_key from position(':' in p_target_key) + 1);
    if p_target_key like 'case:%' and target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.member_cases c where c.id = target_id::uuid and c.learning_undone_at is null
         and c.organization_id = p_organization_id and not c.is_restricted) then
      select f.folder_id into expected_parent from private.google_drive_filing_folders f
      where f.organization_id = p_organization_id and f.root_folder_id = p_root_folder_id and f.target_key = 'group:Cases';
    elsif p_target_key like 'meeting:%' and char_length(target_id) between 1 and 200
       and exists (select 1 from public.member_events e join public.chapters ch on ch.id = e.chapter_id
         where e.id = target_id and ch.organization_id = p_organization_id) then
      select f.folder_id into expected_parent from private.google_drive_filing_folders f
      where f.organization_id = p_organization_id and f.root_folder_id = p_root_folder_id and f.target_key = 'group:Meetings';
    else
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;
  if expected_parent is null or expected_parent is distinct from p_parent_folder_id then
    raise exception 'folder parent mismatch' using errcode = '42501';
  end if;
  select f.folder_id into reserved_id from private.google_drive_filing_folders f
  where f.organization_id = p_organization_id and f.root_folder_id = p_root_folder_id and f.target_key = p_target_key;
  if reserved_id is null and p_proposed_folder_id is not null then
    insert into private.google_drive_filing_folders as f
      (organization_id, root_folder_id, parent_folder_id, target_key, folder_name, folder_id)
    values (p_organization_id, p_root_folder_id, p_parent_folder_id, p_target_key, p_folder_name, p_proposed_folder_id)
    on conflict (organization_id, root_folder_id, target_key) do update set folder_id = f.folder_id
    returning folder_id into reserved_id;
  end if;
  return pg_catalog.jsonb_build_object('folderId', reserved_id);
end;
$function$;

create or replace function public.set_grievance_identity_private(p_case uuid, p_private boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[p_case]);
declare target public.member_cases%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'authentication required' using errcode='42501'; end if;
  select * into target from public.member_cases where id=p_case and learning_undone_at is null and steward_user_id=(select auth.uid()) and private.chapter_grievance_steward_scope(chapter_id,user_id) for update;
  if not found or target.steward_user_id is distinct from (select auth.uid())
    or not private.chapter_grievance_steward_scope(target.chapter_id,target.user_id) then
    raise exception 'assigned steward required' using errcode='42501';
  end if;
  if coalesce(p_private,false) then insert into private.case_identity_privacy(case_id) values(p_case) on conflict do nothing;
  else delete from private.case_identity_privacy where case_id=p_case; end if;
  insert into public.member_admin_audit(actor,action,detail) values(auth.uid(),'grievance_identity_visibility_updated',pg_catalog.jsonb_build_object('caseId',p_case,'private',coalesce(p_private,false)));
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;

create or replace function public.sensitive_case_inspection_metadata(p_file_id uuid, p_attempt_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('id', f.id, 'size_bytes', f.size_bytes,
    'object_name', f.object_name, 'encrypted_content', f.encrypted_content,
    'organization_id', c.organization_id)
  from public.member_case_files f
  join public.member_cases c on c.id = f.case_id and c.learning_undone_at is null
  join private.private_upload_inspection_attempts a
    on a.bucket_id = f.bucket_id and a.object_name = f.object_name
  join storage.objects o on o.id = a.object_id
    and o.bucket_id = a.bucket_id and o.name = a.object_name
    and o.version is not distinct from a.object_version
  where (select auth.role()) = 'service_role'
    and f.id = p_file_id and f.bucket_id = 'case-files' and a.id = p_attempt_id
    and a.completed_at is null and a.expires_at > clock_timestamp()
    and f.removal_requested_at is null and f.cleanup_requested_at is null
    and f.encrypted_content is not null
$$;

create or replace function public.casework_submit_retaliation_report(
  p_case_id uuid,
  p_incident_at timestamptz,
  p_management_person text,
  p_protected_activity text,
  p_adverse_action text,
  p_requested_support text,
  p_idempotency_key uuid
)
returns public.casework_retaliation_reports
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_case public.member_cases%rowtype; v_row public.casework_retaliation_reports%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_case from public.member_cases where id = p_case_id and learning_undone_at is null and user_id = (select auth.uid()) for share;
  if v_case.organization_id is null or v_case.chapter_id is null then raise exception 'case not found' using errcode = 'P0002'; end if;
  insert into public.casework_retaliation_reports(id, organization_id, chapter_id, reporter_user_id, case_id, incident_at, management_person, protected_activity, adverse_action, requested_support, idempotency_key)
  values (p_idempotency_key, v_case.organization_id, v_case.chapter_id, (select auth.uid()), v_case.id, p_incident_at, pg_catalog.btrim(p_management_person), pg_catalog.btrim(p_protected_activity), pg_catalog.btrim(p_adverse_action), nullif(pg_catalog.btrim(p_requested_support), ''), p_idempotency_key)
  on conflict (organization_id, reporter_user_id, idempotency_key) do nothing
  returning * into v_row;
  if not found then select * into strict v_row from public.casework_retaliation_reports where organization_id = v_case.organization_id and reporter_user_id = (select auth.uid()) and idempotency_key = p_idempotency_key; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'retaliation_submitted', 'retaliation_report', v_row.id);
  return v_row;
end;
end;
$function$;

create or replace function private.casework_retaliation_adverse_events(p_since date)
returns table (
  adverse_kind text,
  adverse_id uuid,
  organization_id uuid,
  member_id uuid,
  adverse_on date,
  linked_case_id uuid,
  is_discipline boolean,
  severity numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
  select 'management_entry', e.id, e.organization_id, c.user_id,
    (e.occurred_at at time zone 'UTC')::date, e.case_id,
    pg_catalog.lower(pg_catalog.btrim(e.category)) = 'discipline',
    private.casework_retaliation_severity(e.summary)
  from public.casework_management_entries e
  join public.member_cases c on c.id = e.case_id and c.learning_undone_at is null
  where e.case_id is not null
    and pg_catalog.lower(pg_catalog.btrim(e.category)) in ('discipline', 'retaliation')
    and e.occurred_at >= (p_since::timestamp at time zone 'UTC')
  union all
  select 'discipline_case', d.id, d.organization_id, d.user_id,
    coalesce(
      (select (f.answers ->> 'incident_date')::date from public.member_forms f
        where f.case_id = d.id and f.user_id = d.user_id
          and coalesce(f.answers ->> 'incident_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
        order by f.created_at, f.id limit 1),
      (d.created_at at time zone 'UTC')::date),
    null::uuid, true, private.casework_retaliation_severity(d.title)
  from public.member_cases d
  where d.organization_id is not null and d.learning_undone_at is null
    and pg_catalog.lower(pg_catalog.btrim(d.case_type)) = 'discipline'
    and d.created_at >= (p_since::timestamp at time zone 'UTC') - interval '1 year';
$function$;

create or replace function public.get_member_union_statistics()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid;
  privacy_floor integer;
  generated timestamptz := pg_catalog.now();
  first_month timestamp;
  window_start timestamptz;
  months jsonb;
  wins_ok boolean;
  actions_ok boolean;
  outcomes jsonb;
  outcomes_ok boolean;
  chapters jsonb;
  open_ok boolean;
begin
  perform private.lock_case_graph_read();
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.member_pin_require_full_session();
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object('available', false, 'locked', true, 'reason', 'quarterly_survey_gate');
  end if;
  org := private.current_member_organization();
  if org is null or not private.is_organization_member(org) or not private.organization_is_union(org) then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  privacy_floor := greatest(coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25), 10);
  first_month := pg_catalog.date_trunc('month', generated at time zone 'America/New_York') - interval '11 months';
  window_start := first_month at time zone 'America/New_York';

  with month_list as (
    select pg_catalog.generate_series(first_month, first_month + interval '11 months', interval '1 month') as month
  ), wins as (
    select pg_catalog.date_trunc('month', o.recorded_at at time zone 'America/New_York') as month,
      pg_catalog.count(*)::integer as value,
      pg_catalog.count(distinct o.user_id)::integer as people
    from public.member_case_outcomes o
    join public.member_cases c on c.id = o.case_id and c.learning_undone_at is null
    where c.organization_id = org
      and c.status = 'resolved'
      and o.outcome in ('upheld', 'settled')
      and o.recorded_at >= window_start
    group by 1
  ), actions as (
    select pg_catalog.date_trunc('month', p.joined_at at time zone 'America/New_York') as month,
      pg_catalog.count(*)::integer as value,
      pg_catalog.count(distinct p.user_id)::integer as people
    from public.digital_action_participants p
    where p.organization_id = org
      and p.joined_at >= window_start
    group by 1
  )
  select
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'month', pg_catalog.to_char(l.month, 'YYYY-MM'),
      'wins', coalesce(w.value, 0),
      'actions', coalesce(a.value, 0)
    ) order by l.month),
    pg_catalog.bool_and(coalesce(w.people, 0) = 0 or w.people >= privacy_floor),
    pg_catalog.bool_and(coalesce(a.people, 0) = 0 or a.people >= privacy_floor)
  into months, wins_ok, actions_ok
  from month_list l
  left join wins w on w.month = l.month
  left join actions a on a.month = l.month;

  with kinds(outcome, position) as (
    values ('upheld', 1), ('settled', 2), ('withdrawn', 3), ('denied', 4), ('other', 5)
  ), counted as (
    select o.outcome,
      pg_catalog.count(*)::integer as value,
      pg_catalog.count(distinct o.user_id)::integer as people
    from public.member_case_outcomes o
    join public.member_cases c on c.id = o.case_id and c.learning_undone_at is null
    where c.organization_id = org
      and c.status = 'resolved'
      and o.recorded_at >= window_start
    group by o.outcome
  )
  select
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('outcome', k.outcome, 'count', coalesce(n.value, 0)) order by k.position),
    pg_catalog.bool_and(coalesce(n.people, 0) = 0 or n.people >= privacy_floor)
  into outcomes, outcomes_ok
  from kinds k
  left join counted n on n.outcome = k.outcome;

  with chapter_rows as (
    select ch.id, ch.name, ch.order_index,
      (select pg_catalog.count(distinct cm.user_id)::integer
         from public.member_chapter_memberships cm
        where cm.chapter_id = ch.id and cm.status = 'active') as members,
      (select pg_catalog.count(*)::integer from public.member_cases c
        where c.organization_id = org and c.chapter_id = ch.id and c.status = 'active' and c.learning_undone_at is null) as open_cases,
      (select pg_catalog.count(distinct c.user_id)::integer from public.member_cases c
        where c.organization_id = org and c.chapter_id = ch.id and c.status = 'active' and c.learning_undone_at is null) as open_people
    from public.chapters ch
    where ch.organization_id = org
  )
  select
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'members', case when r.members >= privacy_floor then r.members else null end,
      'openCases', r.open_cases
    ) order by r.order_index, r.name, r.id),
    coalesce(pg_catalog.bool_and(r.open_people = 0 or r.open_people >= privacy_floor), true)
  into chapters, open_ok
  from chapter_rows r;

  -- A withheld column leaves the chapter rows without it.
  chapters := coalesce((
    select pg_catalog.jsonb_agg(
      case when open_ok then row.value else row.value - 'openCases' end
      order by row.ordinality)
    from pg_catalog.jsonb_array_elements(coalesce(chapters, '[]'::jsonb)) with ordinality as row(value, ordinality)
  ), '[]'::jsonb);

  return pg_catalog.jsonb_build_object(
    'available', true,
    'generatedAt', generated,
    'privacyFloor', privacy_floor,
    'windowStart', pg_catalog.to_char(first_month, 'YYYY-MM'),
    'wins', case when wins_ok
      then pg_catalog.jsonb_build_object('withheld', false, 'months', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('month', m.value ->> 'month', 'count', (m.value ->> 'wins')::integer)) from pg_catalog.jsonb_array_elements(months) m))
      else pg_catalog.jsonb_build_object('withheld', true) end,
    'actions', case when actions_ok
      then pg_catalog.jsonb_build_object('withheld', false, 'months', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('month', m.value ->> 'month', 'count', (m.value ->> 'actions')::integer)) from pg_catalog.jsonb_array_elements(months) m))
      else pg_catalog.jsonb_build_object('withheld', true) end,
    'outcomes', case when outcomes_ok
      then pg_catalog.jsonb_build_object('withheld', false, 'rows', outcomes)
      else pg_catalog.jsonb_build_object('withheld', true) end,
    'chapters', pg_catalog.jsonb_build_object(
      'rows', chapters,
      'openCasesWithheld', not open_ok
    )
  );
end;
$function$;

create or replace function private.workload_rebalancing(p_chapter text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with chapter_scope as materialized (
    select c.organization_id
    from public.chapters c
    where c.id = p_chapter
  ), steward_roster as materialized (
    select distinct p.id as steward_id, p.full_name
    from public.member_profiles p
    cross join chapter_scope
    where p.chapter_id = p_chapter
      and (
        (
          chapter_scope.organization_id is not null
          and private.organization_member_roles(
            p.id,
            chapter_scope.organization_id,
            p_chapter
          ) ? 'steward'
        )
        or (
          chapter_scope.organization_id is null
          and exists (
            select 1
            from public.member_roles legacy_role
            where legacy_role.user_id = p.id
              and legacy_role.role = 'steward'
              and (legacy_role.chapter_id is null or legacy_role.chapter_id = p_chapter)
          )
        )
      )
    order by p.full_name, p.id
    limit 50
  ), counts as (
    select s.steward_id, s.full_name,
      pg_catalog.count(c.id)::integer as active,
      pg_catalog.count(c.id) filter (
        where c.deadline between current_date and current_date + 6)::integer as due_soon,
      pg_catalog.count(c.id) filter (where c.deadline < current_date)::integer as overdue
    from steward_roster s
    left join public.member_cases c on c.steward_user_id = s.steward_id
      and c.status = 'active' and c.learning_undone_at is null
      and not private.organization_is_platform(c.organization_id)
      and exists (
        select 1 from public.member_profiles owner
        where owner.id = c.user_id and owner.chapter_id = p_chapter)
    group by s.steward_id, s.full_name
  ), mean as (
    select coalesce(pg_catalog.avg(active), 0) as avg_active from counts
  ), ranked_high as (
    select c.*, pg_catalog.row_number() over (order by active desc, overdue desc, steward_id) as rn
    from counts c, mean m where c.active >= pg_catalog.ceil(m.avg_active)::integer + 2
  ), ranked_low as (
    select c.*, pg_catalog.row_number() over (order by active asc, overdue asc, steward_id) as rn
    from counts c, mean m where c.active <= greatest(pg_catalog.floor(m.avg_active)::integer - 1, 0)
  ), suggestions as (
    select h.steward_id as from_id, h.full_name as from_name,
      l.steward_id as to_id, l.full_name as to_name,
      least(greatest((h.active - l.active) / 2, 1), 10)::integer as review_count,
      h.active as from_active, l.active as to_active
    from ranked_high h join ranked_low l using (rn)
    where h.steward_id <> l.steward_id
    order by h.active desc, l.active asc, h.steward_id, l.steward_id
    limit 10
  )
  select pg_catalog.jsonb_build_object(
    'stewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', c.steward_id, 'name', c.full_name, 'activeCases', c.active,
      'dueSoon', c.due_soon, 'overdue', c.overdue) order by c.full_name, c.steward_id) from counts c), '[]'::jsonb),
    'suggestions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fromUserId', s.from_id, 'fromName', s.from_name,
      'toUserId', s.to_id, 'toName', s.to_name,
      'reviewCount', s.review_count, 'fromActiveCases', s.from_active,
      'toActiveCases', s.to_active) order by s.from_active desc, s.from_id) from suggestions s), '[]'::jsonb)
  );
$function$;

create or replace function private.cr108_candidate_sources(
  p_organization_id uuid,
  p_definition_id uuid,
  p_trigger_kind text,
  p_threshold_days integer,
  p_limit integer
)
returns table(source_kind text, source_id uuid, chapter_id text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit not between 1 and 50 then
    raise exception 'automation effect limit out of range' using errcode = '22023';
  end if;
  case p_trigger_kind
    when 'overdue_task' then
      return query
      select 'task'::text, t.id, t.chapter_id
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= current_date - p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id::text
            and e.status in ('pending', 'created')
        )
      order by t.due_date, t.created_at, t.id
      limit p_limit;
    when 'case_deadline' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id and c.learning_undone_at is null
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= current_date + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        )
      order by c.deadline, c.created_at, c.id
      limit p_limit;
    when 'unassigned_case' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id and c.learning_undone_at is null
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        )
      order by c.created_at, c.id
      limit p_limit;
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
end;
$function$;

create or replace function private.automation_recipe_source_in_scope(p_org uuid, p_kind text, p_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_org is not null and case p_kind
    when 'task' then exists (
      select 1 from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id and ch.organization_id = p_org
      where t.id::text = p_id and t.deleted_at is null)
    when 'case' then exists (
      select 1 from public.member_cases c
      join public.chapters ch on ch.id = c.chapter_id and ch.organization_id = p_org
      where c.id::text = p_id and c.organization_id = p_org and not c.is_restricted and c.learning_undone_at is null)
    when 'casework_deadline' then exists (
      select 1 from public.casework_deadlines x
      join public.member_cases c on c.id = x.case_id and c.organization_id = x.organization_id and c.learning_undone_at is null
      where x.id::text = p_id and x.organization_id = p_org and not c.is_restricted)
    when 'checklist' then exists (
      select 1 from public.casework_checklists x
      join public.member_cases c on c.id = x.case_id and c.organization_id = x.organization_id and c.learning_undone_at is null
      where x.id::text = p_id and x.organization_id = p_org and not c.is_restricted)
    else false
  end;
$function$;

create or replace function private.issue_intelligence_family_signal(
  p_organization_id uuid,
  p_family text,
  p_as_of timestamptz default pg_catalog.now(),
  p_window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  window_end timestamptz := coalesce(p_as_of, pg_catalog.now());
  window_days integer := coalesce(p_window_days, 30);
  window_start timestamptz;
  prior_start timestamptz;
  retaliation boolean;
  qa_count integer := 0; qa_prior integer := 0;
  message_count integer := 0; message_senders integer := 0; message_prior integer := 0;
  case_count integer := 0; case_prior integer := 0;
  poll_count integer := 0; poll_prior integer := 0;
  report_count integer := 0; report_prior integer := 0;
  checklist_count integer := 0; checklist_prior integer := 0;
  reviewed_theme boolean := false;
  people_by_evidence jsonb := '{}'::jsonb;
  families text[] := array[]::text[];
  direct boolean := false;
  contributors integer := 0;
  confidence text := null;
  active boolean := false;
  current_total integer;
  prior_total integer;
  trend text;
begin
  if p_organization_id is null or p_family not in ('contract_rights_confusion', 'retaliation_protected_activity_pressure') then
    raise exception 'invalid issue intelligence family' using errcode = '22023';
  end if;
  if window_days not between 1 and 90 then
    raise exception 'invalid issue intelligence window' using errcode = '22023';
  end if;
  -- The old engine looked back 30 days (load-evidence.ts:7); the old weekly
  -- digest used the completed week. Trend compares the same-length window
  -- immediately before.
  window_start := window_end - pg_catalog.make_interval(days => window_days);
  prior_start := window_end - pg_catalog.make_interval(days => window_days * 2);
  retaliation := p_family = 'retaliation_protected_activity_pressure';

  -- Every evidence row is (evidence, person, occurred_at) inside this tenant,
  -- over the current and the prior window (for the trend).
  with evidence(evidence, person, occurred_at) as (
    -- Q&A: the organization's own forum questions (titles and bodies are
    -- already readable by every member of the organization).
    select 'qa', q.author_user_id, q.created_at
    from public.member_qa_questions q
    where q.organization_id = p_organization_id
      and q.deleted_at is null
      and q.created_at >= prior_start and q.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(q.title || ' ' || q.body)
        else private.issue_signal_contract_rights_text(q.title || ' ' || q.body) end
    union all
    -- Messages: inbound member messages and their conversation title, stamped
    -- with the conversation's organization when it was created. Redacted
    -- rows have no text and are skipped.
    select 'messages', m.user_id, m.created_at
    from public.member_messages m
    join public.member_conversations c on c.id = m.conversation_id
      and c.organization_id = p_organization_id
    join public.organization_memberships om
      on om.organization_id = p_organization_id and om.user_id = c.user_id and om.status = 'active'
    where m.sender_kind = 'member'
      and m.redacted_at is null
      and m.created_at >= prior_start and m.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(c.title || ' ' || m.body)
        else private.issue_signal_contract_rights_text(c.title || ' ' || m.body) end
    union all
    -- Cases: category and cited contract articles only; never titles or
    -- narratives; restricted cases never count.
    select 'cases', mc.user_id, mc.created_at
    from public.member_cases mc
    where mc.organization_id = p_organization_id
      and not mc.is_restricted and mc.learning_undone_at is null
      and mc.created_at >= prior_start and mc.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(mc.case_type)
        else private.issue_signal_contract_rights_text(mc.case_type)
          or pg_catalog.btrim(coalesce(mc.articles, '')) <> '' end
    union all
    -- Polls (contract rights): member weekly-question submissions ...
    select 'polls', w.user_id, w.created_at
    from public.member_weekly_questions w
    join public.chapters ch on ch.id = w.chapter_id and ch.organization_id = p_organization_id
    where not retaliation
      and w.created_at >= prior_start and w.created_at <= window_end
      and private.issue_signal_contract_rights_text(w.body)
    union all
    -- ... and contextual pulse responses to a staff-written contract prompt.
    select 'polls', e.user_id, e.responded_at
    from public.organization_pulse_events e
    join public.organization_pulse_prompts pr on pr.id = e.prompt_id and pr.organization_id = p_organization_id
    where not retaliation
      and e.organization_id = p_organization_id
      and e.state = 'responded'
      and e.responded_at >= prior_start and e.responded_at <= window_end
      and private.issue_signal_contract_rights_text(pr.question)
    union all
    -- Retaliation reports (old retaliation_flags): submitted, not withdrawn.
    select 'retaliation_reports', r.reporter_user_id, r.created_at
    from public.casework_retaliation_reports r
    where retaliation
      and r.organization_id = p_organization_id
      and r.status <> 'withdrawn'
      and r.created_at >= prior_start and r.created_at <= window_end
    union all
    -- Know-your-rights emergency checklists (old kyr family) for discipline
    -- scenarios, the current equivalent of the old harassment checklist.
    select 'kyr', k.member_user_id, k.updated_at
    from public.member_emergency_checklists k
    where retaliation
      and k.organization_id = p_organization_id
      and k.scenario in ('disciplinary_meeting', 'pre_discipline_response')
      and k.updated_at >= prior_start and k.updated_at <= window_end
  )
  select
    pg_catalog.count(*) filter (where e.evidence = 'qa' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'qa' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'messages' and e.occurred_at >= window_start),
    pg_catalog.count(distinct e.person) filter (where e.evidence = 'messages' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'messages' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'cases' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'cases' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'polls' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'polls' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'retaliation_reports' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'retaliation_reports' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'kyr' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'kyr' and e.occurred_at < window_start),
    -- People per evidence family in the current window, used only to apply
    -- the privacy floor below; never returned to any caller.
    pg_catalog.jsonb_build_object(
      'qa', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'qa' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'messages', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'messages' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'cases', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'cases' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'polls', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'polls' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'retaliation_reports', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'retaliation_reports' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'kyr', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'kyr' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb)
    )
  into qa_count, qa_prior, message_count, message_senders, message_prior, case_count, case_prior,
    poll_count, poll_prior, report_count, report_prior, checklist_count, checklist_prior, people_by_evidence
  from evidence e;

  -- Reviewed issue themes: the organization's own frozen, privacy-banded
  -- connection aggregates from roughly the last two quarters. They carry no
  -- people and never count toward the privacy floor.
  select exists (
    select 1
    from private.chapter_connection_issue_aggregates a
    join private.chapter_connection_aggregate_runs run
      on run.chapter_id = a.chapter_id and run.period_key = a.period_key
    where run.organization_id = p_organization_id
      and run.period_ends_at >= window_end - interval '200 days'
      and run.period_ends_at <= window_end
      and a.band in ('many', 'most')
      and a.topic_key = any (case when retaliation
        then array['discrimination']
        else array['contract-enforcement', 'discipline'] end)
  ) into reviewed_theme;

  if retaliation then
    if report_count >= 1 then families := families || 'retaliation_reports'::text; direct := true; end if;
    if checklist_count >= 1 then families := families || 'kyr'::text; direct := true; end if;
    if message_count >= 2 and message_senders >= 1 then families := families || 'messages'::text; end if;
    if case_count >= 1 then families := families || 'cases'::text; end if;
    if qa_count >= 1 then families := families || 'qa'::text; end if;
    if reviewed_theme then families := families || 'reviewed_themes'::text; end if;
    active := direct and pg_catalog.cardinality(families) >= 2;
  else
    if qa_count >= 2 then families := families || 'qa'::text; end if;
    if message_count >= 3 and message_senders >= 2 then families := families || 'messages'::text; end if;
    if case_count >= 1 then families := families || 'cases'::text; end if;
    if poll_count >= 1 then families := families || 'polls'::text; end if;
    if reviewed_theme then families := families || 'reviewed_themes'::text; end if;
    active := pg_catalog.cardinality(families) >= 2;
  end if;

  if active then
    confidence := case
      when pg_catalog.cardinality(families) >= 4 then 'strong'
      when pg_catalog.cardinality(families) >= 3 then 'active'
      else 'emerging' end;
  end if;

  -- Distinct people behind the evidence families that made this one active.
  select pg_catalog.count(distinct person.value)
  into contributors
  from pg_catalog.jsonb_each(people_by_evidence) by_family
  cross join lateral pg_catalog.jsonb_array_elements_text(by_family.value) person
  where by_family.key = any (families);

  current_total := qa_count + message_count + case_count + poll_count + report_count + checklist_count;
  prior_total := qa_prior + message_prior + case_prior + poll_prior + report_prior + checklist_prior;
  trend := case
    when current_total >= prior_total + 2 and current_total * 4 >= prior_total * 5 then 'rising'
    when prior_total >= current_total + 2 and current_total * 4 <= prior_total * 3 then 'declining'
    else 'stable' end;

  return pg_catalog.jsonb_build_object(
    'family', p_family,
    'threadKey', case when retaliation then 'retaliation-protected-activity-pressure' else 'contract-rights-confusion' end,
    'active', active,
    'confidence', confidence,
    'evidenceFamilies', pg_catalog.to_jsonb(families),
    'trend', trend,
    'contributors', contributors,
    'windowStart', window_start,
    'windowEnd', window_end,
    'windowDays', window_days,
    'evidence', pg_catalog.jsonb_build_object(
      'qa', qa_count, 'messages', message_count, 'messageSenders', message_senders,
      'cases', case_count, 'polls', poll_count, 'retaliationReports', report_count,
      'kyr', checklist_count, 'reviewedThemes', reviewed_theme
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.search_member_cases(p_query text, p_limit integer DEFAULT 20)
 RETURNS TABLE(case_id uuid, reference text, title text, case_type text, articles text, step text, status text, deadline date, updated_at timestamp with time zone, rank real, headline text, headline_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
begin
  perform private.member_pin_require_full_session();

declare
  v_query tsquery := pg_catalog.websearch_to_tsquery(
    'pg_catalog.english'::pg_catalog.regconfig, coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_actor uuid := (select auth.uid());
begin
  -- An anonymous caller and an empty or stop-word-only query are the same
  -- answer: nothing. Returning early keeps both off the indexes entirely.
  -- Both tests read the request's JWT and the argument, never the database, so
  -- deciding them before the statement below costs the boundary nothing.
  if v_actor is null or pg_catalog.numnode(v_query) = 0 then
    return;
  end if;

  return query
  -- Everything that depends only on the caller, resolved exactly once, in this
  -- statement's snapshot — the same snapshot the row reads below use, which is
  -- what RLS gives the policies. MATERIALIZED is load-bearing: a single-row CTE
  -- referenced once would be inlined and these helpers would run per row again.
  with actor_scope as materialized (
    select
      exists(select 1 from private.chapter_role_scopes s where s.user_id=v_actor) as has_scoped_grants,
      array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=private.current_member_organization()
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(v_actor))
          and (private.has_organization_role(ch.organization_id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships actor on actor.chapter_id=r.chapter_id and actor.user_id=r.user_id and actor.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=v_actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      ) as default_steward_chapters,
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  -- The candidate list is what makes the two GIN indexes load-bearing, and it
  -- is not a micro-optimisation. `<case document> @@ v_query OR note.body is
  -- not null` sits above a LEFT JOIN LATERAL, so the planner cannot push the
  -- case-side predicate into the scan: driving straight off public.member_cases
  -- reads EVERY row of a table this deployment sizes at ~400k and runs the
  -- lateral once per row. Selecting the candidate ids through the indexes first
  -- and joining back on the primary key returns the same set: the union is a
  -- superset of the final predicate, and every row it adds is re-tested below.
  --
  -- The two expressions in this CTE are the two index expressions verbatim,
  -- down to the argument order and the weight letters, because an expression
  -- index only serves a query whose expression matches it. Changing one without
  -- the other silently returns this statement to a sequential scan;
  -- tests/member-case-search-db.test.js pins the equality and EXPLAINs the
  -- statement cut out of this file.
  --
  -- Which arm matched is carried forward instead of recomputed: `case_hit` IS
  -- `<case document> @@ v_query` for that row, so the WHERE clause below needs
  -- no second evaluation of a four-call tsvector expression, and `note_hit` is
  -- false exactly when no note on the case can match, which turns the note
  -- lateral into a one-time filter for those rows.
  candidate_hits as (
    select c.id as candidate_id, true as case_hit, false as note_hit
    from public.member_cases c
    where c.learning_undone_at is null and (
      pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C')
    ) @@ v_query
    union all
    select u.case_id as candidate_id, false as case_hit, true as note_hit
    from public.member_case_updates u
    where u.learning_undone_at is null and (
      pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, ''))
    ) @@ v_query
  ),
  candidates as (
    select
      candidate_id,
      pg_catalog.bool_or(case_hit) as case_hit,
      pg_catalog.bool_or(note_hit) as note_hit
    from candidate_hits
    group by candidate_id
  ),
  -- member_cases_select_coordinator, as a set. No function call per row: the
  -- staff scope is the chapter array resolved once above, the organization
  -- officer test is a column comparison against the one organization
  -- private.has_organization_role can accept, and the access grant is an array
  -- membership test. A caller with no coordinator scope produces this set
  -- without reading public.member_profiles at all.
  --
  -- Every actor_scope value below is read through a scalar subquery rather
  -- than a join to the CTE, here and in the `visible` CTE and the note
  -- lateral. That is deliberate and load-bearing: an uncorrelated scalar
  -- subquery becomes an InitPlan the executor runs once, so each scope value
  -- reaches the row predicates as a constant. Joining actor_scope in instead
  -- makes those values ordinary columns, and the planner is then free to drive
  -- this join from public.member_profiles and re-derive the whole set per outer
  -- row: measured at 48,006 primary-key lookups over an 8,001-candidate
  -- corpus, and unbounded on a deployment where the caller's chapter scope
  -- holds thousands of members. The same rewrite turned the note lateral's
  -- author lookup from a rescan of public.member_profiles per note into one
  -- hashed probe for the statement.
  --
  -- `offset 0` is the optimisation fence explained above the same construct in
  -- the `visible` CTE below: it keeps the candidate list the driving relation
  -- so this CTE reads one case row per candidate and never scans the table.
  staff_visible as (
    select k.candidate_id
    from candidates k
    cross join lateral (
      select row_case.user_id, row_case.is_restricted, row_case.coordinator_user_id,
             row_case.organization_id, row_case.id
      from public.member_cases row_case
      where row_case.id = k.candidate_id and row_case.learning_undone_at is null
      offset 0
    ) c
    join public.member_profiles case_owner on case_owner.id = c.user_id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted
        or c.coordinator_user_id = v_actor
        or (
          c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s)
        )
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ),
  -- The mirror itself: mfa_assurance ANDed over the three permissive SELECT
  -- policies, the first two as column tests and the third as a semijoin.
  visible as (
    select
      k.case_hit,
      k.note_hit,
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      c.user_id,
      c.steward_user_id
    from candidates k
    cross join lateral (
      select
        row_case as authorization_case,
        row_case.is_restricted, row_case.organization_id, row_case.chapter_id,
        row_case.id,
        row_case.reference,
        row_case.title,
        row_case.case_type,
        row_case.articles,
        row_case.step,
        row_case.status,
        row_case.deadline,
        row_case.updated_at,
        row_case.user_id,
        row_case.steward_user_id
      from public.member_cases row_case
      where row_case.id = k.candidate_id and row_case.learning_undone_at is null
      -- `offset 0` is the standard PostgreSQL optimisation fence, and it is
      -- load-bearing rather than decorative. Without it the planner flattens
      -- this LATERAL back into an ordinary join, and because a GIN @@
      -- selectivity estimate over a CTE defaults to 200 rows it then prices a
      -- sequential scan of the whole case table plus a hash join below this
      -- primary-key lookup: measured at 79,999 rows removed by filter for a
      -- query with ONE candidate. The fence keeps the candidate list the
      -- driving relation, so the work is one primary-key probe per candidate
      -- and nothing in this function ever reads a case row the two GIN indexes
      -- did not name.
      offset 0
    ) c
    -- Preserve the established set-wise mirror for unscoped, unmarked cases.
    -- Scoped grants and private identities use the full shared row oracle;
    -- the CASE prevents expensive per-case role queries on the ordinary path.
    where (select s.mfa_satisfied from actor_scope s)
      and case when (select s.has_scoped_grants from actor_scope s)
        or exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=c.id)
      then private.chapter_case_readable(c.authorization_case)
      else (
        c.user_id=v_actor
        or (c.steward_user_id=v_actor and (select s.steward_hat from actor_scope s))
        or c.id in (select candidate_id from staff_visible)
        or (not c.is_restricted and c.chapter_id=any((select s.default_steward_chapters from actor_scope s)::text[])
          and exists(select 1 from public.member_chapter_memberships member
            join public.organization_memberships om on om.user_id=member.user_id and om.organization_id=private.current_member_organization() and om.status='active'
            where member.user_id=c.user_id and member.chapter_id=c.chapter_id and member.status='active'))
      ) end
  ),
  scored as (
    select
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      note.body as note_body,
      pg_catalog.ts_rank(
        pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C'),
        v_query)
        + coalesce(note.note_rank, 0) * 0.5 as rank_value
    from visible c
    left join lateral (
      select
        n.body,
        pg_catalog.ts_rank(n.note_document, v_query) as note_rank
      from (
        select
          u.body,
          u.user_id,
          u.created_at,
          u.id,
          pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, '')) as note_document
        from public.member_case_updates u
        where c.note_hit
          and u.case_id = c.id and u.learning_undone_at is null
      ) n
      where n.note_document @@ v_query
        -- The visible parent supplies the same authorization as the scoped-parent notes policy.

      order by note_rank desc, n.created_at desc, n.id
      limit 1
    ) note on true
    -- `case_hit` is the case-document match the candidate CTE already made.
    where c.case_hit or note.body is not null
  ),
  -- Rank and cut FIRST, then build the snippets. ts_headline is by far the most
  -- expensive expression in this function and a projection is evaluated before
  -- the sort, so leaving it in `scored` would have built one snippet per
  -- visible candidate instead of at most p_limit of them.
  ranked as (
    select r.*
    from scored r
    order by r.rank_value desc, r.updated_at desc, r.id
    limit v_limit
  )
  select
    r.id,
    r.reference,
    r.title,
    r.case_type,
    r.articles,
    r.step,
    r.status,
    r.deadline,
    r.updated_at,
    r.rank_value::real,
    pg_catalog.ts_headline(
      'pg_catalog.english'::pg_catalog.regconfig,
      case
        when r.note_body is not null then r.note_body
        when coalesce(r.articles, '') <> '' then r.articles
        else r.title
      end,
      v_query,
      'StartSel="[[",StopSel="]]",MaxFragments=1,MaxWords=28,MinWords=8,ShortWord=2'),
    case
      when r.note_body is not null then 'update'
      when coalesce(r.articles, '') <> '' then 'articles'
      else 'title'
    end
  from ranked r
  order by r.rank_value desc, r.updated_at desc, r.id;
end;

end;
$function$
;

create or replace function public.get_compass_case_context(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  include_narrative boolean;
  case_row public.member_cases%rowtype;
  facts jsonb;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if org is null
     or not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.case_help') then
    raise exception 'case help is turned off' using errcode = '55000';
  end if;
  include_narrative := private.organization_feature_enabled(org, 'features.ai_assistant.case_context_includes_narrative');

  select c.* into case_row
  from public.member_cases c
  where c.id = p_case_id
    and c.organization_id = org
    and private.casework_can_read(c.id);
  if case_row.id is null then
    raise exception 'case unavailable' using errcode = 'P0002';
  end if;

  facts := pg_catalog.jsonb_build_object(
    'status', case_row.status,
    'step', case_row.step,
    'openedDaysAgo', greatest(0, (current_date - (case_row.created_at at time zone 'UTC')::date)),
    'lastChangeDaysAgo', greatest(0, (current_date - (case_row.updated_at at time zone 'UTC')::date)),
    'caseDeadlineInDays', case when case_row.deadline is null then null else (case_row.deadline - current_date) end,
    'deadlines', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', deadline.kind, 'status', deadline.status,
        'dueInDays', pg_catalog.floor(extract(epoch from (deadline.due_at - pg_catalog.now())) / 86400.0)::integer
      ) order by deadline.due_at)
      from (
        select d.kind, d.status, d.due_at
        from public.casework_deadlines d
        where d.case_id = case_row.id and d.status = 'active'
        order by d.due_at, d.id
        limit 10
      ) deadline
    ), '[]'::jsonb),
    'timeline', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('type', event.kind, 'daysAgo', event.days_ago) order by event.at)
      from (
        select kind, at, greatest(0, (current_date - (at at time zone 'UTC')::date)) as days_ago
        from (
          select 'step_advanced'::text as kind, t.created_at as at
          from public.casework_step_transitions t where t.case_id = case_row.id
          union all
          select 'case_note'::text, u.created_at from public.member_case_updates u where u.case_id = case_row.id and u.learning_undone_at is null
          union all
          select 'outcome_recorded'::text, o.updated_at from public.member_case_outcomes o where o.case_id = case_row.id
        ) events
        order by at desc
        limit 12
      ) event
    ), '[]'::jsonb)
  );

  if include_narrative then
    facts := facts || pg_catalog.jsonb_build_object(
      'title', case_row.title,
      'notes', coalesce((
        select pg_catalog.jsonb_agg(note.body order by note.created_at)
        from (
          select u.body, u.created_at from public.member_case_updates u
          where u.case_id = case_row.id and u.learning_undone_at is null
          order by u.created_at desc
          limit 3
        ) note
      ), '[]'::jsonb));
  end if;

  return pg_catalog.jsonb_build_object(
    'organization_id', org,
    'includesNarrative', include_narrative,
    'data', facts
  );
end;
end;
$function$;

create or replace function private.chapter_leader_active_since(
  p_user_id uuid,
  p_organization_id uuid,
  p_chapter_id text,
  p_cutoff timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
      select 1 from auth.users u
      where u.id = p_user_id
        and (u.last_sign_in_at > p_cutoff or u.created_at > p_cutoff)
    )
    or exists (
      select 1 from auth.sessions s
      where s.user_id = p_user_id
        and (s.created_at > p_cutoff or s.updated_at > p_cutoff
          or s.refreshed_at > (p_cutoff at time zone 'UTC'))
    )
    or exists (
      select 1 from public.member_presence presence
      where presence.user_id = p_user_id and presence.last_seen_at > p_cutoff
    )
    or exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = p_user_id and rc.chapter_id = p_chapter_id
        and rc.role in ('admin', 'steward') and rc.granted_at > p_cutoff
    )
    or exists (
      select 1 from public.organization_role_grants grant_row
      where grant_row.user_id = p_user_id
        and grant_row.organization_id = p_organization_id
        and grant_row.role in ('admin', 'steward')
        and grant_row.granted_at > p_cutoff
    )
    or exists (
      select 1 from public.member_admin_audit a
      where a.actor = p_user_id and a.created_at > p_cutoff
    )
    or exists (
      select 1 from public.member_case_updates cu
      where cu.author_user_id = p_user_id and cu.created_at > p_cutoff and cu.learning_undone_at is null
    )
    or exists (
      select 1 from public.organization_audit_events e
      where e.organization_id = p_organization_id and e.created_at > p_cutoff
        and e.actor_user_id = p_user_id
    )
    or exists (
      select 1 from public.casework_audit_events e
      where e.organization_id = p_organization_id and e.chapter_id = p_chapter_id
        and e.created_at > p_cutoff and e.actor_user_id = p_user_id
    );
$function$;

-- Case writers journal their change, the graph lock first.
create or replace function public.create_member_case(
  p_title text,
  p_deadline date,
  p_case_type text,
  p_articles text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller         uuid := (select auth.uid());
  clean_title    text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles text := pg_catalog.btrim(coalesce(p_articles, ''));
  ref            text;
  new_case       uuid;
  attempts       integer := 0;
  akey           text;
  awarded        integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Bounds are raised, never truncated. A grievance is a legal document; a
  -- server that quietly clips the member's account of what happened at 200
  -- characters is worse than one that refuses and says why.
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;

  -- Mirrors the six <option value> entries in src/views/CasesView.jsx. The
  -- column has no CHECK, so before this the case_type was free text straight
  -- from the wire and the coordinator/steward case planes grouped on it.
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;

  -- Deadlines drive the member's Today screen and the steward deadline board.
  -- +/- 10 years is generous for a real contractual deadline and still keeps a
  -- fat-fingered year 0202 or 20260 out of every downstream sort.
  if p_deadline is not null
     and (p_deadline < current_date - 3650 or p_deadline > current_date + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- Bounded retry rather than a uniqueness pre-check: the check-then-insert
  -- race is exactly the duplicate this migration exists to remove. 5 attempts
  -- over a 100000-value space is astronomically more than enough; exhausting
  -- it means something is badly wrong and the caller gets a clean error rather
  -- than a hung loop.
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (user_id, reference, title, deadline, case_type, articles, step)
      values (caller, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake')
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  akey := 'case-' || ref;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'case')
  on conflict (user_id, action_key) do nothing;

  -- 'case' is capped at 3/week; read the real award, not the rule.
  select e.points into awarded
  from public.member_point_events e
  where e.user_id = caller and e.action_key = akey;

  perform private.learning_case_journal('case_create', new_case, null);
  return pg_catalog.jsonb_build_object(
    'caseId', new_case,
    'reference', ref,
    'awardedPoints', coalesce(awarded, 0));
end;
end;
$$;

create or replace function public.open_member_case(
  p_member_id uuid,
  p_title text,
  p_case_type text,
  p_articles text,
  p_deadline date,
  p_description text,
  p_incident_date date,
  p_remedy_sought text,
  p_filing_status text,
  p_assign_self boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid;
  clean_title text;
  clean_articles text;
  clean_description text;
  clean_remedy text;
  steward_scope boolean;
  assign boolean;
  steward_label text;
  actor_label text;
  created jsonb;
  ref text;
  new_case uuid;
  attempts integer;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  clean_description := nullif(pg_catalog.btrim(coalesce(p_description, '')), '');
  clean_remedy := nullif(pg_catalog.btrim(coalesce(p_remedy_sought, '')), '');
  -- Bounds are raised, never clipped, as in public.create_member_case.
  if pg_catalog.char_length(clean_description) > 10000 then
    raise exception 'case description too long (10000 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_remedy) > 2000 then
    raise exception 'remedy sought too long (2000 characters max)' using errcode = '22023';
  end if;
  if p_filing_status is not null and p_filing_status not in ('informal', 'filed') then
    raise exception 'invalid filing status' using errcode = '22023';
  end if;
  if p_incident_date is not null
     and (p_incident_date < current_date - 3650 or p_incident_date > current_date + 1) then
    raise exception 'incident date out of range' using errcode = '22023';
  end if;

  -- The member's own intake keeps every rule, reference and award of
  -- public.create_member_case and adds the details to that same row.
  if p_member_id is null or p_member_id = caller then
    created := public.create_member_case(p_title, p_deadline, p_case_type, p_articles);
    update public.member_cases set
      description = clean_description,
      incident_date = p_incident_date,
      remedy_sought = clean_remedy,
      filing_status = p_filing_status
    where id = (created->>'caseId')::uuid and user_id = caller;
    -- The details are a later step on the case create_member_case journalled,
    -- so undoing the case undoes both, newest first.
    perform private.learning_case_journal('case_edit', (created->>'caseId')::uuid, null);
    return created || pg_catalog.jsonb_build_object('assigned', false);
  end if;

  -- A case opened for another member: staff in the member's scope only.
  if not public.member_has_role(array['steward', 'coordinator', 'admin']) then
    raise exception 'steward, coordinator or admin role required' using errcode = '42501';
  end if;
  steward_scope := private.chapter_case_intake_role_allows(p_member_id, 'steward');
  if not (steward_scope
          or private.chapter_case_intake_role_allows(p_member_id, 'coordinator')
          or private.chapter_case_intake_role_allows(p_member_id, 'admin')) then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  clean_title := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles := pg_catalog.btrim(coalesce(p_articles, ''));
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;
  if p_deadline is not null
     and (p_deadline < current_date - 3650 or p_deadline > current_date + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- A steward who opens the case is its steward, so it is on their caseload.
  assign := coalesce(p_assign_self, true) and steward_scope;
  if assign then
    select p.full_name into steward_label from public.member_profiles p where p.id = caller;
  end if;

  attempts := 0;
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(pg_catalog.now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (
        user_id, reference, title, deadline, case_type, articles, step,
        description, incident_date, remedy_sought, filing_status,
        steward_user_id, steward_name, assigned_at)
      values (
        p_member_id, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake',
        clean_description, p_incident_date, clean_remedy, p_filing_status,
        case when assign then caller end,
        case when assign then coalesce(steward_label, 'Steward') end,
        case when assign then pg_catalog.now() end)
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  if assign then
    actor_label := coalesce(steward_label, 'Staff member');
    insert into public.member_case_assignment_audit
      (case_id, actor_id, actor_name, before_assignment, after_assignment)
    values (new_case, caller, actor_label,
      pg_catalog.jsonb_build_object('stewardUserId', null, 'stewardName', null,
        'coordinatorUserId', null, 'coordinatorName', null),
      pg_catalog.jsonb_build_object('stewardUserId', caller, 'stewardName', coalesce(steward_label, 'Steward'),
        'coordinatorUserId', null, 'coordinatorName', null));
  end if;

  perform private.learning_case_journal('case_create', new_case, null);
  return pg_catalog.jsonb_build_object('caseId', new_case, 'reference', ref, 'assigned', assign);
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_form_as_case(p_form_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  rec record;
  new_case uuid;
  ref text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, f.answers, f.case_id, coalesce(p.language, 'en') as lang into rec
    from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  -- Not-found, the caller's own form, member-private states (draft/returned
  -- are never steward-visible), and out-of-chapter-scope targets all collapse
  -- to one generic error so a steward holding a guessed form UUID cannot use
  -- the status-specific raises below as an existence oracle for another
  -- member's in-progress filing.
  if not found or rec.user_id = caller or rec.status in ('draft', 'returned')
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found or your own' using errcode = '22023';
  end if;
  if rec.status <> 'approved' then
    raise exception 'only approved forms can be opened as cases' using errcode = '22023';
  end if;
  if rec.template_key not in ('grievance', 'alliance_grievance') then
    raise exception 'only grievance forms can be opened as cases' using errcode = '22023';
  end if;
  if rec.case_id is not null then
    raise exception 'this form already has a case' using errcode = '22023';
  end if;

  -- server-generated reference (pre-mortem #3): the form id is member-visible,
  -- so a member could pre-insert its derived reference and permanently block
  -- this call. A fresh uuid is unknowable to the member; 8 hex chars kill the
  -- intra-user birthday collision. The case_id-null guard makes this
  -- single-shot, and any residual unique_violation surfaces as a clean error
  -- rather than a duplicate case. No action-log write here: steward actions
  -- never mint member points.
  new_case := extensions.gen_random_uuid();
  ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-F' || pg_catalog.substr(pg_catalog.replace(new_case::text, '-', ''), 1, 8);
  begin
    insert into public.member_cases (id, user_id, reference, title, case_type, articles, step)
    values (
      new_case,
      rec.user_id,
      ref,
      coalesce(nullif(pg_catalog.btrim(pg_catalog.left(coalesce(rec.answers->>'summary', ''), 200)), ''), 'Grievance from submitted form'),
      'Grievance',
      pg_catalog.btrim(pg_catalog.left(coalesce(rec.answers->>'articles', ''), 200)),
      'Intake')
    returning id into new_case;
  exception when unique_violation then
    raise exception 'a case with this reference already exists for the member' using errcode = '23505';
  end;

  update public.member_forms set case_id = new_case, updated_at = now() where id = p_form_id and private.member_form_case_readable(p_form_id);

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Caso de queja abierto',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — tu delegado abrió el caso ' || ref || ' a partir de tu formulario aprobado. Síguelo en Casos.', 'cases');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Grievance case opened',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — your steward opened case ' || ref || ' from your approved form. Track it under Cases.', 'cases');
  end if;

  perform private.learning_case_journal('case_create', new_case, null);
  return new_case;
end;
end;
end;
$function$;

create or replace function public.coordinator_update_case(
  p_case_id uuid, p_status text, p_step text, p_deadline date, p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare old_case public.member_cases%rowtype; changed public.member_cases%rowtype; clean_reason text := btrim(coalesce(p_reason,''));
begin
  old_case := private.coordinator_case_for_update(p_case_id);
  if p_status not in ('active','resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  if p_step is not null and p_step is distinct from old_case.step then raise exception 'step changes go through the procedure transition' using errcode = '22023'; end if;
  if char_length(clean_reason) not between 1 and 1000 then raise exception 'reason must be 1-1000 characters' using errcode = '22023'; end if;
  if old_case.deadline is not null and (p_deadline is null or p_deadline < old_case.deadline) then
    raise exception 'deadline may only be extended' using errcode = '22023';
  end if;
  update public.member_cases set status=p_status, deadline=p_deadline where id=old_case.id returning * into changed;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value,reason)
  values (old_case.id,old_case.user_id,(select auth.uid()),'case_updated',
    jsonb_build_object('status',old_case.status,'step',old_case.step,'deadline',old_case.deadline),
    jsonb_build_object('status',changed.status,'step',changed.step,'deadline',changed.deadline),clean_reason);
  perform private.learning_case_journal('case_edit', changed.id, null);
  return jsonb_build_object('id',changed.id,'status',changed.status,'step',changed.step,'deadline',changed.deadline);
end;
end;
$$;

create or replace function public.casework_rename_case(
  p_case_id uuid,
  p_title text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  v_case public.member_cases%rowtype;
  v_title text;
begin
  -- Case graph gate first: this routine updates public.member_cases and writes
  -- public.casework_audit_events.
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  v_title := pg_catalog.btrim(coalesce(p_title, ''));
  if pg_catalog.char_length(v_title) not between 1 and 200 or v_title ~ '[[:cntrl:]]' then
    raise exception 'case title must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('clearer_title', 'member_request', 'correct_error', 'other') then
    raise exception 'unknown rename reason' using errcode = '22023';
  end if;
  select * into v_case from public.member_cases where id = p_case_id for update;
  if not found or not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  if v_case.title is distinct from v_title then
    update public.member_cases set title = v_title where id = v_case.id;
    perform private.learning_case_journal('case_edit', v_case.id, null);
    insert into public.casework_audit_events(
      organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (
      v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
      'case_renamed', 'case', v_case.id,
      pg_catalog.jsonb_build_object(
        'reason', p_reason,
        'titleLength', pg_catalog.char_length(v_title),
        'previousTitleLength', pg_catalog.char_length(v_case.title)));
  end if;
  return pg_catalog.jsonb_build_object(
    'caseId', v_case.id, 'title', v_title, 'changed', v_case.title is distinct from v_title);
end;
end;
$function$;

create or replace function public.coordinator_record_case_outcome(p_case_id uuid, p_outcome text, p_summary text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare learning_parent uuid; learning_image jsonb; c public.member_cases%rowtype; prior public.member_case_outcomes%rowtype; saved public.member_case_outcomes%rowtype; clean_summary text := btrim(coalesce(p_summary,''));
begin
  c := private.coordinator_case_for_update(p_case_id);
  if p_outcome not in ('upheld','settled','withdrawn','denied','other') then raise exception 'invalid outcome' using errcode='22023'; end if;
  if char_length(clean_summary) not between 1 and 4000 then raise exception 'summary must be 1-4000 characters' using errcode='22023'; end if;
  select * into prior from public.member_case_outcomes where case_id=c.id;
  insert into public.member_case_outcomes(case_id,user_id,outcome,summary,recorded_by)
  values(c.id,c.user_id,p_outcome,clean_summary,(select auth.uid()))
  on conflict(case_id) do update set outcome=excluded.outcome,summary=excluded.summary,recorded_by=excluded.recorded_by,updated_at=now()
  returning * into saved;
  update public.member_cases set status='resolved' where id=c.id;
  -- One action: the status change is the parent, the outcome its child.
  learning_parent := private.learning_case_journal('case_edit', c.id, null);
  learning_image := case when prior.case_id is null then '{"existed": false}'::jsonb
    else pg_catalog.jsonb_build_object('existed', true, 'outcome', prior.outcome, 'summary', prior.summary, 'recorded_by', prior.recorded_by) end;
  -- The journal bounds a before-image by bytes (16,384); an earlier summary
  -- that does not fit keeps this outcome as recorded rather than block it.
  if pg_catalog.octet_length(learning_image::text) <= 16384 then
    perform private.learning_journal_append('case_outcome', 'public.member_case_outcomes', c.id::text, learning_parent,
      private.learning_fingerprint(private.learning_case_outcome_state(c.id)), null, learning_image);
  else
    perform private.learning_journal_append('case_outcome_kept', 'public.member_case_outcomes', c.id::text, learning_parent);
  end if;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value)
  values(c.id,c.user_id,(select auth.uid()),'outcome_recorded',
    case when prior.case_id is null then null else jsonb_build_object('outcome',prior.outcome,'summary',prior.summary) end,
    jsonb_build_object('outcome',saved.outcome,'summary',saved.summary,'status','resolved'));
  return jsonb_build_object('caseId',saved.case_id,'outcome',saved.outcome,'summary',saved.summary,'recordedAt',saved.recorded_at,'updatedAt',saved.updated_at);
end;
end;
$$;

create or replace function public.casework_bulk_update_cases(
  p_case_ids uuid[],
  p_expected_status text,
  p_next_status text,
  p_next_step text,
  p_idempotency_key uuid
)
returns integer
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare learning_parent uuid; v_count integer; v_org_count integer; v_case record;
begin
  perform private.casework_require_mfa();
  if coalesce(pg_catalog.array_length(p_case_ids, 1), 0) not between 1 and 100 then raise exception 'select 1 to 100 cases' using errcode = '22023'; end if;
  if p_next_status is not null and p_next_status not in ('active','resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  select pg_catalog.count(*), pg_catalog.count(distinct organization_id) into v_count, v_org_count
  from public.member_cases c where c.id = any(p_case_ids) and private.casework_staff_can_access(c.id);
  if v_count <> pg_catalog.array_length(p_case_ids, 1) or v_org_count <> 1 then raise exception 'case selection is not authorized' using errcode = 'P0002'; end if;
  perform 1 from public.member_cases c where c.id = any(p_case_ids) order by c.id for update;
  if exists (select 1 from public.member_cases c where c.id = any(p_case_ids) and c.status <> p_expected_status) then raise exception 'case status changed' using errcode = '40001'; end if;
  update public.member_cases set status = coalesce(p_next_status, status), step = coalesce(nullif(pg_catalog.btrim(p_next_step), ''), step), updated_at = pg_catalog.now() where id = any(p_case_ids);
  for v_case in select id, organization_id, chapter_id from public.member_cases where id = any(p_case_ids) loop
    insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'bulk_updated', 'case', v_case.id, pg_catalog.jsonb_build_object('operationId', p_idempotency_key, 'status', p_next_status, 'step', p_next_step));
  end loop;
  -- One bulk action: a parent entry and one edit per case, undone all or nothing.
  learning_parent := private.learning_journal_append('case_bulk_update', 'public.member_cases',
    'bulk:' || coalesce(p_idempotency_key::text, extensions.gen_random_uuid()::text));
  perform private.learning_case_journal('case_edit', ids.id, learning_parent)
  from pg_catalog.unnest(p_case_ids) as ids(id) order by ids.id;
  return v_count;
end;
end;
$function$;

create or replace function public.coordinator_add_case_note(p_case_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare c public.member_cases%rowtype; clean_body text := btrim(coalesce(p_body,'')); inserted public.member_case_updates%rowtype;
begin
  c := private.coordinator_case_for_update(p_case_id);
  if char_length(clean_body) not between 1 and 4000 then raise exception 'note must be 1-4000 characters' using errcode = '22023'; end if;
  insert into public.member_case_updates(case_id,user_id,body) values(c.id,c.user_id,clean_body) returning * into inserted;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,after_value)
  values(c.id,c.user_id,(select auth.uid()),'note_added',jsonb_build_object('updateId',inserted.id,'body',inserted.body));
  perform private.learning_journal_append('case_note_add', 'public.member_case_updates', inserted.id::text, null,
    private.learning_fingerprint(private.learning_case_note_state(inserted.id)), null, '{}'::jsonb);
  return jsonb_build_object('id',inserted.id,'caseId',inserted.case_id,'body',inserted.body,'createdAt',inserted.created_at);
end;
end;
$$;

create or replace function public.casework_add_case_note(
  p_case_id uuid,
  p_body text,
  p_mention_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  v_case public.member_cases%rowtype;
  v_chapter text;
  v_body text;
  v_mentions uuid[];
  v_mention_count integer;
  v_inserted public.member_case_updates%rowtype;
  v_actor text;
  v_recipient uuid;
begin
  -- Case graph gate first, before any declaration initializer, authorization
  -- read or row acquisition: this routine writes member_case_updates and
  -- member_notifications, both of which sit inside the account/case graph.
  perform private.lock_case_graph(array[(select auth.uid())], array[p_case_id]);
  v_body := pg_catalog.btrim(coalesce(p_body, ''));
  v_case := private.coordinator_case_for_update(p_case_id);
  if pg_catalog.char_length(v_body) not between 1 and 4000 then
    raise exception 'note must be 1-4000 characters' using errcode = '22023';
  end if;

  -- Self-mentions are dropped rather than rejected: a coordinator typing their
  -- own name is not an error, it is just not a notification.
  select pg_catalog.array_agg(distinct candidate.id) into v_mentions
  from pg_catalog.unnest(coalesce(p_mention_ids, '{}'::uuid[])) as candidate(id)
  where candidate.id is not null and candidate.id <> (select auth.uid());
  v_mentions := coalesce(v_mentions, '{}'::uuid[]);
  v_mention_count := coalesce(pg_catalog.array_length(v_mentions, 1), 0);
  if v_mention_count > 10 then
    raise exception 'a note mentions at most 10 people' using errcode = '22023';
  end if;

  select p.chapter_id into v_chapter from public.member_profiles p where p.id = v_case.user_id;
  if exists (
    select 1
    from pg_catalog.unnest(v_mentions) as mention(id)
    where not exists (
      select 1 from public.member_roles r
      where r.user_id = mention.id
        and r.role in ('steward', 'coordinator')
        and (r.chapter_id is null or r.chapter_id = v_chapter))
  ) then
    raise exception 'mentioned person is outside the case chapter' using errcode = '23514';
  end if;

  insert into public.member_case_updates(case_id, user_id, body, mentioned_user_ids)
  values (v_case.id, v_case.user_id, v_body, v_mentions)
  returning * into v_inserted;

  insert into public.coordinator_case_audit(case_id, user_id, actor_id, action, after_value)
  values (v_case.id, v_case.user_id, (select auth.uid()), 'note_added',
    pg_catalog.jsonb_build_object('updateId', v_inserted.id, 'body', v_inserted.body, 'mentionCount', v_mention_count));

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
    'note_added', 'case_update', v_inserted.id,
    pg_catalog.jsonb_build_object('mentionCount', v_mention_count));

  if v_mention_count > 0 then
    select coalesce(p.full_name, 'A staff member') into v_actor
    from public.member_profiles p where p.id = (select auth.uid());
    foreach v_recipient in array v_mentions loop
      perform private.notify_member(v_recipient, 'case.note.mention',
        pg_catalog.jsonb_build_object('name', coalesce(v_actor, 'A staff member')), 'cases');
    end loop;
    insert into public.casework_audit_events(
      organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
      'note_mentioned', 'case_update', v_inserted.id,
      pg_catalog.jsonb_build_object('mentionCount', v_mention_count));
  end if;

  perform private.learning_journal_append('case_note_add', 'public.member_case_updates', v_inserted.id::text, null,
    private.learning_fingerprint(private.learning_case_note_state(v_inserted.id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'id', v_inserted.id, 'caseId', v_inserted.case_id, 'body', v_inserted.body,
    'mentionedUserIds', pg_catalog.to_jsonb(v_mentions), 'createdAt', v_inserted.created_at);
end;
end;
$function$;

create or replace function public.steward_add_case_note(p_case_id uuid, p_body text, p_occurred_on date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid;
  v_case public.member_cases%rowtype;
  v_body text;
  v_today date;
  v_on date;
  v_inserted public.member_case_updates%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[p_case_id]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  select c.* into v_case from public.member_cases c where c.id = p_case_id for update;
  -- Only the case's own steward, and only while they still hold staff
  -- authority in the case's own chapter and organization
  -- (private.casework_staff_can_access): a steward whose membership there was
  -- revoked keeps the assignment row but not the case. Any other case
  -- collapses to one refusal.
  if not found or v_case.steward_user_id is distinct from caller
     or not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found or not yours' using errcode = '42501';
  end if;
  v_body := pg_catalog.btrim(coalesce(p_body, ''));
  if pg_catalog.char_length(v_body) not between 1 and 4000 then
    raise exception 'note must be 1-4000 characters' using errcode = '22023';
  end if;
  -- Today on the Eastern calendar, the day the steward is living in; the
  -- session's current_date is the UTC day.
  v_today := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_on := coalesce(p_occurred_on, v_today);
  if v_on < v_today - 3650 or v_on > v_today + 1 then
    raise exception 'note date out of range' using errcode = '22023';
  end if;

  insert into public.member_case_updates(case_id, user_id, body, occurred_on)
  values (v_case.id, v_case.user_id, v_body, v_on)
  returning * into v_inserted;

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, caller,
    'note_added', 'case_update', v_inserted.id,
    pg_catalog.jsonb_build_object('occurredOn', v_on, 'by', 'steward'));

  perform private.learning_journal_append('case_note_add', 'public.member_case_updates', v_inserted.id::text, null,
    private.learning_fingerprint(private.learning_case_note_state(v_inserted.id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'id', v_inserted.id, 'caseId', v_inserted.case_id, 'body', v_inserted.body,
    'occurredOn', v_inserted.occurred_on, 'createdAt', v_inserted.created_at);
end;
end;
$function$;

create or replace function public.register_member_case_file(
  p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  case_row public.member_cases%rowtype;
  file_id uuid := extensions.gen_random_uuid();
  clean_name text := pg_catalog.btrim(coalesce(p_filename, ''));
  inserted public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
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

  select c.* into case_row from public.member_cases c
  where c.id = p_case_id
    and (
      c.user_id = caller
      or (public.staff_can_see_user(c.user_id, 'coordinator')
        and private.member_case_visible_to_caller(c.id))
    )
  for update of c;
  if case_row.id is null then raise exception 'case unavailable' using errcode = '22023'; end if;

  insert into public.member_case_files(
    id, case_id, user_id, object_name, filename, mime_type, size_bytes,
    uploaded_by, confirmed_at, cleanup_requested_at
  ) values (
    file_id, case_row.id, case_row.user_id,
    case_row.user_id || '/' || case_row.id || '/' || file_id || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller, now(), null
  ) returning * into inserted;
  -- The row this RPC mints is confirmed on creation, so the gate has to sit
  -- here rather than at a later confirmation step. Read from the inserted row,
  -- never from an argument.
  if not private.private_upload_is_current(inserted.bucket_id, inserted.object_name) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  perform private.learning_journal_append('case_file_upload', 'public.member_case_files', inserted.id::text, null,
      private.learning_fingerprint(private.learning_case_file_state(inserted.id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'caseId', inserted.case_id, 'userId', inserted.user_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end;
end;
$function$;

create or replace function public.confirm_member_case_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
  object storage.objects%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into file_row from public.member_case_files f
  join public.member_cases c on c.id = f.case_id and c.user_id = f.user_id
  where f.id = p_file_id and f.uploaded_by = caller
    and f.cleanup_requested_at is null
    and f.removal_requested_at is null
    and (
      c.user_id = caller
      or (public.staff_can_see_user(c.user_id, 'coordinator')
        and private.member_case_visible_to_caller(c.id))
    )
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
  update public.member_case_files set confirmed_at = coalesce(confirmed_at, now())
    where id = file_row.id returning * into file_row;
  -- Journalled once, when it first becomes visible.
  if file_row.confirmed_at = pg_catalog.now() then
    perform private.learning_journal_append('case_file_upload', 'public.member_case_files', file_row.id::text, null,
      private.learning_fingerprint(private.learning_case_file_state(file_row.id)), null, '{}'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'caseId', file_row.case_id, 'userId', file_row.user_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at);
end;
end;
$function$;

create or replace function public.request_member_case_file_removal(p_file_id uuid, p_removal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_file_id is null or p_removal_id is null then
    raise exception 'file and removal ids required' using errcode = '22023';
  end if;

  select f.* into file_row from public.member_case_files f
  where f.id = p_file_id
    and (
      (f.removal_id = p_removal_id and f.removal_requested_by = caller)
      or (
        f.removal_id is null
        and f.confirmed_at is not null
        and (
          f.user_id = caller
          or (public.staff_can_see_user(f.user_id, 'coordinator')
            and private.member_case_visible_to_caller(f.case_id))
        )
      )
    )
  for update;
  if file_row.id is null then
    if exists (
      select 1 from private.attachment_removal_receipts r
      where r.file_kind = 'member_case'
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
    update public.member_case_files
    set removal_id = p_removal_id,
        removal_requested_at = now(),
        removal_requested_by = caller
    where id = file_row.id and removal_id is null
    returning * into file_row;
    perform private.learning_journal_append('case_file_remove', 'public.member_case_files', file_row.id::text);
  end if;

  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'caseId', file_row.case_id, 'userId', file_row.user_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at,
    'removalId', file_row.removal_id,
    'removalRequestedAt', file_row.removal_requested_at);
end;
end;
$function$;

create or replace function public.remove_member_case_file(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into file_row from public.member_case_files f
  where f.id = p_file_id and f.confirmed_at is not null
    and f.removal_requested_at is null
    and (
      f.user_id = caller
      or (public.staff_can_see_user(f.user_id, 'coordinator')
        and private.member_case_visible_to_caller(f.case_id))
    )
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    raise exception 'uploaded object still exists' using errcode = '22023';
  end if;
  delete from public.member_case_files where id = file_row.id;
  perform private.learning_journal_append('case_file_remove', 'public.member_case_files', file_row.id::text);
  return pg_catalog.jsonb_build_object('deleted', true, 'id', file_row.id);
end;
end;
$function$;

-- The two re-emitted functions on the reviewed account-lifecycle surface are
-- reviewed again at their new definitions; nothing else is waived.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function'
  and ((s.schema_name = 'public' and pg_catalog.split_part(s.object_name, '(', 1) = 'casework_submit_retaliation_report')
    or (s.schema_name = 'private' and pg_catalog.split_part(s.object_name, '(', 1) = 'case_scope_and_identity_allowed'))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_case_records_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after case records under learning';
  end if;
end;
$assert_case_records_trigger_review$;

notify pgrst, 'reload schema';
commit;
