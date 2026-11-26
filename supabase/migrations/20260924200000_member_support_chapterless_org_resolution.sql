-- Chapterless single-organization staff must reach member support.
--
-- BUG-UG-MEMBER-SUPPORT-RPCS-REQUIRE-HOME-CHAPTER-FOR-CHAPTERLESS-STAFF-20260921
--
-- Every public member-support RPC resolved its organization through
-- private.mi1_require_selected_organization(), which reads only
-- private.current_member_organization() — the organization behind the caller's
-- SELECTED CHAPTER. An organization administrator who holds an active
-- organization_memberships row and an organization_role_grants grant but no
-- member_chapter_memberships row therefore got 42501 'active organization
-- membership required' from get_member_support_workspace, and the desk stuck on
-- a generic "Member support is not available" retry that could never succeed.
-- The same session already resolves through private.mi1_w2_selected_organization()
-- for member operations and through private.current_mobile_staff_organization()
-- for native staff scope, so member support was the outlier.
--
-- This migration is append-only: it re-creates the affected definitions rather
-- than editing migrations already applied on Main.
--
--   1. private.member_support_selected_organization() resolves the organization
--      through private.mi1_w2_selected_organization() (selected chapter first,
--      then the single active organization membership for a chapterless
--      caller) while KEEPING the authentication/MFA error vocabulary the
--      previous helper raised, so the client still distinguishes
--      'mfa required' from an authorization refusal. Multiple active
--      organizations stay fail-closed: mi1_w2 resolves null and the helper
--      raises 'active organization membership required'.
--   2. The fifteen public member-support RPCs call the new helper.
--   3. public.initiate_member_handoff() still requires a selected chapter — a
--      handoff writes chapter_id — but says so honestly instead of returning
--      the same opaque 'not authorized' it returns for a foreign chapter.
--   4. public.get_my_chapter_memberships() emits one organization-level
--      selected row for a chapterless single-organization caller so the web
--      member snapshot stops reporting "Organization setup is still empty" for
--      an organization that exists. Callers with any active chapter membership
--      are untouched.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.member_support_selected_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  -- Chapterless single-organization resolution, identical to the one member
  -- operations and native staff scope already use. Zero or multiple active
  -- organizations raise 'active organization membership required'.
  return private.mi1_w2_selected_organization();
end;
$function$;

revoke all on function private.member_support_selected_organization()
  from public, anon, authenticated, service_role;

