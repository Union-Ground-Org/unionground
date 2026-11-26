-- BUG-UG-MEMBER-CAN-RESOLVE-OWN-CASE-AND-MOVE-ITS-DEADLINE-20261110 (#7980).
-- public.update_my_member_case (20261104075000) checked only that the caller
-- owns the case and may read it, then wrote status, deadline and step. A
-- member could set a grievance their steward and coordinator were working to
-- Resolved (it left the coordinator queue, which lists active cases only) or
-- move or clear the deadline the queue orders and focuses by.
--
-- The member's own edit now applies only to a case nobody else works: no
-- assigned steward or coordinator (by account or by the name stamped with the
-- assignment, which is what the member's case window shows) and no
-- organization procedure resolving for the case. Any other case is refused
-- with 42501 before any write or journal entry, whatever values are sent;
-- its representative moves it through coordinator_update_case and the
-- procedure transition, which are unchanged.
--
-- private.member_case_managed holds that predicate once.
-- public.get_my_member_case_managed lets the member's case window ask it, so a
-- case assigned by account only (no stamped name) is read-only there too.
--
-- The body is the 20261104075000 body with that one refusal added after the
-- ownership check. The learning-period undo of a member's own earlier edit
-- (private.learning_undo_case, body 20261106220000) would otherwise put back
-- status, deadline and step on a case that is now assigned, so its check step
-- refuses that undo the same way unless the caller is staff who can work on
-- the case, or the same undo chain also undoes the caller's own creation of
-- the case (the whole case goes, under the creation checks); the rest of that body is unchanged. create or replace keeps each
-- owner and the grants; they are restated as before.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- The one definition of a case its representative moves: an assigned
-- steward or coordinator (by account, or by the stamped name the member's
-- window shows) or an organization procedure resolving for it.
create function private.member_case_managed(case_row public.member_cases)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case_row.steward_user_id is not null or case_row.coordinator_user_id is not null
    or pg_catalog.btrim(coalesce(case_row.steward_name, '')) <> ''
    or pg_catalog.btrim(coalesce(case_row.coordinator_name, '')) <> ''
    or private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null;
$function$;
revoke all on function private.member_case_managed(public.member_cases) from public, anon, authenticated, service_role;

create or replace function public.update_my_member_case(p_case_id uuid, p_status text, p_deadline date, p_step text default null)
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
  -- Only a member-only case keeps the member's edit: an assigned case or one
  -- under an organization procedure is moved by its representative.
  if private.member_case_managed(case_row) then
    raise exception 'case is managed by its representative' using errcode = '42501';
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

-- What the member's case window reads to decide between the edit form and
-- read-only text, so a case assigned by account only is read-only too (the
-- member's case read carries the names, not the accounts). The caller's own
-- readable case only; the answer is the same predicate the edit refuses on.
create function public.get_my_member_case_managed(p_case_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  case_row public.member_cases%rowtype;
begin
  if caller is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select c.* into case_row from public.member_cases c where c.id = p_case_id and c.user_id = caller;
  if case_row.id is null or not private.chapter_case_readable(case_row) then
    raise exception 'case unavailable' using errcode = '42501';
  end if;
  return private.member_case_managed(case_row);
end;
$function$;
revoke all on function public.get_my_member_case_managed(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_my_member_case_managed(uuid) to authenticated;

-- private.learning_undo_case (body: 20261106220000, plus the managed-case refusal for case_edit)
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
    -- Undoing a member's own edit is still the member changing status,
    -- deadline and step: refused once a steward, a coordinator or an
    -- organization procedure holds the case, as update_my_member_case refuses
    -- the edit itself (#7980). Staff who can work on the case keep their undo,
    -- and so does an undo whose chain also undoes the caller's own creation of
    -- this case: the case goes as a whole, under the case_create checks below.
    if p_entry ->> 'action_kind' = 'case_edit' and not private.casework_staff_can_access(case_row.id)
       and not exists (
         select 1 from private.learning_action_journal created
         where created.id::text in (select pg_catalog.jsonb_array_elements_text(coalesce(p_entry -> 'chain_entry_ids', '[]'::jsonb)))
           and created.action_kind = 'case_create'
           and created.target_table = 'public.member_cases'
           and created.target_id = target::text
           and created.actor_user_id = caller)
       and private.member_case_managed(case_row) then
      raise exception 'case is managed by its representative' using errcode = '42501';
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
      raise exception 'someone else has changed this since' using errcode = 'PT409';
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
      raise exception 'someone else has changed this since' using errcode = 'PT409';
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
revoke all on function private.learning_undo_case(text, jsonb) from public, anon, authenticated, service_role;

commit;
