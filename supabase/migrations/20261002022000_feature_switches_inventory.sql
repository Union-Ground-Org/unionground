-- REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 (PR 2: inventory)
--
-- Surfaces the 2026-10-01 inventory of functions that could be adjusted only
-- through a write path with no control, or only by changing code. Every value
-- below is a platform_setting_definitions row, so it appears on the admin
-- "Feature switches & limits" page automatically, and the server enforces it
-- with the 20261002017000 helpers.
--
--   A1  public.set_organization_integration_status(p_provider, p_status):
--       an organization admin turns a provider off ('disabled') or asks for it
--       again ('requested') without resending, and so without erasing, its
--       credential reference, chapter controls or settings. Activation
--       ('configured'/'connected') stays an operator-verified step.
--   A6  features.ai_assistant.enabled (organization switch on top of the
--       platform policy) and limits.ai_assistant.hourly_<role> (organization
--       caps that can only lower the platform role limit). Enforced in
--       public.reserve_compass_ai_request, so a refusal happens before any
--       provider dispatch. The platform kill switch, attestation and global cap
--       are unchanged and still checked first.
--   B8  features.notifications.dues_reminders and
--       limits.notifications.dues_reminder_days_past_due, enforced by
--       public.plan_dues_reminder_attempts (the cron planner).
--   B13 limits.intelligence.connection_weight_<signal>: the organization's
--       default chapter-matching weights. Staff still tune a session's sliders.
--
-- Defaults: a new switch over a function that works today defaults to
-- today's behavior (controller correction, 2026-10-01), ahead of the old app's
-- values that would otherwise use:
--   features.ai_assistant.enabled 'true': Compass works today under the
--   platform policy alone. (Old claude_enabled was off in production: old
--   0404_align_claude_widget_flags_to_master_gate.sql and
--   0406_realign_claude_flags... record the master gate at 'false'.)
--   features.notifications.dues_reminders 'true' and
--   limits.notifications.dues_reminder_days_past_due '1': today's planner
--   (20260831110100) plans a reminder once an obligation is past due
--   (due_on < today, the same as due_on <= today - 1). (Old
--   0616_dues_operations.sql:9-10 had dues_reminders_enabled 'false' and 7
--   days.)
--   Matching weights had no old flag: today's balanced preset.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Platform-only definitions
-- ---------------------------------------------------------------------------
-- Some limits are deliberately platform-wide: W1-URGENT-B's sign-in throttles
-- (20261002015000,) refuse per-organization values, because an
-- organization-specific cutoff would let a 429 reveal membership. Such rows
-- stay visible on the admin page as read-only facts ("Set for the whole
-- platform") and every organization write refuses them. The lanes' pinned
-- insert column list stays valid: the flag defaults to true.
alter table public.platform_setting_definitions
  add column organization_editable boolean not null default true;

comment on column public.platform_setting_definitions.organization_editable is
  'False for platform-wide values an organization admin can see but not change.';

-- 20261002015000 sorts before this file, so the sign-in throttle rows exist
-- here on every path (fresh replay and forward deploy).
update public.platform_setting_definitions
set organization_editable = false
where key in ('limits.security.signin_attempts_per_email_hour', 'limits.security.signin_attempts_per_ip_hour');

-- Readers ignore any stored organization value of a platform-only key.
create or replace function private.organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  definition_kind text;
  default_value jsonb;
  editable boolean;
  stored jsonb;
begin
  select d.value_kind, d.default_value, d.organization_editable into definition_kind, default_value, editable
  from public.platform_setting_definitions d
  where d.key = p_key;
  if not found then
    raise exception 'unknown organization setting: %', p_key using errcode = '22023';
  end if;
  if definition_kind is distinct from p_kind then
    raise exception 'organization setting % is %, not %', p_key, definition_kind, p_kind using errcode = '22023';
  end if;
  if p_organization_id is not null and editable then
    select v.value into stored
    from public.organization_setting_values v
    where v.organization_id = p_organization_id and v.setting_key = p_key;
  end if;
  return coalesce(stored, default_value);
end;
$function$;

create or replace function private.organization_member_switches(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_object_agg(d.key, coalesce(v.value, d.default_value)), '{}'::jsonb)
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on p_organization_id is not null and d.organization_editable
      and v.organization_id = p_organization_id and v.setting_key = d.key
  where d.member_visible
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
    'organizationEditable', d.organization_editable,
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
    on d.organization_editable and v.organization_id = org_id and v.setting_key = d.key;

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

-- Organization writes refuse platform-only keys with one flat answer.
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

create or replace function public.get_organization_settings_for_service(p_organization_id uuid, p_keys text[])
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
    on d.organization_editable and v.organization_id = p_organization_id and v.setting_key = d.key
  where d.key = any(p_keys);
  return result;
end;
$function$;

revoke all on function public.get_organization_settings_for_service(uuid, text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_settings_for_service(uuid, text[]) to service_role;
revoke all on function private.organization_setting_effective(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.organization_member_switches(uuid) from public, anon, authenticated, service_role;
revoke all on function private.write_organization_setting(text, jsonb, timestamptz, boolean) from public, anon, authenticated, service_role;
revoke all on function public.get_admin_organization_configuration() from public, anon, authenticated, service_role;
grant execute on function public.get_admin_organization_configuration() to authenticated;

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.ai_assistant.enabled', 'boolean', 'Compass AI assistant',
   'Let members and staff of this organization use Compass. Union Ground''s platform controls still apply.',
   'true', null, null, null, 10, 'ai_assistant', true),
  ('limits.ai_assistant.hourly_member', 'integer', 'Compass requests per hour: members',
   'Hourly Compass requests for a member. The platform limit for the role still caps it.',
   '200', 0, 200, null, 20, 'ai_assistant', false),
  ('limits.ai_assistant.hourly_steward', 'integer', 'Compass requests per hour: stewards',
   'Hourly Compass requests for a steward. The platform limit for the role still caps it.',
   '200', 0, 200, null, 30, 'ai_assistant', false),
  ('limits.ai_assistant.hourly_coordinator', 'integer', 'Compass requests per hour: coordinators',
   'Hourly Compass requests for a coordinator. The platform limit for the role still caps it.',
   '200', 0, 200, null, 40, 'ai_assistant', false),
  ('limits.ai_assistant.hourly_advisor', 'integer', 'Compass requests per hour: advisors',
   'Hourly Compass requests for an advisor. The platform limit for the role still caps it.',
   '200', 0, 200, null, 50, 'ai_assistant', false),
  ('limits.ai_assistant.hourly_admin', 'integer', 'Compass requests per hour: admins',
   'Hourly Compass requests for an admin. The platform limit for the role still caps it.',
   '200', 0, 200, null, 60, 'ai_assistant', false),
  ('limits.ai_assistant.hourly_vp', 'integer', 'Compass requests per hour: vice presidents',
   'Hourly Compass requests for a vice president. The platform limit for the role still caps it.',
   '200', 0, 200, null, 70, 'ai_assistant', false),
  ('features.notifications.dues_reminders', 'boolean', 'Dues reminders',
   'Queue in-app reminders for dues obligations that are past due.',
   'true', null, null, null, 10, 'notifications', false),
  ('limits.notifications.dues_reminder_days_past_due', 'integer', 'Dues reminder delay (days past due)',
   'Days an obligation must be past due before its first reminder is queued.',
   '1', 1, 90, null, 20, 'notifications', false),
  ('limits.intelligence.connection_weight_location', 'integer', 'Chapter matching weight: location',
   'Default weight for location when suggesting chapters to connect with.', '20', 0, 100, null, 10, 'intelligence', true),
  ('limits.intelligence.connection_weight_sector', 'integer', 'Chapter matching weight: sector',
   'Default weight for a shared sector when suggesting chapters to connect with.', '20', 0, 100, null, 20, 'intelligence', true),
  ('limits.intelligence.connection_weight_issues', 'integer', 'Chapter matching weight: shared issues',
   'Default weight for shared published issues when suggesting chapters to connect with.', '25', 0, 100, null, 30, 'intelligence', true),
  ('limits.intelligence.connection_weight_expertise', 'integer', 'Chapter matching weight: expertise',
   'Default weight for offered steward expertise when suggesting chapters to connect with.', '20', 0, 100, null, 40, 'intelligence', true),
  ('limits.intelligence.connection_weight_local', 'integer', 'Chapter matching weight: same local',
   'Default weight for chapters of the same local when suggesting connections.', '10', 0, 100, null, 50, 'intelligence', true),
  ('limits.intelligence.connection_weight_union', 'integer', 'Chapter matching weight: same union',
   'Default weight for chapters of the same union when suggesting connections.', '5', 0, 100, null, 60, 'intelligence', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- A1. Provider status without resending credentials or settings
-- ---------------------------------------------------------------------------

create function public.set_organization_integration_status(p_provider text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  current_status text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.mi1_require_integration_admin();
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_provider like 'ai\_connector\_%' then
    raise exception 'AI connectors are enabled through enable_organization_ai_connector' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('disabled', 'requested') then
    raise exception 'organization admins can turn a provider off or request it again' using errcode = '22023';
  end if;
  if p_provider = 'scim' and p_status <> 'disabled' then
    raise exception 'SCIM stays disabled until the enterprise-later gate' using errcode = '42501';
  end if;
  select i.status into current_status
  from public.organization_integrations i
  where i.organization_id = org and i.provider = p_provider
  for update;
  if not found or current_status = 'unset' then
    raise exception 'provider not set up' using errcode = 'P0002';
  end if;
  update public.organization_integrations
  set status = p_status, updated_at = pg_catalog.now()
  where organization_id = org and provider = p_provider;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'status', p_status
  ));
  return public.list_organization_integrations();
end;
$function$;

revoke all on function public.set_organization_integration_status(text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_organization_integration_status(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- A6. Organization Compass switch and per-role caps
-- ---------------------------------------------------------------------------
-- Source of 20261001002000 with two additions after the platform checks: the
-- organization switch (a disabled organization gets the existing 'disabled'
-- cause, which api/guide.js already reports as "paused by an administrator")
-- and least(platform role limit, organization role cap) before the reward
-- bonus and the existing 200 ceiling.
create or replace function public.reserve_compass_ai_request(
  p_user_id uuid,
  p_gateway text,
  p_model text,
  p_zero_data_retention boolean,
  p_disallow_prompt_training boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
declare
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  reservation_id uuid;

  quota_organization uuid := private.member_organization_for(p_user_id);
  assigned_role_count integer := 0;
  configured_role_count integer := 0;
  effective_role text;
  effective_limit integer;
  recent_user_count integer;
  recent_global_count integer;
begin
  if p_user_id is null
     or not exists (select 1 from public.member_profiles p where p.id = p_user_id) then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'member_unavailable');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-ai-global', 509)
  );

  select p.* into policy
  from public.compass_ai_policy p
  where p.id = true;

  if policy.id is null
     or not (p_zero_data_retention is true
             and p_disallow_prompt_training is true)
     or not private.compass_ai_provider_permitted(p_user_id, p_gateway, p_model, policy.gateway, policy.model)
     or not (policy.zero_data_retention is true
             and policy.disallow_prompt_training is true) then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'config');
  end if;
  if policy.enabled is not true then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'disabled');
  end if;
  -- The organization switch applies to the quota organization; a member with no
  -- organization selected stays under the platform policy alone.
  if quota_organization is not null
     and not private.organization_feature_enabled(quota_organization, 'features.ai_assistant.enabled') then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'disabled');
  end if;

  select a.* into latest_attestation
  from public.compass_ai_provider_attestations a
  where a.gateway = policy.gateway
    and a.model = policy.model
    and a.zero_data_retention = policy.zero_data_retention
    and a.disallow_prompt_training = policy.disallow_prompt_training
  order by sequence_no desc
  limit 1;
  if latest_attestation.id is null
     or not (latest_attestation.status = 'verified'
             and latest_attestation.expires_at > now()) then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'unattested');
  end if;

  select pg_catalog.count(*)::integer into assigned_role_count
  from public.organization_role_grants r
  where r.user_id = p_user_id
    and r.organization_id = quota_organization
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');

  if assigned_role_count = 0 then
    select l.role, l.hourly_limit into effective_role, effective_limit
    from public.compass_ai_role_limits l
    where l.role = 'member';
    configured_role_count := case when found then 1 else 0 end;
    if configured_role_count <> 1 then
      return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');
    end if;
  else
    select pg_catalog.count(*)::integer into configured_role_count
    from public.organization_role_grants r
    join public.compass_ai_role_limits l on l.role = r.role
    where r.user_id = p_user_id
    and r.organization_id = quota_organization
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');
    if configured_role_count <> assigned_role_count then
      return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');
    end if;

    select l.role, l.hourly_limit into effective_role, effective_limit
    from public.organization_role_grants r
    join public.compass_ai_role_limits l on l.role = r.role
    where r.user_id = p_user_id
    and r.organization_id = quota_organization
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    order by l.hourly_limit asc,
      case l.role when 'steward' then 1 when 'coordinator' then 2
        when 'advisor' then 3 when 'admin' then 4 else 5 end
    limit 1;
  end if;

  if effective_role is null or effective_limit is null then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');
  end if;

  -- The organization caps can only lower the platform limit: the strictest cap
  -- of the caller's roles in the quota organization (members use the member cap).
  effective_limit := least(effective_limit, coalesce((
    select pg_catalog.min(private.organization_limit(quota_organization, 'limits.ai_assistant.hourly_' || r.role))
    from public.organization_role_grants r
    where r.user_id = p_user_id
      and r.organization_id = quota_organization
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ), private.organization_limit(quota_organization, 'limits.ai_assistant.hourly_member')));

  effective_limit := least(
    200,
    effective_limit + private.compass_ai_reward_quota_bonus(p_user_id)
  );

  delete from public.member_ai_requests
  where created_at < now() - interval '2 hours';

  select pg_catalog.count(*)::integer into recent_user_count
  from public.member_ai_requests
  where user_id = p_user_id
    and created_at >= now() - interval '1 hour';
  if recent_user_count >= effective_limit then
    perform private.mesh_usage_bump(p_user_id, 'compass_rate_limited');
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'role',
                                         'role', effective_role, 'limit', effective_limit);
  end if;

  select pg_catalog.count(*)::integer into recent_global_count
  from public.member_ai_requests
  where created_at >= now() - interval '1 hour';
  if recent_global_count >= 200 then
    perform private.mesh_usage_bump(p_user_id, 'compass_rate_limited');
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'shared');
  end if;

  insert into public.member_ai_requests (user_id, compass_role, compass_limit, compass_organization_id, compass_gateway, compass_model)
  values (p_user_id, effective_role, effective_limit, quota_organization, p_gateway, p_model)
  returning id into reservation_id;

  return pg_catalog.jsonb_build_object('id', reservation_id, 'cause', null,
                                       'role', effective_role, 'limit', effective_limit);