-- Every member-support write records an event through this guard, and the guard
-- re-derived the organization from private.current_member_organization() — the
-- chapter-derived organization again. Widening only the RPCs would have let the
-- desk load for organization-only staff and then refused every write it offers.
create or replace function private.member_support_record_event(
  p_id uuid,
  p_organization_id uuid,
  p_member_user_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_event_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is distinct from private.member_support_selected_organization() then
    raise exception 'organization is derived from the session' using errcode = '42501';
  end if;
  insert into public.member_support_events (
    id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type
  ) values (
    p_id, p_organization_id, (select auth.uid()), p_member_user_id, p_entity_type, p_entity_id, p_event_type
  ) on conflict (id) do nothing;
end
$function$;

create or replace function public.get_member_support_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.member_support_selected_organization();
  staff boolean := private.member_support_is_staff(org);
begin
  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', org,
    'staff', staff,
    'emergencyChecklists', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'memberUserId', c.member_user_id,
        'memberLabel', private.member_support_member_label(c.member_user_id),
        'scenario', c.scenario, 'status', c.status,
        'completedSteps', c.completed_steps, 'notes', c.notes,
        'alertedAt', c.alerted_at, 'resolvedAt', c.resolved_at, 'updatedAt', c.updated_at
      ) order by c.updated_at desc)
      from public.member_emergency_checklists c
      where c.organization_id = org
        and (c.member_user_id = caller or (staff and c.status = 'alerted'))
    ), '[]'::jsonb),
    'accommodations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'memberUserId', a.member_user_id,
        'memberLabel', private.member_support_member_label(a.member_user_id),
        'requestType', a.request_type, 'description', a.description,
        'status', a.status, 'staffNote', a.staff_note,
        'submittedAt', a.submitted_at, 'resolvedAt', a.resolved_at, 'updatedAt', a.updated_at
      ) order by a.submitted_at desc)
      from public.member_accommodation_requests a
      where a.organization_id = org and (a.member_user_id = caller or staff)
    ), '[]'::jsonb),
    'accommodationSummary', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff)),
      'open', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status in ('submitted', 'under_review')),
      'approved', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'approved'),
      'denied', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'denied'),
      'withdrawn', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'withdrawn')
    ),
    'hrDirectory', (
      select pg_catalog.jsonb_build_object(
        'id', d.organization_id, 'name', d.name, 'title', d.title,
        'department', d.department, 'email', d.email, 'phone', d.phone,
        'hours', d.hours, 'notes', d.notes, 'enabled', d.enabled
      ) from public.organization_hr_directory d
      where d.organization_id = org and d.enabled
    ),
    'hrContacts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id, 'memberUserId', h.member_user_id,
        'memberLabel', private.member_support_member_label(h.member_user_id),
        'channel', h.channel, 'purpose', h.purpose, 'disposition', h.disposition,
        'note', h.note, 'occurredAt', h.occurred_at,
        'followUpOn', h.follow_up_on, 'createdAt', h.created_at
      ) order by h.occurred_at desc)
      from public.member_hr_contacts h
      where h.organization_id = org and (h.member_user_id = caller or staff)
    ), '[]'::jsonb),
    'onboardingProgram', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id, 'title', s.title, 'description', s.description,
        'position', s.position, 'active', s.active
      ) order by s.position, s.id)
      from public.organization_onboarding_steps s
      where s.organization_id = org and (s.active or staff)
    ), '[]'::jsonb),
    'onboardingPlan', (
      select pg_catalog.jsonb_build_object(
        'id', p.id, 'memberUserId', p.member_user_id, 'status', p.status,
        'completedStepIds', p.completed_step_ids, 'startedAt', p.started_at,
        'completedAt', p.completed_at,
        'assignedByLabel', private.member_support_member_label(p.assigned_by)
      ) from public.member_onboarding_plans p
      where p.organization_id = org and p.member_user_id = caller
    ),
    'onboardingRoster', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'memberUserId', p.member_user_id,
        'memberLabel', private.member_support_member_label(p.member_user_id),
        'status', p.status, 'completedStepIds', p.completed_step_ids,
        'startedAt', p.started_at, 'completedAt', p.completed_at
      ) order by p.updated_at desc)
      from public.member_onboarding_plans p where p.organization_id = org
    ), '[]'::jsonb) else '[]'::jsonb end,
    'mentorshipPairs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'mentorUserId', p.mentor_user_id, 'menteeUserId', p.mentee_user_id,
        'mentorLabel', private.member_support_member_label(p.mentor_user_id),
        'menteeLabel', private.member_support_member_label(p.mentee_user_id),
        'status', p.status, 'startedOn', p.started_on, 'endedOn', p.ended_on,
        'outcome', p.outcome,
        'goals', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', g.id, 'title', g.title, 'completed', g.completed,
          'completedAt', g.completed_at
        ) order by g.created_at) from public.member_mentorship_goals g where g.pair_id = p.id), '[]'::jsonb),
        'notes', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', n.id, 'authorLabel', private.member_support_member_label(n.author_user_id),
          'body', n.body, 'createdAt', n.created_at
        ) order by n.created_at desc) from public.member_mentorship_notes n where n.pair_id = p.id), '[]'::jsonb)
      ) order by p.updated_at desc)
      from public.member_mentorship_pairs p
      where p.organization_id = org
        and (p.mentor_user_id = caller or p.mentee_user_id = caller or staff)
    ), '[]'::jsonb),
    'mentorshipDirectory', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', m.user_id, 'label', private.member_support_member_label(m.user_id),
        'chapterId', p.chapter_id
      ) order by private.member_support_member_label(m.user_id), m.user_id)
      from public.organization_memberships m
      join public.member_profiles p on p.id = m.user_id
      where m.organization_id = org and m.status = 'active'
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end
$function$;

create or replace function public.save_member_emergency_checklist(
  p_scenario text,
  p_completed_steps integer[],
  p_notes text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.member_support_selected_organization(); row_out record;
begin
  if p_scenario not in ('disciplinary_meeting', 'pre_discipline_response', 'unsafe_work')
    or coalesce(pg_catalog.cardinality(p_completed_steps), 0) > 16
    or exists (select 1 from pg_catalog.unnest(coalesce(p_completed_steps, '{}')) step where step not between 0 and 3)
    or pg_catalog.char_length(coalesce(p_notes, '')) > 4000 then
    raise exception 'invalid emergency checklist' using errcode = '22023';
  end if;
  insert into public.member_emergency_checklists (
    organization_id, member_user_id, scenario, completed_steps, notes
  ) values (org, caller, p_scenario, coalesce(p_completed_steps, '{}')::smallint[], coalesce(p_notes, ''))
  on conflict (organization_id, member_user_id, scenario) do update set
    completed_steps = excluded.completed_steps, notes = excluded.notes, updated_at = pg_catalog.now()
  returning id, status, updated_at into row_out;
  perform private.member_support_record_event(p_idempotency_key, org, caller, 'emergency_checklist', row_out.id, 'saved');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'updatedAt', row_out.updated_at);
end
$function$;

