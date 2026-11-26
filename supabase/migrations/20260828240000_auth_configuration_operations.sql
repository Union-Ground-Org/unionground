-- MI1 administration parity: recovery codes, organization configuration,
-- navigation labels, and the failed-login operations inbox.
--
-- Passkey credentials intentionally do not live in public tables. GoTrue owns
-- their challenges, credential material, counters, and device list. This
-- migration supplies the organization control that governs enrollment; the
-- browser uses auth-js's native WebAuthn API.
--
-- Production remains empty. The only seeded rows below are platform setting
-- definitions, never an organization, membership, user, or setting value.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Organization-scoped settings registry and navigation labels
-- ---------------------------------------------------------------------------

create table public.platform_setting_definitions (
  key text primary key,
  value_kind text not null check (value_kind in ('boolean', 'integer', 'text')),
  label text not null,
  description text not null,
  default_value jsonb not null,
  minimum integer,
  maximum integer,
  allowed_values text[],
  sort_order integer not null default 0,
  constraint platform_setting_definitions_key check (key ~ '^[a-z][a-z0-9_.-]{2,79}$'),
  constraint platform_setting_definitions_copy check (
    pg_catalog.char_length(pg_catalog.btrim(label)) between 2 and 80
    and pg_catalog.char_length(pg_catalog.btrim(description)) between 2 and 240
    and label !~ '[[:cntrl:]]'
    and description !~ '[[:cntrl:]]'
  ),
  constraint platform_setting_definitions_bounds check (
    minimum is null or maximum is null or minimum <= maximum
  )
);

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, sort_order)
values
  ('features.passkey_enrollment', 'boolean', 'Member passkey enrollment',
   'Allow signed-in members to add phishing-resistant passkeys to their own account.', 'true', null, null, 10),
  ('features.mfa_recovery_code_enrollment', 'boolean', 'Recovery code enrollment',
   'Allow members with verified two-step authentication to generate or rotate recovery codes.', 'true', null, null, 20),
  ('security.failed_login_retention_days', 'integer', 'Failed sign-in retention',
   'Days to retain organization-attributed failed sign-in records.', '90', 7, 365, 30),
  ('security.failed_login_alert_threshold', 'integer', 'Failed sign-in attention threshold',
   'Open failures in the last 24 hours that mark the operations inbox for attention.', '5', 1, 100, 40)
on conflict (key) do update set
  value_kind = excluded.value_kind,
  label = excluded.label,
  description = excluded.description,
  default_value = excluded.default_value,
  minimum = excluded.minimum,
  maximum = excluded.maximum,
  sort_order = excluded.sort_order;

create table public.organization_setting_values (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  setting_key text not null references public.platform_setting_definitions(key) on update cascade on delete restrict,
  value jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, setting_key),
  constraint organization_setting_values_bounded check (pg_catalog.octet_length(value::text) <= 1024)
);

create table public.organization_label_overrides (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  label_key text not null,
  label_value text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, label_key),
  constraint organization_label_overrides_key check (label_key in (
    'nav.home', 'nav.myCases', 'nav.messages', 'nav.inbox', 'nav.knowRights',
    'nav.myChapter', 'nav.settings', 'staff.chapterWork', 'nav.casework',
    'admin.title', 'coordinator.title', 'advisor.title', 'vp.title'
  )),
  constraint organization_label_overrides_value check (
    pg_catalog.char_length(pg_catalog.btrim(label_value)) between 1 and 40
    and label_value !~ '[<>[:cntrl:]]'
  )
);

create table public.organization_configuration_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('setting_updated', 'label_updated', 'label_removed')),
  item_key text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_configuration_audit_key check (item_key ~ '^[a-z][a-zA-Z0-9_.-]{1,79}$')
);

create index organization_configuration_audit_recent_idx
  on public.organization_configuration_audit (organization_id, created_at desc);

