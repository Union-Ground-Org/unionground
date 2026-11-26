-- REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001
-- REQ-UG-CONFIGURABLE-THRESHOLDS-20261001
--
-- Restore-everything campaign,. One organization settings
-- registry that every restored behavior registers into, so each function that
-- can be switched or adjusted has a visible control for organization admins.
--
-- ===========================================================================
-- CONTRACT FOR OTHER LANES (pinned 2026-10-01; do not rename)
-- ===========================================================================
--
-- public.platform_setting_definitions gains:
--   category text not null default 'general'
--     one of: general, security, engagement_voice, guidance_onboarding, home,
--     casework, intelligence, automation, messaging, governance, integrations,
--     ai_assistant, notifications, data_retention, analytics, labels
--   member_visible boolean not null default false
--     true = the effective value is returned to every signed-in member of the
--     organization by get_member_organization_configuration().switches so web
--     and native UI can show or hide the feature honestly. Never mark a value
--     member-visible when it is sensitive.
--   value_kind 'boolean' | 'integer' | 'text' | 'text_list'
--     text + allowed_values is an enum (select). text_list is a jsonb array of
--     distinct, trimmed strings: at most 50 items of 1..80 characters each;
--     minimum/maximum bound the ITEM COUNT for text_list and the VALUE for
--     integer. allowed_values, when set on a text_list, restricts its items.
--   default_value must itself be valid for its kind (CHECK).
--
-- Key convention: features.<area>.<name> (boolean switch),
-- limits.<area>.<name> (integer or enum), lists.<area>.<name> (text_list).
--
-- Lanes register definitions in their own migration with exactly:
--   insert into public.platform_setting_definitions
--     (key, value_kind, label, description, default_value, minimum, maximum,
--      allowed_values, sort_order, category, member_visible)
--   values (...)
--   on conflict (key) do nothing;
-- The default_value is the old app's effective production default, cited in a
-- comment next to the row. EN/ES copy lives in src/lib/i18n.js under
-- settings.def.<key>.label and settings.def.<key>.description; the DB label is
-- the English fallback.
--
-- SQL helpers (SECURITY DEFINER, empty search_path, EXECUTE revoked from
-- public/anon/authenticated/service_role; call them from SECURITY DEFINER
-- code that has already resolved the caller's organization):
--   private.organization_feature_enabled(p_organization_id uuid, p_key text) returns boolean
--   private.organization_limit(p_organization_id uuid, p_key text) returns integer
--   private.organization_setting_text(p_organization_id uuid, p_key text) returns text
--   private.organization_setting_text_list(p_organization_id uuid, p_key text) returns text[]
-- Each returns the organization's value, else the definition default (also
-- for a null organization). An unknown key, or a key of a different value
-- kind, raises 22023 so a typo fails loudly in tests.
--
-- RPCs:
--   public.get_member_organization_configuration()      member-safe read; adds
--     "switches": { "<key>": <effective value> } for every member_visible key
--   public.get_admin_organization_configuration()       admin read; each setting
--     adds category, memberVisible, updatedAt (version token) and lastChange
--   public.set_organization_setting(p_key text, p_value jsonb, p_expected_updated_at timestamptz)
--   public.reset_organization_setting(p_key text, p_expected_updated_at timestamptz)
--     admin writes with an optimistic version check (40001 'setting changed')
--   public.update_organization_setting(p_key text, p_value jsonb)  (unchanged
--     signature, now audited with values, no version check)
--   public.list_organization_configuration_audit(p_setting_key text, p_limit integer)
--   public.get_organization_settings_for_service(p_organization_id uuid, p_keys text[])
--     service_role only; used by api/_lib/organizationSettings.js
--
-- Boundaries kept: organization admins write through MFA-aware SECURITY
-- DEFINER RPCs only; the four tables keep their restrictive mfa_assurance
-- policies and no client table grants; every write is audited, now with the
-- previous and new value. The organization is always derived from the
-- caller's session, never accepted from a client.
--
-- Production stays empty: the only rows written are platform definitions.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Registry columns, value kinds and bounds
-- ---------------------------------------------------------------------------

alter table public.platform_setting_definitions
  add column category text not null default 'general',
  add column member_visible boolean not null default false;