create or replace function public.alert_member_emergency_steward(
  p_scenario text,
  p_completed_steps integer[],
  p_notes text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.member_support_selected_organization(); row_out record;
begin
  if p_scenario not in ('disciplinary_meeting', 'pre_discipline_response', 'unsafe_work')
    or coalesce(pg_catalog.cardinality(p_completed_steps), 0) > 16
    or exists (select 1 from pg_catalog.unnest(coalesce(p_completed_steps, '{}')) step where step not between 0 and 3)
    or pg_catalog.char_length(coalesce(p_notes, '')) > 4000 then
    raise exception 'invalid emergency alert' using errcode = '22023';
  end if;
  insert into public.member_emergency_checklists (
    organization_id, member_user_id, scenario, status, completed_steps, notes, alerted_at
  ) values (org, caller, p_scenario, 'alerted', coalesce(p_completed_steps, '{}')::smallint[], coalesce(p_notes, ''), pg_catalog.now())
  on conflict (organization_id, member_user_id, scenario) do update set
    status = 'alerted', completed_steps = excluded.completed_steps, notes = excluded.notes,
    alerted_at = coalesce(public.member_emergency_checklists.alerted_at, pg_catalog.now()),
    resolved_at = null, updated_at = pg_catalog.now()
  returning id, alerted_at into row_out;
  insert into public.member_steward_requests (id, user_id, lesson_id)
  values (p_idempotency_key, caller, null)
  on conflict (id) do nothing;
  perform private.member_support_record_event(p_idempotency_key, org, caller, 'emergency_checklist', row_out.id, 'alerted');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', 'alerted', 'alertedAt', row_out.alerted_at);
end
$function$;

create or replace function public.resolve_member_emergency_checklist(
  p_checklist_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.member_support_selected_organization();
  row_out record;
begin
  update public.member_emergency_checklists checklist
  set status = 'resolved', resolved_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where checklist.id = p_checklist_id
    and checklist.organization_id = org
    and checklist.status = 'alerted'
    and (checklist.member_user_id = caller or private.member_support_is_staff(org))
  returning checklist.id, checklist.member_user_id, checklist.resolved_at into row_out;
  if row_out.id is null then
    raise exception 'open emergency alert not found in selected organization' using errcode = '22023';
  end if;
  perform private.member_support_record_event(
    p_idempotency_key, org, row_out.member_user_id,
    'emergency_checklist', row_out.id, 'transitioned'
  );
  return pg_catalog.jsonb_build_object(
    'id', row_out.id, 'status', 'resolved', 'resolvedAt', row_out.resolved_at
  );
end
$function$;

create or replace function public.create_member_accommodation_request(
  p_request_type text,
  p_description text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.member_support_selected_organization(); row_out record;
begin
  if p_request_type not in ('schedule', 'equipment', 'workspace', 'leave', 'communication', 'remote_work', 'other')
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_description, ''))) not between 1 and 4000 then
    raise exception 'invalid accommodation request' using errcode = '22023';
  end if;
  insert into public.member_accommodation_requests (
    id, organization_id, member_user_id, request_type, description
  ) values (p_idempotency_key, org, caller, p_request_type, pg_catalog.btrim(p_description))
  on conflict (id) do nothing;
  select id, status, submitted_at into row_out
  from public.member_accommodation_requests
  where id = p_idempotency_key and organization_id = org and member_user_id = caller;
  if row_out.id is null then raise exception 'idempotency key belongs to another request' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, caller, 'accommodation_request', row_out.id, 'created');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'submittedAt', row_out.submitted_at);
end
$function$;

create or replace function public.transition_member_accommodation_request(
  p_request_id uuid,
  p_status text,
  p_staff_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.member_support_selected_organization(); staff boolean := private.member_support_is_staff(org); row_out record;
begin
  if p_status not in ('under_review', 'approved', 'denied', 'withdrawn')
    or pg_catalog.char_length(coalesce(p_staff_note, '')) > 2000 then
    raise exception 'invalid accommodation transition' using errcode = '22023';
  end if;
  if p_status = 'withdrawn' then
    update public.member_accommodation_requests set
      status = 'withdrawn', resolved_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_request_id and organization_id = org and member_user_id = caller
      and status in ('submitted', 'under_review')
    returning id, member_user_id, status, resolved_at into row_out;
  elsif staff then
    update public.member_accommodation_requests set
      status = p_status, staff_note = coalesce(p_staff_note, ''),
      resolved_at = case when p_status in ('approved', 'denied') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
    where id = p_request_id and organization_id = org
      and status not in ('withdrawn')
    returning id, member_user_id, status, resolved_at into row_out;
  else
    raise exception 'staff role and MFA required' using errcode = '42501';
  end if;
  if row_out.id is null then raise exception 'request not found or transition refused' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, row_out.member_user_id, 'accommodation_request', row_out.id, case when p_status = 'withdrawn' then 'withdrawn' else 'transitioned' end);
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'resolvedAt', row_out.resolved_at);
end
$function$;

create or replace function public.record_member_hr_contact(
  p_member_user_id uuid,
  p_channel text,
  p_purpose text,
  p_disposition text,
  p_note text,
  p_occurred_at timestamptz,
  p_follow_up_on date,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.member_support_selected_organization(); target uuid := coalesce(p_member_user_id, caller); row_out record;
begin
  if target <> caller and not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if not exists (select 1 from public.organization_memberships m where m.organization_id = org and m.user_id = target and m.status = 'active') then raise exception 'member not found' using errcode = '22023'; end if;
  if p_channel not in ('email', 'phone', 'meeting', 'letter', 'portal', 'other')
    or p_disposition not in ('planned', 'attempted', 'reached', 'follow_up_due', 'resolved')
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose, ''))) not between 1 and 240
    or pg_catalog.char_length(coalesce(p_note, '')) > 4000
    or (p_disposition = 'follow_up_due' and p_follow_up_on is null) then
    raise exception 'invalid HR contact' using errcode = '22023';
  end if;
  insert into public.member_hr_contacts (
    id, organization_id, member_user_id, actor_user_id, channel, purpose,
    disposition, note, occurred_at, follow_up_on
  ) values (
    p_idempotency_key, org, target, caller, p_channel, pg_catalog.btrim(p_purpose),
    p_disposition, coalesce(p_note, ''), coalesce(p_occurred_at, pg_catalog.now()), p_follow_up_on
  ) on conflict (id) do nothing
  returning id, disposition, occurred_at into row_out;
  if row_out.id is null then
    select id, disposition, occurred_at into row_out from public.member_hr_contacts
    where id = p_idempotency_key and organization_id = org and member_user_id = target;
  end if;
  if row_out.id is null then raise exception 'idempotency key belongs to another contact' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, target, 'hr_contact', row_out.id, 'created');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'disposition', row_out.disposition, 'occurredAt', row_out.occurred_at);
