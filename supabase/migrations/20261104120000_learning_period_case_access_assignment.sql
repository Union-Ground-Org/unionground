-- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103 (#6943),
-- slice 4 of 9 of #6805. Built on the engine (20261103163000, #6940) and the
-- task slice (20261103183000, #6941). Design:
-- the operator runbook, "Action
-- inventory", "Cases": assignment, case access and restrictions, retaliation
-- withdraw; build-record row 4.
--
-- While an organization's learning period runs, a person's own changes to
-- who is assigned to a case, who may see it and how it is restricted are
-- journalled in the same transaction as the change, and that person can undo
-- them through undo_my_learning_action:
--   case_assign                  assign_member_case; undo puts the earlier steward
--                                and coordinator back, only while the ones you set
--                                are still assigned
--   case_claim                   claim_member_case; undo releases the case
--   case_access_grant            casework_grant_access; undo takes the access away
--   case_access_revoke           casework_revoke_access; undo grants it again
--   case_restriction             casework_set_restriction; undo puts the earlier
--                                restriction back
-- Submitting or withdrawing your own retaliation report, and a note on a
-- pattern review, are recorded and kept (section 5 says why).
--
-- Undo never widens access beyond what the person may grant at undo time:
-- giving access back reactivates the grant the revoke took away, only for
-- someone they could grant it to today; an undone assignment puts back only people who could be
-- assigned today, by someone who may assign today; an undone restriction
-- change is applied only by someone who may set the restriction today, and
-- never locks them out. Each reversal writes the normal audit rows
-- (member_case_assignment_audit, casework_audit_events) and a new case
-- version; nothing earlier is changed or removed, and a notice already
-- received stays sent.
--
-- Only a change to a case of the organization whose period runs is
-- journalled; a case of another organization never carries its practice state.
--
-- Assignment and restriction are facets of the case row. They are journalled
-- under their own targets, keyed by the case id
-- (public.member_case_assignment_audit, and the label
-- private.learning_case_restriction), so their undo chains and fingerprints
-- stay apart from the case's other fields and from other people's edits of
-- those fields. Explicit access is journalled per case and grantee
-- (public.casework_access_grants, target '<case id>:<grantee id>'), so every
-- grant and revoke of that pair, through any grant row, is one chain.
-- Assignment, access and restriction entries also keep the newest
-- assignment, access or restriction audit row id at the time of the action
-- (audit_floor): a change by anyone else recorded after it, even one no
-- learning period journals (a case of another organization's staff), refuses
-- the undo.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Kinds
-- ---------------------------------------------------------------------------
insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('case_assign', 'case_access', 'reverse', 'public.member_case_assignment_audit', false, 'private.learning_undo_case_assignment',
    array['steward_user_id', 'coordinator_user_id', 'assigned_at', 'audit_floor']::text[],
    'Assigning or reassigning a case''s steward or coordinator. Undo puts the earlier ones back while the ones you set are still assigned, and only people who could be assigned today. The assignment audit row and any notice already received stay.'),
  ('case_claim', 'case_access', 'reverse', 'public.member_case_assignment_audit', false, 'private.learning_undo_case_assignment',
    array['steward_user_id', 'coordinator_user_id', 'assigned_at', 'audit_floor']::text[],
    'Taking an unassigned case as its steward. Undo releases it while you are still its steward.'),
  ('case_access_grant', 'case_access', 'reverse', 'public.casework_access_grants', false, 'private.learning_undo_case_access',
    array['active_grant_id', 'audit_floor']::text[],
    'Giving a coordinator explicit access to a case. Undo takes it away again. The grant row and its audit rows stay.'),
  ('case_access_revoke', 'case_access', 'reverse', 'public.casework_access_grants', false, 'private.learning_undo_case_access',
    array['active_grant_id', 'audit_floor']::text[],
    'Taking away a coordinator''s explicit access to a case. Undo gives the same grant back, only if you could grant it today.'),
  ('case_restriction', 'case_access', 'reverse', 'private.learning_case_restriction', false, 'private.learning_undo_case_restriction',
    array['is_restricted', 'restriction_reason', 'restricted_at', 'restricted_by', 'audit_floor']::text[],
    'Restricting or unrestricting a case, or changing its restriction reason. Undo puts the earlier restriction back, only if you may set it today.'),
  ('retaliation_report_submit', 'case_access', 'permanent', 'public.casework_retaliation_reports', false, null,
    array[]::text[],
    'Submitting your own retaliation report. Recorded and kept, never marked as practice: its text is sealed on your device, so the learning undo cannot take it back; withdraw it through the report''s own withdraw path.'),
  ('retaliation_report_withdraw', 'case_access', 'permanent', 'public.casework_retaliation_reports', false, null,
    array[]::text[],
    'Withdrawing your own retaliation report. Recorded and kept: its withdrawal reason is sealed on your device, so the learning undo cannot clear it.'),
  ('retaliation_pattern_note', 'case_access', 'permanent', 'public.casework_retaliation_pattern_notes', false, null,
    array[]::text[],
    'A note added while reviewing a retaliation pattern. It is evidence with no withdraw path and its text never enters a before-image, so it is recorded and kept; review the pattern again to change its status.');

-- A change is practice only inside the organization whose period runs. A
-- case of another organization, reached through an explicit grant or a
-- cross-organization role, belongs to an organization that never started this
-- period, so a change to it is real and is not journalled here.
create function private.learning_case_in_own_organization(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.member_cases c
    where c.id = p_case_id and c.organization_id = private.current_mobile_staff_organization());
$function$;
revoke all on function private.learning_case_in_own_organization(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Assignment
-- ---------------------------------------------------------------------------
-- The assignment facet of a case: who its steward and coordinator are. The
-- stored display names are labels, looked up again on restore, so they are
-- not compared.
create function private.learning_case_assignment_state(p_case_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when c.id is null then null else pg_catalog.jsonb_build_object(
    'steward_user_id', c.steward_user_id, 'coordinator_user_id', c.coordinator_user_id) end
  from (select 1) one
  left join public.member_cases c on c.id = p_case_id;
$function$;
revoke all on function private.learning_case_assignment_state(uuid) from public, anon, authenticated, service_role;

-- The reversing handler for case_assign and case_claim (the interface is in
-- 20261103163000). It writes the case row and one assignment audit row the
-- way assign_member_case does, so the reversal is not itself journalled.
create function private.learning_undo_case_assignment(p_mode text, p_entry jsonb)
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
    if p_entry ->> 'action_kind' = 'case_claim' and restored_steward is null
       and restored_coordinator is not distinct from case_row.coordinator_user_id then
      -- Releasing a case you took only takes you off it, so you need only
      -- still belong to its organization.
      if not exists (
        select 1 from public.organization_memberships m
        where m.organization_id = case_row.organization_id and m.user_id = caller and m.status = 'active'
      ) then
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
revoke all on function private.learning_undo_case_assignment(text, jsonb) from public, anon, authenticated, service_role;

-- Re-emitted from the live definition (20260923220000 as rewritten by
-- 20261102005607) with the journal call after the audit row.
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
  if not public.staff_can_see_user(case_row.user_id, 'coordinator') or not private.chapter_case_staff_readable(case_row) then
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
      and (r.chapter_id is null or r.chapter_id = case_chapter)
      and private.actor_role_covers_member(r.user_id,case_chapter,r.role,case_row.user_id,true);
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
      and (r.chapter_id is null or r.chapter_id = case_chapter)
      and private.actor_role_covers_member(r.user_id,case_chapter,r.role,case_row.user_id,true);
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

  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103: a
  -- practice reassignment can be undone while the ones set here stay.
  if private.learning_case_in_own_organization(p_case_id) then
    perform private.learning_journal_append(
      'case_assign', 'public.member_case_assignment_audit', p_case_id::text, null,
      private.learning_fingerprint(private.learning_case_assignment_state(p_case_id)), null,
      pg_catalog.jsonb_build_object('steward_user_id', case_row.steward_user_id,
        'coordinator_user_id', case_row.coordinator_user_id, 'assigned_at', case_row.assigned_at,
        'audit_floor', (select pg_catalog.max(a.id) from public.member_case_assignment_audit a where a.case_id = p_case_id)));
  end if;
end;
end;
end;
$$;

-- Re-emitted from the live definition (20261102005607) with the journal call
-- after the audit row.
create or replace function public.claim_member_case(p_case_id uuid)
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
  case_row public.member_cases%rowtype;
  steward_label text;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;

  select c.* into case_row from public.member_cases c where c.id = p_case_id for update;
  -- Not found, out of scope and restricted collapse to one refusal, so a
  -- guessed id is no existence oracle. Scope is the case's own organization
  -- and chapter, not only the member's current profile: a member who moved
  -- to another organization must not carry an old case into its stewards'
  -- reach (gate round 1, r1s1).
  if not found
     or case_row.organization_id is distinct from (select private.current_member_organization())
     or not (private.has_organization_role(case_row.organization_id, array['steward'])
             or private.member_has_chapter_role(case_row.chapter_id, array['steward'])
             or private.chapter_scoped_role_allows(case_row.chapter_id,'steward',case_row.user_id,true))
     or not private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
     or case_row.is_restricted or private.chapter_case_readable(case_row) is not true then
    raise exception 'case not found or outside your scope' using errcode = '42501';
  end if;
  if case_row.user_id = caller then
    raise exception 'a steward cannot take their own case' using errcode = '22023';
  end if;
  if case_row.status <> 'active' then
    raise exception 'only an active case can be taken' using errcode = '22023';
  end if;
  if case_row.steward_user_id = caller then
    return pg_catalog.jsonb_build_object('caseId', case_row.id, 'reference', case_row.reference, 'assigned', true);
  end if;
  if case_row.steward_user_id is not null then
    raise exception 'this case already has a steward' using errcode = '23505';
  end if;

  select p.full_name into steward_label from public.member_profiles p where p.id = caller;
  steward_label := coalesce(steward_label, 'Steward');
  update public.member_cases set
    steward_user_id = caller, steward_name = steward_label, assigned_at = pg_catalog.now()
  where id = case_row.id;

  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (case_row.id, caller, steward_label,
    pg_catalog.jsonb_build_object('stewardUserId', null, 'stewardName', null,
      'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name),
    pg_catalog.jsonb_build_object('stewardUserId', caller, 'stewardName', steward_label,
      'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name));

  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103: a
  -- practice claim can be undone while the caller is still the steward.
  if private.learning_case_in_own_organization(case_row.id) then
    perform private.learning_journal_append(
      'case_claim', 'public.member_case_assignment_audit', case_row.id::text, null,
      private.learning_fingerprint(private.learning_case_assignment_state(case_row.id)), null,
      pg_catalog.jsonb_build_object('steward_user_id', null,
        'coordinator_user_id', case_row.coordinator_user_id, 'assigned_at', case_row.assigned_at,
        'audit_floor', (select pg_catalog.max(a.id) from public.member_case_assignment_audit a where a.case_id = case_row.id)));
  end if;

  return pg_catalog.jsonb_build_object('caseId', case_row.id, 'reference', case_row.reference, 'assigned', true);
end;
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Explicit case access
-- ---------------------------------------------------------------------------
-- Who may give or take away explicit access to a case: the caller rule
-- casework_grant_access and casework_revoke_access have always applied, in
-- one place for the grant and the undo (casework_revoke_access keeps its
-- verbatim copy), so an undo rechecks exactly the same rule.
create function private.casework_may_manage_case_access(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.member_cases c
    where c.id = p_case_id
      and private.casework_staff_can_access(c.id)
      and (private.member_has_chapter_role(c.chapter_id, array['steward','coordinator','advisor','admin','vp'])
           or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])));
$function$;
revoke all on function private.casework_may_manage_case_access(uuid) from public, anon, authenticated, service_role;

-- Whom explicit access to a case may be given to today: the grantee rule of
-- casework_grant_access (20261021034151), moved here unchanged so a grant and
-- the undo of a revoke refuse the same people with the same reasons.
create function private.casework_require_case_access_grantee(p_case_id uuid, p_grantee_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare v_case public.member_cases%rowtype; v_member_org uuid;
begin
  select * into strict v_case from public.member_cases where id = p_case_id;
  if not exists (select 1 from public.organization_memberships m where m.organization_id = v_case.organization_id and m.user_id = p_grantee_user_id and m.status = 'active')
     or not private.actor_has_chapter_staff_role(p_grantee_user_id, v_case.chapter_id)
  then raise exception 'grantee is not active chapter staff' using errcode = '22023'; end if;
  if not (
       exists (select 1 from public.organization_role_grants g
                where g.organization_id = v_case.organization_id and g.user_id = p_grantee_user_id and g.role = 'coordinator')
       or exists (select 1 from public.member_role_chapters rc
                    join public.member_chapter_memberships cm on cm.user_id = rc.user_id and cm.chapter_id = rc.chapter_id and cm.status = 'active'
                   where rc.user_id = p_grantee_user_id and rc.role = 'coordinator'
                     and rc.chapter_id = (select p.chapter_id from public.member_profiles p where p.id = v_case.user_id)))
  then raise exception 'only a coordinator can be given explicit access' using errcode = '22023', detail = 'casework_grantee_cannot_use_grant'; end if;
  -- The grantee then reads the case only through staff_can_see_user's organization branch: the
  -- grantee's active organization is the organization of the member's profile chapter, and the
  -- grantee is a coordinator of that organization or of that chapter. Otherwise the grant would be
  -- saved and still open nothing.
  v_member_org := (select ch.organization_id from public.member_profiles mp join public.chapters ch on ch.id = mp.chapter_id
                    where mp.id = v_case.user_id);
  if v_member_org is null
     or private.member_organization_for(p_grantee_user_id) is distinct from v_member_org
     or not (
       exists (select 1 from public.organization_role_grants g
                where g.organization_id = v_member_org and g.user_id = p_grantee_user_id and g.role = 'coordinator')
       or exists (select 1 from public.member_role_chapters rc
                    join public.member_chapter_memberships cm on cm.user_id = rc.user_id and cm.chapter_id = rc.chapter_id and cm.status = 'active'
                   where rc.user_id = p_grantee_user_id and rc.role = 'coordinator'
                     and rc.chapter_id = (select p.chapter_id from public.member_profiles p where p.id = v_case.user_id)))
  then raise exception 'grantee cannot reach this member through the case organization' using errcode = '22023', detail = 'casework_grantee_outside_case_organization'; end if;
end;
$function$;
revoke all on function private.casework_require_case_access_grantee(uuid, uuid) from public, anon, authenticated, service_role;

-- After a grant is revoked: true when the case is restricted and the caller
-- can no longer reach it (the casework_set_restriction self-lockout rule), so
-- the undo that revokes is refused instead. The forward casework_revoke_access
-- keeps today's behaviour: giving up your own access stays allowed, and the
-- account lifecycle concurrency proof relies on it.
create function private.casework_access_revoke_locks_out(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.member_cases c
    where c.id = p_case_id and c.is_restricted
      and (not private.casework_staff_can_access(c.id) or private.member_case_row_visible(c) is not true));
$function$;
revoke all on function private.casework_access_revoke_locks_out(uuid) from public, anon, authenticated, service_role;

-- The access facet of a case for one grantee, the target every grant and
-- revoke of that pair journals (target id '<case id>:<grantee id>'), so a
-- later grant or revoke by anyone, through any replacement grant row, joins
-- the same undo chain and other-actor check. The state names the active
-- grant row, if any. A grant or revoke of the pair that no learning period
-- journals (another organization's staff) is caught by the audit floor the
-- entries keep, as for assignment and restriction, so a person's own grants
-- and undos never stand in the way of their own earlier undo.
create function private.learning_case_access_state(p_case_id uuid, p_grantee_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when c.id is null then null else pg_catalog.jsonb_build_object(
    'active_grant_id', (
      select a.id from public.casework_access_grants a
      where a.case_id = c.id and a.grantee_user_id = p_grantee_user_id and a.revoked_at is null)) end
  from (select 1) one
  left join public.member_cases c on c.id = p_case_id;
$function$;
revoke all on function private.learning_case_access_state(uuid, uuid) from public, anon, authenticated, service_role;

-- The reversing handler for case_access_grant and case_access_revoke. Undoing
-- a grant revokes the grantee's active grant; undoing a revoke makes the grant
-- it took away active again. Each writes the audit row its normal path writes,
-- and the grant row's case history keeps every step.
create function private.learning_undo_case_access(p_mode text, p_entry jsonb)
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
  target_case uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1)::uuid;
  grantee uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2)::uuid;
  image jsonb := p_entry -> 'before_image';
  case_row public.member_cases%rowtype;
  changed public.casework_access_grants%rowtype;
begin
  if p_mode = 'lock' then
    -- Case before grant, as casework_revoke_access takes them.
    perform 1 from public.member_cases c where c.id = target_case for update;
    perform 1 from public.casework_access_grants g
    where g.case_id = target_case and g.grantee_user_id = grantee
    order by g.id for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_access_state(target_case, grantee);
  elsif p_mode = 'before' then
    return pg_catalog.jsonb_build_object('active_grant_id', image -> 'active_grant_id');
  end if;

  select c.* into case_row from public.member_cases c where c.id = target_case;
  if p_mode = 'check' then
    if case_row.id is null or case_row.organization_id is distinct from (p_entry ->> 'organization_id')::uuid
       or not private.mfa_satisfied() or not private.casework_may_manage_case_access(case_row.id) then
      raise exception 'you can no longer change who can see this case' using errcode = '42501';
    end if;
    -- Someone else granted or revoked this access since, even through a path
    -- no learning period journals (and even back to the same state): their
    -- decision stands.
    if exists (
      select 1 from public.casework_audit_events a
      where a.case_id = target_case and a.event_type in ('access_granted', 'access_revoked')
        and a.metadata ->> 'granteeUserId' = grantee::text
        and a.id > coalesce((image ->> 'audit_floor')::bigint, 0)
        and a.actor_user_id is distinct from caller
    ) then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    -- Giving access back is a new grant, made only to someone you could
    -- grant it to today.
    if p_entry ->> 'action_kind' = 'case_access_revoke' then
      perform private.casework_require_case_access_grantee(case_row.id, grantee);
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if p_entry ->> 'action_kind' = 'case_access_grant' then
    update public.casework_access_grants g set revoked_at = pg_catalog.now(), revoked_by = caller
    where g.case_id = target_case and g.grantee_user_id = grantee and g.revoked_at is null
    returning g.* into changed;
    if changed.id is not null then
      insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
      values (changed.organization_id, changed.chapter_id, changed.case_id, caller, 'access_revoked', 'casework_access_grant', changed.id,
        pg_catalog.jsonb_build_object('granteeUserId', changed.grantee_user_id));
    end if;
    -- The grant may be what lets you into a restricted case: an undo that
    -- would leave you unable to reach it (and so unable to lift or undo its
    -- restriction) is refused, as the assignment undo refuses. Undo the
    -- restriction first.
    if private.casework_access_revoke_locks_out(target_case) then
      raise exception 'undoing this would remove your own access to this restricted case' using errcode = '22023', detail = 'casework_restriction_self_lockout';
    end if;
    return null;
  end if;
  -- Someone already gave the access back: nothing is granted twice.
  if exists (select 1 from public.casework_access_grants g
             where g.case_id = target_case and g.grantee_user_id = grantee and g.revoked_at is null) then
    raise exception 'someone else has changed this since' using errcode = '40001';
  end if;
  -- The same grant comes back, so the pair's grant rows are exactly as they
  -- were before the revoke and an earlier grant of yours stays undoable. Its
  -- revoke stays in the access audit rows and in the case history.
  update public.casework_access_grants g set revoked_at = null, revoked_by = null
  where g.id = (image ->> 'active_grant_id')::uuid
    and g.case_id = target_case and g.grantee_user_id = grantee and g.revoked_at is not null
  returning g.* into changed;
  if changed.id is null then
    raise exception 'this has changed since your practice action' using errcode = '40001';
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (changed.organization_id, changed.chapter_id, changed.case_id, caller, 'access_granted', 'casework_access_grant', changed.id,
    pg_catalog.jsonb_build_object('granteeUserId', changed.grantee_user_id));
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_case_access(text, jsonb) from public, anon, authenticated, service_role;

-- Re-emitted from 20261021034151: the caller and grantee rules now come from
-- the two helpers above (unchanged), and a new grant is journalled.
create or replace function public.casework_grant_access(p_case_id uuid, p_grantee_user_id uuid, p_reason text)
returns public.casework_access_grants
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_case public.member_cases%rowtype; v_row public.casework_access_grants%rowtype; v_before jsonb;
begin
  perform private.casework_require_mfa();
  select * into strict v_case from public.member_cases where id = p_case_id for share;
  if not private.casework_may_manage_case_access(v_case.id)
  then raise exception 'case not found' using errcode = 'P0002'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 8 and 500
  then raise exception 'grant reason must be 8 to 500 characters' using errcode = '22023', detail = 'casework_grant_reason_invalid'; end if;
  perform private.casework_require_case_access_grantee(v_case.id, p_grantee_user_id);
  select * into v_row from public.casework_access_grants where case_id = v_case.id and grantee_user_id = p_grantee_user_id and revoked_at is null;
  if found then return v_row; end if;
  v_before := private.learning_case_access_state(v_case.id, p_grantee_user_id);
  insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, p_grantee_user_id, (select auth.uid()), pg_catalog.btrim(p_reason)) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'access_granted', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', p_grantee_user_id));
  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103.
  if private.learning_case_in_own_organization(v_case.id) then
    perform private.learning_journal_append(
      'case_access_grant', 'public.casework_access_grants', v_case.id::text || ':' || p_grantee_user_id::text, null,
      private.learning_fingerprint(private.learning_case_access_state(v_case.id, p_grantee_user_id)), null,
      v_before || pg_catalog.jsonb_build_object('audit_floor', (
        select pg_catalog.max(a.id) from public.casework_audit_events a
        where a.case_id = v_case.id and a.event_type in ('access_granted', 'access_revoked')
          and a.metadata ->> 'granteeUserId' = p_grantee_user_id::text)));
  end if;
  return v_row;
end;
end;
$function$;

-- Re-emitted from the live definition (20260907150000) with a revoke
-- journalled. Its caller check stays inline and verbatim (the account
-- lifecycle concurrency proof pauses the installed body at that line); it is
-- the same rule as private.casework_may_manage_case_access.
create or replace function public.casework_revoke_access(p_grant_id uuid)
returns public.casework_access_grants
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_access_grants%rowtype; v_before jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  -- Resolve the parent without a child lock, then acquire case before grant.
  -- Re-read the grant after waiting; the case may have been deleted meanwhile.
  select * into strict v_row from public.casework_access_grants where id = p_grant_id;
  perform 1 from public.member_cases where id = v_row.case_id for update;
  if not found then raise exception 'grant not found' using errcode = 'P0002'; end if;
  select * into strict v_row from public.casework_access_grants where id = p_grant_id for update;
  if not private.casework_staff_can_access(v_row.case_id)
     or not (private.member_has_chapter_role(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role(v_row.organization_id, array['advisor','admin','vp']))
  then raise exception 'grant not found' using errcode = 'P0002'; end if;
  if v_row.revoked_at is not null then return v_row; end if;
  v_before := private.learning_case_access_state(v_row.case_id, v_row.grantee_user_id);
  update public.casework_access_grants set revoked_at = pg_catalog.now(), revoked_by = (select auth.uid()) where id = v_row.id returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'access_revoked', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', v_row.grantee_user_id));
  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103.
  if private.learning_case_in_own_organization(v_row.case_id) then
    perform private.learning_journal_append(
      'case_access_revoke', 'public.casework_access_grants', v_row.case_id::text || ':' || v_row.grantee_user_id::text, null,
      private.learning_fingerprint(private.learning_case_access_state(v_row.case_id, v_row.grantee_user_id)), null,
      v_before || pg_catalog.jsonb_build_object('audit_floor', (
        select pg_catalog.max(a.id) from public.casework_audit_events a
        where a.case_id = v_row.case_id and a.event_type in ('access_granted', 'access_revoked')
          and a.metadata ->> 'granteeUserId' = v_row.grantee_user_id::text)));
  end if;
  return v_row;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Restriction
-- ---------------------------------------------------------------------------
-- The restriction facet of a case.
create function private.learning_case_restriction_state(p_case_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when c.id is null then null else pg_catalog.jsonb_build_object(
    'is_restricted', c.is_restricted, 'restriction_reason', c.restriction_reason) end
  from (select 1) one
  left join public.member_cases c on c.id = p_case_id;
$function$;
revoke all on function private.learning_case_restriction_state(uuid) from public, anon, authenticated, service_role;

-- The reversing handler for case_restriction. Only someone who may set the
-- case's restriction today (casework_set_restriction's rule) can put the
-- earlier one back, so an undo never leaves a case less restricted than they
-- could set it, and putting a restriction back may not lock them out.
create function private.learning_undo_case_restriction(p_mode text, p_entry jsonb)
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
  case_row public.member_cases%rowtype;
  restored_by uuid := (p_entry -> 'before_image' ->> 'restricted_by')::uuid;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_restriction_state(target);
  elsif p_mode = 'before' then
    return pg_catalog.jsonb_build_object(
      'is_restricted', image -> 'is_restricted', 'restriction_reason', image -> 'restriction_reason');
  elsif p_mode = 'check' then
    select c.* into case_row from public.member_cases c where c.id = target;
    if case_row.id is null or case_row.organization_id is distinct from (p_entry ->> 'organization_id')::uuid
       or not private.mfa_satisfied() or not private.casework_staff_can_access(target) then
      raise exception 'you can no longer change this case''s restriction' using errcode = '42501';
    end if;
    -- Someone else changed the restriction since, even through a path no
    -- learning period journals (and even back to the same values): their
    -- decision stands.
    if exists (
      select 1 from public.casework_audit_events a
      where a.case_id = target and a.event_type = 'restriction_changed'
        and a.id > coalesce((image ->> 'audit_floor')::bigint, 0)
        and a.actor_user_id is distinct from (select auth.uid())
    ) then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  -- A restriction put back names who restricted it. When that account is
  -- gone (detached to null, or deleted since the before-image), the person
  -- restoring it now is the attribution.
  if (image ->> 'is_restricted')::boolean
     and (restored_by is null or not exists (select 1 from auth.users u where u.id = restored_by)) then
    restored_by := (select auth.uid());
  end if;
  update public.member_cases set
    is_restricted = (image ->> 'is_restricted')::boolean,
    restriction_reason = image ->> 'restriction_reason',
    restricted_at = case when (image ->> 'is_restricted')::boolean
      then coalesce((image ->> 'restricted_at')::timestamptz, pg_catalog.now()) end,
    restricted_by = case when (image ->> 'is_restricted')::boolean then restored_by end,
    updated_at = pg_catalog.now()
  where id = target returning * into case_row;
  if case_row.is_restricted
     and (not private.casework_staff_can_access(target) or private.member_case_row_visible(case_row) is not true) then
    raise exception 'restricting this case would remove your own access to it' using errcode = '22023', detail = 'casework_restriction_self_lockout';
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (case_row.organization_id, case_row.chapter_id, case_row.id, (select auth.uid()), 'restriction_changed', 'case', case_row.id,
    pg_catalog.jsonb_build_object('restricted', case_row.is_restricted));
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_case_restriction(text, jsonb) from public, anon, authenticated, service_role;

-- Re-emitted from 20261006040000 with the journal call after the audit row.
create or replace function public.casework_set_restriction(p_case_id uuid, p_restricted boolean, p_reason text)
returns public.member_cases
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare v_case public.member_cases%rowtype; v_before jsonb;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_restricted and pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 8 and 500 then raise exception 'restriction reason is required' using errcode = '22023'; end if;
  select pg_catalog.jsonb_build_object('is_restricted', c.is_restricted, 'restriction_reason', c.restriction_reason,
      'restricted_at', c.restricted_at, 'restricted_by', c.restricted_by)
    into v_before
  from public.member_cases c where c.id = p_case_id;
  update public.member_cases set
    is_restricted = p_restricted,
    restriction_reason = case when p_restricted then pg_catalog.btrim(p_reason) else null end,
    restricted_at = case when p_restricted then pg_catalog.now() else null end,
    restricted_by = case when p_restricted then (select auth.uid()) else null end,
    updated_at = pg_catalog.now()
  where id = p_case_id returning * into v_case;
  if p_restricted and (not private.casework_staff_can_access(p_case_id) or private.member_case_row_visible(v_case) is not true)
  then raise exception 'restricting this case would remove your own access to it' using errcode = '22023', detail = 'casework_restriction_self_lockout'; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'restriction_changed', 'case', v_case.id, pg_catalog.jsonb_build_object('restricted', p_restricted));
  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103.
  if private.learning_case_in_own_organization(v_case.id) then
    perform private.learning_journal_append(
      'case_restriction', 'private.learning_case_restriction', v_case.id::text, null,
      private.learning_fingerprint(private.learning_case_restriction_state(v_case.id)), null,
      v_before || pg_catalog.jsonb_build_object('audit_floor', (
        select pg_catalog.max(a.id) from public.casework_audit_events a
        where a.case_id = v_case.id and a.event_type = 'restriction_changed')));
  end if;
  return v_case;
end;
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Retaliation reports and pattern notes: recorded and kept
-- ---------------------------------------------------------------------------
-- A retaliation report's text and its withdrawal reason are sealed on the
-- reporter's device (sensitive_envelopes, 20260906190000): the withdraw path
-- needs an envelope only the reporter's client can make, and clearing a
-- withdrawal would have to change a sealed field in plaintext. A server-side
-- undo could do neither safely, and practising a report without effect would
-- hold back a real report of retaliation. So submitting and withdrawing your
-- own report, and a note on a pattern review, are journalled metadata-only
-- and kept (never marked as practice), and the report's own withdraw path
-- stays the way to take a submission back.

-- Re-emitted from the live definition (20260828210000 as rewritten by
-- 20260906190000 and 20261104075000, which skips an undone case) with a new
-- report journalled; a replay of the same submission is not.
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

declare v_case public.member_cases%rowtype; v_row public.casework_retaliation_reports%rowtype; v_new boolean;
begin
  perform private.casework_require_mfa();
  select * into strict v_case from public.member_cases where id = p_case_id and learning_undone_at is null and user_id = (select auth.uid()) for share;
  if v_case.organization_id is null or v_case.chapter_id is null then raise exception 'case not found' using errcode = 'P0002'; end if;
  insert into public.casework_retaliation_reports(id, organization_id, chapter_id, reporter_user_id, case_id, incident_at, management_person, protected_activity, adverse_action, requested_support, idempotency_key)
  values (p_idempotency_key, v_case.organization_id, v_case.chapter_id, (select auth.uid()), v_case.id, p_incident_at, pg_catalog.btrim(p_management_person), pg_catalog.btrim(p_protected_activity), pg_catalog.btrim(p_adverse_action), nullif(pg_catalog.btrim(p_requested_support), ''), p_idempotency_key)
  on conflict (organization_id, reporter_user_id, idempotency_key) do nothing
  returning * into v_row;
  v_new := found;
  if not v_new then select * into strict v_row from public.casework_retaliation_reports where organization_id = v_case.organization_id and reporter_user_id = (select auth.uid()) and idempotency_key = p_idempotency_key; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'retaliation_submitted', 'retaliation_report', v_row.id);
  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103: kept.
  if v_new then
    perform private.learning_journal_append('retaliation_report_submit', 'public.casework_retaliation_reports', v_row.id::text);
  end if;
  return v_row;
end;
end;
$function$;

-- Re-emitted from 20260907150000 with the withdrawal journalled.
create or replace function public.casework_withdraw_retaliation_report(p_report_id uuid, p_reason text)
returns public.casework_retaliation_reports
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_retaliation_reports%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  update public.casework_retaliation_reports set status = 'withdrawn', withdrawn_at = pg_catalog.now(), withdrawal_reason = pg_catalog.btrim(p_reason), updated_at = pg_catalog.now()
  where id = p_report_id and reporter_user_id = (select auth.uid()) and status = 'submitted' returning * into v_row;
  if not found then raise exception 'report not found or cannot be withdrawn' using errcode = 'P0002'; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'retaliation_withdrawn', 'retaliation_report', v_row.id);
  -- Reporter ownership above is the exact live and retained write predicate.
  -- Preserve the reader scope of the resulting audit when the case is gone.
  insert into private.account_lifecycle_history_scope(kind, record_id, case_id)
  select 'casework_audit', a.id::text, h.case_id
  from public.casework_audit_events a
  join private.account_lifecycle_history_scope h on h.kind = 'retaliation_report' and h.record_id = v_row.id::text
  where a.entity_id = v_row.id and a.entity_type = 'retaliation_report'
  on conflict (kind, record_id) do update set case_id = excluded.case_id;
  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103: kept.
  perform private.learning_journal_append('retaliation_report_withdraw', 'public.casework_retaliation_reports', v_row.id::text);
  return v_row;
end;
$function$;

-- Re-emitted from the live definition (20260828210000, graph lock first)
-- with a note it adds journalled as kept.
create or replace function public.casework_review_retaliation_pattern(p_pattern_id uuid, p_status text, p_disposition text, p_note text)
returns public.casework_retaliation_patterns
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_row public.casework_retaliation_patterns%rowtype; v_note_id uuid;
begin
  perform private.casework_require_mfa();
  if p_status not in ('flagged','investigating','substantiated','dismissed') then raise exception 'invalid pattern status' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_retaliation_patterns where id = p_pattern_id for update;
  if not ((v_row.chapter_id is not null and private.member_has_chapter_role(v_row.chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(v_row.organization_id, array['coordinator','advisor','admin','vp'])) then raise exception 'pattern not found' using errcode = 'P0002'; end if;
  update public.casework_retaliation_patterns set status = p_status, disposition = nullif(pg_catalog.btrim(p_disposition), ''), reviewed_by = (select auth.uid()), reviewed_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  if nullif(pg_catalog.btrim(p_note), '') is not null then
    insert into public.casework_retaliation_pattern_notes(pattern_id, organization_id, body, created_by) values (v_row.id, v_row.organization_id, pg_catalog.btrim(p_note), (select auth.uid()))
    returning id into v_note_id;
    -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103: kept.
    perform private.learning_journal_append('retaliation_pattern_note', 'public.casework_retaliation_pattern_notes', v_note_id::text);
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, (select auth.uid()), 'pattern_reviewed', 'retaliation_pattern', v_row.id, pg_catalog.jsonb_build_object('status', p_status));
  return v_row;
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Dispatch
-- ---------------------------------------------------------------------------
-- Hand-off, as 20261104111500 does: the dispatcher installed when this
-- applies (every earlier slice's handlers) keeps its body under a new name,
-- and the new dispatcher sends this slice's three handlers to them and every
-- other handler to it. No earlier slice's branch is copied, so none can be
-- dropped whichever order the slices land in.
alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_case_access;
comment on function private.learning_dispatch_before_case_access(text, text, jsonb) is
  'REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103: the undo dispatcher as the slices before slice 4 left it, reached only through private.learning_dispatch.';

create function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb)
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
    when 'private.learning_undo_case_assignment' then return private.learning_undo_case_assignment(p_mode, p_entry);
    when 'private.learning_undo_case_access' then return private.learning_undo_case_access(p_mode, p_entry);
    when 'private.learning_undo_case_restriction' then return private.learning_undo_case_restriction(p_mode, p_entry);
    else return private.learning_dispatch_before_case_access(p_handler, p_mode, p_entry);
  end case;
end;
$function$;
revoke all on function private.learning_dispatch(text, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Account lifecycle trigger review
-- ---------------------------------------------------------------------------
-- The sealed-field trigger names the two retaliation writers, so they are
-- reachable from a trigger; journalling them makes the engine's append and
-- its clock check reachable too. Record the four new definitions, and refuse
-- to commit if the review is left incomplete.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function'
  and ((s.schema_name = 'public' and s.object_name in (
         'casework_submit_retaliation_report(p_case_id uuid, p_incident_at timestamp with time zone, p_management_person text, p_protected_activity text, p_adverse_action text, p_requested_support text, p_idempotency_key uuid)',
         'casework_withdraw_retaliation_report(p_report_id uuid, p_reason text)'))
    or (s.schema_name = 'private' and s.object_name in (
         'learning_journal_append(p_action_kind text, p_target_table text, p_target_id text, p_parent_entry_id uuid, p_after_fingerprint text, p_before_ref bigint, p_before_image jsonb)',
         'learning_period_running(p_organization_id uuid)')))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_learning_case_access_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the learning period case access slice';
  end if;
end;
$assert_learning_case_access_trigger_review$;

notify pgrst, 'reload schema';
commit;
