-- REQ-UG-LEARNING-PERIOD-MEMBERSHIP-ROLES-SETTINGS-20261103 (#6946),
-- slice 7 of 9 of #6805. Built on the engine (20261103163000, #6940) and the
-- task slice's dispatcher (20261103183000, #6941). Design:
-- the operator runbook, "Invitations and
-- membership" (role, membership and settings rows) and "Your own preferences".
--
-- While an organization's learning period runs, these changes are journalled
-- in the same transaction and can be undone by the person who made them,
-- through undo_my_learning_action, with today's permission rechecked:
--   organization_role_grant / _revoke     set_member_organization_role
--   chapter_role_grant / _revoke / _scope set_member_chapter_role, set_member_access_role
--   chapter_membership_grant / _revoke    grant_ and revoke_member_chapter_membership
--   chapter_display_title_change          set_member_chapter_display_title
--   chapter_budget_office_change          set_chapter_budget_office
--   organization_setting_change / _reset  set_, update_ and reset_organization_setting
--   network_profile_change                upsert_organization_network_profile
--   own_profile_update / own_settings_update  update_my_member_profile (new)
--   own_profile_details_update            set_my_profile_details(_v2), set_my_form_autofill_preference
--   own_chapter_pin                       set_my_chapter_pin
-- A role or membership undo re-grants only what the person could grant today,
-- and writes its own organization_audit_events row (plus the domain's usual
-- member_admin_audit row); nothing earlier changes. Undo never creates or
-- revives a session: sessions a staff grant ended stay ended. Removing
-- someone's last chapter in the organization also ends their organization
-- membership, so it is journalled as permanent (Sent, never Undo): they come
-- back only through an invitation. Accepted memberships stay outside undo.
--
-- Excluded rows refuse journalling (learning_journal_append returns null for
-- them and they name no table or handler): the staff and member extra
-- verification step policy, retention settings and runs, organization merge,
-- SSO and SCIM, and every security, sign-in, SCIM, SSO, passkey, MFA, PIN
-- or retention switch kept in organization_setting_values.
--
-- member_profiles keeps its column UPDATE grant in this slice: shipped native
-- builds write language, notification and pulse choices directly, and taking
-- the grant away before a native release calls update_my_member_profile would
-- break them. The web client moves to the RPC here; native writes stay real
-- (not practice) until that release, which then revokes the grant.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Kinds
-- ---------------------------------------------------------------------------
insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('organization_role_grant', 'membership', 'reverse', 'public.organization_role_grants', false, 'private.learning_undo_organization_role',
    array['granted']::text[], 'Granting an organization role. Undo removes it if you may still manage organization roles.'),
  ('organization_role_revoke', 'membership', 'reverse', 'public.organization_role_grants', false, 'private.learning_undo_organization_role',
    array['granted']::text[], 'Removing an organization role. Undo grants it again only if you may grant it today; sessions it ended stay ended.'),
  ('chapter_role_grant', 'membership', 'reverse', 'public.member_role_chapters', false, 'private.learning_undo_chapter_role',
    array['granted', 'unit_id', 'committee_id']::text[], 'Granting a chapter role. Undo removes it if you may still manage that role.'),
  ('chapter_role_revoke', 'membership', 'reverse', 'public.member_role_chapters', false, 'private.learning_undo_chapter_role',
    array['granted', 'unit_id', 'committee_id']::text[], 'Removing a chapter role. Undo grants it again, with its unit or committee scope, only if you may grant it today.'),
  ('chapter_role_scope', 'membership', 'reverse', 'public.member_role_chapters', false, 'private.learning_undo_chapter_role',
    array['granted', 'unit_id', 'committee_id']::text[], 'Changing the unit or committee a chapter role covers.'),
  ('chapter_membership_grant', 'membership', 'reverse', 'public.member_chapter_memberships', false, 'private.learning_undo_chapter_membership',
    array['status', 'pinned', 'budget_office', 'roles']::text[], 'Adding a member of the organization to a chapter. Undo takes the chapter away again unless it is their only one.'),
  ('chapter_membership_revoke', 'membership', 'reverse', 'public.member_chapter_memberships', false, 'private.learning_undo_chapter_membership',
    array['status', 'pinned', 'budget_office', 'roles']::text[], 'Removing someone from a chapter they are not leaving the organization by. Undo puts the chapter, its pin, budget office and roles back only if you may grant them today.'),
  ('chapter_membership_revoke_final', 'membership', 'permanent', 'public.member_chapter_memberships', false, null, array[]::text[],
    'Removing someone''s last chapter, which ends their organization membership. Kept; they come back only through an invitation.'),
  ('chapter_display_title_change', 'membership', 'reverse', 'public.member_chapter_memberships', false, 'private.learning_undo_chapter_membership',
    array['display_title']::text[], 'Changing a member''s display title in a chapter.'),
  ('chapter_budget_office_change', 'membership', 'reverse', 'public.member_chapter_memberships', false, 'private.learning_undo_chapter_membership',
    array['budget_office']::text[], 'Assigning or clearing a chapter budget office.'),
  ('own_chapter_pin', 'settings', 'reverse', 'public.member_chapter_memberships', false, 'private.learning_undo_chapter_membership',
    array['pinned']::text[], 'Pinning or unpinning one of your own chapters.'),
  ('organization_setting_change', 'settings', 'reverse', 'public.organization_setting_values', false, 'private.learning_undo_organization_setting',
    array['overridden', 'value']::text[], 'Changing an ordinary organization setting.'),
  ('organization_setting_reset', 'settings', 'reverse', 'public.organization_setting_values', false, 'private.learning_undo_organization_setting',
    array['overridden', 'value']::text[], 'Resetting an ordinary organization setting to the platform default.'),
  ('network_profile_change', 'settings', 'reverse', 'public.organization_network_directory_profiles', false, 'private.learning_undo_network_profile',
    array['present', 'display_name', 'summary', 'visibility', 'contact_mode', 'parent_organization_id']::text[],
    'Changing the organization''s network profile. The confirmation says other organizations may already have seen it.'),
  ('own_profile_update', 'settings', 'reverse', 'public.member_profiles', false, 'private.learning_undo_own_profile',
    array['first_name', 'full_name', 'initials', 'role_line', 'member_since', 'language', 'notification_prefs', 'dnd_enabled',
      'quiet_hours_start', 'quiet_hours_end', 'quiet_hours_timezone', 'urgent_notifications_enabled', 'shortcut_keys',
      'work_widget_order', 'pulse_score_visible']::text[], 'Changing your own name, initials, role line or join year.'),
  ('own_settings_update', 'settings', 'reverse', 'public.member_profiles', false, 'private.learning_undo_own_profile',
    array['first_name', 'full_name', 'initials', 'role_line', 'member_since', 'language', 'notification_prefs', 'dnd_enabled',
      'quiet_hours_start', 'quiet_hours_end', 'quiet_hours_timezone', 'urgent_notifications_enabled', 'shortcut_keys',
      'work_widget_order', 'pulse_score_visible']::text[], 'Changing your own language, notification or display choices.'),
  ('own_profile_details_update', 'settings', 'reverse', 'public.member_profile_details', false, 'private.learning_undo_own_profile_details',
    array['present', 'pronouns', 'job_title', 'worksite', 'phone', 'details_visibility', 'phone_visibility', 'shift', 'classification', 'form_autofill']::text[],
    'Changing your own profile details or form autofill choice.'),
  -- Security, preservation and identity-provider controls keep their own
  -- controls and audits and are never learning-undoable.
  ('staff_mfa_policy_change', 'settings', 'excluded', null, false, null, array[]::text[],
    'The staff extra verification step policy (set_staff_mfa_policy). A security control with its own audit.'),
  ('member_mfa_policy_change', 'settings', 'excluded', null, false, null, array[]::text[],
    'The member extra verification step policy (set_member_mfa_policy). A security control with its own audit.'),
  ('organization_security_setting_change', 'settings', 'excluded', null, false, null, array[]::text[],
    'A security, sign-in, PIN, passkey, MFA, SSO, SCIM or retention switch kept as an organization setting.'),
  ('retention_policy_change', 'settings', 'excluded', null, false, null, array[]::text[],
    'Retention settings and retention runs (upsert_organization_retention_policy, authorize_ and execute_organization_retention_run).'),
  ('organization_merge', 'settings', 'excluded', null, false, null, array[]::text[],
    'Reviewing or executing an organization merge plan.'),
  ('sso_change', 'settings', 'excluded', null, false, null, array[]::text[],
    'SSO connections, domains and checks.'),
  ('scim_change', 'settings', 'excluded', null, false, null, array[]::text[],
    'SCIM settings, tokens and group roles, and provisioning from the identity provider.'),
  ('membership_accept', 'membership', 'excluded', null, false, null, array[]::text[],
    'Accepting an invitation makes the membership the person''s own; it stays outside undo.');

-- ---------------------------------------------------------------------------
-- 2. State, target keys and the journal call
-- ---------------------------------------------------------------------------
-- A setting key is a security or retention control when its name says so.
-- These are excluded: they keep their own controls and are never journalled.
create function private.learning_setting_excluded(p_key text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $function$
  select p_key is null
    or p_key ~ '^(security|limits\.security|features\.security)\.'
    or p_key ~ '(scim|sso|mfa|passkey|retention|member_pin)';
$function$;
revoke all on function private.learning_setting_excluded(text) from public, anon, authenticated, service_role;

-- The undo state of each target, from its target id alone:
--   organization_role_grants        '<organization>:<user>:<role>'
--   member_role_chapters            '<user>:<role>:<chapter>'
--   member_chapter_memberships      'm|p|t|o:<user>:<chapter>' (membership with its
--                                   pin, budget office and chapter roles; pin alone;
--                                   display title; budget office alone)
--   organization_setting_values     '<organization>:<setting key>'
--   organization_network_directory_profiles, member_profiles,
--   member_profile_details          the organization or user id
-- Chapter ids are slugs and role names have no colon, so the parts split.
create function private.learning_membership_state(p_table text, p_target text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  part1 text := pg_catalog.split_part(p_target, ':', 1);
  part2 text := pg_catalog.split_part(p_target, ':', 2);
  part3 text := pg_catalog.split_part(p_target, ':', 3);
  result jsonb;
begin
  case p_table
    when 'public.organization_role_grants' then
      return pg_catalog.jsonb_build_object('granted', exists (
        select 1 from public.organization_role_grants g
        where g.organization_id = part1::uuid and g.user_id = part2::uuid and g.role = part3));
    when 'public.member_role_chapters' then
      select pg_catalog.jsonb_build_object('granted', rc.user_id is not null, 'unit_id', s.unit_id, 'committee_id', s.committee_id)
      into result
      from (select 1) one
      left join public.member_role_chapters rc on rc.user_id = part1::uuid and rc.role = part2 and rc.chapter_id = part3
      left join private.chapter_role_scopes s on s.user_id = rc.user_id and s.chapter_id = rc.chapter_id and s.role = rc.role;
      return result;
    when 'public.member_chapter_memberships' then
      if part1 = 'm' then
        -- No row reads as revoked: a grant's undo hides the chapter again.
        -- A removal clears the pin, and clear_inactive_budget_office clears
        -- the budget office, so both ride with the membership.
        select pg_catalog.jsonb_build_object('status', m.status, 'pinned', m.pinned, 'budget_office', m.budget_office)
        into result
        from public.member_chapter_memberships m
        where m.user_id = part2::uuid and m.chapter_id = part3;
        return coalesce(result, pg_catalog.jsonb_build_object('status', 'revoked', 'pinned', false, 'budget_office', null))
          || pg_catalog.jsonb_build_object(
          'roles', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', rc.role, 'unit_id', s.unit_id, 'committee_id', s.committee_id) order by rc.role)
            from public.member_role_chapters rc
            left join private.chapter_role_scopes s on s.user_id = rc.user_id and s.chapter_id = rc.chapter_id and s.role = rc.role
            where rc.user_id = part2::uuid and rc.chapter_id = part3), '[]'::jsonb));
      elsif part1 in ('p', 't', 'o') then
        -- Only an active membership carries these; none reads as no state.
        select case part1
            when 'p' then pg_catalog.jsonb_build_object('pinned', m.pinned)
            when 't' then pg_catalog.jsonb_build_object('display_title', m.display_title)
            else pg_catalog.jsonb_build_object('budget_office', m.budget_office) end
        into result
        from public.member_chapter_memberships m
        where m.user_id = part2::uuid and m.chapter_id = part3 and m.status = 'active';
        return result;
      end if;
    when 'public.organization_setting_values' then
      select pg_catalog.jsonb_build_object('overridden', v.organization_id is not null, 'value', v.value)
      into result
      from (select 1) one
      left join public.organization_setting_values v
        on v.organization_id = part1::uuid and v.setting_key = pg_catalog.substr(p_target, 38);
      return result;
    when 'public.organization_network_directory_profiles' then
      select pg_catalog.jsonb_build_object('present', d.organization_id is not null, 'display_name', d.display_name,
        'summary', d.summary, 'visibility', d.visibility, 'contact_mode', d.contact_mode,
        'parent_organization_id', d.parent_organization_id)
      into result
      from (select 1) one
      left join public.organization_network_directory_profiles d on d.organization_id = p_target::uuid;
      return result;
    when 'public.member_profiles' then
      select pg_catalog.jsonb_build_object('first_name', p.first_name, 'full_name', p.full_name, 'initials', p.initials,
        'role_line', p.role_line, 'member_since', p.member_since, 'language', p.language,
        'notification_prefs', p.notification_prefs, 'dnd_enabled', p.dnd_enabled,
        'quiet_hours_start', p.quiet_hours_start, 'quiet_hours_end', p.quiet_hours_end,
        'quiet_hours_timezone', p.quiet_hours_timezone, 'urgent_notifications_enabled', p.urgent_notifications_enabled,
        'shortcut_keys', p.shortcut_keys, 'work_widget_order', p.work_widget_order, 'pulse_score_visible', p.pulse_score_visible)
      into result
      from public.member_profiles p where p.id = p_target::uuid;
      return result;
    when 'public.member_profile_details' then
      select pg_catalog.jsonb_build_object('present', d.user_id is not null, 'pronouns', d.pronouns, 'job_title', d.job_title,
        'worksite', d.worksite, 'phone', d.phone, 'details_visibility', d.details_visibility,
        'phone_visibility', d.phone_visibility, 'shift', d.shift, 'classification', d.classification,
        'form_autofill', d.form_autofill)
      into result
      from (select 1) one
      left join public.member_profile_details d on d.user_id = p_target::uuid;
      return result;
    else
      null;
  end case;
  raise exception 'invalid learning target' using errcode = '22023';
end;
$function$;
revoke all on function private.learning_membership_state(text, text) from public, anon, authenticated, service_role;

-- The one journal call every writer in this slice makes after its change,
-- with the state it read before the change. Nothing is journalled when the
-- change changed nothing, when no state is left to come back to, or when the
-- target id would not fit the journal (a chapter slug over 75 characters);
-- the action is then a real one, recorded by its usual audit rows. The same
-- holds for a before-image over the journal's image bound (a large setting
-- value), whatever bound is installed, so a valid save is never refused for
-- its size.
create function private.learning_membership_journal(p_kind text, p_table text, p_target text, p_before jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  after_state jsonb := private.learning_membership_state(p_table, p_target);
  failed_check text;
begin
  if after_state is null or p_before is null or after_state = p_before
     or pg_catalog.char_length(p_target) > 128 then
    return null;
  end if;
  return private.learning_journal_append(
    p_kind, p_table, p_target, null, private.learning_fingerprint(after_state), null, p_before);
exception
  when check_violation then
    get stacked diagnostics failed_check = constraint_name;
    if failed_check = 'learning_action_journal_image' then
      return null;
    end if;
    raise;
end;
end;
$function$;
revoke all on function private.learning_membership_journal(text, text, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Reversing handlers (interface in 20261103163000)
-- ---------------------------------------------------------------------------
-- Each handler writes its rows directly, so the reversal is not itself
-- journalled, and writes the audit rows the forward path writes; nothing is
-- removed from any audit table. 'check' applies today's rule for the
-- reversing step, so an undo never grants more than the person could grant now.

-- Organization roles: today's rule is set_member_organization_role's.
create function private.learning_undo_organization_role(p_mode text, p_entry jsonb)
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
  target text := p_entry ->> 'target_id';
  org uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1)::uuid;
  member uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2)::uuid;
  role_name text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 3);
  wanted boolean := (p_entry -> 'before_image' ->> 'granted')::boolean;
  holds boolean;