end
$function$;

create or replace function public.save_organization_hr_directory(
  p_name text,
  p_title text,
  p_department text,
  p_email text,
  p_phone text,
  p_hours text,
  p_notes text,
  p_enabled boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.member_support_selected_organization(); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if pg_catalog.char_length(coalesce(p_name, '')) > 160
    or pg_catalog.char_length(coalesce(p_title, '')) > 160
    or pg_catalog.char_length(coalesce(p_department, '')) > 160
    or pg_catalog.char_length(coalesce(p_email, '')) > 320
    or (coalesce(p_email, '') <> '' and p_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or pg_catalog.char_length(coalesce(p_phone, '')) > 80
    or pg_catalog.char_length(coalesce(p_hours, '')) > 500
    or pg_catalog.char_length(coalesce(p_notes, '')) > 2000 then
    raise exception 'invalid HR directory' using errcode = '22023';
  end if;
  insert into public.organization_hr_directory (
    organization_id, name, title, department, email, phone, hours, notes, enabled, updated_by
  ) values (
    org, coalesce(p_name, ''), coalesce(p_title, ''), coalesce(p_department, ''),
    coalesce(p_email, ''), coalesce(p_phone, ''), coalesce(p_hours, ''),
    coalesce(p_notes, ''), coalesce(p_enabled, true), caller
  ) on conflict (organization_id) do update set
    name = excluded.name, title = excluded.title, department = excluded.department,
    email = excluded.email, phone = excluded.phone, hours = excluded.hours,
    notes = excluded.notes, enabled = excluded.enabled, updated_by = caller,
    updated_at = pg_catalog.now()
  returning organization_id, enabled, updated_at into row_out;
  perform private.member_support_record_event(p_idempotency_key, org, null, 'hr_directory', row_out.organization_id, 'configured');
  return pg_catalog.jsonb_build_object('id', row_out.organization_id, 'enabled', row_out.enabled, 'updatedAt', row_out.updated_at);
end
$function$;

create or replace function public.save_organization_onboarding_step(
  p_step_id uuid,
  p_title text,
  p_description text,
  p_position integer,
  p_active boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.member_support_selected_organization(); step_id uuid := coalesce(p_step_id, p_idempotency_key); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 160
    or pg_catalog.char_length(coalesce(p_description, '')) > 2000
    or p_position not between 0 and 1000 then raise exception 'invalid onboarding step' using errcode = '22023'; end if;
  begin
    insert into public.organization_onboarding_steps (
      id, organization_id, title, description, position, active, created_by
    ) values (
      step_id, org, pg_catalog.btrim(p_title), coalesce(p_description, ''), p_position, coalesce(p_active, true), (select auth.uid())
    ) on conflict (id) do update set
      title = excluded.title, description = excluded.description, position = excluded.position,
      active = excluded.active, updated_at = pg_catalog.now()
    where public.organization_onboarding_steps.organization_id = org
    returning id, position, active, updated_at into row_out;
  exception when unique_violation then
    raise exception 'onboarding position already in use' using errcode = '22023';
  end;
  if row_out.id is null then raise exception 'step not found in selected organization' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, null, 'onboarding_step', row_out.id, 'configured');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'position', row_out.position, 'active', row_out.active, 'updatedAt', row_out.updated_at);
end
$function$;

create or replace function public.start_member_onboarding_plan(
  p_member_user_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.member_support_selected_organization(); target uuid := coalesce(p_member_user_id, caller); row_out record;
begin
  if target <> caller and not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if not exists (select 1 from public.organization_memberships m where m.organization_id = org and m.user_id = target and m.status = 'active') then raise exception 'member not found' using errcode = '22023'; end if;
  if not exists (select 1 from public.organization_onboarding_steps s where s.organization_id = org and s.active) then raise exception 'onboarding program is not configured' using errcode = '22023'; end if;
  insert into public.member_onboarding_plans (
    id, organization_id, member_user_id, assigned_by
  ) values (p_idempotency_key, org, target, caller)
  on conflict (organization_id, member_user_id) do nothing;
  select id, status, started_at, completed_at into row_out
  from public.member_onboarding_plans where organization_id = org and member_user_id = target;
  perform private.member_support_record_event(p_idempotency_key, org, target, 'onboarding_plan', row_out.id, 'started');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'startedAt', row_out.started_at, 'completedAt', row_out.completed_at);
end
$function$;

create or replace function public.complete_member_onboarding_step(
  p_step_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.member_support_selected_organization(); plan record; step_position integer; remaining integer; completed uuid[];
begin
  select * into plan from public.member_onboarding_plans
  where organization_id = org and member_user_id = caller for update;
  if plan.id is null then raise exception 'onboarding plan not found' using errcode = '22023'; end if;
  select s.position into step_position from public.organization_onboarding_steps s
  where s.id = p_step_id and s.organization_id = org and s.active;
  if step_position is null then raise exception 'onboarding step not found' using errcode = '22023'; end if;
  if exists (
    select 1 from public.organization_onboarding_steps earlier
    where earlier.organization_id = org and earlier.active and earlier.position < step_position
      and not (earlier.id = any(plan.completed_step_ids))
  ) then raise exception 'onboarding steps must be completed in order' using errcode = '22023'; end if;
  completed := array(select distinct value from pg_catalog.unnest(plan.completed_step_ids || p_step_id) value);
  select pg_catalog.count(*) into remaining from public.organization_onboarding_steps s
  where s.organization_id = org and s.active and not (s.id = any(completed));
  update public.member_onboarding_plans set
    completed_step_ids = completed,
    status = case when remaining = 0 then 'completed' else 'in_progress' end,
    started_at = coalesce(started_at, pg_catalog.now()),
    completed_at = case when remaining = 0 then coalesce(completed_at, pg_catalog.now()) else null end,
    updated_at = pg_catalog.now()
  where id = plan.id;
  perform private.member_support_record_event(p_idempotency_key, org, caller, 'onboarding_plan', plan.id, 'step_completed');
  return pg_catalog.jsonb_build_object('id', plan.id, 'status', case when remaining = 0 then 'completed' else 'in_progress' end, 'completedStepIds', completed);
end
$function$;

create or replace function public.create_member_mentorship_pair(
  p_mentor_user_id uuid,
  p_mentee_user_id uuid,
  p_started_on date,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.member_support_selected_organization(); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if p_mentor_user_id is null or p_mentee_user_id is null or p_mentor_user_id = p_mentee_user_id then raise exception 'mentor and mentee must be different members' using errcode = '22023'; end if;
  if (select pg_catalog.count(*) from public.organization_memberships m where m.organization_id = org and m.user_id in (p_mentor_user_id, p_mentee_user_id) and m.status = 'active') <> 2 then raise exception 'both participants require active organization membership' using errcode = '22023'; end if;
  insert into public.member_mentorship_pairs (
    id, organization_id, mentor_user_id, mentee_user_id, started_on, created_by
  ) values (p_idempotency_key, org, p_mentor_user_id, p_mentee_user_id, coalesce(p_started_on, current_date), (select auth.uid()))
  on conflict (id) do nothing;
  select id, status, started_on into row_out from public.member_mentorship_pairs
  where id = p_idempotency_key and organization_id = org;
  if row_out.id is null then raise exception 'pair already exists or idempotency key is invalid' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, p_mentee_user_id, 'mentorship_pair', row_out.id, 'created');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'startedOn', row_out.started_on);
exception when unique_violation then
  raise exception 'an active mentorship pair already exists' using errcode = '22023';
end
$function$;

create or replace function public.transition_member_mentorship_pair(
  p_pair_id uuid,
  p_status text,
  p_outcome text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.member_support_selected_organization(); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if p_status not in ('active', 'completed', 'cancelled') or pg_catalog.char_length(coalesce(p_outcome, '')) > 2000 then raise exception 'invalid mentorship transition' using errcode = '22023'; end if;
  update public.member_mentorship_pairs set
    status = p_status, outcome = coalesce(p_outcome, ''),
    ended_on = case when p_status = 'active' then null else current_date end,
    updated_at = pg_catalog.now()
  where id = p_pair_id and organization_id = org
  returning id, mentee_user_id, status, ended_on into row_out;
  if row_out.id is null then raise exception 'mentorship pair not found' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, row_out.mentee_user_id, 'mentorship_pair', row_out.id, 'transitioned');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'endedOn', row_out.ended_on);
