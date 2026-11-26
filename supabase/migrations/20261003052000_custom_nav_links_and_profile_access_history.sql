-- REQ-UG-CUSTOM-NAV-LINKS-20261001
-- REQ-UG-ACCESS-HISTORY-PROFILE-VIEWS-20261001 (clean-room parity CR-086)
--
-- Restore-everything campaign, GOVERNANCE (second PR).
--
-- ===========================================================================
-- 1. Custom navigation links
-- ===========================================================================
-- Old app (git ref de7df4b57c^): supabase/migrations/0036_custom_links_config.sql
-- seeded custom_link_1_label/_url and custom_link_2_label/_url as empty public
-- settings, and lib/settings/settings-keys.ts:265-301 (getCustomLinks,
-- sanitizeCustomLinkUrl) rendered a link only when both its label and URL were
-- set and the URL parsed to an allowed scheme. The sidebar footer and the
-- mobile menu showed them (components/mobile/mobile-nav-fallback.tsx:63).
--
-- Restored as four organization text settings (category general, visible to
-- members so web and native can render them). Defaults: empty, as old 0036
-- (no link until an admin sets both halves). Safer than the old app: only
-- https:// addresses are accepted (old allowed http: too), checked in the
-- database by a CHECK constraint on organization_setting_values, so no
-- javascript:, data:, http: or credential-bearing address can be stored by
-- any writer. Labels are 1-40 characters with no control characters or angle
-- brackets.
--
-- ===========================================================================
-- 2. Access history: staff profile views and updates
-- ===========================================================================
-- The member access history (20260828021500) can list viewed_profile and
-- updated_profile, but nothing produced them, so  narrowed the
-- member-facing copy to case and role events. The server paths that read or
-- update a member's profile for staff now record them:
--   * public.get_member_operational_profile (the organization admin's member
--     profile read) records viewed_profile. It becomes VOLATILE and enters
--     through private.lock_case_graph. Repeated views of one member by the
--     same staff member within 10 minutes are recorded once.
--   * Every write of public.organization_member_operational_profiles (the
--     single save, the bulk update and the import commit) records
--     updated_profile for the member through an AFTER trigger, when the
--     profile data actually changed and the writer is staff of the
--     organization.
-- Privacy: only staff access to someone else's profile is recorded. A member
-- reading or changing their own profile is never recorded
-- (member_access_events_not_self), and a writer who holds no staff role in the
-- organization records nothing. Queue, list and directory reads stay outside
-- the logged surface, as the member copy says.
--
-- No switch: the access history is a privacy protection for members. A switch
-- that let an organization stop recording its own staff's access would weaken
-- it, so none is added (listed for the owner in the delivery report).
--
-- Boundaries kept: same signatures and grants, SECURITY DEFINER with an empty
-- search_path, organization derived from the session; member_access_events
-- keeps its RLS, MFA floor and self-only read.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Custom navigation links
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old 0036_custom_links_config.sql:22-26: empty until an admin sets both halves.
  ('text.navigation.custom_link_1_label', 'text', 'Custom link 1: label',
   'Shown in the web and phone menus when both the label and the address are set. Up to 40 characters.',
   '""', null, null, null, 110, 'general', true),
  ('text.navigation.custom_link_1_url', 'text', 'Custom link 1: address',
   'The https:// address the link opens. Other kinds of address, including http: and javascript:, are refused.',
   '""', null, null, null, 111, 'general', true),
  ('text.navigation.custom_link_2_label', 'text', 'Custom link 2: label',
   'Shown in the web and phone menus when both the label and the address are set. Up to 40 characters.',
   '""', null, null, null, 112, 'general', true),
  ('text.navigation.custom_link_2_url', 'text', 'Custom link 2: address',
   'The https:// address the link opens. Other kinds of address, including http: and javascript:, are refused.',
   '""', null, null, null, 113, 'general', true)
on conflict (key) do nothing;

