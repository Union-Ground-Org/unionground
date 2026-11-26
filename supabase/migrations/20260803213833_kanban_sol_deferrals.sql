-- REQ-UG-KANBAN-SOL-DEFERRALS-20260801
-- REQ-UG-KANBAN-P2-SOL-DEFERRALS-20260801
--
-- Durable task keys, transactional board moves, optimistic content writes,
-- and an edge read whose 4,000-row ceiling is spent only on cards that the
-- board can render.

set local lock_timeout = '5s';

-- A purged task must not free its visible key for reuse. The counter is the
-- durable high-water mark; chapter_tasks remains the immutable key ledger for
-- rows that still exist, while this row survives their eventual hard purge.
create table private.chapter_task_number_counters (
  chapter_id text primary key references public.chapters(id) on update cascade on delete restrict,
  last_number integer not null,
  constraint chapter_task_number_counters_nonnegative check (last_number >= 0)
);

insert into private.chapter_task_number_counters (chapter_id, last_number)
select t.chapter_id, max(t.task_number)
from public.chapter_tasks t
group by t.chapter_id
on conflict (chapter_id) do update
  set last_number = greatest(private.chapter_task_number_counters.last_number, excluded.last_number);

revoke all on table private.chapter_task_number_counters from public, anon, authenticated;

comment on table private.chapter_task_number_counters is
  'Per-chapter task-number high-water marks. Rows survive task purges so a visible task key is never reused.';

-- Full current prepare body, with only max()+1 replaced by the durable
-- counter. The existing advisory-lock key is retained so an insert racing this
-- migration serializes with both allocator generations.
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

    -- The lazy max seed makes rollout race-safe with the previous allocator;
    -- after this row exists, UPDATE ... RETURNING is the sole mint authority.
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

-- Description/checklist and title edits are compare-and-swap writes. A stale
-- editor receives 40001 and keeps its draft instead of silently overwriting a
-- teammate's newer text.
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
declare
  caller uuid := (select auth.uid());
  current_task public.chapter_tasks%rowtype;
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

  return query
  update public.chapter_tasks t
     set title = coalesce(p_title, t.title),
         description = coalesce(p_description, t.description)
   where t.id = current_task.id
   returning t.*;
end
$$;

revoke all on function public.update_chapter_task_content(uuid, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.update_chapter_task_content(uuid, timestamptz, text, text)
  to authenticated, service_role;

-- Every drop is one transaction. The normal case updates one row at a
-- midpoint. If that gap has closed, one server call renumbers exactly the
-- target (workstream x status) partition with spacing derived from its size;
-- no row can exceed the table's 1,000,000 ceiling.
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
declare
  caller uuid := (select auth.uid());
  moving public.chapter_tasks%rowtype;
  before_task public.chapter_tasks%rowtype;
  previous_index integer;
  next_index integer;
  candidate integer;
  partition_count integer;
  spacing integer;
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
end
$$;

revoke all on function public.move_chapter_task(uuid, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.move_chapter_task(uuid, text, text, uuid, timestamptz)
  to authenticated, service_role;

-- Spend the edge cap only on endpoints in the same 500-card window as the
-- board. Newest-first keeps the most recently authored renderable edges if
-- the explicit ceiling itself binds.
create or replace function public.list_chapter_task_dependencies(p_limit integer default 4000)
returns setof public.chapter_task_dependencies
language sql
stable
security invoker
set search_path = ''
as $$
  with visible_tasks as (
    select t.id
    from public.chapter_tasks t
    where t.deleted_at is null
      and (t.status <> 'done' or t.done_at >= now() - interval '60 days')
    order by t.status desc, t.order_index, t.created_at
    limit 500
  )
  select d.*
  from public.chapter_task_dependencies d
  join visible_tasks task on task.id = d.task_id
  join visible_tasks dependency on dependency.id = d.depends_on_id
  order by d.created_at desc, d.id desc
  limit least(greatest(coalesce(p_limit, 4000), 0), 4000)
$$;

revoke all on function public.list_chapter_task_dependencies(integer)
  from public, anon, authenticated;
grant execute on function public.list_chapter_task_dependencies(integer)
  to authenticated, service_role;

comment on function public.update_chapter_task_content(uuid, timestamptz, text, text) is
  'Compare-and-swap title/description update. 40001 preserves a stale editor draft for retry.';
comment on function public.move_chapter_task(uuid, text, text, uuid, timestamptz) is
  'Atomic board drop and target-partition renumber. Returned rows are the complete mutation response.';
comment on function public.list_chapter_task_dependencies(integer) is
  'Newest-first dependency edges whose endpoints are both renderable in the 500-card board window; hard ceiling 4000.';

notify pgrst, 'reload schema';