end
$function$;

create or replace function public.add_member_mentorship_note(
  p_pair_id uuid,
  p_body text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.member_support_selected_organization(); mentee uuid; row_out record;
begin
  if not private.member_support_pair_allowed(p_pair_id, org) then raise exception 'mentorship access denied' using errcode = '42501'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid mentorship note' using errcode = '22023'; end if;
  select mentee_user_id into mentee from public.member_mentorship_pairs where id = p_pair_id and organization_id = org;
  insert into public.member_mentorship_notes (
    id, organization_id, pair_id, author_user_id, body
  ) values (p_idempotency_key, org, p_pair_id, (select auth.uid()), pg_catalog.btrim(p_body))
  on conflict (id) do nothing
  returning id, created_at into row_out;
  if row_out.id is null then select id, created_at into row_out from public.member_mentorship_notes where id = p_idempotency_key and pair_id = p_pair_id; end if;
  if row_out.id is null then raise exception 'idempotency key belongs to another note' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, mentee, 'mentorship_note', row_out.id, 'note_added');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'createdAt', row_out.created_at);
end
$function$;

create or replace function public.save_member_mentorship_goal(
  p_pair_id uuid,
  p_goal_id uuid,
  p_title text,
  p_completed boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.member_support_selected_organization(); goal_id uuid := coalesce(p_goal_id, p_idempotency_key); mentee uuid; row_out record;
begin
  if not private.member_support_pair_allowed(p_pair_id, org) then raise exception 'mentorship access denied' using errcode = '42501'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 200 then raise exception 'invalid mentorship goal' using errcode = '22023'; end if;
  select mentee_user_id into mentee from public.member_mentorship_pairs where id = p_pair_id and organization_id = org;
  insert into public.member_mentorship_goals (
    id, organization_id, pair_id, title, completed, completed_at, created_by
  ) values (
    goal_id, org, p_pair_id, pg_catalog.btrim(p_title), coalesce(p_completed, false),
    case when coalesce(p_completed, false) then pg_catalog.now() else null end,
    (select auth.uid())
  ) on conflict (id) do update set
    title = excluded.title, completed = excluded.completed,
    completed_at = case when excluded.completed then coalesce(public.member_mentorship_goals.completed_at, pg_catalog.now()) else null end,
    updated_at = pg_catalog.now()
  where public.member_mentorship_goals.organization_id = org
    and public.member_mentorship_goals.pair_id = p_pair_id
  returning id, completed, completed_at into row_out;
  if row_out.id is null then raise exception 'goal not found in mentorship pair' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, mentee, 'mentorship_goal', row_out.id, 'goal_saved');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'completed', row_out.completed, 'completedAt', row_out.completed_at);