alter table public.platform_setting_definitions enable row level security;
alter table public.organization_setting_values enable row level security;
alter table public.organization_label_overrides enable row level security;
alter table public.organization_configuration_audit enable row level security;

create policy mfa_assurance on public.platform_setting_definitions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_setting_values
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_label_overrides
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_configuration_audit
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.platform_setting_definitions from public, anon, authenticated;
revoke all on table public.organization_setting_values from public, anon, authenticated;
revoke all on table public.organization_label_overrides from public, anon, authenticated;
revoke all on table public.organization_configuration_audit from public, anon, authenticated;

create function private.setting_value_valid(
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
  select case p_kind
    when 'boolean' then pg_catalog.jsonb_typeof(p_value) = 'boolean'
    when 'integer' then
      pg_catalog.jsonb_typeof(p_value) = 'number'
      and p_value::text ~ '^-?[0-9]+$'
      and (p_minimum is null or (p_value::text)::integer >= p_minimum)
      and (p_maximum is null or (p_value::text)::integer <= p_maximum)
    when 'text' then
      pg_catalog.jsonb_typeof(p_value) = 'string'
      and pg_catalog.char_length(p_value #>> '{}') <= 240
      and (p_allowed_values is null or (p_value #>> '{}') = any(p_allowed_values))
      and (p_value #>> '{}') !~ '[[:cntrl:]]'
    else false
  end
$function$;

create function public.get_member_organization_configuration()
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
      'labelOverrides', '{}'::jsonb);
  end if;
  if not private.is_organization_member(org_id) then raise exception 'organization membership required' using errcode = '42501'; end if;

  select coalesce((v.value #>> '{}')::boolean, (d.default_value #>> '{}')::boolean)
  into enrollment_enabled
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on v.organization_id = org_id and v.setting_key = d.key
  where d.key = 'features.passkey_enrollment';

  select coalesce((v.value #>> '{}')::boolean, (d.default_value #>> '{}')::boolean)
  into recovery_enrollment_enabled
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on v.organization_id = org_id and v.setting_key = d.key
  where d.key = 'features.mfa_recovery_code_enrollment';

  select coalesce(pg_catalog.jsonb_object_agg(o.label_key, o.label_value), '{}'::jsonb)
  into labels
  from public.organization_label_overrides o
  where o.organization_id = org_id;

  return pg_catalog.jsonb_build_object(
    'available', true,
    'organizationId', org_id,
    'passkeyEnrollmentEnabled', coalesce(enrollment_enabled, true),
    'recoveryCodeEnrollmentEnabled', coalesce(recovery_enrollment_enabled, true),
    'labelOverrides', coalesce(labels, '{}'::jsonb)
  );
end;
$function$;

create function public.get_admin_organization_configuration()
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
    'value', coalesce(v.value, d.default_value),
    'defaultValue', d.default_value,
    'minimum', d.minimum,
    'maximum', d.maximum,
    'allowedValues', d.allowed_values,
    'overridden', v.setting_key is not null
  ) order by d.sort_order, d.key), '[]'::jsonb)
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
    'labelOverrides', labels,
    'labelKeys', pg_catalog.to_jsonb(array[
      'nav.home', 'nav.myCases', 'nav.messages', 'nav.inbox', 'nav.knowRights',
      'nav.myChapter', 'nav.settings', 'staff.chapterWork', 'nav.casework',
      'admin.title', 'coordinator.title', 'advisor.title', 'vp.title'
    ]::text[])
  );
end;
$function$;

create function public.update_organization_setting(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org_id uuid := private.current_member_organization();
  caller uuid := (select auth.uid());
  definition public.platform_setting_definitions%rowtype;
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select * into definition from public.platform_setting_definitions where key = p_key;
  if not found or not private.setting_value_valid(definition.value_kind, p_value, definition.minimum, definition.maximum, definition.allowed_values) then
    raise exception 'invalid setting value' using errcode = '22023';
  end if;

  insert into public.organization_setting_values (organization_id, setting_key, value, updated_by)
  values (org_id, p_key, p_value, caller)
  on conflict (organization_id, setting_key) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = pg_catalog.now();
  insert into public.organization_configuration_audit (organization_id, actor_user_id, action, item_key)
  values (org_id, caller, 'setting_updated', p_key);
  return pg_catalog.jsonb_build_object('key', p_key, 'value', p_value, 'updated', true);
end;
$function$;

create function public.update_organization_label(p_key text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org_id uuid := private.current_member_organization();
  caller uuid := (select auth.uid());
  clean text := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g');
  valid_keys constant text[] := array[
    'nav.home', 'nav.myCases', 'nav.messages', 'nav.inbox', 'nav.knowRights',
    'nav.myChapter', 'nav.settings', 'staff.chapterWork', 'nav.casework',
    'admin.title', 'coordinator.title', 'advisor.title', 'vp.title'
  ]::text[];
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not (p_key = any(valid_keys)) then raise exception 'invalid label key' using errcode = '22023'; end if;
  if clean = '' then
    delete from public.organization_label_overrides where organization_id = org_id and label_key = p_key;
    insert into public.organization_configuration_audit (organization_id, actor_user_id, action, item_key)
    values (org_id, caller, 'label_removed', p_key);
    return pg_catalog.jsonb_build_object('key', p_key, 'value', null, 'removed', true);
  end if;
  if pg_catalog.char_length(clean) > 40 or clean ~ '[<>[:cntrl:]]' then
    raise exception 'invalid label value' using errcode = '22023';
  end if;
  insert into public.organization_label_overrides (organization_id, label_key, label_value, updated_by)
  values (org_id, p_key, clean, caller)
  on conflict (organization_id, label_key) do update
    set label_value = excluded.label_value, updated_by = excluded.updated_by, updated_at = pg_catalog.now();
  insert into public.organization_configuration_audit (organization_id, actor_user_id, action, item_key)
  values (org_id, caller, 'label_updated', p_key);
  return pg_catalog.jsonb_build_object('key', p_key, 'value', clean, 'updated', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. One-time MFA recovery codes
-- ---------------------------------------------------------------------------

create table public.mfa_recovery_code_sets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on update cascade on delete restrict,
  generation integer not null default 1 check (generation > 0),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  locked_until timestamptz,
  generated_at timestamptz not null default pg_catalog.now(),
  generated_aal text not null default 'aal2' check (generated_aal = 'aal2')
);

create table public.mfa_recovery_codes (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on update cascade on delete restrict,
  generation integer not null check (generation > 0),
  code_prefix text not null check (code_prefix ~ '^[A-F0-9]{8}$'),
  code_hash text not null,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claim_token_hash text,
  used_at timestamptz,
  constraint mfa_recovery_codes_claim_complete check (
    (claimed_at is null and claim_expires_at is null and claim_token_hash is null)
    or (claimed_at is not null and claim_expires_at is not null and claim_token_hash is not null)
  )
);

create unique index mfa_recovery_codes_generation_prefix_key
  on public.mfa_recovery_codes (user_id, generation, code_prefix);
create index mfa_recovery_codes_user_unused_idx
  on public.mfa_recovery_codes (user_id, used_at) where used_at is null;

alter table public.mfa_recovery_code_sets enable row level security;
alter table public.mfa_recovery_codes enable row level security;
create policy mfa_assurance on public.mfa_recovery_code_sets
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.mfa_recovery_codes
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
revoke all on table public.mfa_recovery_code_sets from public, anon, authenticated;
revoke all on table public.mfa_recovery_codes from public, anon, authenticated;

create function public.generate_mfa_recovery_codes()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org_id uuid := private.current_member_organization();
  next_generation integer;
  plain text;
  compact text;
  codes text[] := array[]::text[];
  i integer;
begin
  if caller is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'aal2 required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.mfa_factors f
    where f.user_id = caller and f.status = 'verified' and f.factor_type = 'totp'
  ) then raise exception 'verified authenticator required' using errcode = '42501'; end if;
  if org_id is not null and not coalesce((
    select coalesce((v.value #>> '{}')::boolean, (d.default_value #>> '{}')::boolean)
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
$function$;

create function public.get_mfa_recovery_code_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid()); result jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select pg_catalog.jsonb_build_object(
    'generatedAt', s.generated_at,
    'generation', s.generation,
    'unusedCount', count(c.id) filter (where c.used_at is null),
    'usedCount', count(c.id) filter (where c.used_at is not null),
    'lockedUntil', s.locked_until
  ) into result
  from public.mfa_recovery_code_sets s
  left join public.mfa_recovery_codes c on c.user_id = s.user_id and c.generation = s.generation
  where s.user_id = caller
  group by s.user_id, s.generated_at, s.generation, s.locked_until;
  return coalesce(result, pg_catalog.jsonb_build_object('generatedAt', null, 'generation', 0,
    'unusedCount', 0, 'usedCount', 0, 'lockedUntil', null));
end;
$function$;

create function public.claim_mfa_recovery_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  clean text := pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  prefix text;
  set_row public.mfa_recovery_code_sets%rowtype;
  code_row public.mfa_recovery_codes%rowtype;
  claim_token text;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if clean !~ '^UG[A-F0-9]{16}$' then raise exception 'recovery code not accepted' using errcode = '22023'; end if;
  select * into set_row from public.mfa_recovery_code_sets where user_id = caller for update;
  if not found or (set_row.locked_until is not null and set_row.locked_until > pg_catalog.now()) then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;
  prefix := pg_catalog.substr(clean, 3, 8);
  select * into code_row
  from public.mfa_recovery_codes
  where user_id = caller and generation = set_row.generation and code_prefix = prefix and used_at is null
    and (claim_expires_at is null or claim_expires_at <= pg_catalog.now())
  for update;
  if not found or extensions.crypt(clean, code_row.code_hash) <> code_row.code_hash then
    update public.mfa_recovery_code_sets set
      failed_attempts = case when failed_attempts >= 4 then 0 else failed_attempts + 1 end,
      locked_until = case when failed_attempts >= 4 then pg_catalog.now() + interval '15 minutes' else null end
    where user_id = caller;
    -- Return a generic refusal instead of raising: a PL/pgSQL exception would
    -- roll back the counter update in this transaction and silently disable
    -- the five-attempt lockout. The server seam maps this shape to the same
    -- public 400 used for malformed and locked codes.
    return pg_catalog.jsonb_build_object('accepted', false);
  end if;
  claim_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  update public.mfa_recovery_codes set
    claimed_at = pg_catalog.now(),
    claim_expires_at = pg_catalog.now() + interval '2 minutes',
    claim_token_hash = pg_catalog.encode(extensions.digest(claim_token, 'sha256'), 'hex')
  where id = code_row.id;
  update public.mfa_recovery_code_sets set failed_attempts = 0, locked_until = null where user_id = caller;
  return pg_catalog.jsonb_build_object('claimToken', claim_token, 'userId', caller, 'expiresIn', 120);
end;
$function$;

create function public.finalize_mfa_recovery_code(p_user_id uuid, p_claim_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare changed integer;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  update public.mfa_recovery_codes set used_at = pg_catalog.now()
  where user_id = p_user_id and used_at is null and claim_expires_at > pg_catalog.now()
    and claim_token_hash = pg_catalog.encode(extensions.digest(coalesce(p_claim_token, ''), 'sha256'), 'hex');
  get diagnostics changed = row_count;
  return changed = 1;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Failed-login operations inbox
-- ---------------------------------------------------------------------------

create table public.organization_failed_login_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  member_user_id uuid references auth.users(id) on delete set null,
  identity_hash text not null check (identity_hash ~ '^[a-f0-9]{64}$'),
  method text not null check (method in ('password', 'passkey')),
  source text not null check (source in ('web-saas', 'web-sample', 'native-ios', 'native-android')),
  user_agent text not null,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  disposition_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  occurred_at timestamptz not null default pg_catalog.now(),
  constraint organization_failed_login_attempts_user_agent check (
    pg_catalog.char_length(user_agent) between 1 and 160 and user_agent !~ '[[:cntrl:]]'
  ),
  constraint organization_failed_login_attempts_disposition check (
    (status = 'open' and reviewed_by is null and reviewed_at is null and disposition_note is null)
    or (status <> 'open' and reviewed_by is not null and reviewed_at is not null
      and pg_catalog.char_length(pg_catalog.btrim(disposition_note)) between 2 and 240
      and disposition_note !~ '[[:cntrl:]]')
  )
);

create index organization_failed_login_attempts_inbox_idx
  on public.organization_failed_login_attempts (organization_id, status, occurred_at desc);
alter table public.organization_failed_login_attempts enable row level security;
create policy mfa_assurance on public.organization_failed_login_attempts
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
revoke all on table public.organization_failed_login_attempts from public, anon, authenticated;

create function public.record_failed_login_attempt(
  p_email text,
  p_method text,
  p_source text,
  p_user_agent text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  safe_agent text := pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_user_agent, 'Unknown client')), '[[:cntrl:]]+', ' ', 'g'), 160);
  subject uuid;
  org_id uuid;
  inserted_id uuid;
  retention_days integer := 90;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_method not in ('password', 'passkey') or p_source not in ('web-saas', 'web-sample', 'native-ios', 'native-android') then
    raise exception 'invalid login failure metadata' using errcode = '22023';
  end if;
  select u.id into subject from auth.users u where pg_catalog.lower(u.email) = normalized_email limit 1;
  if subject is null then return null; end if;
  select c.organization_id into org_id
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id and c.organization_id is not null
  join public.organization_memberships m on m.organization_id = c.organization_id and m.user_id = p.id and m.status = 'active'
  where p.id = subject limit 1;
  if org_id is null then return null; end if;

  insert into public.organization_failed_login_attempts
    (organization_id, member_user_id, identity_hash, method, source, user_agent)
  values (
    org_id, subject,
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(normalized_email, 'UTF8'), 'sha256'), 'hex'),
    p_method, p_source, coalesce(nullif(safe_agent, ''), 'Unknown client')
  ) returning id into inserted_id;

  select coalesce((v.value #>> '{}')::integer, (d.default_value #>> '{}')::integer)
  into retention_days
  from public.platform_setting_definitions d
  left join public.organization_setting_values v on v.organization_id = org_id and v.setting_key = d.key
  where d.key = 'security.failed_login_retention_days';
  delete from public.organization_failed_login_attempts
  where organization_id = org_id and occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => retention_days);
  return inserted_id;
end;
$function$;

create function public.list_failed_login_operations_inbox(p_status text default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org_id uuid := private.current_member_organization(); threshold integer := 5; result jsonb;
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('open', 'reviewed', 'dismissed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_limit not between 1 and 100 then raise exception 'invalid limit' using errcode = '22023'; end if;
  select coalesce((v.value #>> '{}')::integer, (d.default_value #>> '{}')::integer)
  into threshold
  from public.platform_setting_definitions d
  left join public.organization_setting_values v on v.organization_id = org_id and v.setting_key = d.key
  where d.key = 'security.failed_login_alert_threshold';

  select pg_catalog.jsonb_build_object(
    'openLast24Hours', (select count(*) from public.organization_failed_login_attempts a
      where a.organization_id = org_id and a.status = 'open' and a.occurred_at >= pg_catalog.now() - interval '24 hours'),
    'attentionThreshold', threshold,
    'items', coalesce((select pg_catalog.jsonb_agg(row_data order by occurred_at desc) from (
      select a.occurred_at, pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Former member'),
        'memberReference', pg_catalog.upper(pg_catalog.right(a.identity_hash, 6)),
        'method', a.method,
        'source', a.source,
        'userAgent', a.user_agent,
        'status', a.status,
        'dispositionNote', a.disposition_note,
        'occurredAt', a.occurred_at,
        'reviewedAt', a.reviewed_at
      ) as row_data
      from public.organization_failed_login_attempts a
      left join public.member_profiles p on p.id = a.member_user_id
      where a.organization_id = org_id and (p_status is null or a.status = p_status)
      order by a.occurred_at desc limit p_limit
    ) bounded), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

create function public.disposition_failed_login_attempt(p_attempt_id uuid, p_status text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org_id uuid := private.current_member_organization(); caller uuid := (select auth.uid()); clean_note text := pg_catalog.btrim(coalesce(p_note, '')); changed integer;
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_status not in ('reviewed', 'dismissed') or pg_catalog.char_length(clean_note) not between 2 and 240 or clean_note ~ '[[:cntrl:]]' then
    raise exception 'invalid disposition' using errcode = '22023';
  end if;
  update public.organization_failed_login_attempts set
    status = p_status, disposition_note = clean_note, reviewed_by = caller, reviewed_at = pg_catalog.now()
  where id = p_attempt_id and organization_id = org_id and status = 'open';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'attempt not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object('id', p_attempt_id, 'status', p_status, 'updated', true);
end;
$function$;

-- Exact grants. Service-role-only functions are still revoked from the browser
-- roles even though each also verifies auth.role() internally.
revoke all on function private.setting_value_valid(text, jsonb, integer, integer, text[]) from public, anon, authenticated, service_role;
revoke all on function public.get_member_organization_configuration() from public, anon, authenticated, service_role;
revoke all on function public.get_admin_organization_configuration() from public, anon, authenticated, service_role;
revoke all on function public.update_organization_setting(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.update_organization_label(text, text) from public, anon, authenticated, service_role;
revoke all on function public.generate_mfa_recovery_codes() from public, anon, authenticated, service_role;
revoke all on function public.get_mfa_recovery_code_status() from public, anon, authenticated, service_role;
revoke all on function public.claim_mfa_recovery_code(text) from public, anon, authenticated, service_role;
revoke all on function public.finalize_mfa_recovery_code(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.record_failed_login_attempt(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.list_failed_login_operations_inbox(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.disposition_failed_login_attempt(uuid, text, text) from public, anon, authenticated, service_role;

grant execute on function public.get_member_organization_configuration() to authenticated;
grant execute on function public.get_admin_organization_configuration() to authenticated;
grant execute on function public.update_organization_setting(text, jsonb) to authenticated;
grant execute on function public.update_organization_label(text, text) to authenticated;
grant execute on function public.generate_mfa_recovery_codes() to authenticated;
grant execute on function public.get_mfa_recovery_code_status() to authenticated;
grant execute on function public.claim_mfa_recovery_code(text) to authenticated;
grant execute on function public.list_failed_login_operations_inbox(text, integer) to authenticated;
grant execute on function public.disposition_failed_login_attempt(uuid, text, text) to authenticated;
grant execute on function public.finalize_mfa_recovery_code(uuid, text) to service_role;
grant execute on function public.record_failed_login_attempt(text, text, text, text) to service_role;

comment on table public.organization_setting_values is
  'Tenant settings; no direct client access. Admin writes and member-safe projections use MFA-aware RPCs.';
comment on table public.organization_label_overrides is
  'Allowlisted tenant wording for existing navigation keys. Labels never change authorization or routes.';
comment on table public.mfa_recovery_codes is
  'Bcrypt-hashed one-time recovery credentials. Plaintext is returned once by the generation RPC and never stored.';
comment on table public.organization_failed_login_attempts is
  'Tenant-attributed auth failures only. Unknown identities are deliberately not assigned to or exposed inside any tenant.';