end;
end;
$$;

revoke all on function public.reserve_compass_ai_request(uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.reserve_compass_ai_request(uuid, text, text, boolean, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- B8. Dues reminder planner honors the organization switch and delay
-- ---------------------------------------------------------------------------
create or replace function public.plan_dues_reminder_attempts(p_limit integer, p_today date default current_date)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  inserted_count integer;
begin
  -- A case-graph writer (dues_reminder_attempts): the transaction entry gate
  -- comes first, as 20260907151000 installed it for the prior definition.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 500 or p_today is null then
    raise exception 'invalid dues reminder planning limit' using errcode = '22023';
  end if;
  with candidates as materialized (
    select obligation.organization_id, obligation.id
    from public.dues_obligations obligation
    where obligation.due_on < p_today
      and private.organization_feature_enabled(obligation.organization_id, 'features.notifications.dues_reminders')
      and obligation.due_on <= p_today - private.organization_limit(obligation.organization_id, 'limits.notifications.dues_reminder_days_past_due')
      and private.dues_balance_cents(obligation.organization_id, obligation.id) > 0
    order by obligation.due_on asc, obligation.id asc
    limit p_limit
  ), inserted as (
    insert into public.dues_reminder_attempts (organization_id, obligation_id, policy_window, channel)
    select organization_id, id, date_trunc('month', p_today)::date, 'in_app'
    from candidates
    on conflict (organization_id, obligation_id, policy_window, channel) do nothing
    returning id
  )
  select count(*) into inserted_count from inserted;
  return inserted_count;
end;
$function$;

revoke all on function public.plan_dues_reminder_attempts(integer, date) from public, anon, authenticated;
grant execute on function public.plan_dues_reminder_attempts(integer, date) to service_role;

comment on function public.set_organization_integration_status(text, text) is
  'Organization admin/vp turns a provider off or requests it again without touching its credential reference, chapter controls or settings; activation stays operator-verified.';

notify pgrst, 'reload schema';

commit;