-- An empty value clears the link. A URL is https:// plus a host name, an
-- optional port and an optional path, query or fragment with no spaces,
-- control characters, quotes, backslashes or angle brackets; no user
-- information (no "@" before the host).
create function private.custom_nav_link_value_valid(p_key text, p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_key in ('text.navigation.custom_link_1_url', 'text.navigation.custom_link_2_url') then
      pg_catalog.jsonb_typeof(p_value) = 'string'
      and (
        (p_value #>> '{}') = ''
        or (
          pg_catalog.char_length(p_value #>> '{}') <= 240
          and (p_value #>> '{}') ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?([/?#][^[:space:][:cntrl:]<>"''\\`]*)?$'
        )
      )
    when p_key in ('text.navigation.custom_link_1_label', 'text.navigation.custom_link_2_label') then
      pg_catalog.jsonb_typeof(p_value) = 'string'
      and pg_catalog.char_length(p_value #>> '{}') <= 40
      and (p_value #>> '{}') = pg_catalog.btrim(p_value #>> '{}')
      and (p_value #>> '{}') !~ '[[:cntrl:]<>]'
    else true
  end;
$function$;

revoke all on function private.custom_nav_link_value_valid(text, jsonb) from public, anon, authenticated, service_role;

alter table public.organization_setting_values
  add constraint organization_setting_values_custom_nav_links
    check (private.custom_nav_link_value_valid(setting_key, value));

-- ---------------------------------------------------------------------------
-- 2. Access history: staff profile views and updates
-- ---------------------------------------------------------------------------

-- The highest staff role the actor holds in the organization (organization
-- grant, or a chapter role in one of its chapters), or NULL for a non-staff
-- writer. NULL means nothing is recorded.
create function private.member_access_actor_role(p_organization_id uuid, p_actor uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select held.role
  from (
    select grant_row.role
    from public.organization_role_grants grant_row
    where grant_row.organization_id = p_organization_id and grant_row.user_id = p_actor
    union all
    select rc.role
    from public.member_role_chapters rc
    join public.chapters chapter_row
      on chapter_row.id = rc.chapter_id and chapter_row.organization_id = p_organization_id
    join public.member_chapter_memberships m
      on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
    where rc.user_id = p_actor
  ) held
  where held.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by case held.role
    when 'admin' then 1 when 'vp' then 2 when 'coordinator' then 3 when 'advisor' then 4 else 5 end
  limit 1;
$function$;

-- Records one staff profile access. Self-access and non-staff actors record
-- nothing. A view repeated by the same staff member within 10 minutes, or
-- right after their own update, is recorded once, and one transaction records
-- at most one update per member (the bulk writer inserts, then updates).
create function private.record_staff_profile_access(
  p_organization_id uuid,
  p_subject_user_id uuid,
  p_action text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  actor uuid := (select auth.uid());
  actor_role text;
begin
  if actor is null or p_subject_user_id is null or actor = p_subject_user_id
     or p_organization_id is null or p_action not in ('viewed_profile', 'updated_profile') then
    return;
  end if;
  actor_role := private.member_access_actor_role(p_organization_id, actor);
  if actor_role is null then
    return;
  end if;
  if p_action = 'viewed_profile' and exists (
      select 1 from public.member_access_events e
      where e.organization_id = p_organization_id and e.subject_user_id = p_subject_user_id
        and e.actor_user_id = actor and e.action in ('viewed_profile', 'updated_profile')
        and e.occurred_at > pg_catalog.now() - interval '10 minutes'
    ) then
    return;
  end if;
  if p_action = 'updated_profile' and exists (
      select 1 from public.member_access_events e
      where e.organization_id = p_organization_id and e.subject_user_id = p_subject_user_id
        and e.actor_user_id = actor and e.action = 'updated_profile'
        and e.occurred_at = pg_catalog.now()
    ) then
    return;
  end if;
  insert into public.member_access_events (
    organization_id, subject_user_id, actor_user_id, actor_role, action, entity_type, entity_id
  ) values (
    p_organization_id, p_subject_user_id, actor, actor_role, p_action, 'member', null
  );
end;
end;
$function$;

create function private.record_operational_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Account deletion only nulls updated_by; that is not a profile change.
  if tg_op = 'UPDATE' and (pg_catalog.to_jsonb(new) - 'updated_by' - 'updated_at' - 'version')
       is not distinct from (pg_catalog.to_jsonb(old) - 'updated_by' - 'updated_at' - 'version') then
    return null;
  end if;
  -- An empty placeholder row (the bulk writer creates one before updating it)
  -- holds no profile data yet.
  if tg_op = 'INSERT' and not exists (
      select 1 from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)
        - 'organization_id' - 'member_user_id' - 'version' - 'updated_by' - 'created_at' - 'updated_at') field
      where field.value <> 'null'::jsonb
    ) then
    return null;
  end if;
  perform private.record_staff_profile_access(new.organization_id, new.member_user_id, 'updated_profile');
  return null;
end;
$function$;

create trigger z90_record_operational_profile_update
  after insert or update on public.organization_member_operational_profiles
  for each row execute function private.record_operational_profile_update();

-- The organization admin's member profile read (20260830160000, wrapped by
-- 20260907151000) now records viewed_profile. Only VOLATILE (it writes), the
-- case-graph entry lock and the final record call change; the projection, the
-- admin and MFA gate (private.require_member_operations_admin) and the
-- active-membership refusal are unchanged. save_member_operational_profile
-- still returns this projection; its own update was recorded a moment earlier,
-- so no view is added for the save.
create or replace function public.get_member_operational_profile(p_member_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  org uuid := private.require_member_operations_admin();
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'userId', profile.id, 'fullName', profile.full_name, 'initials', profile.initials,
    'version', coalesce(operational.version, 0),
    'profile', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'memberNumber', operational.member_number, 'jobTitle', operational.job_title,
      'department', operational.department, 'workLocation', operational.work_location,
      'hireDate', operational.hire_date, 'membershipClass', operational.membership_class,
      'preferredLanguage', operational.preferred_language,
      'administrativeNotes', operational.administrative_notes
    )), 'updatedAt', operational.updated_at, 'updatedByName', editor.full_name
  ) into result
  from public.organization_memberships membership
  join public.member_profiles profile on profile.id = membership.user_id
  left join public.organization_member_operational_profiles operational
    on operational.organization_id = membership.organization_id and operational.member_user_id = membership.user_id
  left join public.member_profiles editor on editor.id = operational.updated_by
  where membership.organization_id = org and membership.user_id = p_member_user_id
    and membership.status = 'active' and membership.revoked_at is null;
  if result is null then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.record_staff_profile_access(org, p_member_user_id, 'viewed_profile');
  return result;
end;
end;
$function$;

revoke all on function private.member_access_actor_role(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.record_staff_profile_access(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.record_operational_profile_update() from public, anon, authenticated, service_role;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public'
        and table_name = 'organization_member_operational_profiles'
        and object_name = 'z90_record_operational_profile_update')
   or (kind = 'function' and schema_name = 'private' and object_name in (
        'record_operational_profile_update()',
        'record_staff_profile_access(p_organization_id uuid, p_subject_user_id uuid, p_action text)',
        'member_access_actor_role(p_organization_id uuid, p_actor uuid)'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_profile_access_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after profile access history: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_profile_access_lifecycle$;

notify pgrst, 'reload schema';

commit;