begin
  if p_mode = 'lock' then
    -- The forward path's tenant lock, so a queued role change waits for us.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || org::text, 509));
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.organization_role_grants', target);
  elsif p_mode = 'before' then
    return p_entry -> 'before_image';
  end if;
  holds := exists (select 1 from public.organization_role_grants g
    where g.organization_id = org and g.user_id = member and g.role = role_name);
  if p_mode = 'check' then
    if org is distinct from private.current_mobile_staff_organization()
       or not private.has_organization_role(org, array['admin']) then
      raise exception 'you can no longer change organization roles' using errcode = '42501';
    end if;
    if wanted and not exists (
      select 1 from public.organization_memberships om
      where om.organization_id = org and om.user_id = member and om.status = 'active'
    ) then
      raise exception 'active organization membership required' using errcode = '22023';
    end if;
    if not wanted and holds and role_name = 'admin' and (
      select pg_catalog.count(*) from public.organization_role_grants g
      where g.organization_id = org and g.role = 'admin') <= 1 then
      raise exception 'cannot remove the last organization admin' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if wanted and not holds then
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values (org, member, role_name, caller);
  elsif not wanted and holds then
    delete from public.organization_role_grants g
    where g.organization_id = org and g.user_id = member and g.role = role_name;
  else
    return null;
  end if;
  insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
  values (org, case when wanted then 'organization_role_granted' else 'organization_role_revoked' end, caller,
    extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('organizationId', org::text, 'userId', member::text, 'role', role_name,
      'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_organization_role(text, jsonb) from public, anon, authenticated, service_role;

-- Chapter roles and their unit or committee scope: today's rule is
-- set_member_chapter_role's, plus set_member_access_role's for a scope.
create function private.learning_undo_chapter_role(p_mode text, p_entry jsonb)
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
  target text := p_entry ->> 'target_id';
  member uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1)::uuid;
  role_name text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2);
  chapter text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 3);
  image jsonb := p_entry -> 'before_image';
  wanted boolean := (p_entry -> 'before_image' ->> 'granted')::boolean;
  wanted_unit uuid := (p_entry -> 'before_image' ->> 'unit_id')::uuid;
  wanted_committee uuid := (p_entry -> 'before_image' ->> 'committee_id')::uuid;
  chapter_org uuid;
  org_admin boolean;
  current_state jsonb;