end
$function$;

-- The handoff write still needs a chapter, but it now says so.
create or replace function public.initiate_member_handoff(
  p_member_user_id uuid,
  p_to_steward_id uuid,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  existing public.member_handoffs%rowtype;
  created uuid;
  current_steward uuid;
  hourly integer;
  daily integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.mi1_w2_handoff_can_initiate(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_member_user_id is null or p_to_steward_id is null or p_idempotency_key is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_member_user_id = p_to_steward_id then
    raise exception 'A member cannot be handed off to themselves.' using errcode = '22023';
  end if;
  -- A handoff writes chapter_id, so it still needs a selected chapter. Say that
  -- instead of reusing the opaque refusal a foreign chapter gets: after the
  -- workspace load was widened to chapterless staff, the generic message read
  -- as the whole desk failing again.
  if chapter is null then
    raise exception 'A handoff records a chapter. Select a chapter before transferring responsibility for a member.'
      using errcode = '42501';
  end if;
  if not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = org and m.user_id = p_member_user_id and m.status = 'active'
  ) or not exists (
    select 1 from public.member_chapter_memberships cm
    where cm.user_id = p_member_user_id and cm.chapter_id = chapter and cm.status = 'active'
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1
    from public.organization_memberships m
    join public.organization_role_grants g
      on g.organization_id = m.organization_id and g.user_id = m.user_id
    where m.organization_id = org and m.user_id = p_to_steward_id
      and m.status = 'active' and g.role = 'steward'
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  select pg_catalog.count(*) into hourly from public.member_handoffs h
  where h.organization_id = org and h.initiated_by = (select auth.uid())
    and h.created_at >= pg_catalog.now() - interval '1 hour';
  select pg_catalog.count(*) into daily from public.member_handoffs h
  where h.organization_id = org and h.initiated_by = (select auth.uid())
    and h.created_at >= pg_catalog.now() - interval '1 day';
  if hourly >= 20 or daily >= 80 then
    raise exception 'handoff rate limit exceeded' using errcode = '54000';
  end if;
  select * into existing
  from public.member_handoffs
  where organization_id = org and idempotency_key = p_idempotency_key;
  if found then
    if existing.member_user_id is distinct from p_member_user_id
       or existing.to_steward_id is distinct from p_to_steward_id
       or existing.initiated_by is distinct from (select auth.uid())
       or existing.note is distinct from nullif(pg_catalog.btrim(coalesce(p_note, '')), '') then
      raise exception 'That idempotency key already started a different handoff.' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'status', existing.status, 'kind', 'reuse');
  end if;
  perform 1 from public.member_handoffs
  where organization_id = org and chapter_id = chapter
    and member_user_id = p_member_user_id and status = 'pending';
  if found then raise exception 'This member already has a pending handoff.' using errcode = 'P0001'; end if;
  select r.steward_user_id into current_steward
  from public.member_steward_relationships r
  where r.organization_id = org and r.chapter_id = chapter and r.member_user_id = p_member_user_id;
  insert into public.member_handoffs (
    organization_id, chapter_id, member_user_id, from_steward_id, to_steward_id,
    initiated_by, note, idempotency_key, status
  ) values (
    org, chapter, p_member_user_id, current_steward, p_to_steward_id,
    (select auth.uid()), nullif(pg_catalog.btrim(coalesce(p_note, '')), ''), p_idempotency_key, 'pending'
  ) returning id into created;
  perform private.mi1_w2_write_audit(org, 'member_handoff_initiated', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'userId', p_member_user_id,
    'status', 'pending', 'handoffId', created,
    'fromStewardId', current_steward, 'toStewardId', p_to_steward_id
  ));
  return pg_catalog.jsonb_build_object('id', created, 'status', 'pending', 'kind', 'initiate');
end;
$function$;