alter table public.platform_setting_definitions
  add constraint platform_setting_definitions_category check (category in (
    'general', 'security', 'engagement_voice', 'guidance_onboarding', 'home',
    'casework', 'intelligence', 'automation', 'messaging', 'governance',
    'integrations', 'ai_assistant', 'notifications', 'data_retention',
    'analytics', 'labels'
  ));

alter table public.platform_setting_definitions
  drop constraint platform_setting_definitions_value_kind_check;
alter table public.platform_setting_definitions
  add constraint platform_setting_definitions_value_kind_check
    check (value_kind in ('boolean', 'integer', 'text', 'text_list'));

alter table public.platform_setting_definitions
  add constraint platform_setting_definitions_text_list_bounds check (
    value_kind <> 'text_list'
    or ((minimum is null or minimum between 0 and 50) and (maximum is null or maximum between 0 and 50))
  ),
  add constraint platform_setting_definitions_allowed_values check (
    allowed_values is null
    or (pg_catalog.cardinality(allowed_values) between 1 and 50 and value_kind in ('text', 'text_list'))
  );

-- A 50-item list of 80 multi-byte characters does not fit the original 1 KiB
-- bound. Keep a bound, sized for the largest valid list.
alter table public.organization_setting_values
  drop constraint organization_setting_values_bounded;
alter table public.organization_setting_values
  add constraint organization_setting_values_bounded check (pg_catalog.octet_length(value::text) <= 16384);