begin
  select c.organization_id into chapter_org from public.chapters c where c.id = chapter;
  if p_mode = 'lock' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || chapter_org::text, 509));
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.member_role_chapters', target);
  elsif p_mode = 'before' then
    return image;
  end if;
  current_state := private.learning_membership_state('public.member_role_chapters', target);
  if p_mode = 'check' then
    org_admin := private.has_organization_role(chapter_org, array['admin']);
    if chapter_org is null or chapter_org is distinct from private.current_mobile_staff_organization()
       or (not org_admin and (chapter is distinct from private.current_member_chapter()
         or not (private.member_has_chapter_role(chapter, array['admin'])
           or (role_name in ('secretary', 'records', 'treasurer') and private.member_has_chapter_role(chapter, array['vp']))))) then
      raise exception 'you can no longer change this role' using errcode = '42501';
    end if;
    -- A scope is set or cleared only by someone who may scope roles today.
    if (wanted_unit is not null or wanted_committee is not null
        or current_state ->> 'unit_id' is not null or current_state ->> 'committee_id' is not null)
       and not (private.has_organization_role(chapter_org, array['admin']) or private.chapter_access_leadership(chapter)) then
      raise exception 'chapter leadership required' using errcode = '42501';
    end if;
    if wanted then
      if not exists (select 1 from public.member_chapter_memberships m
          where m.user_id = member and m.chapter_id = chapter and m.status = 'active')
         or not exists (select 1 from public.organization_memberships om
          where om.user_id = member and om.organization_id = chapter_org and om.status = 'active') then
        raise exception 'active chapter membership required' using errcode = '22023';
      end if;
      if (wanted_unit is not null and not exists (select 1 from private.chapter_units u where u.id = wanted_unit and u.chapter_id = chapter))
         or (wanted_committee is not null and not exists (select 1 from private.chapter_committees k where k.id = wanted_committee and k.chapter_id = chapter)) then
        raise exception 'role scope no longer exists' using errcode = '22023';
      end if;
    elsif role_name = 'admin' and member = caller and chapter = private.current_member_chapter() then
      raise exception 'an admin cannot remove the active admin role from this session' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if wanted then
    insert into public.member_roles (user_id, role, granted_by, chapter_id)
    values (member, role_name, caller, chapter)
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values (member, role_name, chapter, caller)
    on conflict (user_id, role, chapter_id) do nothing;
    if wanted_unit is not null or wanted_committee is not null then
      insert into private.chapter_role_scopes (user_id, chapter_id, role, unit_id, committee_id)
      values (member, chapter, role_name, wanted_unit, wanted_committee)
      on conflict (user_id, chapter_id, role) do update set unit_id = excluded.unit_id, committee_id = excluded.committee_id;
    else
      delete from private.chapter_role_scopes s where s.user_id = member and s.chapter_id = chapter and s.role = role_name;
    end if;
  else
    delete from public.member_role_chapters rc
    where rc.user_id = member and rc.role = role_name and rc.chapter_id = chapter;
    delete from public.member_roles r
    where r.user_id = member and r.role = role_name and r.chapter_id is not null
      and not exists (select 1 from public.member_role_chapters rc where rc.user_id = r.user_id and rc.role = r.role);
  end if;
  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller,
    case when wanted is distinct from (current_state ->> 'granted')::boolean
      then case when wanted then 'grant_role' else 'revoke_role' end else 'role_scope_updated' end,
    member,
    pg_catalog.jsonb_build_object('role', role_name, 'chapterId', chapter, 'unitId', wanted_unit,
      'committeeId', wanted_committee, 'learningUndo', true));
  insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
  values (chapter_org, case when wanted then 'organization_role_granted' else 'organization_role_revoked' end, caller,
    extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
      'role', role_name, 'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_chapter_role(text, jsonb) from public, anon, authenticated, service_role;

-- A chapter membership ('m', with the chapter roles it carried), its pin
-- ('p', the member's own), display title ('t') and budget office ('o').
create function private.learning_undo_chapter_membership(p_mode text, p_entry jsonb)
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
  target text := p_entry ->> 'target_id';
  part text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1);
  member uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2)::uuid;
  chapter text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 3);
  image jsonb := p_entry -> 'before_image';
  chapter_org uuid;
  org_admin boolean;
  can_assign boolean;
  previous_title text;
  previous_office text;
  replacement_chapter text;
  item jsonb;
begin
  select c.organization_id into chapter_org from public.chapters c where c.id = chapter;
  if p_mode = 'lock' then
    -- The forward paths' lock order: tenant, then member, then the row.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || chapter_org::text, 509));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-chapter:' || member::text, 0));
    perform 1 from public.member_chapter_memberships m where m.user_id = member and m.chapter_id = chapter for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.member_chapter_memberships', target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    if chapter_org is null or chapter_org is distinct from private.current_mobile_staff_organization() then
      raise exception 'you can no longer change this membership' using errcode = '42501';
    end if;
    if part = 'm' then
      -- grant_ and revoke_member_chapter_membership's rule.
      org_admin := private.has_organization_role(chapter_org, array['admin']);
      if not org_admin and (chapter is distinct from private.current_member_chapter()
          or not private.member_has_chapter_role(chapter, array['admin'])) then
        raise exception 'you can no longer change this membership' using errcode = '42501';
      end if;
      if image ->> 'status' = 'active' then
        -- Putting a removed chapter back never re-admits someone who has
        -- left the organization since; that takes an invitation.
        if not exists (select 1 from public.organization_memberships om
            where om.organization_id = chapter_org and om.user_id = member and om.status = 'active') then
          raise exception 'active organization membership required' using errcode = '22023';
        end if;
        for item in select value from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) loop
          if (item ->> 'unit_id' is not null or item ->> 'committee_id' is not null)
             and not (org_admin or private.chapter_access_leadership(chapter)) then
            raise exception 'chapter leadership required' using errcode = '42501';
          end if;
          if (item ->> 'unit_id' is not null and not exists (select 1 from private.chapter_units u
                where u.id = (item ->> 'unit_id')::uuid and u.chapter_id = chapter))
             or (item ->> 'committee_id' is not null and not exists (select 1 from private.chapter_committees k
                where k.id = (item ->> 'committee_id')::uuid and k.chapter_id = chapter)) then
            raise exception 'role scope no longer exists' using errcode = '22023';
          end if;
        end loop;
        -- The pin and budget office come back under the rule that let this
        -- person take them away (revoke_member_chapter_membership's, above).
      elsif not exists (select 1 from public.member_chapter_memberships m
                join public.chapters c on c.id = m.chapter_id
                where m.user_id = member and m.chapter_id <> chapter and m.status = 'active' and c.organization_id = chapter_org) then
        -- Taking back someone's only chapter would leave an organization
        -- member with no chapter; that is a removal from the organization,
        -- which only revoke_member_chapter_membership does, and is permanent.
        raise exception 'this is their only chapter; remove them from it instead' using errcode = '22023';
      elsif exists (select 1 from public.organization_role_grants g
                where g.organization_id = chapter_org and g.user_id = member and g.role = 'admin')
            and not exists (select 1 from public.member_chapter_memberships m
                join public.chapters c on c.id = m.chapter_id
                where m.user_id = member and m.chapter_id <> chapter and m.status = 'active' and c.organization_id = chapter_org)
            and (select pg_catalog.count(*) from public.organization_role_grants g
                where g.organization_id = chapter_org and g.role = 'admin') <= 1 then
        raise exception 'cannot remove the last organization admin' using errcode = '22023';
      end if;
      return null;
    end if;
    if not exists (select 1 from public.member_chapter_memberships m
        where m.user_id = member and m.chapter_id = chapter and m.status = 'active') then
      raise exception 'membership not found' using errcode = '22023';
    end if;
    if part = 'p' then
      if member is distinct from caller or not private.mfa_satisfied() then
        raise exception 'authentication required' using errcode = '42501';
      end if;
    elsif part = 't' then
      if not private.mfa_satisfied() or not private.member_invitation_chapter_administrable(chapter) then
        raise exception 'admin role required' using errcode = '42501';
      end if;
    elsif part = 'o' then
      select ctx.can_assign into can_assign
      from private.chapter_budget_context(private.current_member_organization(), chapter) ctx;
      if not coalesce(can_assign, false) or not exists (select 1 from public.organization_memberships om
          where om.user_id = member and om.organization_id = chapter_org and om.status = 'active') then
        raise exception 'chapter admin required' using errcode = '42501';
      end if;
    else
      raise exception 'invalid learning target' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if part = 'm' and image ->> 'status' = 'active' then
    update public.member_chapter_memberships m
    set status = 'active', revoked_at = null, pinned = coalesce((image ->> 'pinned')::boolean, false),
        budget_office = image ->> 'budget_office'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'revoked';
    for item in select value from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) loop
      insert into public.member_roles (user_id, role, granted_by, chapter_id)
      values (member, item ->> 'role', caller, chapter)
      on conflict (user_id, role) do nothing;
      insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
      values (member, item ->> 'role', chapter, caller)
      on conflict (user_id, role, chapter_id) do nothing;
      if item ->> 'unit_id' is not null or item ->> 'committee_id' is not null then
        insert into private.chapter_role_scopes (user_id, chapter_id, role, unit_id, committee_id)
        values (member, chapter, item ->> 'role', (item ->> 'unit_id')::uuid, (item ->> 'committee_id')::uuid)
        on conflict (user_id, chapter_id, role) do update set unit_id = excluded.unit_id, committee_id = excluded.committee_id;
      end if;
    end loop;
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'grant_chapter_membership', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'learningUndo', true,
        'roles', (select coalesce(pg_catalog.jsonb_agg(r ->> 'role'), '[]'::jsonb)
                  from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) r)));
    insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
    values (chapter_org, 'organization_membership_granted', caller, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
        'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  elsif part = 'm' then
    -- Taking a granted chapter back: the same steps as a removal that leaves
    -- the person in the organization. Their selected chapter moves if needed.
    if exists (select 1 from public.member_profiles p where p.id = member and p.chapter_id = chapter) then
      select m.chapter_id into replacement_chapter
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = chapter_org
      where m.user_id = member and m.chapter_id <> chapter and m.status = 'active'
      order by m.last_selected_at desc nulls last, m.joined_at, m.chapter_id
      limit 1;
    end if;
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'revoke_chapter_membership', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'replacementChapterId', replacement_chapter, 'learningUndo', true));
    update public.member_chapter_memberships m
    set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    update public.member_profiles p set chapter_id = replacement_chapter
    where p.id = member and p.chapter_id = chapter;
    insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
    values (chapter_org, 'organization_membership_revoked', caller, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
        'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  elsif part = 'p' then
    update public.member_chapter_memberships m set pinned = coalesce((image ->> 'pinned')::boolean, false)
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
  elsif part = 't' then
    select m.display_title into previous_title from public.member_chapter_memberships m
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    update public.member_chapter_memberships m set display_title = image ->> 'display_title'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'set_chapter_display_title', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'title', image ->> 'display_title',
        'previousTitle', previous_title, 'learningUndo', true));
  elsif part = 'o' then
    select m.budget_office into previous_office from public.member_chapter_memberships m
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    update public.member_chapter_memberships m set budget_office = image ->> 'budget_office'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    insert into public.organization_audit_ledger
      (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
    values (chapter_org, 'administration', 'chapter_budget_office',
      case when image ->> 'budget_office' is null then 'revoke' else 'grant' end,
      caller, 'membership', member::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('chapterId', chapter, 'fromRole', previous_office, 'toRole', image ->> 'budget_office'));
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_chapter_membership(text, jsonb) from public, anon, authenticated, service_role;

-- Ordinary organization settings: today's rule is write_organization_setting's.
create function private.learning_undo_organization_setting(p_mode text, p_entry jsonb)
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
  target text := p_entry ->> 'target_id';
  org uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1)::uuid;
  setting text := pg_catalog.substr(p_entry ->> 'target_id', 38);
  image jsonb := p_entry -> 'before_image';
  definition public.platform_setting_definitions%rowtype;
  stored jsonb;
