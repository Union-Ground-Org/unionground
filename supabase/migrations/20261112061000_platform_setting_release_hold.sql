-- REQ-UG-PLATFORM-RELEASE-HOLD-ON-ORGANIZATION-SWITCHES-20261112 (#8436).
--
-- The owner releases finished features one at a time on announced dates
-- (owner direction, November 12, 2026; docs/contracts/staged-feature-releases.md).
-- Until now nothing could hold an organization switch back: an organization
-- admin could turn any organization-editable switch on, and even a platform-only
-- switch still showed in the admin list and the member switch map.
--
-- public.platform_setting_definitions.release_at (timestamptz, nullable) is the
-- release time of a boolean switch. Null means released, which is every row
-- today: this migration holds nothing, and a later data-only migration sets
-- the dates. A row whose release_at is later than now() is held ('infinity'
-- holds it with no date). Only boolean switches can be held.
--
-- While a switch is held:
--   * every server read resolves it to false for every organization, whatever
--     the stored organization value or the default;
--   * the admin settings list leaves its row out;
--   * the member switch map reports it as false (src/lib/siteGuide.js reads a
--     missing switch as on, so leaving it out would not be off on every client);
--   * the three write entry points refuse it exactly as they refuse a key that
--     does not exist ('invalid setting value', 22023), and the learning-period
--     undo refuses it as it refuses a missing key;
--   * a stored organization value is kept untouched.
-- When release_at passes, with no deploy and no further change, the switch
-- behaves as before: listed, editable as its definition says, values honored.
--
-- Every function whose newest definition reads public.organization_setting_values
-- or a definition's default_value directly, and how it is covered:
--   held-aware (re-emitted below from its newest source, held check added):
--     private.organization_setting_effective            (20261002022000)
--       also covers private.organization_feature_enabled, organization_limit,
--       organization_setting_text, organization_setting_text_list and
--       public.get_member_organization_configuration's two enrollment flags
--     private.organization_member_switches              (20261002022000)
--     public.get_admin_organization_configuration       (20261002022000)
--     public.get_organization_settings_for_service      (20261002022000)
--     private.write_organization_setting                (20261106220000)
--       behind set_, reset_ and update_organization_setting
--     private.learning_undo_organization_setting        (20261104113000)
--     private.auto_enroll_member_onboarding             (20261002121000)
--     private.urgent_a_setting_enabled                  (20261002021000)
--     public.generate_mfa_recovery_codes                (20261002135500)
--   cannot meet a held boolean (tests/feature-switches-release-hold-db.test.js
--   keeps this list as its reviewed allowlist):
--     integer settings only: private.urgent_a_setting_integer,
--       private.urgent_b_setting_limit, private.lock_lifecycle_telemetry,
--       public.list_failed_login_operations_inbox,
--       public.record_failed_login_attempt, public.record_member_pin_failure
--     stored rows, not an effective value: private.demo_seed_apply_auth_operations,
--       private.demo_seed_auth_operations_status,
--       private.demo_seed_remove_auth_operations,
--       private.learning_membership_state,
--       private.production_residue_check_references,
--       public.production_residue_remove_batch
begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. The release time
-- ---------------------------------------------------------------------------

alter table public.platform_setting_definitions
  add column release_at timestamptz;

alter table public.platform_setting_definitions
  add constraint platform_setting_definitions_release_at_boolean_only
    check (release_at is null or value_kind = 'boolean');

comment on column public.platform_setting_definitions.release_at is
  'Release time of a boolean switch. Null = released. Later than now() = held: every read is false, the admin list leaves it out and organization writes refuse it as an unknown key. infinity holds it with no date.';

-- ---------------------------------------------------------------------------
-- 2. The effective read and the member switch map
-- ---------------------------------------------------------------------------

-- Readers ignore any stored organization value of a platform-only key. A held
-- switch reads false after the unknown-key and kind checks.
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
  held_until timestamptz;
  stored jsonb;
begin
  select d.value_kind, d.default_value, d.organization_editable, d.release_at
  into definition_kind, default_value, editable, held_until
  from public.platform_setting_definitions d
  where d.key = p_key;
  if not found then
    raise exception 'unknown organization setting: %', p_key using errcode = '22023';
  end if;
  if definition_kind is distinct from p_kind then
    raise exception 'organization setting % is %, not %', p_key, definition_kind, p_kind using errcode = '22023';
  end if;
  if held_until > pg_catalog.now() then
    return 'false'::jsonb;
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
  select coalesce(pg_catalog.jsonb_object_agg(d.key, case
    when d.release_at > pg_catalog.now() then 'false'::jsonb
    else coalesce(v.value, d.default_value)
  end), '{}'::jsonb)
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on p_organization_id is not null and d.organization_editable
      and v.organization_id = p_organization_id and v.setting_key = d.key
  where d.member_visible
$function$;

-- ---------------------------------------------------------------------------
-- 3. The admin list and the service read
-- ---------------------------------------------------------------------------

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
    on d.organization_editable and v.organization_id = org_id and v.setting_key = d.key
  where d.release_at is null or d.release_at <= pg_catalog.now();

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

  select coalesce(pg_catalog.jsonb_object_agg(d.key, case
    when d.release_at > pg_catalog.now() then 'false'::jsonb
    else coalesce(v.value, d.default_value)
  end), '{}'::jsonb)
  into result
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on d.organization_editable and v.organization_id = p_organization_id and v.setting_key = d.key
  where d.key = any(p_keys);
  return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Writes: a held switch is a key that does not exist
-- ---------------------------------------------------------------------------

-- From 20261106220000 verbatim, except that the definition lookup skips a
-- held row, so a held key takes the unknown-key refusal before the
-- platform-only one.
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
  select * into definition from public.platform_setting_definitions
  where key = p_key and (release_at is null or release_at <= pg_catalog.now());
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
    raise exception 'setting changed' using errcode = 'PT409';
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

-- Ordinary organization settings: today's rule is write_organization_setting's.
-- From 20261104113000 verbatim, except that a held key is refused in the check
-- step exactly as a missing one is.
create or replace function private.learning_undo_organization_setting(p_mode text, p_entry jsonb)
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
  select * into definition from public.platform_setting_definitions d
  where d.key = setting and (d.release_at is null or d.release_at <= pg_catalog.now());
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

-- ---------------------------------------------------------------------------
-- 5. Inline readers of one boolean switch
-- ---------------------------------------------------------------------------

-- From 20261002121000 verbatim, except that a held switch reads off.
create or replace function private.auto_enroll_member_onboarding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  enabled boolean;
  plan_id uuid;
begin
  -- Case-graph gate first, like every writer of an account-lifecycle table.
  -- The membership statement trigger already holds it, so this is reentrant.
  perform private.lock_case_graph(array[new.user_id], array[]::uuid[]);
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
    return new;
  end if;
  -- The switch is read straight from the registry (override, else default),
  -- the settings helper's own answer, kept inline so this trigger's
  -- account-lifecycle review does not pin the helper's body. A held switch
  -- has no row here, so it reads off.
  select coalesce(v.value, d.default_value) = 'true'::jsonb into enabled
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on v.organization_id = new.organization_id and v.setting_key = d.key
  where d.key = 'features.guidance_onboarding.auto_enroll_onboarding'
    and (d.release_at is null or d.release_at <= pg_catalog.now());
  if not coalesce(enabled, false) then
    return new;
  end if;
  if not exists (
    select 1 from public.organization_onboarding_steps s
    where s.organization_id = new.organization_id and s.active
  ) then
    return new;
  end if;
  insert into public.member_onboarding_plans (id, organization_id, member_user_id, assigned_by)
  values (extensions.gen_random_uuid(), new.organization_id, new.user_id, null)
  on conflict (organization_id, member_user_id) do nothing
  returning id into plan_id;
  if plan_id is not null then
    insert into public.member_support_events (
      id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type
    ) values (
      extensions.gen_random_uuid(), new.organization_id, null, new.user_id, 'onboarding_plan', plan_id, 'auto_enrolled'
    );
  end if;
  return new;
end;
$function$;

-- From 20261002021000 verbatim, except that a held switch reads false.
create or replace function private.urgent_a_setting_enabled(p_organization_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case when exists (
    select 1 from public.platform_setting_definitions h
    where h.key = p_key and h.release_at > pg_catalog.now()
  ) then false else coalesce(
    (select (v.value #>> '{}')::boolean
       from public.organization_setting_values v
      where p_organization_id is not null
        and v.organization_id = p_organization_id
        and v.setting_key = p_key
        and pg_catalog.jsonb_typeof(v.value) = 'boolean'),
    (select (d.default_value #>> '{}')::boolean
       from public.platform_setting_definitions d
      where d.key = p_key
        and d.value_kind = 'boolean'
        and pg_catalog.jsonb_typeof(d.default_value) = 'boolean'),
    false) end;
$function$;

-- From 20261002135500 verbatim, except that a held enrollment switch reads off.
create or replace function public.generate_mfa_recovery_codes()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org_id uuid := private.current_member_organization();
  next_generation integer;
  plain text;
  compact text;
  codes text[] := array[]::text[];
  i integer;
begin
  if caller is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' or not private.mfa_satisfied() then
    raise exception 'aal2 required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.mfa_factors f
    where f.user_id = caller and f.status = 'verified' and f.factor_type = 'totp'
  ) then raise exception 'verified authenticator required' using errcode = '42501'; end if;
  if org_id is not null and not coalesce((
    select case when d.release_at > pg_catalog.now() then false
      else coalesce((v.value #>> '{}')::boolean, (d.default_value #>> '{}')::boolean) end
    from public.platform_setting_definitions d
    left join public.organization_setting_values v
      on v.organization_id = org_id and v.setting_key = d.key
    where d.key = 'features.mfa_recovery_code_enrollment'
  ), true) then
    raise exception 'recovery code enrollment disabled' using errcode = '42501';
  end if;

  insert into public.mfa_recovery_code_sets (user_id, organization_id)
  values (caller, org_id)
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    generation = public.mfa_recovery_code_sets.generation + 1,
    failed_attempts = 0,
    locked_until = null,
    generated_at = pg_catalog.now();
  select generation into next_generation from public.mfa_recovery_code_sets where user_id = caller;
  delete from public.mfa_recovery_codes where user_id = caller;

  for i in 1..8 loop
    compact := pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'));
    plain := 'UG-' || pg_catalog.substr(compact, 1, 4) || '-'
      || pg_catalog.substr(compact, 5, 4) || '-'
      || pg_catalog.substr(compact, 9, 4) || '-'
      || pg_catalog.substr(compact, 13, 4);
    insert into public.mfa_recovery_codes
      (user_id, organization_id, generation, code_prefix, code_hash)
    values (
      caller, org_id, next_generation, pg_catalog.substr(compact, 1, 8),
      extensions.crypt('UG' || compact, extensions.gen_salt('bf', 12))
    );
    codes := pg_catalog.array_append(codes, plain);
  end loop;
  return pg_catalog.jsonb_build_object('codes', pg_catalog.to_jsonb(codes), 'generation', next_generation,
    'generatedAt', pg_catalog.now(), 'displayOnce', true);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Re-enroll the replaced definitions the account-lifecycle trigger review
--    reaches (only these; unrelated review mismatches must stay detectable)
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function' and s.table_name = ''
  and (s.schema_name, s.object_name) in (
    ('private', 'organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)'),
    ('private', 'organization_member_switches(p_organization_id uuid)'),
    ('private', 'write_organization_setting(p_key text, p_value jsonb, p_expected_updated_at timestamp with time zone, p_check_version boolean)'),
    ('private', 'learning_undo_organization_setting(p_mode text, p_entry jsonb)'),
    ('private', 'auto_enroll_member_onboarding()'),
    ('private', 'urgent_a_setting_enabled(p_organization_id uuid, p_key text)'),
    ('public', 'get_admin_organization_configuration()'),
    ('public', 'get_organization_settings_for_service(p_organization_id uuid, p_keys text[])'),
    ('public', 'generate_mfa_recovery_codes()'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';

commit;