-- Web member snapshot: an organization-level selected row for a chapterless
-- single-organization caller. Previously this RPC joined only through
-- member_chapter_memberships, so an organization administrator with no chapter
-- membership received [] and every surface that reads the selected membership
-- (src/lib/memberApi.js, the mi1 session-scope wirings) concluded there was no
-- organization at all. The fallback fires ONLY when the caller has zero active
-- chapter memberships and exactly one active organization membership, so every
-- existing caller keeps its current rows and multi-organization callers stay
-- fail-closed.
create or replace function public.get_my_chapter_memberships()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    nullif((
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'chapterId', c.id,
          'name', c.name,
          'region', c.region,
          'selected', c.id = p.chapter_id,
          'pinned', m.pinned,
          'lastSelectedAt', m.last_selected_at,
          'joinedAt', m.joined_at,
          'organizationId', c.organization_id,
          'roles', coalesce((
            select pg_catalog.jsonb_agg(scoped_role.role order by scoped_role.role)
            from (
              select rc.role
              from public.member_role_chapters rc
              where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
              union
              select g.role
              from public.organization_role_grants g
              where g.user_id = m.user_id
                and c.organization_id is not null
                and g.organization_id = c.organization_id
              union
              select r.role
              from public.member_roles r
              where r.user_id = m.user_id
                and r.chapter_id is null
                and c.organization_id is null
            ) scoped_role
          ), '[]'::jsonb),
          'organizationRoles', coalesce((
            select pg_catalog.jsonb_agg(g.role order by g.role)
            from public.organization_role_grants g
            where g.user_id = m.user_id
              and c.organization_id is not null
              and g.organization_id = c.organization_id
          ), '[]'::jsonb),
          'chapterRoles', coalesce((
            select pg_catalog.jsonb_agg(rc.role order by rc.role)
            from public.member_role_chapters rc
            where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
          ), '[]'::jsonb)
        ) order by m.pinned desc, m.last_selected_at desc nulls last, c.name
      ), '[]'::jsonb)
      from public.member_profiles p
      join public.member_chapter_memberships m
        on m.user_id = p.id and m.status = 'active'
      join public.chapters c on c.id = m.chapter_id
      where p.id = (select auth.uid())
        and private.mfa_satisfied()
        and (
          (
            c.organization_id is not null
            and exists (
              select 1
              from public.organization_memberships om
              join public.organizations o
                on o.id = om.organization_id
               and o.status = 'active'
              where om.user_id = p.id
                and om.organization_id = c.organization_id
                and om.status = 'active'
            )
            and (
              private.current_member_organization() is null
              or c.organization_id = private.current_member_organization()
            )
          )
          or (
            c.organization_id is null
            and private.current_member_organization() is null
            and not exists (
              select 1
              from public.organization_memberships om
              join public.organizations o
                on o.id = om.organization_id
               and o.status = 'active'
              where om.user_id = p.id
                and om.status = 'active'
            )
          )
        )
    ), '[]'::jsonb),
    (
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'chapterId', null,
          'name', o.name,
          'region', null,
          'selected', true,
          'pinned', false,
          'lastSelectedAt', null,
          'joinedAt', om.created_at,
          'organizationId', o.id,
          'roles', coalesce((
            select pg_catalog.jsonb_agg(g.role order by g.role)
            from public.organization_role_grants g
            where g.user_id = om.user_id and g.organization_id = o.id
          ), '[]'::jsonb),
          'organizationRoles', coalesce((
            select pg_catalog.jsonb_agg(g.role order by g.role)
            from public.organization_role_grants g
            where g.user_id = om.user_id and g.organization_id = o.id
          ), '[]'::jsonb),
          'chapterRoles', '[]'::jsonb
        )
      ), '[]'::jsonb)
      from public.organization_memberships om
      join public.organizations o
        on o.id = om.organization_id and o.status = 'active'
      where om.user_id = (select auth.uid())
        and om.status = 'active'
        and private.mfa_satisfied()
        and private.current_member_organization() is null
        and not exists (
          select 1
          from public.member_chapter_memberships cm
          where cm.user_id = om.user_id and cm.status = 'active'
        )
        and (
          select pg_catalog.count(*)
          from public.organization_memberships peer
          join public.organizations peer_org
            on peer_org.id = peer.organization_id and peer_org.status = 'active'
          where peer.user_id = om.user_id and peer.status = 'active'
        ) = 1
    ),
    '[]'::jsonb)
$function$;

-- Case-graph transaction entry. 20260907151000 wrapped every case-graph writer
-- so the lock is taken before the function's own declarations evaluate, and a
-- create-or-replace above drops that wrapper. Re-apply it with the same
-- mechanism, pinning the source this migration just installed so a later edit
-- to any of these bodies has to come back through here.
do $case_graph_writers$
declare
  r record;
  source text;
  original_source text;
  definition text;
  directive text;
  wrapped text;