begin
  if p_mode = 'lock' then
    perform 1 from public.organization_setting_values v
    where v.organization_id = org and v.setting_key = setting for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.organization_setting_values', target);
  elsif p_mode = 'before' then
    return image;
  end if;
  select * into definition from public.platform_setting_definitions d where d.key = setting;
  if p_mode = 'check' then
    if org is distinct from private.current_mobile_staff_organization() or not private.mfa_satisfied()
       or not private.has_organization_role(org, array['admin']) then
      raise exception 'admin role required' using errcode = '42501';
    end if;
    if definition.key is null or not definition.organization_editable or private.learning_setting_excluded(setting) then
      raise exception 'setting is set for the whole platform' using errcode = '42501';
    end if;
    if (image ->> 'overridden')::boolean and not private.setting_value_valid(
      definition.value_kind, image -> 'value', definition.minimum, definition.maximum, definition.allowed_values) then
      raise exception 'invalid setting value' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  select v.value into stored from public.organization_setting_values v
  where v.organization_id = org and v.setting_key = setting;
  if (image ->> 'overridden')::boolean then
    insert into public.organization_setting_values (organization_id, setting_key, value, updated_by, updated_at)
    values (org, setting, image -> 'value', caller, pg_catalog.clock_timestamp())
    on conflict (organization_id, setting_key) do update
      set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
    insert into public.organization_configuration_audit
      (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
    values (org, caller, 'setting_updated', setting, coalesce(stored, definition.default_value), image -> 'value',
      pg_catalog.clock_timestamp());
  else
    delete from public.organization_setting_values v where v.organization_id = org and v.setting_key = setting;
    insert into public.organization_configuration_audit
      (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
    values (org, caller, 'setting_reset', setting, coalesce(stored, definition.default_value), definition.default_value,
      pg_catalog.clock_timestamp());
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_organization_setting(text, jsonb) from public, anon, authenticated, service_role;

-- The organization's network profile: today's rule is
-- upsert_organization_network_profile's. A profile that did not exist
-- before is made private and closed to contact, never deleted.
create function private.learning_undo_network_profile(p_mode text, p_entry jsonb)
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
  org uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  wanted public.organization_network_directory_profiles%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.organization_network_directory_profiles d where d.organization_id = org for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.organization_network_directory_profiles', org::text);
  elsif p_mode = 'before' then
    return image;
  end if;
  wanted := pg_catalog.jsonb_populate_record(null::public.organization_network_directory_profiles, image);
  if p_mode = 'check' then
    if not private.mfa_satisfied() or org is distinct from private.current_mobile_staff_organization()
       or not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
      raise exception 'organization directory role required' using errcode = '42501';
    end if;
    if (image ->> 'present')::boolean and wanted.parent_organization_id is not null and not exists (
      select 1
      from public.organization_network_permission_grants permission
      join public.organization_coordination_records network on network.id = permission.network_record_id
      join public.organization_coordination_organization_participants parent_participant
        on parent_participant.record_id = network.id
        and parent_participant.organization_id = wanted.parent_organization_id
        and parent_participant.status = 'active'
      join public.organization_coordination_organization_participants child_participant
        on child_participant.record_id = network.id
        and child_participant.organization_id = org
        and child_participant.status = 'active'
      where permission.grantor_organization_id = wanted.parent_organization_id
        and permission.grantee_organization_id = org
        and permission.capability = 'oversight'
        and permission.status = 'active'
        and network.kind = 'network_link' and network.status = 'active'
    ) then
      raise exception 'accepted parent oversight grant required' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if (image ->> 'present')::boolean then
    insert into public.organization_network_directory_profiles (
      organization_id, display_name, summary, visibility, contact_mode, parent_organization_id, updated_by
    ) values (
      org, wanted.display_name, wanted.summary, wanted.visibility, wanted.contact_mode, wanted.parent_organization_id, caller
    ) on conflict (organization_id) do update
      set display_name = excluded.display_name,
          summary = excluded.summary,
          visibility = excluded.visibility,
          contact_mode = excluded.contact_mode,
          parent_organization_id = excluded.parent_organization_id,
          updated_by = caller,
          updated_at = pg_catalog.clock_timestamp();
  else
    update public.organization_network_directory_profiles d
    set visibility = 'private', contact_mode = 'disabled', parent_organization_id = null,
        updated_by = caller, updated_at = pg_catalog.clock_timestamp()
    where d.organization_id = org;
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_network_profile(text, jsonb) from public, anon, authenticated, service_role;

-- Your own profile, language, notification and display choices.
create function private.learning_undo_own_profile(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  member uuid := (p_entry ->> 'target_id')::uuid;
  wanted public.member_profiles%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_profiles p where p.id = member for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.member_profiles', member::text);
  elsif p_mode = 'before' then
    return p_entry -> 'before_image';
  elsif p_mode = 'check' then
    if member is distinct from (select auth.uid()) then
      raise exception 'authentication required' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  wanted := pg_catalog.jsonb_populate_record(null::public.member_profiles, p_entry -> 'before_image');
  -- The before-image is the member's own earlier choice, so an email choice
  -- that was unset then is unset again: preserve_engagement_email_preferences
  -- stands aside for this one update only.
  perform pg_catalog.set_config('sg.learning_restore_own_preferences', '1', true);
  update public.member_profiles p
  set first_name = wanted.first_name, full_name = wanted.full_name, initials = wanted.initials,
      role_line = wanted.role_line, member_since = wanted.member_since, language = wanted.language,
      notification_prefs = wanted.notification_prefs, dnd_enabled = wanted.dnd_enabled,
      quiet_hours_start = wanted.quiet_hours_start, quiet_hours_end = wanted.quiet_hours_end,
      quiet_hours_timezone = wanted.quiet_hours_timezone,
      urgent_notifications_enabled = wanted.urgent_notifications_enabled,
      shortcut_keys = wanted.shortcut_keys, work_widget_order = wanted.work_widget_order,
      pulse_score_visible = wanted.pulse_score_visible
  where p.id = member;
  perform pg_catalog.set_config('sg.learning_restore_own_preferences', '', true);
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_own_profile(text, jsonb) from public, anon, authenticated, service_role;

-- The engagement email guard (20261104090000, which added the onboarding
-- reminder choice), re-emitted with one early return: a stale or partial
-- client write still keeps a stored announcements, surveys, welcome or
-- onboarding choice it did not send, but the own
-- profile undo above restores the member's own earlier map exactly. Only
-- that handler sets the flag, for its single update; clients cannot set it.
create or replace function private.preserve_engagement_email_preferences()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if pg_catalog.current_setting('sg.learning_restore_own_preferences', true) = '1' then
    return new;
  end if;
  new.notification_prefs := coalesce((
    select pg_catalog.jsonb_object_agg(stored.key, stored.value)
      from pg_catalog.jsonb_each(old.notification_prefs) stored
     where stored.key in ('announcements', 'surveys', 'welcome', 'onboarding')
       and not (new.notification_prefs ? stored.key)
  ), '{}'::jsonb) || new.notification_prefs;
  return new;
end;
$function$;
revoke all on function private.preserve_engagement_email_preferences() from public, anon, authenticated, service_role;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.object_name in ('preserve_engagement_email_preferences', 'preserve_engagement_email_preferences()')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_learning_preferences_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the engagement email guard';
  end if;
end;
$assert_learning_preferences_trigger_review$;

-- Your own profile details. Details that did not exist before go back to
-- their defaults; the row is not deleted.
create function private.learning_undo_own_profile_details(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  member uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  wanted public.member_profile_details%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_profile_details d where d.user_id = member for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.member_profile_details', member::text);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    perform private.member_pin_require_full_session();
    if member is distinct from (select auth.uid()) or not private.mfa_satisfied() then
      raise exception 'authentication required' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if (image ->> 'present')::boolean then
    wanted := pg_catalog.jsonb_populate_record(null::public.member_profile_details, image);
  else
    wanted := pg_catalog.jsonb_populate_record(null::public.member_profile_details,
      '{"details_visibility": "only_me", "phone_visibility": "only_me", "form_autofill": "ask"}'::jsonb);
  end if;
  update public.member_profile_details d
  set pronouns = wanted.pronouns, job_title = wanted.job_title, worksite = wanted.worksite, phone = wanted.phone,
      details_visibility = wanted.details_visibility, phone_visibility = wanted.phone_visibility,
      shift = wanted.shift, classification = wanted.classification, form_autofill = wanted.form_autofill,
      updated_at = pg_catalog.now()
  where d.user_id = member;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_own_profile_details(text, jsonb) from public, anon, authenticated, service_role;

-- The installed dispatcher keeps every branch the earlier slices gave it;
-- it moves aside under its own name and this one hands it every handler
-- that is not this slice's, as slice 6 does. The blob does not change with
-- the order the slices land in. Dispatch stays static: only named,
-- reviewed functions are ever called.
alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_membership;
comment on function private.learning_dispatch_before_membership(text, text, jsonb) is
  'REQ-UG-LEARNING-PERIOD-MEMBERSHIP-ROLES-SETTINGS-20261103: the undo dispatcher as the slices applied before slice 7 left it, reached only through private.learning_dispatch.';

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
    when 'private.learning_undo_organization_role' then return private.learning_undo_organization_role(p_mode, p_entry);
    when 'private.learning_undo_chapter_role' then return private.learning_undo_chapter_role(p_mode, p_entry);
    when 'private.learning_undo_chapter_membership' then return private.learning_undo_chapter_membership(p_mode, p_entry);
    when 'private.learning_undo_organization_setting' then return private.learning_undo_organization_setting(p_mode, p_entry);
    when 'private.learning_undo_network_profile' then return private.learning_undo_network_profile(p_mode, p_entry);
    when 'private.learning_undo_own_profile' then return private.learning_undo_own_profile(p_mode, p_entry);
    when 'private.learning_undo_own_profile_details' then return private.learning_undo_own_profile_details(p_mode, p_entry);
    else return private.learning_dispatch_before_membership(p_handler, p_mode, p_entry);
  end case;
end;
$function$;
revoke all on function private.learning_dispatch(text, text, jsonb) from public, anon, authenticated, service_role;

-- Every registered handler must still be named by a dispatcher in the
-- chain; refuse to apply otherwise, so no slice's undo can stop working.
do $assert_learning_dispatch_complete$
declare
  missing text;
  chain text;
begin
  select pg_catalog.string_agg(pg_catalog.pg_get_functiondef(p.oid), ' ') into chain
  from pg_catalog.pg_proc p
  where p.pronamespace = 'private'::regnamespace and p.proname ~ '^learning_dispatch(_before_[a-z0-9_]+)?$';
  select pg_catalog.string_agg(distinct k.handler, ', ') into missing
  from private.learning_action_kinds k
  where k.handler is not null
    and pg_catalog.strpos(chain, 'when ''' || k.handler || ''' then return ' || k.handler || '(p_mode, p_entry);') = 0;
  if missing is not null then
    raise exception 'learning dispatcher lacks handlers: %', missing;
  end if;
end;
$assert_learning_dispatch_complete$;

-- ---------------------------------------------------------------------------
-- 4. Writers, re-emitted from their latest definitions with the journal call
-- ---------------------------------------------------------------------------
-- Each body is the current one with only the before-state read and the
-- journal call added. The grants on each function are unchanged.

-- Organization roles (20260822010000), journalled; the graph lock now comes first, as in every writer.
create or replace function public.set_member_organization_role(
  p_user_id uuid,
  p_role text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid()), p_user_id], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  locked_org uuid := private.current_member_organization();
  target_org uuid;
  changed integer := 0;
  role_key text;
  before_state jsonb;
begin
  if caller is null or locked_org is null then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  if not private.has_organization_role(locked_org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));

  -- Re-derive and reauthorize under the lock. In particular, a self-regrant
  -- queued behind revocation cannot reuse its pre-lock admin authority.
  target_org := private.current_member_organization();
  if target_org is distinct from locked_org
     or not private.has_organization_role(locked_org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.organization_memberships om
    where om.organization_id = locked_org
      and om.user_id = p_user_id
      and om.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '22023';
  end if;

  target_org := locked_org;
  role_key := target_org::text || ':' || p_user_id::text || ':' || p_role;
  before_state := private.learning_membership_state('public.organization_role_grants', role_key);

  if coalesce(p_enabled, false) then
    insert into public.organization_role_grants
      (organization_id, user_id, role, granted_by)
    values (target_org, p_user_id, p_role, caller)
    on conflict (organization_id, user_id, role) do nothing;
    get diagnostics changed = row_count;
  else
    if p_role = 'admin'
       and exists (
         select 1 from public.organization_role_grants g
         where g.organization_id = target_org
           and g.user_id = p_user_id
           and g.role = 'admin'
       )
       and (
         select pg_catalog.count(*)
         from public.organization_role_grants g
         where g.organization_id = target_org and g.role = 'admin'
       ) <= 1 then
      raise exception 'cannot remove the last organization admin' using errcode = '22023';
    end if;

    delete from public.organization_role_grants g
    where g.organization_id = target_org
      and g.user_id = p_user_id
      and g.role = p_role;
    get diagnostics changed = row_count;
  end if;

  if changed > 0 then
    insert into public.organization_audit_events (
      organization_id, event_type, actor_user_id, idempotency_key, metadata
    ) values (
      target_org,
      case when coalesce(p_enabled, false)
        then 'organization_role_granted'
        else 'organization_role_revoked'
      end,
      caller,
      extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', target_org::text,
        'userId', p_user_id::text,
        'role', p_role
      )
    );
    if coalesce(p_enabled, false) then
      perform private.learning_membership_journal('organization_role_grant', 'public.organization_role_grants', role_key, before_state);
    else
      perform private.learning_membership_journal('organization_role_revoke', 'public.organization_role_grants', role_key, before_state);
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', target_org,
    'userId', p_user_id,
    'role', p_role,
    'enabled', coalesce(p_enabled, false),
    'changed', changed > 0
  );
end;
end;
$function$;


-- Chapter roles (20261102014446), journalled unless set_member_access_role journals the whole change itself.
CREATE OR REPLACE FUNCTION public.set_member_chapter_role(p_user_id uuid, p_chapter_id text, p_role text, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_user_id],array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_org uuid;
  org_admin boolean;
  role_key text := p_user_id::text || ':' || p_role || ':' || p_chapter_id;
  before_state jsonb;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'admin', 'vp', 'secretary', 'records', 'treasurer') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Reject implausible callers without letting them wait on an admin lock.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records','treasurer') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));

  -- All authoritative authorization and target-membership checks occur after
  -- the tenant authorization lock. This prevents a queued chapter-admin grant
  -- from restoring authority revoked by the transaction ahead of it.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records','treasurer') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id and m.chapter_id = p_chapter_id and m.status = 'active'
  ) then
    raise exception 'active chapter membership required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships om
    where om.user_id = p_user_id and om.organization_id = target_org and om.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '22023';
  end if;
  before_state := private.learning_membership_state('public.member_role_chapters', role_key);

  if coalesce(p_enabled, false) then
    insert into public.member_roles (user_id, role, granted_by, chapter_id)
    values (p_user_id, p_role, caller, p_chapter_id)
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values (p_user_id, p_role, p_chapter_id, caller)
    on conflict (user_id, role, chapter_id) do nothing;
  else
    if p_role = 'admin' and p_user_id = caller and p_chapter_id = private.current_member_chapter() then
      raise exception 'an admin cannot remove the active admin role from this session' using errcode = '22023';
    end if;
    delete from public.member_role_chapters
    where user_id = p_user_id and role = p_role and chapter_id = p_chapter_id;
    delete from public.member_roles r
    where r.user_id = p_user_id and r.role = p_role and r.chapter_id is not null
      and not exists (
        select 1 from public.member_role_chapters rc
        where rc.user_id = r.user_id and rc.role = r.role
      );
  end if;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, case when coalesce(p_enabled, false) then 'grant_role' else 'revoke_role' end,
    p_user_id, pg_catalog.jsonb_build_object('role', p_role, 'chapterId', p_chapter_id));
  if coalesce(pg_catalog.current_setting('sg.learning_role_scope_writer', true), '') <> '1' then
    if coalesce(p_enabled, false) then
      perform private.learning_membership_journal('chapter_role_grant', 'public.member_role_chapters', role_key, before_state);
    else
      perform private.learning_membership_journal('chapter_role_revoke', 'public.member_role_chapters', role_key, before_state);
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'chapterId', p_chapter_id, 'role', p_role,
    'enabled', coalesce(p_enabled, false));
end;
end;
$function$;


-- Scoped chapter roles (20261102005607): one entry for the role and its scope together.
create or replace function public.set_member_access_role(p_user uuid, p_chapter text, p_role text, p_enabled boolean, p_unit uuid default null, p_committee uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_user],array[]::uuid[]);
declare
  role_key text := p_user::text || ':' || p_role || ':' || p_chapter;
  before_state jsonb;
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  if p_unit is not null and p_committee is not null then raise exception 'choose one role scope' using errcode='22023'; end if;
  if (p_unit is not null or p_committee is not null) and p_role not in ('steward','coordinator','advisor','secretary','records') then raise exception 'role does not support that scope' using errcode='22023'; end if;
  if p_unit is not null and not exists(select 1 from private.chapter_units where id=p_unit and chapter_id=p_chapter) then raise exception 'unit outside chapter' using errcode='42501'; end if;
  if p_committee is not null and not exists(select 1 from private.chapter_committees where id=p_committee and chapter_id=p_chapter) then raise exception 'committee outside chapter' using errcode='42501'; end if;
  before_state := private.learning_membership_state('public.member_role_chapters', role_key);
  -- The inner role change leaves its journalling to this call, which
  -- journals the role and its scope as one change below.
  perform pg_catalog.set_config('sg.learning_role_scope_writer', '1', true);
  perform public.set_member_chapter_role(p_user,p_chapter,p_role,p_enabled);
  perform pg_catalog.set_config('sg.learning_role_scope_writer', '', true);
  if coalesce(p_enabled,false) and (p_unit is not null or p_committee is not null) then
    insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,committee_id)
    values(p_user,p_chapter,p_role,p_unit,p_committee)
    on conflict(user_id,chapter_id,role) do update set unit_id=excluded.unit_id,committee_id=excluded.committee_id;
  else
    delete from private.chapter_role_scopes where user_id=p_user and chapter_id=p_chapter and role=p_role;
  end if;
  insert into public.member_admin_audit(actor,action,target_user,detail) values(auth.uid(),'role_scope_updated',p_user,
    pg_catalog.jsonb_build_object('chapterId',p_chapter,'role',p_role,'unitId',p_unit,'committeeId',p_committee,'enabled',coalesce(p_enabled,false)));
  if not coalesce((before_state ->> 'granted')::boolean, false) and coalesce(p_enabled, false) then
    perform private.learning_membership_journal('chapter_role_grant', 'public.member_role_chapters', role_key, before_state);
  elsif not coalesce(p_enabled, false) then
    perform private.learning_membership_journal('chapter_role_revoke', 'public.member_role_chapters', role_key, before_state);
  else
    perform private.learning_membership_journal('chapter_role_scope', 'public.member_role_chapters', role_key, before_state);
  end if;
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;


-- Adding a chapter (20260927100000), journalled.
create or replace function public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  locked_org uuid;
  target_org uuid;
  org_admin boolean;
  membership_key text := 'm:' || p_user_id::text || ':' || p_chapter_id;
  before_state jsonb;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select c.organization_id into locked_org
  from public.chapters c
  where c.id = p_chapter_id;
  if locked_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Cheap plausibility check: ordinary members must not be able to queue on
  -- the tenant lock. The identical checks are repeated authoritatively below.
  org_admin := private.has_organization_role(locked_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));

  -- Re-resolve and authorize only after taking the same tenant→member lock
  -- order as revocation. A queued grant cannot reuse stale caller authority.
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is distinct from locked_org then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  -- Tenant check: the grant adds a chapter inside the caller's organization
  -- for someone who is already an ACTIVE member of that organization. It
  -- never admits a person from outside it and never re-activates a revoked
  -- membership; organization entry and re-entry happen only through an
  -- accepted invitation or the organization's own creation. Unknown,
  -- outside, revoked and inactive targets share one refusal.
  if not exists (select 1 from public.member_profiles p where p.id = p_user_id)
     or not exists (select 1 from public.chapters c where c.id = p_chapter_id)
     or not exists (
       select 1 from public.organization_memberships om
       where om.organization_id = target_org
         and om.user_id = p_user_id
         and om.status = 'active'
     ) then
    raise exception 'membership target unavailable' using errcode = '22023';
  end if;
  before_state := private.learning_membership_state('public.member_chapter_memberships', membership_key);

  insert into public.member_chapter_memberships (user_id, chapter_id, status)
  values (p_user_id, p_chapter_id, 'active')
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null;

  update public.member_profiles
  set chapter_id = p_chapter_id
  where id = p_user_id and chapter_id is null;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'grant_chapter_membership', p_user_id,
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id));
  perform private.learning_membership_journal('chapter_membership_grant', 'public.member_chapter_memberships', membership_key, before_state);
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'chapterId', p_chapter_id, 'active', true);
end;
end;
end;
$function$;


-- Removing a chapter (20260822010000), journalled with the chapter roles it removes. Removing the last chapter in the organization ends the organization membership too, so it is kept as permanent.
create or replace function public.revoke_member_chapter_membership(p_user_id uuid, p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_org uuid;
  org_admin boolean;
  replacement_chapter text;
  membership_key text := 'm:' || p_user_id::text || ':' || p_chapter_id;
  before_state jsonb;
  leaves_organization boolean;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Reject implausible callers before they can queue behind tenant admin work.
  -- Stale-authority races are still closed by the post-lock recheck below.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));

  -- Reauthorize after the shared organization-role lock. A queued expulsion
  -- must not continue with an admin grant that was revoked while it waited.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  if exists (
       select 1
       from public.organization_role_grants g
       where g.organization_id = target_org
         and g.user_id = p_user_id
         and g.role = 'admin'
     )
     and exists (
       select 1
       from public.member_chapter_memberships m
       where m.user_id = p_user_id
         and m.chapter_id = p_chapter_id
         and m.status = 'active'
     )
     and not exists (
       select 1
       from public.member_chapter_memberships m
       join public.chapters c on c.id = m.chapter_id
       where m.user_id = p_user_id
         and m.chapter_id <> p_chapter_id
         and m.status = 'active'
         and c.organization_id = target_org
     )
     and (
       select pg_catalog.count(*)
       from public.organization_role_grants g
       where g.organization_id = target_org
         and g.role = 'admin'
     ) <= 1 then
    raise exception 'cannot remove the last organization admin' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.member_chapter_memberships m
    where m.user_id = p_user_id
      and m.chapter_id = p_chapter_id
      and m.status = 'active'
  ) then
    raise exception 'membership unavailable' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.member_profiles p
    where p.id = p_user_id and p.chapter_id = p_chapter_id
  ) then
    select m.chapter_id into replacement_chapter
    from public.member_chapter_memberships m
    join public.chapters c
      on c.id = m.chapter_id
     and c.organization_id = target_org
    where m.user_id = p_user_id
      and m.chapter_id <> p_chapter_id
      and m.status = 'active'
    order by m.last_selected_at desc nulls last, m.joined_at, m.chapter_id
    limit 1;
  end if;

  before_state := private.learning_membership_state('public.member_chapter_memberships', membership_key);
  leaves_organization := not exists (
    select 1
    from public.member_chapter_memberships m
    join public.chapters c on c.id = m.chapter_id
    where m.user_id = p_user_id
      and m.chapter_id <> p_chapter_id
      and m.status = 'active'
      and c.organization_id = target_org
  );

  -- Write tenant-attributed evidence while the actor's selected membership is
  -- still intact. This matters when an organization admin revokes their own
  -- final chapter membership.
  insert into public.member_admin_audit (
    actor, action, target_user, detail, organization_id
  ) values (
    caller,
    'revoke_chapter_membership',
    p_user_id,
    pg_catalog.jsonb_build_object(
      'chapterId', p_chapter_id,
      'replacementChapterId', replacement_chapter
    ),
    target_org
  );

  if leaves_organization and pg_catalog.char_length(membership_key) <= 128 then
    perform private.learning_journal_append('chapter_membership_revoke_final', 'public.member_chapter_memberships', membership_key);
  end if;

  update public.member_chapter_memberships
  set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
  where user_id = p_user_id and chapter_id = p_chapter_id and status = 'active';

  delete from public.member_role_chapters
  where user_id = p_user_id and chapter_id = p_chapter_id;
  delete from public.member_roles r
  where r.user_id = p_user_id and r.chapter_id is not null
    and not exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = r.user_id and rc.role = r.role
    );

  if not exists (
    select 1
    from public.member_chapter_memberships m
    join public.chapters c on c.id = m.chapter_id
    where m.user_id = p_user_id
      and m.status = 'active'
      and c.organization_id = target_org
  ) then
    update public.organization_memberships
    set status = 'revoked', revoked_at = pg_catalog.clock_timestamp()
    where organization_id = target_org and user_id = p_user_id and status = 'active';
  end if;

  if exists (
    select 1 from public.member_profiles p
    where p.id = p_user_id and p.chapter_id = p_chapter_id
  ) then
    update public.member_profiles set chapter_id = replacement_chapter where id = p_user_id;
  end if;
  if not leaves_organization then
    perform private.learning_membership_journal('chapter_membership_revoke', 'public.member_chapter_memberships', membership_key, before_state);
  end if;
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'chapterId', p_chapter_id, 'active', false);
end;
end;
$function$;


-- Chapter display titles (20261004050000), journalled.
create or replace function public.set_member_chapter_display_title(p_user_id uuid, p_chapter_id text, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  clean_title text;
  target_org uuid;
  previous_title text;
  title_key text;
  before_state jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  clean_title := nullif(pg_catalog.btrim(coalesce(p_title, '')), '');
  -- The invitation target-chapter rule: an admin of this chapter in the
  -- selected organization. A President or any title holder cannot set titles.
  if caller is null
     or not private.mfa_satisfied()
     or not private.member_invitation_chapter_administrable(p_chapter_id) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if clean_title is not null and (pg_catalog.char_length(clean_title) > 60 or clean_title ~ '[[:cntrl:]]') then
    raise exception 'invalid display title' using errcode = '22023';
  end if;
  select c.organization_id into target_org from public.chapters c where c.id = p_chapter_id;

  select m.display_title into previous_title
  from public.member_chapter_memberships m
  where m.user_id = p_user_id and m.chapter_id = p_chapter_id and m.status = 'active'
  for update;
  if not found then
    raise exception 'membership not found' using errcode = '22023';
  end if;
  title_key := 't:' || p_user_id::text || ':' || p_chapter_id;
  before_state := private.learning_membership_state('public.member_chapter_memberships', title_key);

  update public.member_chapter_memberships
  set display_title = clean_title
  where user_id = p_user_id and chapter_id = p_chapter_id and status = 'active';

  insert into public.member_admin_audit (actor, action, target_user, detail, organization_id)
  values (caller, 'set_chapter_display_title', p_user_id,
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id, 'title', clean_title,
      'previousTitle', previous_title),
    target_org);
  perform private.learning_membership_journal('chapter_display_title_change', 'public.member_chapter_memberships', title_key, before_state);

  return pg_catalog.jsonb_build_object('updated', true, 'displayTitle', clean_title);
end;
$function$;


-- Chapter budget offices (20261009003000), journalled.
create or replace function public.set_chapter_budget_office(p_expected_org uuid, p_expected_chapter text, p_user_id uuid, p_office text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare ctx record; old_office text; office_key text; before_state jsonb;
begin
  perform private.lock_case_graph(array[(select auth.uid()), p_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into ctx from private.chapter_budget_context(p_expected_org, p_expected_chapter);
  if not ctx.can_assign then raise exception 'chapter admin required' using errcode = '42501'; end if;
  if p_office is not null and p_office not in ('treasurer', 'secretary_treasurer', 'secretary') then
    raise exception 'invalid budget office' using errcode = '22023';
  end if;
  select m.budget_office into old_office from public.member_chapter_memberships m
    join public.organization_memberships om on om.user_id = m.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
    where m.user_id = p_user_id and m.chapter_id = ctx.chapter_id and m.status = 'active'
    for update of m;
  if not found then raise exception 'chapter member required' using errcode = '42501'; end if;
  office_key := 'o:' || p_user_id::text || ':' || ctx.chapter_id;
  before_state := private.learning_membership_state('public.member_chapter_memberships', office_key);
  update public.member_chapter_memberships set budget_office = p_office
    where user_id = p_user_id and chapter_id = ctx.chapter_id;
  if old_office is distinct from p_office then
    insert into public.organization_audit_ledger
      (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
    values (ctx.organization_id, 'administration', 'chapter_budget_office', case when p_office is null then 'revoke' else 'grant' end,
      (select auth.uid()), 'membership', p_user_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('chapterId', ctx.chapter_id, 'fromRole', old_office, 'toRole', p_office));
  end if;
  perform private.learning_membership_journal('chapter_budget_office_change', 'public.member_chapter_memberships', office_key, before_state);
  return pg_catalog.jsonb_build_object('saved', true);
end;
$function$;


-- Pinning your own chapter (20260821010000), journalled; the graph lock now comes first.
create or replace function public.set_my_chapter_pin(p_chapter_id text, p_pinned boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  changed integer;
  pin_key text := 'p:' || (select auth.uid())::text || ':' || p_chapter_id;
  before_state jsonb;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  before_state := private.learning_membership_state('public.member_chapter_memberships', pin_key);
  update public.member_chapter_memberships
  set pinned = coalesce(p_pinned, false)
  where user_id = caller and chapter_id = p_chapter_id and status = 'active';
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'chapter unavailable' using errcode = '42501'; end if;
  perform private.learning_membership_journal('own_chapter_pin', 'public.member_chapter_memberships', pin_key, before_state);
  return pg_catalog.jsonb_build_object('chapterId', p_chapter_id, 'pinned', coalesce(p_pinned, false));
end;
end;
$function$;


-- Organization settings (20261002022000), journalled unless the key is a security or retention control.
create or replace function private.write_organization_setting(
  p_key text,
  p_value jsonb,
  p_expected_updated_at timestamptz,
  p_check_version boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org_id uuid;
  caller uuid;
  definition public.platform_setting_definitions%rowtype;
  stored public.organization_setting_values%rowtype;
  written public.organization_setting_values%rowtype;
  had_override boolean;
  setting_key_text text;
  before_state jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org_id := private.current_member_organization();
  caller := (select auth.uid());
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select * into definition from public.platform_setting_definitions where key = p_key;
  if found and not definition.organization_editable then
    raise exception 'setting is set for the whole platform' using errcode = '42501';
  end if;
  if not found or (p_value is not null and not private.setting_value_valid(
    definition.value_kind, p_value, definition.minimum, definition.maximum, definition.allowed_values
  )) then
    raise exception 'invalid setting value' using errcode = '22023';
  end if;

  select * into stored
  from public.organization_setting_values
  where organization_id = org_id and setting_key = p_key
  for update;
  had_override := found;
  setting_key_text := org_id::text || ':' || p_key;
  before_state := private.learning_membership_state('public.organization_setting_values', setting_key_text);
  if p_check_version and (case when had_override then stored.updated_at else null end) is distinct from p_expected_updated_at then
    raise exception 'setting changed' using errcode = '40001';
  end if;

  -- clock_timestamp(), not the transaction start: two changes in one
  -- transaction keep distinct, ordered version tokens and audit times.
  if p_value is null then
    delete from public.organization_setting_values
    where organization_id = org_id and setting_key = p_key;
    insert into public.organization_configuration_audit
      (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
    values (org_id, caller, 'setting_reset', p_key,
      case when had_override then stored.value else definition.default_value end,
      definition.default_value, pg_catalog.clock_timestamp());
    if not private.learning_setting_excluded(p_key) then
      perform private.learning_membership_journal('organization_setting_reset', 'public.organization_setting_values', setting_key_text, before_state);
    end if;
    return pg_catalog.jsonb_build_object('key', p_key, 'value', definition.default_value,
      'overridden', false, 'updatedAt', null, 'updated', true);
  end if;

  insert into public.organization_setting_values (organization_id, setting_key, value, updated_by, updated_at)
  values (org_id, p_key, p_value, caller, pg_catalog.clock_timestamp())
  on conflict (organization_id, setting_key) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into written;
  insert into public.organization_configuration_audit
    (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
  values (org_id, caller, 'setting_updated', p_key,
    case when had_override then stored.value else definition.default_value end,
    p_value, pg_catalog.clock_timestamp());
  if not private.learning_setting_excluded(p_key) then
    perform private.learning_membership_journal('organization_setting_change', 'public.organization_setting_values', setting_key_text, before_state);
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'value', p_value,
    'overridden', true, 'updatedAt', written.updated_at, 'updated', true);
end;
$function$;


-- The organization network profile (20260828235000), journalled; the graph lock now comes first.
create or replace function public.upsert_organization_network_profile(
  p_display_name text,
  p_summary text default '',
  p_visibility text default 'private',
  p_contact_mode text default 'disabled',
  p_parent_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  before_state jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization directory role required' using errcode = '42501';
  end if;
  if p_parent_organization_id is not null and not exists (
    select 1
    from public.organization_network_permission_grants permission
    join public.organization_coordination_records network
      on network.id = permission.network_record_id
    join public.organization_coordination_organization_participants parent_participant
      on parent_participant.record_id = network.id
      and parent_participant.organization_id = p_parent_organization_id
      and parent_participant.status = 'active'
    join public.organization_coordination_organization_participants child_participant
      on child_participant.record_id = network.id
      and child_participant.organization_id = organization
      and child_participant.status = 'active'
    where permission.grantor_organization_id = p_parent_organization_id
      and permission.grantee_organization_id = organization
      and permission.capability = 'oversight'
      and permission.status = 'active'
      and network.kind = 'network_link' and network.status = 'active'
  ) then
    raise exception 'accepted parent oversight grant required' using errcode = '42501';
  end if;
  before_state := private.learning_membership_state('public.organization_network_directory_profiles', organization::text);
  insert into public.organization_network_directory_profiles (
    organization_id, display_name, summary, visibility, contact_mode,
    parent_organization_id, updated_by
  ) values (
    organization, pg_catalog.btrim(p_display_name), coalesce(p_summary, ''),
    p_visibility, p_contact_mode, p_parent_organization_id, caller
  ) on conflict (organization_id) do update
    set display_name = excluded.display_name,
        summary = excluded.summary,
        visibility = excluded.visibility,
        contact_mode = excluded.contact_mode,
        parent_organization_id = excluded.parent_organization_id,
        updated_by = caller,
        updated_at = pg_catalog.clock_timestamp();
  perform private.learning_membership_journal('network_profile_change', 'public.organization_network_directory_profiles', organization::text, before_state);
  return pg_catalog.jsonb_build_object(
    'saved', true, 'organizationId', organization,
    'visibility', p_visibility, 'contactMode', p_contact_mode,
    'parentOrganizationId', p_parent_organization_id
  );
end;
end;
$function$;


-- Your own profile details (20261008100000), journalled unless set_my_profile_details_v2 journals the whole change itself.
create or replace function public.set_my_profile_details(
  p_pronouns text,
  p_job_title text,
  p_worksite text,
  p_phone text,
  p_details_visibility text,
  p_phone_visibility text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  clean_pronouns text := nullif(pg_catalog.btrim(coalesce(p_pronouns, '')), '');
  clean_job_title text := nullif(pg_catalog.btrim(coalesce(p_job_title, '')), '');
  clean_worksite text := nullif(pg_catalog.btrim(coalesce(p_worksite, '')), '');
  clean_phone text := nullif(pg_catalog.btrim(coalesce(p_phone, '')), '');
  details_choice text := coalesce(p_details_visibility, 'only_me');
  phone_choice text := coalesce(p_phone_visibility, 'only_me');
  before_state jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if details_choice not in ('only_me', 'admins') or phone_choice not in ('only_me', 'admins') then
    raise exception 'invalid visibility' using errcode = '22023';
  end if;
  if (clean_pronouns is not null and (pg_catalog.char_length(clean_pronouns) > 40 or clean_pronouns ~ '[[:cntrl:]]'))
     or (clean_job_title is not null and (pg_catalog.char_length(clean_job_title) > 120 or clean_job_title ~ '[[:cntrl:]]'))
     or (clean_worksite is not null and (pg_catalog.char_length(clean_worksite) > 160 or clean_worksite ~ '[[:cntrl:]]')) then
    raise exception 'invalid profile detail' using errcode = '22023';
  end if;
  if clean_phone is not null
     and (pg_catalog.char_length(clean_phone) not between 7 and 40 or clean_phone !~ '^[0-9+().\- ]+$') then
    raise exception 'invalid phone number' using errcode = '22023';
  end if;

  before_state := private.learning_membership_state('public.member_profile_details', caller::text);
  insert into public.member_profile_details as d (
    user_id, pronouns, job_title, worksite, phone, details_visibility, phone_visibility, updated_at
  ) values (
    caller, clean_pronouns, clean_job_title, clean_worksite, clean_phone, details_choice, phone_choice, pg_catalog.now()
  )
  on conflict (user_id) do update set
    pronouns = excluded.pronouns,
    job_title = excluded.job_title,
    worksite = excluded.worksite,
    phone = excluded.phone,
    details_visibility = excluded.details_visibility,
    phone_visibility = excluded.phone_visibility,
    updated_at = excluded.updated_at;
  if coalesce(pg_catalog.current_setting('sg.learning_profile_details_writer', true), '') <> '1' then
    perform private.learning_membership_journal('own_profile_details_update', 'public.member_profile_details', caller::text, before_state);
  end if;

  return public.get_my_profile_details();
end;
end;
$$;


-- Your own profile and workplace details (20261008232000), journalled as one change.
create or replace function public.set_my_profile_details_v2(p_details jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  before_state jsonb;
begin
  if auth.uid() is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_details) is distinct from 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_details) k
       where k not in ('pronouns','jobTitle','worksite','shift','classification','phone','detailsVisibility','phoneVisibility'))
     or exists (select 1 from pg_catalog.jsonb_each(p_details) e
       where pg_catalog.jsonb_typeof(e.value) not in ('string','null')) then
    raise exception 'invalid profile details' using errcode = '22023';
  end if;
  if exists (select 1 from (values (p_details->>'shift'), (p_details->>'classification')) f(value)
    where pg_catalog.char_length(pg_catalog.btrim(f.value)) > 120 or f.value ~ '[[:cntrl:]]') then
    raise exception 'invalid workplace attribute' using errcode = '22023';
  end if;
  before_state := private.learning_membership_state('public.member_profile_details', auth.uid()::text);
  perform pg_catalog.set_config('sg.learning_profile_details_writer', '1', true);
  perform public.set_my_profile_details(p_details->>'pronouns',p_details->>'jobTitle',p_details->>'worksite',
    p_details->>'phone',p_details->>'detailsVisibility',p_details->>'phoneVisibility');
  update public.member_profile_details
    set shift = nullif(pg_catalog.btrim(p_details->>'shift'), ''),
        classification = nullif(pg_catalog.btrim(p_details->>'classification'), '')
    where user_id = auth.uid();
  perform pg_catalog.set_config('sg.learning_profile_details_writer', '', true);
  perform private.learning_membership_journal('own_profile_details_update', 'public.member_profile_details', auth.uid()::text, before_state);
  return public.get_my_profile_details();
end;
end;
$function$;


-- Your own form autofill choice (20261031130301), journalled.
create or replace function public.set_my_form_autofill_preference(p_preference text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  before_state jsonb;
begin
  if auth.uid() is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_preference is null or p_preference not in ('ask', 'always', 'never') then
    raise exception 'invalid form autofill preference' using errcode = '22023';
  end if;
  before_state := private.learning_membership_state('public.member_profile_details', auth.uid()::text);
  insert into public.member_profile_details as d (user_id, form_autofill)
  values (auth.uid(), p_preference)
  on conflict (user_id) do update
    set form_autofill = excluded.form_autofill, updated_at = pg_catalog.now();
  perform private.learning_membership_journal('own_profile_details_update', 'public.member_profile_details', auth.uid()::text, before_state);
  return pg_catalog.jsonb_build_object('preference', p_preference);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Your own profile and settings through one journalled RPC
-- ---------------------------------------------------------------------------
-- The web client's profile and settings saves, which were direct column
-- updates of the caller's own member_profiles row. The same rule the update
-- policy applied (your own row), the same fifteen columns the column grant
-- allows, and the table's own checks on every value, in a session that has
-- finished its sign-in steps. Keys left out keep their stored value. The
-- caller names the account the form belongs to, so a session switched under
-- an open form can never write it into another account's profile.
create function public.update_my_member_profile(p_expected_user_id uuid, p_fields jsonb)
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
  stored public.member_profiles%rowtype;
  wanted public.member_profiles%rowtype;
  before_state jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_expected_user_id is distinct from caller then
    raise exception 'this form belongs to another account' using errcode = '42501';
  end if;
  if p_fields is null or pg_catalog.jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_fields) k(name) where k.name not in (
       'first_name', 'full_name', 'initials', 'role_line', 'member_since', 'language', 'notification_prefs',
       'dnd_enabled', 'quiet_hours_start', 'quiet_hours_end', 'quiet_hours_timezone',
       'urgent_notifications_enabled', 'shortcut_keys', 'work_widget_order', 'pulse_score_visible')) then
    raise exception 'invalid profile fields' using errcode = '22023';
  end if;
  select * into stored from public.member_profiles p where p.id = caller for update;
  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  before_state := private.learning_membership_state('public.member_profiles', caller::text);
  wanted := pg_catalog.jsonb_populate_record(stored, p_fields);
  update public.member_profiles p
  set first_name = wanted.first_name, full_name = wanted.full_name, initials = wanted.initials,
      role_line = wanted.role_line, member_since = wanted.member_since, language = wanted.language,
      notification_prefs = wanted.notification_prefs, dnd_enabled = wanted.dnd_enabled,
      quiet_hours_start = wanted.quiet_hours_start, quiet_hours_end = wanted.quiet_hours_end,
      quiet_hours_timezone = wanted.quiet_hours_timezone,
      urgent_notifications_enabled = wanted.urgent_notifications_enabled,
      shortcut_keys = wanted.shortcut_keys, work_widget_order = wanted.work_widget_order,
      pulse_score_visible = wanted.pulse_score_visible
  where p.id = caller;
  if p_fields ?| array['first_name', 'full_name', 'initials', 'role_line', 'member_since'] then
    perform private.learning_membership_journal('own_profile_update', 'public.member_profiles', caller::text, before_state);
  else
    perform private.learning_membership_journal('own_settings_update', 'public.member_profiles', caller::text, before_state);
  end if;
  return pg_catalog.jsonb_build_object('updated', true);
end;
end;
$function$;
revoke all on function public.update_my_member_profile(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.update_my_member_profile(uuid, jsonb) to authenticated;

comment on function public.update_my_member_profile(uuid, jsonb) is
  'REQ-UG-LEARNING-PERIOD-MEMBERSHIP-ROLES-SETTINGS-20261103: the caller''s own profile, language, notification and display choices, journalled during a learning period. The member_profiles column UPDATE grant stays until native builds call this RPC.';

notify pgrst, 'reload schema';
commit;
