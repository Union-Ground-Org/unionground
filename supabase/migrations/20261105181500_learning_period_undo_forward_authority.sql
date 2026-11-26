-- BUG-UG-LEARNING-PERIOD-INTAKE-UNDO-AUTHORITY-20261105 (#7085).
-- Fix forward after 20261104123000; no earlier journal or audit row changes.
-- Undo's check phase runs under the engine's graph/target locks before its
-- apply phase. Recheck the specialized forward authority there so a retained
-- broad staff role cannot restore state after the required role was lost.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
    -- Conversion also changed a staff-managed report. Changing the task or
    -- case alone is insufficient: recheck convert_member_intake_report's
    -- current role and same-chapter readable-profile predicate before any
    -- restoring write. An ordinary creation carries no report image.
    if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is not null
       and (not public.member_has_role(array['steward', 'coordinator'])
         or not exists (
           select 1 from public.member_intake_reports r
           join public.member_profiles p on p.id = caller
           where r.id = (p_entry -> 'before_image' -> 'intake_report' ->> 'id')::uuid
             and p.chapter_id = r.chapter_id)) then
      raise exception 'intake staff role required' using errcode = '42501';
    end if;
    -- A report the record was converted from must still stand as conversion
    -- left it; anyone's later triage refuses the undo.
    if not private.learning_intake_report_unchanged(p_entry -> 'before_image' -> 'intake_report') then
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
    -- An intake report converted into the task goes back to how it stood.
    perform private.learning_restore_intake_report(p_entry -> 'before_image' -> 'intake_report');
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

create or replace function private.learning_undo_case(p_mode text, p_entry jsonb)
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
    -- The step is the one the newer undos in this chain leave (projected).
    if p_entry ->> 'action_kind' = 'case_edit'
       and coalesce(p_entry -> 'projected_state' ->> 'step', case_row.step) is distinct from (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)
       and private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null
       -- A step the caller's own transition moved goes back by the reverse
       -- transition (20261104123000); any other step change still does not.
       and not exists (select 1 from public.casework_step_transitions st
         where st.case_id = target and st.to_step = coalesce(p_entry -> 'projected_state' ->> 'step', case_row.step) and st.transitioned_by = caller
           and st.from_step = (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)) then
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
    -- Conversion also changed a staff-managed report. Changing the task or
    -- case alone is insufficient: recheck convert_member_intake_report's
    -- current role and same-chapter readable-profile predicate before any
    -- restoring write. An ordinary creation carries no report image.
    if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is not null
       and (not public.member_has_role(array['steward', 'coordinator'])
         or not exists (
           select 1 from public.member_intake_reports r
           join public.member_profiles p on p.id = caller
           where r.id = (p_entry -> 'before_image' -> 'intake_report' ->> 'id')::uuid
             and p.chapter_id = r.chapter_id)) then
      raise exception 'intake staff role required' using errcode = '42501';
    end if;
    if p_entry ->> 'action_kind' = 'case_create' then
      -- Ordinary staff intake uses open_member_case's current predicate.
      -- Conversion, import and approved forms have their own gates instead;
      -- none acquires an unrelated intake requirement from this handler.
      if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is null
         and not exists (select 1 from public.member_forms f where f.case_id = target)
         and not exists (select 1 from private.learning_action_journal j
           where j.id = (p_entry ->> 'parent_entry_id')::uuid and j.action_kind = 'case_operations_import')
         and case_row.user_id is distinct from caller
         and not (private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
           or private.chapter_case_intake_role_allows(case_row.user_id, 'coordinator')
           or private.chapter_case_intake_role_allows(case_row.user_id, 'admin')) then
        raise exception 'case intake authority required' using errcode = '42501';
      end if;
      -- Freeing an approved form is open_form_as_case's steward-only action,
      -- even when an admin or coordinator could otherwise open a case.
      -- Evaluate the unlinked form the forward writer saw, without changing
      -- its stored row: linked-case readability is not form-opening authority.
      if exists (select 1 from public.member_forms f where f.case_id = target)
         and (not public.member_has_role(array['steward']) or exists (
           select 1 from public.member_forms f where f.case_id = target
             and (f.user_id = caller or not private.member_form_scope_and_identity_allowed(
                 pg_catalog.jsonb_populate_record(f, '{"case_id": null}'::jsonb))
               or not public.staff_can_see_user(f.user_id, 'steward')))) then
        raise exception 'steward role and form scope required' using errcode = '42501';
      end if;
      -- Import children retain the parent's provenance. A broad case role
      -- must not stand in for the import writer's current organization admin.
      if exists (select 1 from private.learning_action_journal j
           where j.id = (p_entry ->> 'parent_entry_id')::uuid and j.action_kind = 'case_operations_import')
         and private.require_member_operations_admin() is distinct from case_row.organization_id then
        raise exception 'admin role required' using errcode = '42501';
      end if;
    end if;
    -- A report the record was converted from must still stand as conversion
    -- left it; anyone's later triage refuses the undo.
    if not private.learning_intake_report_unchanged(p_entry -> 'before_image' -> 'intake_report') then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if p_entry ->> 'action_kind' = 'case_create' then
    update public.member_cases c set learning_undone_at = pg_catalog.clock_timestamp()
    where c.id = target and c.learning_undone_at is null;
    -- A form the case was opened from can be opened as a case again.
    update public.member_forms f set case_id = null, updated_at = pg_catalog.now() where f.case_id = target;
    -- An intake report converted into the case goes back to how it stood.
    perform private.learning_restore_intake_report(p_entry -> 'before_image' -> 'intake_report');
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
    if private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null then
      perform private.learning_reverse_transition(target, case_row.step, earlier ->> 'step');
    end if;
    update public.member_cases c set step = earlier ->> 'step' where c.id = target;
  end if;
  return null;
end;
end;
$function$;

create or replace function private.learning_undo_case_outcome(p_mode text, p_entry jsonb)
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
    -- The outcome writer is coordinator_record_case_outcome, whose shared
    -- gate includes the coordinator role, current scope, MFA and visibility.
    perform private.coordinator_case_for_update(target);
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

create or replace function private.learning_undo_case_assignment(p_mode text, p_entry jsonb)
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
  restored_steward uuid := (p_entry -> 'before_image' ->> 'steward_user_id')::uuid;
  restored_coordinator uuid := (p_entry -> 'before_image' ->> 'coordinator_user_id')::uuid;
  case_row public.member_cases%rowtype;
  restored_row public.member_cases%rowtype;
  case_chapter text;
  steward_label text;
  coordinator_label text;
  actor_label text;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_assignment_state(target);
  elsif p_mode = 'before' then
    return pg_catalog.jsonb_build_object(
      'steward_user_id', image -> 'steward_user_id', 'coordinator_user_id', image -> 'coordinator_user_id');
  end if;

  select c.* into case_row from public.member_cases c where c.id = target;
  select p.chapter_id into case_chapter from public.member_profiles p where p.id = case_row.user_id;
  if p_mode = 'check' then
    -- Checks precede every apply. Newer entries in this chain may already
    -- have projected a different assignment; use that state for authority
    -- and unchanged-assignee comparisons, never the still-live assignment.
    case_row := pg_catalog.jsonb_populate_record(case_row,
      coalesce(nullif(p_entry -> 'projected_state', 'null'::jsonb), '{}'::jsonb));
    if case_row.id is null or case_row.organization_id is distinct from (p_entry ->> 'organization_id')::uuid
       or not private.mfa_satisfied() then
      raise exception 'you can no longer change who is assigned to this case' using errcode = '42501';
    end if;
    -- Someone else changed the assignment since, even through a path no
    -- learning period journals: their decision stands.
    if exists (
      select 1 from public.member_case_assignment_audit a
      where a.case_id = target and a.id > coalesce((image ->> 'audit_floor')::bigint, 0)
        and a.actor_id is distinct from caller
    ) then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    if p_entry ->> 'action_kind' = 'case_claim' then
      -- Recheck claim_member_case's current steward authority and scope.
      -- Keeping membership after losing that role is insufficient.
      if not public.member_has_role(array['steward'])
         or case_row.organization_id is distinct from private.current_member_organization()
         or not (private.has_organization_role(case_row.organization_id, array['steward'])
           or private.member_has_chapter_role(case_row.chapter_id, array['steward'])
           or private.chapter_scoped_role_allows(case_row.chapter_id, 'steward', case_row.user_id, true))
         or not private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
         or private.chapter_case_readable(case_row) is not true then
        raise exception 'you can no longer change who is assigned to this case' using errcode = '42501';
      end if;
      return null;
    end if;
    -- Today's rule for assigning this case (assign_member_case) ...
    if not public.member_has_role(array['coordinator', 'admin'])
       or not public.staff_can_see_user(case_row.user_id, 'coordinator')
       or not private.chapter_case_staff_readable(case_row) then
      raise exception 'you can no longer change who is assigned to this case' using errcode = '42501';
    end if;
    -- ... and for each person put back: they must still hold the role in the
    -- case's scope, as assign_member_case requires of anyone it names.
    if restored_steward is not null and restored_steward is distinct from case_row.steward_user_id
       and not exists (
         select 1 from public.member_roles r
         where r.user_id = restored_steward and r.role = 'steward'
           and (r.chapter_id is null or r.chapter_id = case_chapter)
           and private.actor_role_covers_member(r.user_id, case_chapter, r.role, case_row.user_id, true)) then
      raise exception 'the earlier steward can no longer be assigned to this case' using errcode = '42501';
    end if;
    if restored_coordinator is not null and restored_coordinator is distinct from case_row.coordinator_user_id
       and not exists (
         select 1 from public.member_roles r
         where r.user_id = restored_coordinator and r.role = 'coordinator'
           and (r.chapter_id is null or r.chapter_id = case_chapter)
           and private.actor_role_covers_member(r.user_id, case_chapter, r.role, case_row.user_id, true)) then
      raise exception 'the earlier coordinator can no longer be assigned to this case' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  steward_label := case
    when restored_steward is null then null
    when restored_steward = case_row.steward_user_id then case_row.steward_name
    else (select p.full_name from public.member_profiles p where p.id = restored_steward) end;
  coordinator_label := case
    when restored_coordinator is null then null
    when restored_coordinator = case_row.coordinator_user_id then case_row.coordinator_name
    else (select p.full_name from public.member_profiles p where p.id = restored_coordinator) end;
  update public.member_cases set
    steward_user_id = restored_steward, steward_name = steward_label,
    coordinator_user_id = restored_coordinator, coordinator_name = coordinator_label,
    assigned_at = case when restored_steward is null and restored_coordinator is null then null
      else coalesce((image ->> 'assigned_at')::timestamptz, pg_catalog.now()) end
  where id = target returning * into restored_row;
  -- On a restricted case the assignment may be what lets you in: an undo
  -- that would leave you unable to reach it (and so unable to lift or undo
  -- its restriction) is refused, as casework_set_restriction refuses a
  -- restriction that locks you out. Undo the restriction first.
  if restored_row.is_restricted
     and (not private.casework_staff_can_access(target) or private.member_case_row_visible(restored_row) is not true) then
    raise exception 'undoing this would remove your own access to this restricted case' using errcode = '22023', detail = 'casework_restriction_self_lockout';
  end if;
  actor_label := coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Staff member');
  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (target, caller, actor_label,
    pg_catalog.jsonb_build_object(
      'stewardUserId', case_row.steward_user_id, 'stewardName', case_row.steward_name,
      'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name),
    pg_catalog.jsonb_build_object(
      'stewardUserId', restored_steward, 'stewardName', steward_label,
      'coordinatorUserId', restored_coordinator, 'coordinatorName', coordinator_label));
  return null;
end;
end;
$function$;

-- Supply the already locked, validated chain to check handlers so a
-- reminder change can distinguish net cancellation from rescheduling.
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
        pg_catalog.to_jsonb(item) || pg_catalog.jsonb_build_object('projected_state', current_state, 'projected', projected,
          'chain_entry_ids', chain_ids));
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

create or replace function private.learning_undo_message_reminder(p_mode text, p_entry jsonb)
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
  reminder public.member_message_reminders%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_message_reminders r where r.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_message_reminder_state(target);
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'message_reminder_set' then return null; end if;
    return image;
  elsif p_mode = 'check' then
    select r.* into reminder from public.member_message_reminders r where r.id = target and r.owner_id = caller;
    if reminder.id is null then
      raise exception 'this reminder is no longer yours to change' using errcode = '42501';
    end if;
    -- Removing your own reminder remains yours. Putting a channel-staff
    -- send back in the queue needs create_channel_here_reminder's current
    -- staff, channel, organization and feature authority, not ownership alone.
    if p_entry ->> 'action_kind' = 'message_reminder_change'
       and image ->> 'audience' = 'here' and image ->> 'status' in ('pending', 'scheduled')
       -- A validated older creation in this exact chain cancels the
       -- reminder before commit. No send is requeued by that net undo.
       -- Standalone change undo has no such creation in its chain.
       and not exists (
         select 1 from private.learning_action_journal j
         where j.id::text in (select value from pg_catalog.jsonb_array_elements_text(
             coalesce(p_entry -> 'chain_entry_ids', '[]'::jsonb)))
           and j.action_kind = 'message_reminder_set' and j.state = 'active'
           and j.target_table = p_entry ->> 'target_table' and j.target_id = target::text
           and j.actor_user_id = caller and j.organization_id = (p_entry ->> 'organization_id')::uuid
           and (j.created_at, j.id) < ((p_entry ->> 'created_at')::timestamptz, (p_entry ->> 'id')::uuid))
       and not exists (
         select 1 from public.chapter_spaces space
         join public.chapters chapter on chapter.id = space.chapter_id
         where space.id::text = reminder.source_ref and reminder.source_kind = 'space'
           and space.archived_at is null and private.can_read_chapter_space(space)
           and chapter.organization_id = private.current_member_organization()
           and private.organization_feature_enabled(chapter.organization_id, 'features.messaging.remind_here')
           and private.remind_here_staff_reads_space(caller, space.id)) then
      raise exception 'channel staff reminder authority required' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if p_entry ->> 'action_kind' = 'message_reminder_set' then
    update public.member_message_reminders r
    set status = 'cancelled', updated_at = pg_catalog.now()
    where r.id = target and r.owner_id = caller and r.status in ('pending', 'scheduled');
  else
    update public.member_message_reminders r
    set status = image ->> 'status', remind_at = (image ->> 'remind_at')::timestamptz, note = image ->> 'note',
        title = image ->> 'title', repeat_rule = image ->> 'repeat_rule', time_zone = image ->> 'time_zone',
        audience = image ->> 'audience', snooze_count = (image ->> 'snooze_count')::smallint,
        completed_at = (image ->> 'completed_at')::timestamptz, delivered_at = (image ->> 'delivered_at')::timestamptz,
        updated_at = pg_catalog.now()
    where r.id = target and r.owner_id = caller;
  end if;
  return null;
end;
end;
$function$;

notify pgrst, 'reload schema';
commit;