create or replace function private.setting_value_valid(
  p_kind text,
  p_value jsonb,
  p_minimum integer,
  p_maximum integer,
  p_allowed_values text[]
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_value is null then false
    when p_kind = 'boolean' then pg_catalog.jsonb_typeof(p_value) = 'boolean'
    when p_kind = 'integer' then
      pg_catalog.jsonb_typeof(p_value) = 'number'
      and p_value::text ~ '^-?[0-9]+$'
      and pg_catalog.char_length(p_value::text) <= 10
      and (p_minimum is null or (p_value::text)::bigint >= p_minimum)
      and (p_maximum is null or (p_value::text)::bigint <= p_maximum)
    when p_kind = 'text' then
      pg_catalog.jsonb_typeof(p_value) = 'string'
      and pg_catalog.char_length(p_value #>> '{}') <= 240
      and (p_allowed_values is null or (p_value #>> '{}') = any(p_allowed_values))
      and (p_value #>> '{}') !~ '[[:cntrl:]]'
    when p_kind = 'text_list' then
      case
        when pg_catalog.jsonb_typeof(p_value) <> 'array' then false
        when pg_catalog.jsonb_array_length(p_value) > 50
          or pg_catalog.jsonb_array_length(p_value) < coalesce(p_minimum, 0)
          or pg_catalog.jsonb_array_length(p_value) > coalesce(p_maximum, 50) then false
        when exists (
          select 1 from pg_catalog.jsonb_array_elements(p_value) item
          where pg_catalog.jsonb_typeof(item) <> 'string'
        ) then false
        else not exists (
          select 1 from pg_catalog.jsonb_array_elements_text(p_value) item
          where pg_catalog.char_length(item) not between 1 and 80
            or item <> pg_catalog.btrim(item)
            or item ~ '[[:cntrl:]<>]'
            or (p_allowed_values is not null and not (item = any(p_allowed_values)))
        )
        and (
          select pg_catalog.count(distinct pg_catalog.lower(item))
          from pg_catalog.jsonb_array_elements_text(p_value) item
        ) = pg_catalog.jsonb_array_length(p_value)
      end
    else false
  end
$function$;

revoke all on function private.setting_value_valid(text, jsonb, integer, integer, text[]) from public, anon, authenticated, service_role;

-- Every definition's own default must be a valid value of its kind, so a
-- helper can never hand a lane a default the write path would refuse.
alter table public.platform_setting_definitions
  add constraint platform_setting_definitions_default_valid check (
    private.setting_value_valid(value_kind, default_value, minimum, maximum, allowed_values)
  );

-- The two platform-wide password sign-in limits of 20261002015000 are
-- security settings too; they stay member-invisible and read-only per
-- organization (organization_setting_values_platform_wide_keys).
update public.platform_setting_definitions
set category = 'security', member_visible = key in ('features.passkey_enrollment', 'features.mfa_recovery_code_enrollment')
where key in (
  'features.passkey_enrollment', 'features.mfa_recovery_code_enrollment',
  'security.failed_login_retention_days', 'security.failed_login_alert_threshold',
  'limits.security.signin_attempts_per_email_hour', 'limits.security.signin_attempts_per_ip_hour'
);

-- Configuration audit now records what changed, and a reset is its own action.
alter table public.organization_configuration_audit
  add column previous_value jsonb,
  add column new_value jsonb;
alter table public.organization_configuration_audit
  add constraint organization_configuration_audit_values_bounded check (
    (previous_value is null or pg_catalog.octet_length(previous_value::text) <= 16384)
    and (new_value is null or pg_catalog.octet_length(new_value::text) <= 16384)
  );
alter table public.organization_configuration_audit
  drop constraint organization_configuration_audit_action_check;
alter table public.organization_configuration_audit
  add constraint organization_configuration_audit_action_check
    check (action in ('setting_updated', 'setting_reset', 'label_updated', 'label_removed'));

create index organization_configuration_audit_key_recent_idx
  on public.organization_configuration_audit (organization_id, item_key, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Server helpers other lanes call from SQL
-- ---------------------------------------------------------------------------

create function private.organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  definition_kind text;
  default_value jsonb;
  stored jsonb;
begin
  select d.value_kind, d.default_value into definition_kind, default_value
  from public.platform_setting_definitions d
  where d.key = p_key;
  if not found then
    raise exception 'unknown organization setting: %', p_key using errcode = '22023';
  end if;
  if definition_kind is distinct from p_kind then
    raise exception 'organization setting % is %, not %', p_key, definition_kind, p_kind using errcode = '22023';
  end if;
  if p_organization_id is not null then
    select v.value into stored
    from public.organization_setting_values v
    where v.organization_id = p_organization_id and v.setting_key = p_key;
  end if;
  return coalesce(stored, default_value);
end;
$function$;

create function private.organization_feature_enabled(p_organization_id uuid, p_key text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return (private.organization_setting_effective(p_organization_id, p_key, 'boolean') #>> '{}')::boolean;
end;
$function$;

create function private.organization_limit(p_organization_id uuid, p_key text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return (private.organization_setting_effective(p_organization_id, p_key, 'integer') #>> '{}')::integer;
end;
$function$;

create function private.organization_setting_text(p_organization_id uuid, p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return private.organization_setting_effective(p_organization_id, p_key, 'text') #>> '{}';
end;
$function$;

create function private.organization_setting_text_list(p_organization_id uuid, p_key text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return coalesce((
    select pg_catalog.array_agg(item.value order by item.ordinality)
    from pg_catalog.jsonb_array_elements_text(
      private.organization_setting_effective(p_organization_id, p_key, 'text_list')
    ) with ordinality as item(value, ordinality)
  ), array[]::text[]);
end;
$function$;

-- Member-safe projection: every member_visible definition, effective value.
create function private.organization_member_switches(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_object_agg(d.key, coalesce(v.value, d.default_value)), '{}'::jsonb)
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on p_organization_id is not null and v.organization_id = p_organization_id and v.setting_key = d.key
  where d.member_visible
$function$;

-- ---------------------------------------------------------------------------
-- 3. Reads
-- ---------------------------------------------------------------------------

create or replace function public.get_member_organization_configuration()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org_id uuid := private.current_member_organization();
  enrollment_enabled boolean := true;
  recovery_enrollment_enabled boolean := true;
  labels jsonb := '{}'::jsonb;
begin
  if (select auth.uid()) is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if org_id is null then
    return pg_catalog.jsonb_build_object('available', true, 'organizationId', null,
      'passkeyEnrollmentEnabled', true, 'recoveryCodeEnrollmentEnabled', true,
      'labelOverrides', '{}'::jsonb,
      'switches', private.organization_member_switches(null));
  end if;
  if not private.is_organization_member(org_id) then raise exception 'organization membership required' using errcode = '42501'; end if;

  enrollment_enabled := private.organization_feature_enabled(org_id, 'features.passkey_enrollment');
  recovery_enrollment_enabled := private.organization_feature_enabled(org_id, 'features.mfa_recovery_code_enrollment');

  select coalesce(pg_catalog.jsonb_object_agg(o.label_key, o.label_value), '{}'::jsonb)
  into labels
  from public.organization_label_overrides o
  where o.organization_id = org_id;

  return pg_catalog.jsonb_build_object(
    'available', true,
    'organizationId', org_id,
    'passkeyEnrollmentEnabled', coalesce(enrollment_enabled, true),
    'recoveryCodeEnrollmentEnabled', coalesce(recovery_enrollment_enabled, true),
    'labelOverrides', coalesce(labels, '{}'::jsonb),
    'switches', private.organization_member_switches(org_id)
  );
end;
$function$;

create or replace function public.get_admin_organization_configuration()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org_id uuid := private.current_member_organization();
  settings jsonb;
  labels jsonb;
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'key', d.key,
    'kind', d.value_kind,
    'label', d.label,
    'description', d.description,
    'category', d.category,
    'memberVisible', d.member_visible,
    'value', coalesce(v.value, d.default_value),
    'defaultValue', d.default_value,
    'minimum', d.minimum,
    'maximum', d.maximum,
    'allowedValues', d.allowed_values,
    'overridden', v.setting_key is not null,
    'updatedAt', v.updated_at,
    'lastChange', (
      select pg_catalog.jsonb_build_object(
        'action', a.action,
        'at', a.created_at,
        'actorName', case when a.actor_user_id is null then null
          else coalesce(p.full_name, 'Former member') end
      )
      from public.organization_configuration_audit a
      left join public.member_profiles p on p.id = a.actor_user_id
      where a.organization_id = org_id and a.item_key = d.key
        and a.action in ('setting_updated', 'setting_reset')
      order by a.created_at desc, a.id desc
      limit 1
    )
  ) order by d.category, d.sort_order, d.key), '[]'::jsonb)
  into settings
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on v.organization_id = org_id and v.setting_key = d.key;

  select coalesce(pg_catalog.jsonb_object_agg(o.label_key, o.label_value), '{}'::jsonb)
  into labels
  from public.organization_label_overrides o
  where o.organization_id = org_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', org_id,
    'settings', settings,
    'categories', pg_catalog.to_jsonb(array[
      'general', 'security', 'engagement_voice', 'guidance_onboarding', 'home',
      'casework', 'intelligence', 'automation', 'messaging', 'governance',
      'integrations', 'ai_assistant', 'notifications', 'data_retention',
      'analytics', 'labels'
    ]::text[]),
    'labelOverrides', labels,
    'labelKeys', pg_catalog.to_jsonb(array[
      'nav.home', 'nav.myCases', 'nav.messages', 'nav.inbox', 'nav.knowRights',
      'nav.myChapter', 'nav.settings', 'staff.chapterWork', 'nav.casework',
      'admin.title', 'coordinator.title', 'advisor.title', 'vp.title'
    ]::text[])
  );
end;
$function$;

create function public.list_organization_configuration_audit(p_setting_key text, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org_id uuid := private.current_member_organization();
  result jsonb;
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid limit' using errcode = '22023'; end if;
  if p_setting_key is not null and p_setting_key !~ '^[a-z][a-zA-Z0-9_.-]{1,79}$' then
    raise exception 'invalid setting key' using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object('items', coalesce(pg_catalog.jsonb_agg(row_data order by created_at desc, id desc), '[]'::jsonb))
  into result
  from (
    select a.created_at, a.id, pg_catalog.jsonb_build_object(
      'id', a.id,
      'action', a.action,
      'key', a.item_key,
      'previousValue', a.previous_value,
      'newValue', a.new_value,
      'actorName', case when a.actor_user_id is null then null else coalesce(p.full_name, 'Former member') end,
      'createdAt', a.created_at
    ) as row_data
    from public.organization_configuration_audit a
    left join public.member_profiles p on p.id = a.actor_user_id
    where a.organization_id = org_id
      and (p_setting_key is null or a.item_key = p_setting_key)
    order by a.created_at desc, a.id desc
    limit p_limit
  ) bounded;
  return result;
end;
$function$;

create function public.get_organization_settings_for_service(p_organization_id uuid, p_keys text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  requested text;
  result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_organization_id is null or not exists (select 1 from public.organizations o where o.id = p_organization_id) then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  if p_keys is null or pg_catalog.cardinality(p_keys) not between 1 and 100 then
    raise exception 'invalid setting keys' using errcode = '22023';
  end if;
  foreach requested in array p_keys loop
    if not exists (select 1 from public.platform_setting_definitions d where d.key = requested) then
      raise exception 'unknown organization setting: %', requested using errcode = '22023';
    end if;
  end loop;

  select coalesce(pg_catalog.jsonb_object_agg(d.key, coalesce(v.value, d.default_value)), '{}'::jsonb)
  into result
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on v.organization_id = p_organization_id and v.setting_key = d.key
  where d.key = any(p_keys);
  return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Audited writes
-- ---------------------------------------------------------------------------

-- The three public writers each force MFA step-up themselves
-- (private.mfa_satisfied(), 42501) right after the case-graph gate and before
-- delegating here, so the definer-MFA sweep sees the guard in every public
-- body; this helper keeps the admin-role check (has_organization_role).
-- p_value null resets to the definition default. p_check_version compares the
-- caller's last-read updated_at (null = "I saw the default") with the stored
-- override; every case-graph writer is already serialized by the common gate.
create function private.write_organization_setting(
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
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org_id := private.current_member_organization();
  caller := (select auth.uid());
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select * into definition from public.platform_setting_definitions where key = p_key;
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
  return pg_catalog.jsonb_build_object('key', p_key, 'value', p_value,
    'overridden', true, 'updatedAt', written.updated_at, 'updated', true);
end;
$function$;

create function public.set_organization_setting(p_key text, p_value jsonb, p_expected_updated_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_value is null then raise exception 'invalid setting value' using errcode = '22023'; end if;
  return private.write_organization_setting(p_key, p_value, p_expected_updated_at, true);
end;
$function$;

create function public.reset_organization_setting(p_key text, p_expected_updated_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.write_organization_setting(p_key, null, p_expected_updated_at, true);
end;
$function$;

-- Same signature and behavior as 20260828240000 (no version check), now with
-- the previous and new value in its audit row. The installed case-graph
-- wrapper stays the first statement, then the explicit MFA step-up (42501),
-- as in set/reset. private.write_organization_setting re-checks the admin
-- role through private.has_organization_role (MFA plus the staff second-factor
-- enrolment rule, the same guard 20260828240000 used), validates with
-- private.setting_value_valid,
-- upserts on conflict (organization_id, setting_key) and writes
-- organization_configuration_audit.
create or replace function public.update_organization_setting(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;

begin
  if p_value is null then raise exception 'invalid setting value' using errcode = '22023'; end if;
  return private.write_organization_setting(p_key, p_value, null, false) - 'overridden' - 'updatedAt';
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Record 2: configurable thresholds (defaults = old app's effective values)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old supabase/migrations/0022_features_all.sql:442 and 0029:24 (red 5).
  ('limits.casework.deadline_red_days', 'integer', 'Deadline red threshold (days)',
   'Deadlines due within this many days show red. Overdue deadlines are always red.',
   '5', 0, 90, null, 10, 'casework', true),
  -- Old 0022_features_all.sql:443 and 0029:25 (amber 14).
  ('limits.casework.deadline_amber_days', 'integer', 'Deadline amber threshold (days)',
   'Deadlines due within this many days show amber. Later deadlines show as scheduled.',
   '14', 0, 180, null, 20, 'casework', true),
  -- Old 0575_deadline_extensions.sql:152 deadline_risk_thresholds {"critical": 0, "high": 7, "medium": 14}.
  ('limits.casework.deadline_risk_critical_days', 'integer', 'Deadline risk: critical (days)',
   'Deadlines due within this many days rank as critical in the coordinator queue. Overdue is always critical.',
   '0', 0, 30, null, 30, 'casework', true),
  ('limits.casework.deadline_risk_high_days', 'integer', 'Deadline risk: high (days)',
   'Deadlines due within this many days rank as high risk in the coordinator queue.',
   '7', 0, 90, null, 40, 'casework', true),
  ('limits.casework.deadline_risk_medium_days', 'integer', 'Deadline risk: medium (days)',
   'Deadlines due within this many days rank as medium risk when the lookahead reaches them.',
   '14', 0, 180, null, 50, 'casework', true),
  -- Old 0024_tier1_polish.sql:52 dashboard_lookahead_days 7.
  ('limits.casework.deadline_lookahead_days', 'integer', 'Deadline lookahead (days)',
   'How many days ahead the due-soon dashboard and coordinator ranking look for deadlines.',
   '7', 1, 30, null, 60, 'casework', true),
  -- Old 0022_features_all.sql:456 mgmt_behavior_types (0022 upserts its value; 0029 does nothing on conflict).
  ('lists.casework.management_behavior_categories', 'text_list', 'Management behavior categories',
   'Categories staff can choose when logging a management behavior. Existing entries keep their category.',
   '["Verbal threat","Intimidation","Policy change (unilateral)","Weingarten denial","Retaliation","Discrimination","Other"]',
   1, 50, null, 70, 'casework', true),
  -- Old 0024_tier1_polish.sql:51 mgmt_behavior_window_days 90.
  ('limits.casework.management_behavior_window_days', 'integer', 'Management behavior window (days)',
   'Days of management behavior history counted when summarizing a manager across cases.',
   '90', 7, 730, null, 80, 'casework', true),
  -- Old 0024_tier1_polish.sql:56-59 org_health_*_max 24/44/64/84 (five tiers).
  ('limits.analytics.health_critical_max', 'integer', 'Health score: critical up to',
   'Scores at or below this value are critical.', '24', 0, 100, null, 10, 'analytics', true),
  ('limits.analytics.health_concerning_max', 'integer', 'Health score: concerning up to',
   'Scores above critical and at or below this value are concerning.', '44', 0, 100, null, 20, 'analytics', true),
  ('limits.analytics.health_moderate_max', 'integer', 'Health score: moderate up to',
   'Scores above concerning and at or below this value are moderate.', '64', 0, 100, null, 30, 'analytics', true),
  ('limits.analytics.health_healthy_max', 'integer', 'Health score: healthy up to',
   'Scores above moderate and at or below this value are healthy; higher scores are excellent.', '84', 0, 100, null, 40, 'analytics', true)
on conflict (key) do nothing;

-- Management behavior categories become organization-editable. Existing rows
-- (the six tokens of 20260828210000) stay valid under a shape-only rule; the
-- authorized writer enforces the organization's current list for new rows.
alter table public.casework_management_entries
  drop constraint casework_management_entries_category_check;

alter table public.casework_management_entries
  add constraint casework_management_entries_category_shape check (
    category = pg_catalog.btrim(category)
    and pg_catalog.char_length(category) between 1 and 80
    and category !~ '[[:cntrl:]<>]'
  );

create or replace function public.casework_log_management_behavior(
  p_case_id uuid, p_display_name text, p_title text, p_workplace text,
  p_occurred_at timestamptz, p_category text, p_summary text
)
returns public.casework_management_entries
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_case public.member_cases%rowtype; v_person public.casework_management_people%rowtype; v_row public.casework_management_entries%rowtype;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  if p_category is null or not (p_category = any(
    private.organization_setting_text_list(v_case.organization_id, 'lists.casework.management_behavior_categories')
  )) then
    raise exception 'invalid management behavior category' using errcode = '22023';
  end if;
  select * into v_person from public.casework_management_people p where p.organization_id = v_case.organization_id and p.chapter_id = v_case.chapter_id and pg_catalog.lower(pg_catalog.btrim(p.display_name)) = pg_catalog.lower(pg_catalog.btrim(p_display_name)) order by p.created_at limit 1;
  if not found then
    insert into public.casework_management_people(organization_id, chapter_id, display_name, title, workplace, created_by)
    values (v_case.organization_id, v_case.chapter_id, pg_catalog.btrim(p_display_name), nullif(pg_catalog.btrim(p_title), ''), nullif(pg_catalog.btrim(p_workplace), ''), (select auth.uid())) returning * into v_person;
  end if;
  insert into public.casework_management_entries(management_person_id, case_id, organization_id, chapter_id, occurred_at, category, summary, created_by)
  values (v_person.id, v_case.id, v_case.organization_id, v_case.chapter_id, p_occurred_at, p_category, pg_catalog.btrim(p_summary), (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'behavior_logged', 'management_entry', v_row.id);
  return v_row;
end;
end;
$function$;

-- The due-soon tile looks ahead the organization's configured number of days
-- (default 7, the previous fixed window).
create or replace function public.casework_dashboard_deadlines_due_soon()
returns table (days_out integer, deadline_count bigint, case_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  lookahead integer;
begin
  perform private.casework_dashboard_require_staff();
  lookahead := private.organization_limit(private.current_member_organization(), 'limits.casework.deadline_lookahead_days');
  return query
  with scoped as (
    select deadline.id, deadline.case_id, deadline.due_at
    from public.casework_deadlines deadline
    join private.casework_dashboard_open_cases() visible
      on visible.case_id = deadline.case_id
    where deadline.status in ('active', 'extended')
      and deadline.due_at >= pg_catalog.now()
      and deadline.due_at < pg_catalog.now() + pg_catalog.make_interval(days => lookahead)
  )
  select
    pg_catalog.floor(
      extract(epoch from (scoped.due_at - pg_catalog.now())) / 86400.0
    )::integer as bucket,
    pg_catalog.count(*),
    pg_catalog.count(distinct scoped.case_id)
  from scoped
  group by bucket
  order by bucket;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

revoke all on function private.organization_setting_effective(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.organization_feature_enabled(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.organization_limit(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.organization_setting_text(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.organization_setting_text_list(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.organization_member_switches(uuid) from public, anon, authenticated, service_role;
revoke all on function private.write_organization_setting(text, jsonb, timestamptz, boolean) from public, anon, authenticated, service_role;

revoke all on function public.get_member_organization_configuration() from public, anon, authenticated, service_role;
revoke all on function public.get_admin_organization_configuration() from public, anon, authenticated, service_role;
revoke all on function public.update_organization_setting(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.set_organization_setting(text, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reset_organization_setting(text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.list_organization_configuration_audit(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_organization_settings_for_service(uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function public.casework_log_management_behavior(uuid, text, text, text, timestamptz, text, text) from public, anon;
revoke all on function public.casework_dashboard_deadlines_due_soon() from public, anon, service_role;

grant execute on function public.get_member_organization_configuration() to authenticated;
grant execute on function public.get_admin_organization_configuration() to authenticated;
grant execute on function public.update_organization_setting(text, jsonb) to authenticated;
grant execute on function public.set_organization_setting(text, jsonb, timestamptz) to authenticated;
grant execute on function public.reset_organization_setting(text, timestamptz) to authenticated;
grant execute on function public.list_organization_configuration_audit(text, integer) to authenticated;
grant execute on function public.get_organization_settings_for_service(uuid, text[]) to service_role;
grant execute on function public.casework_log_management_behavior(uuid, text, text, text, timestamptz, text, text) to authenticated;
grant execute on function public.casework_dashboard_deadlines_due_soon() to authenticated;

comment on column public.platform_setting_definitions.category is
  'Fixed admin-page group for the Feature switches & limits page.';
comment on column public.platform_setting_definitions.member_visible is
  'True when the effective value is safe to return to every member through get_member_organization_configuration().switches.';
comment on function private.organization_feature_enabled(uuid, text) is
  'Effective boolean switch for an organization (stored value, else definition default). Unknown or non-boolean keys raise 22023.';
comment on function private.organization_limit(uuid, text) is
  'Effective integer setting for an organization (stored value, else definition default). Unknown or non-integer keys raise 22023.';
comment on function private.organization_setting_text(uuid, text) is
  'Effective text or enum setting for an organization (stored value, else definition default). Unknown or non-text keys raise 22023.';
comment on function private.organization_setting_text_list(uuid, text) is
  'Effective text-list setting for an organization as text[] (stored value, else definition default). Unknown or non-text_list keys raise 22023.';
comment on function public.set_organization_setting(text, jsonb, timestamptz) is
  'Organization-admin write of one registry-validated setting with an optimistic version check (40001 when the stored override changed since it was read) and a value audit row.';
comment on function public.reset_organization_setting(text, timestamptz) is
  'Organization-admin reset of one setting to its platform default with the same version check and a setting_reset audit row.';
comment on function public.list_organization_configuration_audit(text, integer) is
  'Organization-admin read of recent configuration audit rows with previous and new setting values.';
comment on function public.get_organization_settings_for_service(uuid, text[]) is
  'Service-role read of effective settings for one existing organization. Unknown keys raise 22023.';

notify pgrst, 'reload schema';

commit;
