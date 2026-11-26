begin;

-- BUG-UG-CASE-BULK-ASSIGN-CLEARS-UNTOUCHED-ROLE-20260920
--
-- The bulk Assign panel names only the roles the coordinator picked. An
-- unnamed role must never change on any selected case, so this re-emission
-- gives assign_member_case an explicit per-role intent: the nil uuid means
-- "leave this role exactly as it is". null still means "clear" — that is the
-- deliberate, labelled blank choice of the single-case editor (whose selects
-- default to the case's current assignees) and of casework_apply_macro (whose
-- clear option is explicitly labelled), so their behavior is unchanged.
--
-- A real user id can never be the nil uuid (auth.users ids are random), so
-- the sentinel cannot collide with an assignee. The signature is unchanged:
-- existing callers, grants, and the historical hash ratchets that pin this
-- signature all keep meaning what they meant.
--
-- The live body carries two installation-time entry gates added by
-- 20260907122000 (message lifecycle) and 20260907151000 (case graph, outer).
-- Both are re-emitted here verbatim, in the same order, before any
-- declaration initializer, authorization read or row lock.

create or replace function public.assign_member_case(
  p_case_id uuid,
  p_steward uuid default null,
  p_coordinator uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid := (select auth.uid());
  unchanged uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  case_row public.member_cases%rowtype;
  case_chapter text;
  steward_label text;
  coordinator_label text;
  actor_label text;
  before_value jsonb;
  after_value jsonb;
  new_steward uuid;
  new_coordinator uuid;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator', 'admin']) then
    raise exception 'coordinator role and MFA required' using errcode = '42501';
  end if;

  select c.* into case_row from public.member_cases c where c.id = p_case_id for update;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not public.staff_can_see_user(case_row.user_id, 'coordinator') then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;
  select p.chapter_id into case_chapter from public.member_profiles p where p.id = case_row.user_id;

  -- The leave-unchanged intent is resolved against the locked row before any
  -- validation: a role the caller did not name is carried over byte-for-byte,
  -- never re-checked, never re-labelled, and never written as a null.
  new_steward := case when p_steward = unchanged then case_row.steward_user_id else p_steward end;
  new_coordinator := case when p_coordinator = unchanged then case_row.coordinator_user_id else p_coordinator end;

  -- Scope checks run only for a role that is actually being written. The
  -- stored display name follows the same three-way intent as the user id: a
  -- named person is looked up, the leave-unchanged sentinel keeps the existing
  -- label, and an explicit null clears the label with the id.
  if p_steward is not null and p_steward <> unchanged then
    select p.full_name into steward_label
    from public.member_roles r join public.member_profiles p on p.id = r.user_id
    where r.user_id = p_steward and r.role = 'steward'
      and (r.chapter_id is null or r.chapter_id = case_chapter);
    if not found then raise exception 'steward is outside case scope or lacks role' using errcode = '23514'; end if;
  elsif p_steward = unchanged then
    steward_label := case_row.steward_name;
  else
    steward_label := null;
  end if;
  if p_coordinator is not null and p_coordinator <> unchanged then
    select p.full_name into coordinator_label
    from public.member_roles r join public.member_profiles p on p.id = r.user_id
    where r.user_id = p_coordinator and r.role = 'coordinator'
      and (r.chapter_id is null or r.chapter_id = case_chapter);
    if not found then raise exception 'coordinator is outside case scope or lacks role' using errcode = '23514'; end if;
  elsif p_coordinator = unchanged then
    coordinator_label := case_row.coordinator_name;
  else
    coordinator_label := null;
  end if;

  before_value := pg_catalog.jsonb_build_object(
    'stewardUserId', case_row.steward_user_id, 'stewardName', case_row.steward_name,
    'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name
  );
  after_value := pg_catalog.jsonb_build_object(
    'stewardUserId', new_steward, 'stewardName', steward_label,
    'coordinatorUserId', new_coordinator, 'coordinatorName', coordinator_label
  );
  if before_value = after_value then return; end if;

  update public.member_cases set
    steward_user_id = new_steward, steward_name = steward_label,
    coordinator_user_id = new_coordinator, coordinator_name = coordinator_label,
    assigned_at = case when new_steward is null and new_coordinator is null then null else now() end
  where id = p_case_id;

  actor_label := coalesce(
    (select p.full_name from public.member_profiles p where p.id = caller),
    'Staff member'
  );
  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (p_case_id, caller, actor_label, before_value, after_value);
end;
end;
end;
$$;

commit;