begin
  for r in select * from (values
    ('public.save_member_emergency_checklist(text,integer[],text,uuid)', '0d942beb97ffa8e77166a202143bb2225fbe0a847acd08b62cb375a689c78161'),
    ('public.alert_member_emergency_steward(text,integer[],text,uuid)', '1275c4aeb77cae566a1840fb855c7b5255b06e4e3bfc5502d5d32fba1ba3138d'),
    ('public.resolve_member_emergency_checklist(uuid,uuid)', '3038a78bc8054736cb654c765f0507198c3b101e2cd5746612531e9ff3419a67'),
    ('public.create_member_accommodation_request(text,text,uuid)', 'cdb3320b1c431993b43ed3e35212c2ecfbc2d69e32fdc1ffc40483f7f65237fb'),
    ('public.transition_member_accommodation_request(uuid,text,text,uuid)', '30277386bdd772a47d94479c95333f45a41bdb93d4a02c5043489794f18dbba4'),
    ('public.record_member_hr_contact(uuid,text,text,text,text,timestamp with time zone,date,uuid)', '5aa348c2bbc788f8938f4c896536410d357f8e5c1c11230d7131c52253281723'),
    ('public.save_organization_hr_directory(text,text,text,text,text,text,text,boolean,uuid)', '4670508db406ebc78b25a0bf7d83ddeb4b8df731289583d98e5c48e925cacff6'),
    ('public.save_organization_onboarding_step(uuid,text,text,integer,boolean,uuid)', '7741ba54370c936770307c0e27e3295f9196af901426a4d11799d61fa41f79c4'),
    ('public.start_member_onboarding_plan(uuid,uuid)', 'e98947046e19709cf448ab1bffa39707f27a7bb108d78d85885b51453b967f1b'),
    ('public.complete_member_onboarding_step(uuid,uuid)', '0a08d481ccd1fd05a64ec70c7dff36b48b2483ac6c1b177832bd9ec2065868a6'),
    ('public.create_member_mentorship_pair(uuid,uuid,date,uuid)', 'd44b78be94d5668c50ce177fc072ed70bb94f366051387aa50e2edd1e7471239'),
    ('public.transition_member_mentorship_pair(uuid,text,text,uuid)', 'e6d34aebea4980da68b88644e159c5667cd055b0db1aa7209655c542441c8fd5'),
    ('public.add_member_mentorship_note(uuid,text,uuid)', 'b2def05c96b70c2b50b94f48ff14a51068fea07c68dd88eff1e9f1df4b77f854'),
    ('public.save_member_mentorship_goal(uuid,uuid,text,boolean,uuid)', '371b96282f96ea0c663d525aff11ed54a8616dc2986195be3eb52f7bfa560685'),
    ('public.initiate_member_handoff(uuid,uuid,text,uuid)', '7612a5428323adf0336158937e07257c830b003d7b6121359b7dd1508a5df985'),
    ('private.member_support_record_event(uuid,uuid,uuid,text,uuid,text)', '811a7c4aebb79141814ec1616ca2dfc6f6fa3cbe708fd2dfe399f7740005e34e')
  ) reviewed(signature, source_sha256) loop
    select p.prosrc, pg_catalog.pg_get_functiondef(p.oid) into strict source, definition
      from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(r.signature);
    if pg_catalog.encode(extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'), 'hex') is distinct from r.source_sha256 then
      raise exception 'member support case graph writer source changed: %', r.signature using errcode = '55000';
    end if;
    original_source := source;
    directive := coalesce(pg_catalog.substring(source, $directive$^\s*#[^\n]+\n$directive$), '');
    source := pg_catalog.substr(source, pg_catalog.length(directive) + 1);
    wrapped := directive || $wrapper$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
$wrapper$
      || pg_catalog.rtrim(source, chr(10) || chr(13) || chr(9) || ' ')
      || case when pg_catalog.right(pg_catalog.rtrim(source, chr(10) || chr(13) || chr(9) || ' '), 1) = ';' then '' else ';' end
      || $wrapper$
end;
$wrapper$;
    definition := pg_catalog.replace(definition, original_source, wrapped);
    execute definition;
  end loop;
end;
$case_graph_writers$;

-- Account-lifecycle definer review. The reachability walk in
-- private.account_lifecycle_trigger_surface() reaches the two accommodation
-- RPCs and the event guard through the case-graph triggers, so their new
-- definitions — and the two organization-resolution helpers they now reach —
-- must be re-reviewed here or the manifest reports unreviewed definers.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
values
  ('function', 'private', '', 'member_support_selected_organization()', 'a5677e272ce2c6756f8cfa87f6f437d0'),
  ('function', 'private', '', 'mi1_w2_selected_organization()', '6979b6e5f516568dfab805c88718223a'),
  ('function', 'private', '', 'member_support_record_event(p_id uuid, p_organization_id uuid, p_member_user_id uuid, p_entity_type text, p_entity_id uuid, p_event_type text)', 'eac9e94bd6cf7c41af3159003a2d904a'),
  ('function', 'public', '', 'create_member_accommodation_request(p_request_type text, p_description text, p_idempotency_key uuid)', '6f1771c685e940a1c8c21fcc6cbd489b'),
  ('function', 'public', '', 'transition_member_accommodation_request(p_request_id uuid, p_status text, p_staff_note text, p_idempotency_key uuid)', '041085f7348ef0c78edff6236eb2e926')
on conflict (kind, schema_name, table_name, object_name) do update
set definition_hash = excluded.definition_hash;

do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the member-support chapterless organization resolution';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

notify pgrst, 'reload schema';

commit;
