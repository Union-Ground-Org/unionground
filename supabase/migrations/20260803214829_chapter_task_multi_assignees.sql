-- REQ-UG-INTERACTION-DESIGN-SYSTEM-20260802
-- Multiple assignees inherit the task's chapter boundary. The legacy
-- chapter_tasks.assignee_id remains the ordered primary assignee for reports,
-- notifications, and rollout-safe clients; this relation holds the full set.

set local lock_timeout = '5s';

create table public.chapter_task_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  assignee_id uuid not null references auth.users(id) on delete cascade,
  position smallint not null,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  constraint chapter_task_assignments_position_bounded check (position between 0 and 11),
  constraint chapter_task_assignments_task_member_key unique (task_id, assignee_id),
  constraint chapter_task_assignments_task_position_key unique (task_id, position)
);

create index chapter_task_assignments_chapter_idx
  on public.chapter_task_assignments (chapter_id, task_id, position);
create index chapter_task_assignments_member_idx
  on public.chapter_task_assignments (assignee_id, task_id);
create index chapter_task_assignments_assigned_by_idx
  on public.chapter_task_assignments (assigned_by);

insert into public.chapter_task_assignments (
  task_id, chapter_id, assignee_id, position, assigned_by, assigned_at
)
select t.id, t.chapter_id, t.assignee_id, 0, t.updated_by, coalesce(t.updated_at, t.created_at)
from public.chapter_tasks t
where t.assignee_id is not null
on conflict (task_id, assignee_id) do nothing;

alter table public.chapter_task_assignments enable row level security;

create policy chapter_task_assignments_select_board
  on public.chapter_task_assignments
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.chapter_tasks t
      join public.member_profiles p
        on p.id = (select auth.uid())
       and p.chapter_id = t.chapter_id
      where t.id = chapter_task_assignments.task_id
        and t.chapter_id = chapter_task_assignments.chapter_id
        and t.deleted_at is null
    )
  );

create policy mfa_assurance on public.chapter_task_assignments
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_assignments from public, anon, authenticated;
grant select on table public.chapter_task_assignments to authenticated;

-- Older clients and existing create paths still write the compatibility
-- column. Keep those writes honest by treating them as an intentional
-- single-assignee selection. The multi-select RPC sets a transaction-local
-- guard while it mirrors its ordered primary back to the compatibility row.
create or replace function private.sync_chapter_task_primary_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('sg.setting_task_assignees', true) = '1' then
    return new;
  end if;

  delete from public.chapter_task_assignments a where a.task_id = new.id;
  if new.assignee_id is not null then
    insert into public.chapter_task_assignments (
      task_id, chapter_id, assignee_id, position, assigned_by, assigned_at
    ) values (
      new.id, new.chapter_id, new.assignee_id, 0,
      coalesce(new.updated_by, new.created_by), coalesce(new.updated_at, now())
    );
  end if;
  return new;
end
$$;

revoke all on function private.sync_chapter_task_primary_assignment()
  from public, anon, authenticated;

create trigger chapter_tasks_sync_primary_assignment
after insert or update of assignee_id on public.chapter_tasks
for each row execute function private.sync_chapter_task_primary_assignment();

create or replace function public.set_chapter_task_assignees(
  p_task_id uuid,
  p_assignee_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_name text;
  task_row public.chapter_tasks%rowtype;
  clean_ids uuid[] := '{}';
  old_ids uuid[] := '{}';
  recipient uuid;
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
end
$$;

revoke all on function public.set_chapter_task_assignees(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.set_chapter_task_assignees(uuid, uuid[])
  to authenticated;

create trigger chapter_task_assignments_broadcast
after insert or update or delete on public.chapter_task_assignments
for each row execute function private.broadcast_chapter_task_change();

comment on table public.chapter_task_assignments is
  'Ordered, chapter-scoped task assignees. Mutated atomically through set_chapter_task_assignees; the first row mirrors chapter_tasks.assignee_id for compatibility.';

notify pgrst, 'reload schema';
