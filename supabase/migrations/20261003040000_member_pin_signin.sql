-- REQ-UG-MEMBER-PIN-SIGNIN-20261001
--
-- Restore-everything campaign,:
-- members-only PIN sign-in. A member with no staff role anywhere may set a
-- personal PIN while signed in with their normal credentials and later sign in
-- with email + PIN through api/auth-pin-signin.js.
--
-- What the old app got wrong, and what this migration does instead:
--   * BUG-pin-seed-from-phone-exploitable: old lib/pin.ts seeded PINs from the
--     last six phone digits. Nothing here derives a PIN from member data; a
--     member must choose one, and a PIN that appears inside the member's own
--     phone number is refused.
--   * BUG-pin-lockout-423-email-enum: the old lockout answered differently for
--     a real account. verify_member_pin_signin returns one flat refusal for an
--     unknown email, a missing PIN, a wrong PIN, a lockout, a throttled request,
--     a staff account, an MFA-enrolled account and an organization that has not
--     enabled the feature, and every one of those paths runs exactly one bcrypt
--     comparison so database time does not separate them either.
--
-- Security model (see the PR body for the full write-up):
--   * Hash: pgcrypto bcrypt (gen_salt('bf', 12)), the repo's existing
--     credential-hash approach (public.mfa_recovery_codes). The PIN is never
--     stored, returned, logged or written to the audit.
--   * Eligibility, re-checked on every sign-in: no staff role in any
--     organization or chapter (organization_role_grants, member_roles,
--     member_role_chapters) and no platform authority (platform_operators,
--     compass_platform_operators, learning_platform_editors); no verified MFA
--     factor (a PIN replaces neither the password nor the second factor, so an
--     MFA-enrolled account is refused rather than handed an aal1 session that
--     the mfa_assurance boundary would empty anyway); at least one active
--     organization membership, and features.security.member_pin_signin on in
--     EVERY active organization the account belongs to (a PIN session reaches
--     all of the account's tenants, so one organization cannot opt another in).
--   * Gaining a staff role deletes the PIN immediately (row triggers below).
--   * Throttling: 's generic private.auth_attempt_check per network
--     bucket (20/hour, old lib/security/rate-limit.ts checkIpRate) and per
--     email (10/hour), checked before any account lookup; plus a strict
--     per-account lockout from limits.security.member_pin_lockout_attempts /
--     _minutes that doubles with each repeat lockout up to 24 hours.
--   * Setting or changing a PIN requires an authentication within the last 24
--     hours (the same window supabase/config.toml secure_password_change gives
--     a password change) and a satisfied MFA boundary.
--
-- Defaults (old app's effective production values):
--   features.security.member_pin_signin = false
--     old supabase/migrations/0079_add_login_visibility_settings.sql:20
--     ('show_login_pin_option', 'false', ...); no later migration flipped it.
--   limits.security.member_pin_lockout_attempts = 5
--     old lib/pin.ts (de7df4b57c^ history, aa8b602ad5^:lib/auth/pin.ts:19)
--     MAX_FAILED = PIN_MAX_FAILED_ATTEMPTS ?? 5; 0029 seeded pin_lockout_attempts 5.
--   limits.security.member_pin_lockout_minutes = 15
--     old lib/pin.ts LOCK_MINUTES = PIN_LOCK_MINUTES ?? 15 (aa8b602ad5^:lib/auth/pin.ts:20),
--     0029_fix_settings_constraints_and_seed.sql:58 pin_lockout_minutes 15.
--
-- Account lifecycle: private.member_pin_credentials cascades with auth.users
-- (manifest row below). The attempt state and the audit deliberately carry no
-- auth.users foreign key: the sign-in path writes them on every attempt and
-- must not take the global case-graph lock while bcrypt runs. Attempt state is
-- removed with the credential by trigger; the audit keys rows by the lifecycle
-- HMAC subject hash, the same pseudonymous key the account-lifecycle audit uses.
--
-- Restricted PIN sessions: every session the
-- PIN route mints is marked, and the marked session is refused the surfaces the
-- old app hid from PIN sessions until the member signs in with a password or
-- passkey. Mechanism in section 5b, enforced surfaces in section 8b, switch
-- features.security.member_pin_restricted_sessions (default on).
--
-- Production stays empty: the only rows written are platform setting
-- definitions and notification copy.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Organization switch and limits (W1-SETTINGS registry contract)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- old 0079_add_login_visibility_settings.sql:20 show_login_pin_option 'false'
  ('features.security.member_pin_signin', 'boolean', 'Member PIN sign-in',
   'Members with no staff role may set a personal PIN of at least 6 digits and sign in with email and PIN. Staff roles are always refused.',
   'false', null, null, null, 210, 'security', true),
  -- old lib/pin.ts MAX_FAILED default 5; 0029 pin_lockout_attempts 5
  ('limits.security.member_pin_lockout_attempts', 'integer', 'PIN lockout after wrong PINs',
   'Wrong PINs in a row before PIN sign-in locks for that account. Each later lockout doubles the wait.',
   '5', 3, 10, null, 220, 'security', false),
  -- old lib/pin.ts LOCK_MINUTES default 15; 0029 pin_lockout_minutes 15
  ('limits.security.member_pin_lockout_minutes', 'integer', 'PIN lockout minutes',
   'Minutes the first PIN lockout lasts. Repeat lockouts double it, up to 24 hours.',
   '15', 5, 1440, null, 230, 'security', false),
  -- PIN sessions are restricted like the
  -- old app. The old app had no flag for it: de7df4b57c^:lib/auth/auth-helpers.ts:136
  -- set pinRestricted for every PIN session, so the default is on.
  ('features.security.member_pin_restricted_sessions', 'boolean', 'Restricted PIN sessions',
   'A PIN sign-in cannot open cases, messages, files, data exports or security settings until the member signs in with a password or passkey.',
   'true', null, null, null, 215, 'security', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Storage
-- ---------------------------------------------------------------------------

create table private.member_pin_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pin_hash text not null check (pin_hash ~ '^\$2a\$12\$[./A-Za-z0-9]{53}$'),
  set_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

comment on table private.member_pin_credentials is
  'REQ-UG-MEMBER-PIN-SIGNIN-20261001: one bcrypt PIN hash per member account. No client grant; read and written only by the member PIN definer functions.';

-- Deliberately no auth.users foreign key (see header): written on every
-- sign-in attempt outside the case-graph lock, removed with its credential.
create table private.member_pin_attempt_state (
  user_id uuid primary key,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 100),
  lockout_level integer not null default 0 check (lockout_level between 0 and 20),
  locked_until timestamptz,
  last_failed_at timestamptz,
  last_signed_in_at timestamptz
);

comment on table private.member_pin_attempt_state is
  'Per-account PIN failure counter and escalating lockout. Keyed by user id without a foreign key so the sign-in path never takes the case-graph lock; deleted with the credential.';

create table private.member_pin_audit (
  id bigint generated always as identity primary key,
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  action text not null check (action in (
    'pin_set', 'pin_changed', 'pin_removed', 'pin_disabled_staff_role', 'pin_locked_out'
  )),
  occurred_at timestamptz not null default pg_catalog.now()
);

create index member_pin_audit_subject_recent_idx
  on private.member_pin_audit (subject_hash, occurred_at desc);

comment on table private.member_pin_audit is
  'PIN set, changed, removed, disabled-by-staff-role and lockout events. Never holds the PIN or its hash; keyed by private.member_lifecycle_subject_hash.';

alter table private.member_pin_credentials enable row level security;
alter table private.member_pin_credentials force row level security;
alter table private.member_pin_attempt_state enable row level security;
alter table private.member_pin_attempt_state force row level security;
alter table private.member_pin_audit enable row level security;
alter table private.member_pin_audit force row level security;
revoke all on table private.member_pin_credentials from public, anon, authenticated, service_role;
revoke all on table private.member_pin_attempt_state from public, anon, authenticated, service_role;
revoke all on table private.member_pin_audit from public, anon, authenticated, service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.member_pin_credentials
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_pin_credentials
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, exclusion_reason, note, reviewed_at)
values ('private', 'member_pin_credentials', 'user_id', 'cascade', 'excluded_with_reason',
  null, 'auth_user_fk', 'Sign-in credential hash; credential material never enters a portable export.',
  'ON DELETE CASCADE removes the PIN with the account; the attempt-state trigger removes its counters.', current_date);

-- ---------------------------------------------------------------------------
-- 3. Pure checks
-- ---------------------------------------------------------------------------

-- Returns null for an acceptable new PIN, else the refusal code. Mirrored for
-- immediate feedback by src/lib/memberPin.js and apps/mobile/src/lib/memberPin.ts;
-- this function is the authority.
create function private.member_pin_format_issue(p_pin text)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  digits integer[];
  steps integer[];
  pairs text;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6,12}$' then
    return 'member-pin-format';
  end if;
  -- One digit repeated, or any shorter block repeated (111111, 121212, 123123).
  if p_pin ~ '^([0-9]{1,6})\1+$' then
    return 'member-pin-trivial';
  end if;
  digits := array(
    select pg_catalog.ascii(c.ch) - 48
    from pg_catalog.regexp_split_to_table(p_pin, '') with ordinality c(ch, n)
    order by c.n
  );
  steps := array(
    select (digits[g.k + 1] - digits[g.k] + 10) % 10
    from pg_catalog.generate_series(1, pg_catalog.cardinality(digits) - 1) g(k)
  );
  -- Ascending or descending runs, wrapping 9 -> 0 (123456, 987654, 890123).
  if steps <@ array[1] or steps <@ array[9] then
    return 'member-pin-trivial';
  end if;
  -- Doubled sequences (112233, 998877).
  if pg_catalog.char_length(p_pin) % 2 = 0 then
    pairs := '';
    for i in 1..pg_catalog.char_length(p_pin) / 2 loop
      exit when pg_catalog.substr(p_pin, i * 2 - 1, 1) <> pg_catalog.substr(p_pin, i * 2, 1);
      pairs := pairs || pg_catalog.substr(p_pin, i * 2, 1);
    end loop;
    if pg_catalog.char_length(pairs) = pg_catalog.char_length(p_pin) / 2
      and private.member_pin_format_issue_run(pairs) then
      return 'member-pin-trivial';
    end if;
  end if;
  -- Mirrored halves (123321) and keypad lines that guessing lists try first.
  if p_pin = pg_catalog.reverse(p_pin) then
    return 'member-pin-trivial';
  end if;
  if p_pin = any(array['159753', '357951', '147258', '258369', '369258', '147369', '963852',
                       '852741', '741852', '789456', '456123', '102030', '010203', '112358']) then
    return 'member-pin-trivial';
  end if;
  return null;
end;
$function$;

create function private.member_pin_format_issue_run(p_digits text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.char_length(p_digits) >= 2 and (
    not exists (
      select 1 from pg_catalog.generate_series(1, pg_catalog.char_length(p_digits) - 1) i
      where (pg_catalog.ascii(pg_catalog.substr(p_digits, i + 1, 1)) - pg_catalog.ascii(pg_catalog.substr(p_digits, i, 1)) + 10) % 10 <> 1
    )
    or not exists (
      select 1 from pg_catalog.generate_series(1, pg_catalog.char_length(p_digits) - 1) i
      where (pg_catalog.ascii(pg_catalog.substr(p_digits, i + 1, 1)) - pg_catalog.ascii(pg_catalog.substr(p_digits, i, 1)) + 10) % 10 <> 9
    )
    or p_digits ~ '^([0-9])\1+$'
  )
$function$;

-- True when the PIN appears inside a phone number stored for the account.
create function private.member_pin_matches_phone(p_user_id uuid, p_pin text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from (
      select pg_catalog.regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g') digits
      from auth.users u where u.id = p_user_id
      union all
      select pg_catalog.regexp_replace(s.phone_e164, '[^0-9]', '', 'g')
      from private.member_sms_preferences s where s.user_id = p_user_id
    ) phone
    where pg_catalog.char_length(phone.digits) >= 6
      and pg_catalog.strpos(phone.digits, p_pin) > 0
  )
$function$;

-- The caller authenticated within the last 24 hours (the amr timestamps in the
-- Supabase JWT survive refreshes, so this measures the real sign-in). Mirrors
-- the 24-hour window secure_password_change gives a password change.
create function private.member_pin_recent_authentication()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.max((entry.value ->> 'timestamp')::bigint)
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof((select auth.jwt()) -> 'amr') = 'array'
        then (select auth.jwt()) -> 'amr' else '[]'::jsonb end
    ) entry
    where pg_catalog.jsonb_typeof(entry.value) = 'object'
      and (entry.value ->> 'timestamp') ~ '^[0-9]{1,12}$'
  ) >= pg_catalog.date_part('epoch', pg_catalog.now() - interval '24 hours'), false)
$function$;

-- ---------------------------------------------------------------------------
-- 4. Eligibility and policy, re-read on every sign-in
-- ---------------------------------------------------------------------------

-- Null when the account may use a PIN, else one reason code. The reason is
-- shown only to the signed-in member in Settings; sign-in collapses every
-- reason into the same flat refusal.
create function private.member_pin_ineligibility(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null or not exists (
    select 1 from auth.users u
    where u.id = p_user_id
      and u.deleted_at is null
      and u.email_confirmed_at is not null
      and u.email is not null
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
      and not coalesce(u.is_anonymous, false)
  ) or exists (
    select 1 from private.member_account_deletions d
    where d.subject_hash = private.member_lifecycle_subject_hash(p_user_id)
      and d.status in ('authorized', 'processing')
  ) then
    return 'account_unavailable';
  end if;
  if exists (select 1 from public.organization_role_grants g where g.user_id = p_user_id)
    or exists (select 1 from public.member_roles r where r.user_id = p_user_id)
    or exists (select 1 from public.member_role_chapters rc where rc.user_id = p_user_id)
    or exists (select 1 from private.platform_operators o where o.user_id = p_user_id and o.revoked_at is null)
    or exists (select 1 from private.compass_platform_operators o where o.user_id = p_user_id and o.revoked_at is null)
    or exists (select 1 from private.learning_platform_editors e where e.user_id = p_user_id) then
    return 'staff_role';
  end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = p_user_id and f.status = 'verified') then
    return 'mfa_enrolled';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    where m.user_id = p_user_id and m.status = 'active'
  ) then
    return 'no_organization';
  end if;
  if exists (
    select 1 from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    where m.user_id = p_user_id and m.status = 'active'
      and not private.organization_feature_enabled(m.organization_id, 'features.security.member_pin_signin')
  ) then
    return 'disabled_by_organization';
  end if;
  return null;
end;
$function$;

-- The strictest lockout across the account's active organizations.
create function private.member_pin_lockout_policy(p_user_id uuid, out attempts integer, out minutes integer)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  select pg_catalog.min(private.organization_limit(m.organization_id, 'limits.security.member_pin_lockout_attempts')),
         pg_catalog.max(private.organization_limit(m.organization_id, 'limits.security.member_pin_lockout_minutes'))
  into attempts, minutes
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id and o.status = 'active'
  where m.user_id = p_user_id and m.status = 'active';
  attempts := coalesce(attempts, private.organization_limit(null, 'limits.security.member_pin_lockout_attempts'));
  minutes := coalesce(minutes, private.organization_limit(null, 'limits.security.member_pin_lockout_minutes'));
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Per-account attempt state (no case-graph relation; see header)
-- ---------------------------------------------------------------------------

-- Opens one attempt: holds the account's attempt row until the transaction
-- ends, so concurrent guesses against one account run one at a time and the
-- counter cannot be raced. Returns false while the account is locked.
create function private.member_pin_attempt_open(p_user_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  until_at timestamptz;
begin
  insert into private.member_pin_attempt_state (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select s.locked_until into until_at
  from private.member_pin_attempt_state s
  where s.user_id = p_user_id
  for update;
  return until_at is null or until_at <= pg_catalog.now();
end;
$function$;

create function private.member_pin_attempt_close(
  p_user_id uuid,
  p_success boolean,
  p_max_attempts integer,
  p_lock_minutes integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  failures integer;
  level integer;
begin
  if p_success then
    update private.member_pin_attempt_state set
      failed_attempts = 0, lockout_level = 0, locked_until = null,
      last_signed_in_at = pg_catalog.now()
    where user_id = p_user_id;
    return;
  end if;
  update private.member_pin_attempt_state set
    failed_attempts = least(failed_attempts + 1, 100),
    last_failed_at = pg_catalog.now()
  where user_id = p_user_id
  returning failed_attempts, lockout_level into failures, level;
  if failures >= p_max_attempts then
    update private.member_pin_attempt_state set
      failed_attempts = 0,
      lockout_level = least(level + 1, 20),
      -- First lockout lasts the configured minutes; each repeat doubles it,
      -- capped at 24 hours (the configured maximum is 1440).
      locked_until = pg_catalog.now() + pg_catalog.make_interval(
        mins => least(p_lock_minutes * pg_catalog.power(2, least(level, 10))::integer, 1440))
    where user_id = p_user_id;
    insert into private.member_pin_audit (subject_hash, action)
    values (private.member_lifecycle_subject_hash(p_user_id), 'pin_locked_out');
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5b. Restricted PIN sessions
-- ---------------------------------------------------------------------------
--
-- How the database knows a session came from a PIN. api/auth-pin-signin.js
-- redeems the magic-link token itself, reads the GoTrue session id from the
-- access token GoTrue just signed, and records it with the service-role-only
-- public.mark_member_pin_session before any token reaches the client. The
-- marker is keyed by auth.sessions.id, which is the signed `session_id` JWT
-- claim on every access token of that session, refreshes included. A client
-- cannot change that claim, cannot read or write the marker (no grants), and
-- cannot shed it: a refresh keeps the session id, and the only way to a
-- session without a marker is a new sign-in with a password, a passkey or
-- another full method. That new sign-in is the step-up.
--
-- What a restricted session can do: everything an ordinary member session can,
-- except the surfaces the old app hid from PIN sessions (requireNonPinMember in
-- de7df4b57c^:lib/auth/auth-helpers.ts and its callers): case and grievance
-- records and their narratives, messages with stewards, private files and
-- forms, the personal data export, account deletion, security settings
-- (password, email, MFA, passkeys, linked sign-ins, devices, calendar feed)
-- and setting or changing a PIN. Removing the PIN stays allowed. Every refusal
-- is SQLSTATE 42501 with the message 'step-up required'. The organization
-- switch features.security.member_pin_restricted_sessions turns the
-- restriction off; the strictest organization wins, as for sign-in itself.
-- Staff capability needs no extra rule: a PIN account has no staff role, and
-- gaining one ends every live PIN session (section 8), which also fails the
-- auth.sessions check in private.mfa_satisfied() for that session's tokens.
--
-- Never a second factor. A PIN session is aal1 with the single AMR 'otp' (the
-- magic-link token the route redeems). It cannot reach aal2 by verifying a
-- factor (private.member_pin_mfa_guard below), and it can never become a
-- "verified key" session under the separate key-assurance design (,
-- private.verified_key_sessions and the ug_key_uv claim), which admits only a
-- session whose own AMR is 'passkey'. The restriction keys on the session id,
-- not on aal or any claim, so it holds whatever assurance a session reports.
-- The two designs share no table, function or claim name.

create table private.member_pin_sessions (
  session_id uuid primary key,
  user_id uuid not null,
  marked_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index member_pin_sessions_user_idx on private.member_pin_sessions (user_id);

comment on table private.member_pin_sessions is
  'D5-3 restricted PIN sessions: the GoTrue session ids minted by api/auth-pin-signin.js. No client grant. Deliberately no foreign key (the sign-in path stays off the case-graph lock); rows for ended sessions are pruned at the next mark for the account and when PIN sessions are ended.';

alter table private.member_pin_sessions enable row level security;
alter table private.member_pin_sessions force row level security;
revoke all on table private.member_pin_sessions from public, anon, authenticated, service_role;

-- The session id claim of the caller's access token, or null.
create function private.member_pin_jwt_session_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when claim.value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then claim.value::uuid
  end
  from (select pg_catalog.lower(coalesce((select auth.jwt()) ->> 'session_id', '')) as value) claim
$function$;

-- True unless every active organization of the account has turned the
-- restriction off. An account with no active organization stays restricted.
create function private.member_pin_restriction_applies(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.bool_or(
    private.organization_feature_enabled(m.organization_id, 'features.security.member_pin_restricted_sessions')), true)
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id and o.status = 'active'
  where m.user_id = p_user_id and m.status = 'active'
$function$;

-- The predicate every restricted surface checks: the caller's own session is
-- a marked PIN session and the restriction applies to the account. RLS
-- policies wrap it in a scalar subquery so it runs once per statement.
create function private.member_pin_session_restricted()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  session_key uuid;
begin
  caller := (select auth.uid());
  session_key := private.member_pin_jwt_session_id();
  if caller is null or session_key is null then
    return false;
  end if;
  if not exists (
    select 1 from private.member_pin_sessions s
    where s.session_id = session_key and s.user_id = caller
  ) then
    return false;
  end if;
  return private.member_pin_restriction_applies(caller);
end;
$function$;

comment on function private.member_pin_session_restricted() is
  'D5-3: true when the caller''s JWT session is a marked PIN session and an active organization of the account restricts PIN sessions. Executable by authenticated so RLS policies can evaluate it; it reveals only the caller''s own state.';

create function private.member_pin_require_full_session()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if private.member_pin_session_restricted() then
    raise exception 'step-up required'
      using errcode = '42501', hint = 'Sign in with your password or passkey to continue.';
  end if;
end;
$function$;

-- A marked PIN session of the account that can still make requests. GoTrue
-- refuses a refresh after the inactivity timeout (8 h, supabase/config.toml)
-- and an access token lives at most jwt_expiry (1 h), so a session idle for
-- 9 hours, expired, or deleted cannot be the caller of anything.
create function private.member_pin_live_restricted_session_exists(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from private.member_pin_sessions m
    join auth.sessions s on s.id = m.session_id and s.user_id = m.user_id
    where m.user_id = p_user_id
      and (s.not_after is null or s.not_after > pg_catalog.now())
      and greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'UTC')
        > pg_catalog.now() - interval '9 hours'
  ) and private.member_pin_restriction_applies(p_user_id)
$function$;

-- Ends the account's PIN sessions, except p_keep_session. Deleting the GoTrue
-- session revokes its refresh tokens, and private.mfa_satisfied() refuses its
-- remaining access tokens because their auth.sessions row is gone. Source
-- shape pinned by scripts/account-case-graph-review.json (explicit-exclusive).
create function private.member_pin_end_sessions(p_user_id uuid, p_keep_session uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  delete from auth.sessions s
  using private.member_pin_sessions m
  where m.user_id = p_user_id
    and s.id = m.session_id
    and s.user_id = p_user_id
    and (p_keep_session is null or s.id <> p_keep_session);
  delete from private.member_pin_sessions m
  where m.user_id = p_user_id
    and (p_keep_session is null or m.session_id <> p_keep_session);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Member self-service (authenticated)
-- ---------------------------------------------------------------------------

create function public.get_my_member_pin_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  reason text;
  credential private.member_pin_credentials%rowtype;
  until_at timestamptz;
  other_pin_sessions integer;
begin
  caller := (select auth.uid());
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  reason := private.member_pin_ineligibility(caller);
  select * into credential from private.member_pin_credentials c where c.user_id = caller;
  select s.locked_until into until_at from private.member_pin_attempt_state s
  where s.user_id = caller and s.locked_until > pg_catalog.now();
  -- Other devices still signed in with this account's PIN. While one is live,
  -- password, email, passkey and linked sign-in changes are refused (section
  -- 12), so Settings offers to end them.
  select pg_catalog.count(*)::integer into other_pin_sessions
  from private.member_pin_sessions m
  join auth.sessions s on s.id = m.session_id and s.user_id = m.user_id
  where m.user_id = caller
    and m.session_id is distinct from private.member_pin_jwt_session_id()
    and (s.not_after is null or s.not_after > pg_catalog.now())
    and greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'UTC')
      > pg_catalog.now() - interval '9 hours';
  return pg_catalog.jsonb_build_object(
    'available', reason is null,
    'reason', reason,
    'hasPin', credential.user_id is not null,
    'setAt', credential.set_at,
    'updatedAt', credential.updated_at,
    'lockedUntil', until_at,
    'minimumLength', 6,
    'maximumLength', 12,
    'sessionRestricted', private.member_pin_session_restricted(),
    'otherPinSessions', other_pin_sessions
  );
end;
$function$;

create function public.set_my_member_pin(p_pin text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  issue text;
  existed boolean;
  saved private.member_pin_credentials%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  -- D5-3: a PIN session may remove the PIN but never set or change it.
  perform private.member_pin_require_full_session();
  if private.member_pin_ineligibility(caller) is not null then
    raise exception 'member-pin-unavailable' using errcode = '42501';
  end if;
  if not private.member_pin_recent_authentication() then
    raise exception 'member-pin-reauthentication-required' using errcode = '42501';
  end if;
  issue := private.member_pin_format_issue(p_pin);
  if issue is not null then
    raise exception '%', issue using errcode = '22023';
  end if;
  if private.member_pin_matches_phone(caller, p_pin) then
    raise exception 'member-pin-matches-phone' using errcode = '22023';
  end if;

  existed := exists (select 1 from private.member_pin_credentials c where c.user_id = caller);
  insert into private.member_pin_credentials (user_id, pin_hash, set_at, updated_at)
  values (caller, extensions.crypt(p_pin, extensions.gen_salt('bf', 12)), pg_catalog.now(), pg_catalog.now())
  on conflict (user_id) do update set
    pin_hash = excluded.pin_hash,
    updated_at = excluded.updated_at
  returning * into saved;
  -- A new PIN starts with a clean counter and no lockout, and sessions signed
  -- in with the previous PIN end.
  delete from private.member_pin_attempt_state where user_id = caller;
  if exists (select 1 from private.member_pin_sessions m where m.user_id = caller) then
    perform private.member_pin_end_sessions(caller, null);
  end if;
  insert into private.member_pin_audit (subject_hash, action)
  values (private.member_lifecycle_subject_hash(caller), case when existed then 'pin_changed' else 'pin_set' end);
  perform private.notify_member(caller,
    case when existed then 'security.member_pin_changed' else 'security.member_pin_set' end,
    '{}'::jsonb, 'general');
  return pg_catalog.jsonb_build_object('hasPin', true, 'setAt', saved.set_at, 'updatedAt', saved.updated_at);
end;
$function$;

create function public.remove_my_member_pin()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  delete from private.member_pin_credentials where user_id = caller;
  if found then
    insert into private.member_pin_audit (subject_hash, action)
    values (private.member_lifecycle_subject_hash(caller), 'pin_removed');
    perform private.notify_member(caller, 'security.member_pin_removed', '{}'::jsonb, 'general');
  end if;
  -- Removing the PIN ends every other session signed in with it; the caller's
  -- own session stays (a PIN session that removes the PIN stays restricted).
  if exists (
    select 1 from private.member_pin_sessions m
    where m.user_id = caller and m.session_id is distinct from private.member_pin_jwt_session_id()
  ) then
    perform private.member_pin_end_sessions(caller, private.member_pin_jwt_session_id());
  end if;
  return pg_catalog.jsonb_build_object('hasPin', false);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Sign-in (service role, called only by api/auth-pin-signin.js)
-- ---------------------------------------------------------------------------

-- Public capability for the sign-in screens: true when at least one active
-- organization on this deployment has turned member PIN sign-in on. It names
-- no organization and no account; every per-account refusal stays flat.
create function public.member_pin_signin_offered()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return exists (
    select 1 from public.organizations o
    where o.status = 'active'
      and private.organization_feature_enabled(o.id, 'features.security.member_pin_signin')
  );
end;
$function$;

-- One verdict for one attempt. {"ok": true, "userId", "email"} only when every
-- check passes; otherwise {"ok": false, "recordFailure": <passed throttles>}.
-- The PIN is compared exactly once on every path that reaches an account
-- decision (against a fresh throwaway salt when there is nothing real to
-- compare), so timing does not separate the refusal reasons.
create function public.verify_member_pin_signin(p_email text, p_pin text, p_network text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $function$
declare
  normalized_email text;
  subject uuid;
  canonical_email text;
  stored_hash text;
  open_attempt boolean;
  reason text;
  matched boolean;
  max_attempts integer;
  lock_minutes integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  normalized_email := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  if pg_catalog.char_length(normalized_email) not between 3 and 254
    or coalesce(pg_catalog.char_length(p_pin), 0) not between 1 and 64 then
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', false);
  end if;

  -- Throttles first, before any account lookup, so they apply identically to
  -- real and unknown addresses. private.auth_attempt_check  stores only
  -- an HMAC of scope and key, so no raw address or email is kept. The network
  -- bucket is charged first, as in public.consume_password_signin_attempt: a
  -- network already over its budget does not also spend the address's budget.
  if not private.auth_attempt_check('member-pin-network',
      coalesce(nullif(p_network, ''), 'unknown'), 20, interval '1 hour')
    or not private.auth_attempt_check('member-pin-email',
      normalized_email, 10, interval '1 hour') then
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', false);
  end if;

  select u.id, pg_catalog.lower(u.email) into subject, canonical_email
  from auth.users u
  where pg_catalog.lower(u.email) = normalized_email and u.deleted_at is null
  order by u.created_at
  limit 1;
  if subject is not null then
    select c.pin_hash into stored_hash from private.member_pin_credentials c where c.user_id = subject;
  end if;
  if stored_hash is null then
    perform extensions.crypt(p_pin, extensions.gen_salt('bf', 12));
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', true);
  end if;

  open_attempt := private.member_pin_attempt_open(subject);
  reason := private.member_pin_ineligibility(subject);
  if not open_attempt or reason is not null then
    perform extensions.crypt(p_pin, extensions.gen_salt('bf', 12));
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', true);
  end if;

  matched := extensions.crypt(p_pin, stored_hash) = stored_hash;
  select policy.attempts, policy.minutes into max_attempts, lock_minutes
  from private.member_pin_lockout_policy(subject) policy;
  perform private.member_pin_attempt_close(subject, matched, max_attempts, lock_minutes);
  if not matched then
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', true);
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'userId', subject, 'email', canonical_email);
end;
$function$;

-- D5-3: records the GoTrue session the route just minted for a verified PIN,
-- before the route returns any token. False refuses the session, and the
-- route then signs it out. Not on the case-graph lock: the attempt-state row
-- serializes it with the staff-role trigger, whose credential delete removes
-- that row (member_pin_clear_attempt_state) in the same transaction. Whichever
-- commits first, a staff account never keeps a marked PIN session: either the
-- trigger's end-sessions sees this marker, or this function waits on the row
-- lock, finds the row gone and refuses.
-- Read-only half of the mark: the account still holds a PIN, is still
-- eligible, and owns a session GoTrue created moments ago.
create function private.member_pin_session_markable(p_user_id uuid, p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (select 1 from private.member_pin_credentials c where c.user_id = p_user_id)
    and private.member_pin_ineligibility(p_user_id) is null
    and exists (
      select 1 from auth.sessions s
      where s.id = p_session_id
        and s.user_id = p_user_id
        and s.created_at > pg_catalog.now() - interval '5 minutes'
    )
$function$;

-- Markers of sessions GoTrue has already removed (sign-out, expiry clean-up,
-- account deletion) go at the next mark for the account.
create function private.member_pin_prune_sessions(p_user_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $function$
  delete from private.member_pin_sessions m
  where m.user_id = p_user_id
    and not exists (select 1 from auth.sessions s where s.id = m.session_id)
$function$;

create function public.mark_member_pin_session(p_user_id uuid, p_session_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $function$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_session_id is null then
    return false;
  end if;
  perform 1 from private.member_pin_attempt_state a where a.user_id = p_user_id for update;
  if not found or not private.member_pin_session_markable(p_user_id, p_session_id) then
    return false;
  end if;
  perform private.member_pin_prune_sessions(p_user_id);
  insert into private.member_pin_sessions (session_id, user_id)
  values (p_session_id, p_user_id)
  on conflict (session_id) do nothing;
  return true;
end;
$function$;

-- The organization failed-login inbox learns the PIN method. Mirrors
-- public.record_failed_login_attempt (which stays password/passkey only) so a
-- refused PIN reaches the same admin inbox without a raw email or address.
alter table public.organization_failed_login_attempts
  drop constraint organization_failed_login_attempts_method_check;
alter table public.organization_failed_login_attempts
  add constraint organization_failed_login_attempts_method_check
  check (method in ('password', 'passkey', 'pin'));

create function public.record_member_pin_failure(p_email text, p_source text, p_user_agent text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  normalized_email text;
  safe_agent text;
  subject uuid;
  org_id uuid;
  inserted_id uuid;
  retention_days integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_source not in ('web-saas', 'web-sample', 'native-ios', 'native-android') then
    raise exception 'invalid login failure metadata' using errcode = '22023';
  end if;
  normalized_email := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  safe_agent := pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_user_agent, 'Unknown client')), '[[:cntrl:]]+', ' ', 'g'), 160);
  select u.id into subject from auth.users u where pg_catalog.lower(u.email) = normalized_email limit 1;
  if subject is null then
    return null;
  end if;
  select c.organization_id into org_id
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id and c.organization_id is not null
  join public.organization_memberships m on m.organization_id = c.organization_id and m.user_id = p.id and m.status = 'active'
  where p.id = subject limit 1;
  if org_id is null then
    return null;
  end if;
  insert into public.organization_failed_login_attempts
    (organization_id, member_user_id, identity_hash, method, source, user_agent)
  values (
    org_id, subject,
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(normalized_email, 'UTF8'), 'sha256'), 'hex'),
    'pin', p_source, coalesce(nullif(safe_agent, ''), 'Unknown client')
  ) returning id into inserted_id;
  select coalesce((v.value #>> '{}')::integer, (d.default_value #>> '{}')::integer)
  into retention_days
  from public.platform_setting_definitions d
  left join public.organization_setting_values v on v.organization_id = org_id and v.setting_key = d.key
  where d.key = 'security.failed_login_retention_days';
  delete from public.organization_failed_login_attempts
  where organization_id = org_id
    and occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => coalesce(retention_days, 90));
  return inserted_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Triggers: staff role gain disables the PIN; counters go with the PIN
-- ---------------------------------------------------------------------------

create function private.member_pin_revoke_for_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[new.user_id], array[]::uuid[]);
  -- A revoked platform grant (revoked_at set) is not a staff role.
  if (pg_catalog.to_jsonb(new) ->> 'revoked_at') is not null then
    return null;
  end if;
  delete from private.member_pin_credentials where user_id = new.user_id;
  if found then
    insert into private.member_pin_audit (subject_hash, action)
    values (private.member_lifecycle_subject_hash(new.user_id), 'pin_disabled_staff_role');
    perform private.notify_member(new.user_id, 'security.member_pin_disabled', '{}'::jsonb, 'general');
  end if;
  -- D5-3: a staff role never rides on a PIN session. Every live PIN session
  -- of the account ends now, so no staff-capable action is reachable from it.
  -- Checked first so an ordinary grant never takes the exclusive Auth
  -- bookkeeping lock.
  if exists (select 1 from private.member_pin_sessions m where m.user_id = new.user_id) then
    perform private.member_pin_end_sessions(new.user_id, null);
  end if;
  return null;
end;
$function$;

create trigger member_pin_revoke_for_staff after insert on public.organization_role_grants
for each row execute function private.member_pin_revoke_for_staff();
create trigger member_pin_revoke_for_staff after insert on public.member_roles
for each row execute function private.member_pin_revoke_for_staff();
create trigger member_pin_revoke_for_staff after insert on public.member_role_chapters
for each row execute function private.member_pin_revoke_for_staff();
create trigger member_pin_revoke_for_staff after insert or update of revoked_at on private.platform_operators
for each row execute function private.member_pin_revoke_for_staff();
create trigger member_pin_revoke_for_staff after insert or update of revoked_at on private.compass_platform_operators
for each row execute function private.member_pin_revoke_for_staff();
create trigger member_pin_revoke_for_staff after insert on private.learning_platform_editors
for each row execute function private.member_pin_revoke_for_staff();

create function private.member_pin_clear_attempt_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from private.member_pin_attempt_state where user_id = old.user_id;
  return null;
end;
$function$;

create trigger member_pin_clear_attempt_state after delete on private.member_pin_credentials
for each row execute function private.member_pin_clear_attempt_state();

-- ---------------------------------------------------------------------------
-- 8b. Restricted PIN sessions: the enforced surfaces (D5-3)
-- ---------------------------------------------------------------------------

-- Reads and direct writes. A restrictive policy narrows every other policy on
-- the table, so a restricted session reads no rows and writes none. The table
-- set is what the old app hid from PIN sessions: cases and their updates,
-- files, contacts and outcomes; conversations and messages with stewards and
-- everything hanging off them; steward requests; forms, their files and
-- co-signers; intake reports; and accommodation requests.
create policy member_pin_step_up on public.member_cases as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_case_updates as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_case_files as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_case_contacts as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_case_outcomes as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_conversations as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_messages as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_scheduled_messages as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_message_reminders as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_message_resources as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_steward_requests as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_forms as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_form_files as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_form_cosigners as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_intake_reports as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_accommodation_requests as restrictive for all to authenticated
  using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));

comment on policy member_pin_step_up on public.member_cases is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_case_updates is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_case_files is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_case_contacts is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_case_outcomes is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_conversations is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_messages is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_scheduled_messages is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_message_reminders is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_message_resources is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_steward_requests is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_forms is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_form_files is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_form_cosigners is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_intake_reports is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';
comment on policy member_pin_step_up on public.member_accommodation_requests is
  'A restricted PIN session (private.member_pin_sessions, switch features.security.member_pin_restricted_sessions) admits nothing here, read or write, until the member signs in with a password or passkey. Every other session is narrowed by its own policies only.';

-- The private case and form file buckets. Their storage.objects read policies
-- ask these two definer predicates, which now refuse a restricted session.
-- (Not a new storage.objects policy: the postgres migration role cannot
-- COMMENT ON POLICY there, so the rationale convention could not be met.)
-- Re-emitted from 20260917103000 and 20260812190000 with one added term each.
create or replace function private.can_read_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select not private.member_pin_session_restricted() and exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and f.confirmed_at is not null
      and f.removal_requested_at is null
      and (f.user_id = (select auth.uid())
        or (public.staff_can_see_user(f.user_id, 'coordinator')
          and private.member_case_restriction_cleared(f.case_id)))
  );
$function$;

create or replace function private.can_read_member_form_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select not private.member_pin_session_restricted() and exists (
    select 1 from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.bucket_id = p_bucket and ff.object_name = p_name
      and ff.confirmed_at is not null
      and (f.user_id = (select auth.uid())
        or (f.status in ('submitted', 'in_review', 'approved')
          and public.member_has_role(array['steward'])
          and public.staff_can_see_user(f.user_id, 'steward')))
  );
$function$;

-- Definer writes. SECURITY DEFINER RPCs (send_member_message,
-- create_member_case, submit_form, ...) bypass RLS, so the same tables refuse
-- a restricted caller's statement outright. Jobs and service-role writes carry
-- no member session and pass.
create function private.member_pin_step_up_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();
  return null;
end;
$function$;

create trigger member_pin_step_up before insert or update or delete on public.member_cases
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_case_updates
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_case_files
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_case_contacts
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_case_outcomes
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_conversations
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_messages
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_scheduled_messages
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_message_reminders
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_message_resources
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_steward_requests
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_forms
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_form_files
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_form_cosigners
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_intake_reports
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_accommodation_requests
for each statement execute function private.member_pin_step_up_statement();

-- Account security that GoTrue changes directly (PUT /auth/v1/user, the
-- factor and identity endpoints). GoTrue sets no request JWT in the database,
-- so these deferred checks run at its COMMIT and ask whether the account has a
-- live restricted PIN session:
--   * password: GoTrue signs out every OTHER session in the same transaction
--     as a password change, so at commit a live PIN session means the change
--     came from it. An admin reissue signs out all sessions and passes.
--   * a pending email or phone change, and a linked or unlinked sign-in
--     provider (app_metadata.providers): refused while any PIN session is
--     live, whichever session asked. Settings offers "End PIN sessions"
--     (public.end_my_member_pin_sessions) for a member on a full session.
create function private.member_pin_account_change_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if private.member_pin_live_restricted_session_exists(new.id) then
    raise exception 'step-up required'
      using errcode = '42501', hint = 'Sign in with your password or passkey to change account security.';
  end if;
  return null;
end;
$function$;

create constraint trigger member_pin_account_change_guard
after update of encrypted_password, email_change, phone_change, raw_app_meta_data on auth.users
deferrable initially deferred
for each row
when (
  new.encrypted_password is distinct from old.encrypted_password
  or (coalesce(new.email_change, '') <> '' and new.email_change is distinct from old.email_change)
  or (coalesce(new.phone_change, '') <> '' and new.phone_change is distinct from old.phone_change)
  or (new.raw_app_meta_data -> 'providers') is distinct from (old.raw_app_meta_data -> 'providers')
)
execute function private.member_pin_account_change_guard();

-- MFA: verifying a factor raises the CALLING session to aal2 in the same
-- GoTrue transaction, so a marked session at aal2 at commit is exactly a PIN
-- session that tried to add a second factor. A member verifying a factor from
-- a full session passes even while a PIN session is live elsewhere; that PIN
-- session then fails private.mfa_satisfied() because the account has a TOTP.
create function private.member_pin_mfa_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from private.member_pin_sessions m
    join auth.sessions s on s.id = m.session_id and s.user_id = m.user_id
    where m.user_id = new.user_id
      and s.aal::text = 'aal2'
  ) and private.member_pin_restriction_applies(new.user_id) then
    raise exception 'step-up required'
      using errcode = '42501', hint = 'Sign in with your password or passkey to add a second factor.';
  end if;
  return null;
end;
$function$;

create constraint trigger member_pin_mfa_guard
after insert or update on auth.mfa_factors
deferrable initially deferred
for each row
when (new.status::text = 'verified')
execute function private.member_pin_mfa_guard();

-- Definer reads re-emitted from their installed definitions with one added
-- line each: the personal data export (20260922210600) and the device list
-- (20260812125000). Bodies are otherwise verbatim.
create or replace function public.get_member_data_export()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  exported jsonb;
  peer_contact jsonb;
  additional jsonb;
  safe_workload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- D5-3: the personal data export needs a password or passkey sign-in.
  perform private.member_pin_require_full_session();

  -- This private implementation performs the single lifecycle audit write.
  exported := private.member_data_export_without_peer_contact();

  select pg_catalog.jsonb_build_object(
    'requests', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', request.id,
        'direction', case when request.requester_id = caller then 'sent' else 'received' end,
        'chapterId', request.chapter_id,
        'status', request.status,
        'createdAt', request.created_at,
        'respondedAt', request.responded_at,
        'expiresAt', request.expires_at
      ) order by request.created_at, request.id)
      from (
        select r.id, r.requester_id, r.chapter_id, r.status,
          r.created_at, r.responded_at, r.expires_at
        from public.member_peer_contact_requests r
        where r.requester_id = caller or r.recipient_id = caller
        order by r.created_at desc, r.id desc
        limit 100
      ) request
    ), '[]'::jsonb),
    'conversations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', conversation.id,
        'chapterId', conversation.chapter_id,
        'createdAt', conversation.created_at,
        'updatedAt', conversation.updated_at,
        'messages', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', message.id,
            'sentByMe', message.sender_id = caller,
            'body', message.body,
            'readAt', message.read_at,
            'createdAt', message.created_at
          ) order by message.created_at, message.id)
          from (
            select m.id, m.sender_id, m.body, m.read_at, m.created_at
            from public.member_peer_messages m
            where m.conversation_id = conversation.id
            order by m.created_at desc, m.id desc
            limit 100
          ) message
        ), '[]'::jsonb)
      ) order by conversation.created_at, conversation.id)
      from (
        select c.id, c.chapter_id, c.created_at, c.updated_at
        from public.member_peer_conversations c
        where c.user_low = caller or c.user_high = caller
        order by c.updated_at desc, c.id desc
        limit 20
      ) conversation
    ), '[]'::jsonb)
  ) into peer_contact;

  additional := private.account_lifecycle_export_additional_domains(caller);
  additional := additional || pg_catalog.jsonb_build_object(
    'member_case_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'caseId', file.case_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'createdAt', file.created_at
      ) order by file.created_at, file.id)
      from public.member_case_files file
      where file.user_id = caller
    ), '[]'::jsonb),
    'member_form_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'formId', file.form_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'confirmedAt', file.confirmed_at,
        'createdAt', file.created_at,
        'deletionRequestedAt', file.deletion_requested_at
      ) order by file.created_at, file.id)
      from public.member_form_files file
      where file.uploaded_by = caller
        and exists (
          select 1 from public.member_forms form
          where form.id = file.form_id and form.user_id = caller
        )
    ), '[]'::jsonb),
    'chapter_task_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'taskId', file.task_id,
        'chapterId', file.chapter_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'createdAt', file.created_at
      ) order by file.created_at, file.id)
      from public.chapter_task_files file
      where file.uploaded_by = caller
    ), '[]'::jsonb),
    'member_qa_questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', question.id,
        'organizationId', question.organization_id,
        'chapterId', question.chapter_id,
        'title', question.title,
        'body', question.body,
        'status', question.status,
        'acceptedReplyId', question.accepted_reply_id,
        'upvoteCount', question.upvote_count,
        'createdAt', question.created_at,
        'updatedAt', question.updated_at,
        'deletedAt', question.deleted_at
      ) order by question.created_at, question.id)
      from public.member_qa_questions question
      where question.author_user_id = caller
    ), '[]'::jsonb),
    'member_qa_replies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', reply.id,
        'organizationId', reply.organization_id,
        'questionId', reply.question_id,
        'kind', reply.kind,
        'body', reply.body,
        'accepted', reply.accepted,
        'upvoteCount', reply.upvote_count,
        'createdAt', reply.created_at,
        'updatedAt', reply.updated_at,
        'deletedAt', reply.deleted_at
      ) order by reply.created_at, reply.id)
      from public.member_qa_replies reply
      where reply.author_user_id = caller
    ), '[]'::jsonb),
    'member_scheduled_messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', message.id,
        'conversationId', message.conversation_id,
        'senderKind', message.sender_kind,
        'body', message.body,
        'scheduledFor', message.scheduled_for,
        'status', message.status,
        'sentMessageId', message.sent_message_id,
        'createdAt', message.created_at,
        'dispatchedAt', message.dispatched_at
      ) order by message.created_at, message.id)
      from public.member_scheduled_messages message
      where message.actor_id = caller
    ), '[]'::jsonb),
    'meeting_attendance', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', attendance.record_id,
        'chapterId', attendance.chapter_id,
        'attendanceStatus', attendance.attendance_status,
        'recordedAt', attendance.recorded_at
      ) order by attendance.recorded_at, attendance.record_id)
      from public.meeting_attendance attendance
      where attendance.user_id = caller
    ), '[]'::jsonb),
    'meeting_minutes_dispatches', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', dispatch.id,
        'recordId', dispatch.record_id,
        'chapterId', dispatch.chapter_id,
        'version', dispatch.version,
        'channel', dispatch.channel,
        'status', dispatch.status,
        'deliveredAt', dispatch.delivered_at,
        'createdAt', dispatch.created_at
      ) order by dispatch.created_at, dispatch.id)
      from public.meeting_minutes_dispatches dispatch
      where dispatch.recipient_id = caller
    ), '[]'::jsonb)
  );

  -- The original v1 exporter used `to_jsonb(w) - 'user_id'` for workload
  -- rows. Replace that whole-row shape before anything leaves this wrapper so
  -- the canonical v1 domain is an explicit reviewed projection too.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', workload.id,
    'priority', workload.priority,
    'pending', workload.pending,
    'unreadDocs', workload.unread_docs,
    'todos', workload.todos,
    'referrals', workload.referrals,
    'ceActivities', workload.ce_activities,
    'assistanceRequests', workload.assistance_requests,
    'agedCases', workload.aged_cases,
    'weeklyAssigned', workload.weekly_assigned,
    'employment', workload.employment,
    'partTimeHours', workload.pt_hours,
    'onPlan', workload.on_plan,
    'overtimeWorked', workload.ot_worked,
    'overtimeHours', workload.ot_hours,
    'leaveType', workload.leave_type,
    'leaveTiming', workload.leave_timing,
    'noIntake', workload.no_intake,
    'halfDay', workload.half_day,
    'note', workload.note,
    'subDetails', workload.sub_details,
    'receiptCode', workload.receipt_code,
    'loggedOn', workload.logged_on,
    'createdAt', workload.created_at
  ) order by workload.created_at, workload.id), '[]'::jsonb)
    into safe_workload
    from public.member_workload_logs workload
   where workload.user_id = caller;

  -- No peer id, profile label, email/address, share code, or digest is added.
  -- Direction is expressed only relative to the authenticated caller.
  exported := pg_catalog.jsonb_set(exported, '{activity,workload}', safe_workload, true);
  exported := pg_catalog.jsonb_set(exported, '{peerContact}', peer_contact, true);
  return exported || pg_catalog.jsonb_build_object('additionalDomains', additional,
    'civic', private.civic_member_export(caller));
end;
$function$;

create or replace function public.list_my_sessions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  -- D5-3: the device list (and with it every revoke handle) is a security
  -- setting; a restricted PIN session does not see it.
  perform private.member_pin_require_full_session();
  current_session := private.current_member_session_id();

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'handle', private.member_session_handle(s.id),
    'deviceLabel', case
      when coalesce(s.user_agent, '') ~* 'iphone|ipad|ipod' then 'apple_mobile'
      when coalesce(s.user_agent, '') ~* 'android' then 'android_mobile'
      when coalesce(s.user_agent, '') ~* 'windows' then 'windows_computer'
      when coalesce(s.user_agent, '') ~* 'macintosh|mac os' then 'apple_computer'
      when coalesce(s.user_agent, '') ~* 'linux' then 'linux_computer'
      else 'signed_in_device'
    end,
    'browserLabel', case
      when coalesce(s.user_agent, '') ~* 'edg/' then 'edge'
      when coalesce(s.user_agent, '') ~* 'firefox/' then 'firefox'
      when coalesce(s.user_agent, '') ~* 'chrome/|crios/' then 'chrome'
      when coalesce(s.user_agent, '') ~* 'safari/' then 'safari'
      else 'browser'
    end,
    'current', s.id = current_session,
    'createdAt', s.created_at,
    'lastActiveAt', coalesce(s.updated_at, s.created_at)
  ) order by (s.id = current_session) desc, coalesce(s.updated_at, s.created_at) desc), '[]'::jsonb)
  into payload
  from auth.sessions s
  where s.user_id = caller
    and (s.not_after is null or s.not_after > pg_catalog.now())
    and coalesce(s.updated_at, s.created_at) > pg_catalog.now() - interval '8 hours';

  return payload;
end;
$function$;

-- The official filing copy route (api/form-filing.js) asks this before it
-- renders an approved form; a restricted session gets the route's flat 404.
-- Re-emitted from 20260812190000 with one added term.
create or replace function public.can_access_form_filing(p_form_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null and private.mfa_satisfied()
    and not private.member_pin_session_restricted()
    and exists (
      select 1 from public.member_forms f
      where f.id = p_form_id and f.status = 'approved'
        and (f.user_id = (select auth.uid())
          or (public.member_has_role(array['steward'])
            and public.staff_can_see_user(f.user_id, 'steward')))
    );
$function$;

-- The calendar feed token is a long-lived bearer capability (rotate/revoke
-- through definer RPCs whose source shapes are pinned); its table refuses a
-- restricted caller's statement like the tables above. Account deletion needs
-- no new rule: authorize_member_account_deletion already demands an aal2
-- session with a TOTP or passkey claim, which a PIN session never has.
create trigger member_pin_step_up before insert or update or delete on public.member_calendar_feed_tokens
for each statement execute function private.member_pin_step_up_statement();

-- Passkeys (GoTrue /passkeys/registration): a passkey sign-in is a full
-- session, so a restricted session must not add one. Not attributable to a
-- session, so refused while any PIN session of the account is live.
create function private.member_pin_passkey_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if private.member_pin_live_restricted_session_exists(new.user_id) then
    raise exception 'step-up required'
      using errcode = '42501', hint = 'Sign in with your password or passkey to add a passkey.';
  end if;
  return null;
end;
$function$;

create constraint trigger member_pin_passkey_guard
after insert on auth.webauthn_credentials
deferrable initially deferred
for each row
execute function private.member_pin_passkey_guard();

-- What the member apps read to show the step-up prompt instead of a silent
-- empty screen. Self-only; names no other session.
create function public.get_my_session_restriction()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'restricted', private.member_pin_session_restricted(),
    'pinSession', exists (
      select 1 from private.member_pin_sessions s
      where s.session_id = private.member_pin_jwt_session_id() and s.user_id = caller
    )
  );
end;
$function$;

-- After a step-up, and from Settings: end every session signed in with this
-- account's PIN. Full sessions only.
create function public.end_my_member_pin_sessions()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.member_pin_require_full_session();
  if exists (select 1 from private.member_pin_sessions m where m.user_id = (select auth.uid())) then
    perform private.member_pin_end_sessions((select auth.uid()), null);
  end if;
  return pg_catalog.jsonb_build_object('ended', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Notification copy (rendered by private.notify_member; no PIN, no detail)
-- ---------------------------------------------------------------------------

insert into private.notification_copy (key, lang, title, body) values
  ('security.member_pin_set', 'en', 'A sign-in PIN was added to your account',
   'If you did not do this, remove the PIN in Settings and change your password.'),
  ('security.member_pin_set', 'es', 'Se agregó un PIN de inicio de sesión a tu cuenta',
   'Si no fuiste tú, elimina el PIN en Configuración y cambia tu contraseña.'),
  ('security.member_pin_changed', 'en', 'Your sign-in PIN was changed',
   'If you did not do this, remove the PIN in Settings and change your password.'),
  ('security.member_pin_changed', 'es', 'Se cambió tu PIN de inicio de sesión',
   'Si no fuiste tú, elimina el PIN en Configuración y cambia tu contraseña.'),
  ('security.member_pin_removed', 'en', 'Your sign-in PIN was removed',
   'You can no longer sign in with a PIN. You can set a new one in Settings.'),
  ('security.member_pin_removed', 'es', 'Se eliminó tu PIN de inicio de sesión',
   'Ya no puedes iniciar sesión con un PIN. Puedes crear uno nuevo en Configuración.'),
  ('security.member_pin_disabled', 'en', 'PIN sign-in was turned off for your account',
   'Accounts with a staff role sign in with a password or passkey. Your PIN was deleted.'),
  ('security.member_pin_disabled', 'es', 'Se desactivó el inicio de sesión con PIN para tu cuenta',
   'Las cuentas con un rol de personal inician sesión con contraseña o llave de acceso. Se eliminó tu PIN.')
on conflict (key, lang) do nothing;

-- ---------------------------------------------------------------------------
-- 10. Grants (exact)
-- ---------------------------------------------------------------------------

revoke all on function private.member_pin_format_issue(text) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_format_issue_run(text) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_matches_phone(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_recent_authentication() from public, anon, authenticated, service_role;
revoke all on function private.member_pin_ineligibility(uuid) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_lockout_policy(uuid) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_attempt_open(uuid) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_attempt_close(uuid, boolean, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_revoke_for_staff() from public, anon, authenticated, service_role;
revoke all on function private.member_pin_clear_attempt_state() from public, anon, authenticated, service_role;
revoke all on function public.get_my_member_pin_status() from public, anon, authenticated, service_role;
revoke all on function public.set_my_member_pin(text) from public, anon, authenticated, service_role;
revoke all on function public.remove_my_member_pin() from public, anon, authenticated, service_role;
revoke all on function public.member_pin_signin_offered() from public, anon, authenticated, service_role;
revoke all on function public.verify_member_pin_signin(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.record_member_pin_failure(text, text, text) from public, anon, authenticated, service_role;

revoke all on function private.member_pin_jwt_session_id() from public, anon, authenticated, service_role;
revoke all on function private.member_pin_restriction_applies(uuid) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_session_restricted() from public, anon, authenticated, service_role;
revoke all on function private.member_pin_require_full_session() from public, anon, authenticated, service_role;
revoke all on function private.member_pin_live_restricted_session_exists(uuid) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_end_sessions(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_session_markable(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_prune_sessions(uuid) from public, anon, authenticated, service_role;
revoke all on function private.member_pin_step_up_statement() from public, anon, authenticated, service_role;
revoke all on function private.member_pin_account_change_guard() from public, anon, authenticated, service_role;
revoke all on function private.member_pin_mfa_guard() from public, anon, authenticated, service_role;
revoke all on function private.member_pin_passkey_guard() from public, anon, authenticated, service_role;
revoke all on function public.mark_member_pin_session(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_session_restriction() from public, anon, authenticated, service_role;
revoke all on function public.end_my_member_pin_sessions() from public, anon, authenticated, service_role;

-- RLS policies evaluate the predicate as the querying role, exactly like
-- private.mfa_satisfied(). It answers only for the caller's own session.
grant execute on function private.member_pin_session_restricted() to authenticated;
grant execute on function public.get_my_member_pin_status() to authenticated;
grant execute on function public.set_my_member_pin(text) to authenticated;
grant execute on function public.remove_my_member_pin() to authenticated;
grant execute on function public.member_pin_signin_offered() to service_role;
grant execute on function public.verify_member_pin_signin(text, text, text) to service_role;
grant execute on function public.record_member_pin_failure(text, text, text) to service_role;
grant execute on function public.mark_member_pin_session(uuid, uuid) to service_role;
grant execute on function public.get_my_session_restriction() to authenticated;
grant execute on function public.end_my_member_pin_sessions() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Account-lifecycle trigger review for the new triggers and functions
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (
    s.kind = 'trigger'
    and s.object_name in ('a00_case_graph_lock', 'z99_case_graph_keys', 'member_pin_clear_attempt_state')
    and s.schema_name = 'private' and s.table_name = 'member_pin_credentials'
  ) or (
    s.kind = 'trigger' and s.object_name in (
      'member_pin_revoke_for_staff', 'member_pin_step_up',
      'member_pin_account_change_guard', 'member_pin_mfa_guard', 'member_pin_passkey_guard')
  ) or (
    -- The staff-role trigger makes the lifecycle subject-hash helper reachable
    -- from a trigger for the first time; review it with the new functions.
    s.kind = 'function' and s.schema_name = 'private'
    and (s.object_name like 'member\_pin\_%' or s.object_name = 'member_lifecycle_subject_hash(p_user_id uuid)')
  ) or (
    -- The restricted-session triggers (section 8b) read the organization
    -- switch, which makes the settings registry's read helpers reachable from
    -- a trigger for the first time.
    s.kind = 'function' and s.schema_name = 'private'
    and s.object_name in (
      'organization_feature_enabled(p_organization_id uuid, p_key text)',
      'organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)')
  )
on conflict do nothing;

do $assert_member_pin_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after member PIN sign-in';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after member PIN sign-in';
  end if;
end
$assert_member_pin_trigger_review$;

-- T2c adversarial review: re-declare the newest member-accessible definer
-- readers, including the tenant-scoped Home hotfix. The outer block refuses a
-- restricted session before even evaluated declarations or content reads.

-- Newest source: 20261002135600_restore_review_hotfixes.sql
create or replace function public.get_member_home_takeover()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  org uuid;
  joined_at timestamptz;
  message_item jsonb;
  broadcast_item jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  if org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  if not private.organization_feature_enabled(org, 'features.home.unread_message_takeover') then
    return pg_catalog.jsonb_build_object('enabled', false, 'message', null, 'broadcast', null);
  end if;

  -- Newest unread steward direct message to the caller in a conversation of
  -- the selected organization (member_conversations.organization_id, stamped
  -- at creation). A conversation without an organization never matches.
  -- Bounded preview: the full thread opens in Messages.
  select pg_catalog.jsonb_build_object(
      'id', m.id,
      'conversationId', m.conversation_id,
      'senderName', m.sender_name,
      'body', pg_catalog.left(m.body, 600),
      'truncated', pg_catalog.char_length(m.body) > 600,
      'createdAt', m.created_at
    )
  into message_item
  from public.member_messages m
  join public.member_conversations c on c.id = m.conversation_id and c.user_id = caller
  where m.user_id = caller
    and c.organization_id = org
    and m.sender_kind = 'steward'
    and m.sender_id is distinct from caller
    and m.read_at is null
    and m.redacted_at is null
  order by m.created_at desc, m.id desc
  limit 1;

  select membership.created_at into joined_at
  from public.organization_memberships membership
  where membership.organization_id = org
    and membership.user_id = caller
    and membership.status = 'active';

  -- Newest unread broadcast the caller can see, published since they joined.
  select pg_catalog.jsonb_build_object(
      'id', b.id,
      'sender', b.sender,
      'title', b.title,
      'body', pg_catalog.left(b.body, 600),
      'truncated', pg_catalog.char_length(b.body) > 600,
      'publishedAt', b.published_at,
      'audience', b.audience_scope
    )
  into broadcast_item
  from public.member_broadcasts b
  where b.id in (select private.visible_member_broadcast_ids())
    and b.organization_id = org
    and b.retracted_at is null
    and b.published_at <= pg_catalog.now()
    and (joined_at is null or b.published_at >= joined_at)
    and not exists (
      select 1 from public.member_broadcast_receipts r
      where r.broadcast_id = b.id and r.user_id = caller
    )
  order by b.published_at desc, b.id desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'message', message_item,
    'broadcast', broadcast_item
  );
end;

end;
$function$;

-- Newest source: 20260907140000_native_message_actions.sql
create or replace function public.get_member_message_actions(p_source_kind text, p_message_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.member_pin_require_full_session();

begin
  perform private.lock_message_lifecycle();
  declare caller uuid := (select auth.uid()); message public.member_messages%rowtype; editable boolean := false;
  begin
    if caller is null or private.mfa_satisfied() is not true
       or p_source_kind is null or p_source_kind not in ('private', 'channel')
       or private.can_read_message_source(caller, p_source_kind,
         case when p_source_kind = 'private' then p_message_id end,
         case when p_source_kind = 'channel' then p_message_id end, null) is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if p_source_kind = 'private' then
      select * into message from public.member_messages where id = p_message_id;
      editable := message.sender_id = caller and message.redacted_at is null
        and message.created_at > pg_catalog.clock_timestamp() - interval '15 minutes'
        and private.member_message_under_legal_hold(message.conversation_id) is false
        and not exists (select 1 from public.member_messages later
          where later.conversation_id = message.conversation_id
            and (later.created_at, later.id) > (message.created_at, message.id));
    end if;
    return pg_catalog.jsonb_build_object(
      'canEdit', coalesce(editable, false),
      'saved', exists (select 1 from public.member_saved_messages s where s.owner_id = caller
        and s.source_kind = p_source_kind and coalesce(s.private_message_id, s.channel_post_id) = p_message_id),
      'reminders', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', r.id, 'remindAt', r.remind_at) order by r.remind_at, r.id)
        from public.member_message_reminders r where r.owner_id = caller and r.status = 'pending'
          and r.source_kind = p_source_kind and coalesce(r.private_message_id, r.channel_post_id) = p_message_id), '[]'::jsonb),
      'reactions', coalesce((select pg_catalog.jsonb_agg(r.reaction order by r.reaction)
        from public.member_message_reactions r where r.actor_id = caller and r.source_kind = p_source_kind
          and coalesce(r.private_message_id, r.channel_post_id) = p_message_id), '[]'::jsonb));
  end;
end;

end;
$function$;

-- Newest source: 20260907141000_message_reply_navigation.sql
create or replace function public.get_member_message_replies(p_source_kind text, p_parent_id uuid, p_target_id uuid,
  p_after_at timestamptz default null, p_after_id uuid default null, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.member_pin_require_full_session();

declare caller uuid := (select auth.uid()); parent jsonb; page jsonb; total bigint; target uuid;
begin
  perform private.lock_message_lifecycle();
  if caller is null or private.mfa_satisfied() is not true
     or p_source_kind is null or p_source_kind not in ('private', 'channel')
     or p_target_id is null or p_limit is null or p_limit not between 1 and 100
     or (p_after_at is null) is distinct from (p_after_id is null)
     or private.can_read_message_source(caller, p_source_kind,
       case when p_source_kind = 'private' then p_parent_id end,
       case when p_source_kind = 'channel' then p_parent_id end, null) is not true then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  if p_source_kind = 'private' then
    select m.conversation_id into target from public.member_messages m where m.id = p_parent_id;
  else
    select t.space_id into target from public.chapter_thread_posts p
      join public.chapter_threads t on t.id = p.thread_id where p.id = p_parent_id;
  end if;
  if target is distinct from p_target_id then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  if p_source_kind = 'private' then
    select pg_catalog.jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
      'author_name', m.sender_name, 'parent_id', m.parent_message_id, 'edited_at', m.edited_at,
      'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason)
      into parent from public.member_messages m where m.id = p_parent_id;
    select coalesce(pg_catalog.jsonb_agg(row.value order by row.created_at, row.id), '[]'::jsonb) into page from (
      select m.id, m.created_at, pg_catalog.jsonb_build_object('id', m.id, 'body', m.body,
        'created_at', m.created_at, 'author_name', m.sender_name, 'parent_id', m.parent_message_id,
        'edited_at', m.edited_at, 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) value
      from public.member_messages m where m.parent_message_id = p_parent_id and m.conversation_id = target
        and (p_after_at is null or (m.created_at, m.id) > (p_after_at, p_after_id))
      order by m.created_at, m.id limit p_limit + 1
    ) row;
  else
    select pg_catalog.jsonb_build_object('id', p.id, 'body', p.body, 'created_at', p.created_at,
      'author_name', p.author_name, 'parent_id', p.parent_post_id)
      into parent from public.chapter_thread_posts p where p.id = p_parent_id;
    select coalesce(pg_catalog.jsonb_agg(row.value order by row.created_at, row.id), '[]'::jsonb) into page from (
      select p.id, p.created_at, pg_catalog.jsonb_build_object('id', p.id, 'body', p.body,
        'created_at', p.created_at, 'author_name', p.author_name, 'parent_id', p.parent_post_id) value
      from public.chapter_thread_posts p join public.chapter_thread_posts root on root.id = p_parent_id
      where p.parent_post_id = root.id and p.thread_id = root.thread_id and p.deleted_at is null
        and (p_after_at is null or (p.created_at, p.id) > (p_after_at, p_after_id))
      order by p.created_at, p.id limit p_limit + 1
    ) row;
  end if;
  total := (public.get_member_message_reply_counts(p_source_kind, array[p_parent_id])->>p_parent_id::text)::bigint;
  return pg_catalog.jsonb_build_object('parent', parent, 'replies',
    case when pg_catalog.jsonb_array_length(page) > p_limit then page - p_limit else page end,
    'count', total, 'hasMore', pg_catalog.jsonb_array_length(page) > p_limit);
end;

end;
$function$;

-- Newest source: 20260907141000_message_reply_navigation.sql
create or replace function public.get_member_message_reply_counts(p_source_kind text, p_message_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.member_pin_require_full_session();

declare caller uuid := (select auth.uid()); message_id uuid; result jsonb := '{}'::jsonb; total bigint;
begin
  perform private.lock_message_lifecycle();
  if caller is null or private.mfa_satisfied() is not true
     or p_source_kind is null or p_source_kind not in ('private', 'channel')
     or p_message_ids is null or pg_catalog.cardinality(p_message_ids) > 200 then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  foreach message_id in array p_message_ids loop
    if private.can_read_message_source(caller, p_source_kind,
        case when p_source_kind = 'private' then message_id end,
        case when p_source_kind = 'channel' then message_id end, null) is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if p_source_kind = 'private' then
      select count(*) into total from public.member_messages m
      join public.member_messages parent on parent.id = message_id
      where m.parent_message_id = parent.id and m.conversation_id = parent.conversation_id;
    else
      select count(*) into total from public.chapter_thread_posts p
      join public.chapter_thread_posts parent on parent.id = message_id
      where p.parent_post_id = parent.id and p.thread_id = parent.thread_id and p.deleted_at is null;
    end if;
    result := result || pg_catalog.jsonb_build_object(message_id::text, total);
  end loop;
  return result;
end;

end;
$function$;

-- Newest source: 20260917102000_member_case_full_text_search.sql
create or replace function public.search_member_cases(p_query text, p_limit integer default 20)
returns table (
  case_id uuid,
  reference text,
  title text,
  case_type text,
  articles text,
  step text,
  status text,
  deadline date,
  updated_at timestamptz,
  rank real,
  headline text,
  headline_source text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
#variable_conflict use_column
begin
  perform private.member_pin_require_full_session();

declare
  v_query tsquery := pg_catalog.websearch_to_tsquery(
    'pg_catalog.english'::pg_catalog.regconfig, coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_actor uuid := (select auth.uid());
begin
  -- An anonymous caller and an empty or stop-word-only query are the same
  -- answer: nothing. Returning early keeps both off the indexes entirely.
  -- Both tests read the request's JWT and the argument, never the database, so
  -- deciding them before the statement below costs the boundary nothing.
  if v_actor is null or pg_catalog.numnode(v_query) = 0 then
    return;
  end if;

  return query
  -- Everything that depends only on the caller, resolved exactly once, in this
  -- statement's snapshot — the same snapshot the row reads below use, which is
  -- what RLS gives the policies. MATERIALIZED is load-bearing: a single-row CTE
  -- referenced once would be inlined and these helpers would run per row again.
  with actor_scope as materialized (
    select
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  -- The candidate list is what makes the two GIN indexes load-bearing, and it
  -- is not a micro-optimisation. `<case document> @@ v_query OR note.body is
  -- not null` sits above a LEFT JOIN LATERAL, so the planner cannot push the
  -- case-side predicate into the scan: driving straight off public.member_cases
  -- reads EVERY row of a table this deployment sizes at ~400k and runs the
  -- lateral once per row. Selecting the candidate ids through the indexes first
  -- and joining back on the primary key returns the same set: the union is a
  -- superset of the final predicate, and every row it adds is re-tested below.
  --
  -- The two expressions in this CTE are the two index expressions verbatim,
  -- down to the argument order and the weight letters, because an expression
  -- index only serves a query whose expression matches it. Changing one without
  -- the other silently returns this statement to a sequential scan;
  -- tests/member-case-search-db.test.js pins the equality and EXPLAINs the
  -- statement cut out of this file.
  --
  -- Which arm matched is carried forward instead of recomputed: `case_hit` IS
  -- `<case document> @@ v_query` for that row, so the WHERE clause below needs
  -- no second evaluation of a four-call tsvector expression, and `note_hit` is
  -- false exactly when no note on the case can match, which turns the note
  -- lateral into a one-time filter for those rows.
  candidate_hits as (
    select c.id as candidate_id, true as case_hit, false as note_hit
    from public.member_cases c
    where (
      pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C')
    ) @@ v_query
    union all
    select u.case_id as candidate_id, false as case_hit, true as note_hit
    from public.member_case_updates u
    where (
      pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, ''))
    ) @@ v_query
  ),
  candidates as (
    select
      candidate_id,
      pg_catalog.bool_or(case_hit) as case_hit,
      pg_catalog.bool_or(note_hit) as note_hit
    from candidate_hits
    group by candidate_id
  ),
  -- member_cases_select_coordinator, as a set. No function call per row: the
  -- staff scope is the chapter array resolved once above, the organization
  -- officer test is a column comparison against the one organization
  -- private.has_organization_role can accept, and the access grant is an array
  -- membership test. A caller with no coordinator scope produces this set
  -- without reading public.member_profiles at all.
  --
  -- Every actor_scope value below is read through a scalar subquery rather
  -- than a join to the CTE, here and in the `visible` CTE and the note
  -- lateral. That is deliberate and load-bearing: an uncorrelated scalar
  -- subquery becomes an InitPlan the executor runs once, so each scope value
  -- reaches the row predicates as a constant. Joining actor_scope in instead
  -- makes those values ordinary columns, and the planner is then free to drive
  -- this join from public.member_profiles and re-derive the whole set per outer
  -- row: measured at 48,006 primary-key lookups over an 8,001-candidate
  -- corpus, and unbounded on a deployment where the caller's chapter scope
  -- holds thousands of members. The same rewrite turned the note lateral's
  -- author lookup from a rescan of public.member_profiles per note into one
  -- hashed probe for the statement.
  --
  -- `offset 0` is the optimisation fence explained above the same construct in
  -- the `visible` CTE below: it keeps the candidate list the driving relation
  -- so this CTE reads one case row per candidate and never scans the table.
  staff_visible as (
    select k.candidate_id
    from candidates k
    cross join lateral (
      select row_case.user_id, row_case.is_restricted, row_case.coordinator_user_id,
             row_case.organization_id, row_case.id
      from public.member_cases row_case
      where row_case.id = k.candidate_id
      offset 0
    ) c
    join public.member_profiles case_owner on case_owner.id = c.user_id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted
        or c.coordinator_user_id = v_actor
        or (
          c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s)
        )
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ),
  -- The mirror itself: mfa_assurance ANDed over the three permissive SELECT
  -- policies, the first two as column tests and the third as a semijoin.
  visible as (
    select
      k.case_hit,
      k.note_hit,
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      c.user_id,
      c.steward_user_id
    from candidates k
    cross join lateral (
      select
        row_case.id,
        row_case.reference,
        row_case.title,
        row_case.case_type,
        row_case.articles,
        row_case.step,
        row_case.status,
        row_case.deadline,
        row_case.updated_at,
        row_case.user_id,
        row_case.steward_user_id
      from public.member_cases row_case
      where row_case.id = k.candidate_id
      -- `offset 0` is the standard PostgreSQL optimisation fence, and it is
      -- load-bearing rather than decorative. Without it the planner flattens
      -- this LATERAL back into an ordinary join, and because a GIN @@
      -- selectivity estimate over a CTE defaults to 200 rows it then prices a
      -- sequential scan of the whole case table plus a hash join below this
      -- primary-key lookup: measured at 79,999 rows removed by filter for a
      -- query with ONE candidate. The fence keeps the candidate list the
      -- driving relation, so the work is one primary-key probe per candidate
      -- and nothing in this function ever reads a case row the two GIN indexes
      -- did not name.
      offset 0
    ) c
    -- mfa_assurance
    where (select s.mfa_satisfied from actor_scope s)
      and (
        -- member_cases_select_own
        c.user_id = v_actor
        -- member_cases_select_steward
        or (c.steward_user_id = v_actor and (select s.steward_hat from actor_scope s))
        -- member_cases_select_coordinator
        or c.id in (select candidate_id from staff_visible)
      )
  ),
  scored as (
    select
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      note.body as note_body,
      pg_catalog.ts_rank(
        pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C'),
        v_query)
        + coalesce(note.note_rank, 0) * 0.5 as rank_value
    from visible c
    left join lateral (
      select
        n.body,
        pg_catalog.ts_rank(n.note_document, v_query) as note_rank
      from (
        select
          u.body,
          u.user_id,
          u.created_at,
          u.id,
          pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, '')) as note_document
        from public.member_case_updates u
        where c.note_hit
          and u.case_id = c.id
      ) n
      where n.note_document @@ v_query
        -- The exact disjunction of the three public.member_case_updates SELECT
        -- policies: _select_own (20260720191847), _select_steward (20260808210000)
        -- and _select_coordinator (20260723160000), with the steward hat and the
        -- coordinator staff scope read from actor_scope instead of called per
        -- note. A note the caller cannot read contributes neither the headline
        -- nor the match. The notes table's own restrictive mfa_assurance policy
        -- needs no repetition here: the `visible` CTE this lateral hangs off
        -- already refuses every row without step-up.
        and (
          (n.user_id = v_actor and c.user_id = v_actor)
          or ((select s.steward_hat from actor_scope s) and c.steward_user_id = v_actor)
          or (
            (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
            and exists (
              select 1
              from public.member_profiles note_author
              where note_author.id = n.user_id
                and note_author.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
            )
          )
        )
      order by note_rank desc, n.created_at desc, n.id
      limit 1
    ) note on true
    -- `case_hit` is the case-document match the candidate CTE already made.
    where c.case_hit or note.body is not null
  ),
  -- Rank and cut FIRST, then build the snippets. ts_headline is by far the most
  -- expensive expression in this function and a projection is evaluated before
  -- the sort, so leaving it in `scored` would have built one snippet per
  -- visible candidate instead of at most p_limit of them.
  ranked as (
    select r.*
    from scored r
    order by r.rank_value desc, r.updated_at desc, r.id
    limit v_limit
  )
  select
    r.id,
    r.reference,
    r.title,
    r.case_type,
    r.articles,
    r.step,
    r.status,
    r.deadline,
    r.updated_at,
    r.rank_value::real,
    pg_catalog.ts_headline(
      'pg_catalog.english'::pg_catalog.regconfig,
      case
        when r.note_body is not null then r.note_body
        when coalesce(r.articles, '') <> '' then r.articles
        else r.title
      end,
      v_query,
      'StartSel="[[",StopSel="]]",MaxFragments=1,MaxWords=28,MinWords=8,ShortWord=2'),
    case
      when r.note_body is not null then 'update'
      when coalesce(r.articles, '') <> '' then 'articles'
      else 'title'
    end
  from ranked r
  order by r.rank_value desc, r.updated_at desc, r.id;
end;

end;
$function$;

-- Newest source: 20261002141000_casework_retaliation_timing_detector.sql
create or replace function public.get_my_case_ulp_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', s.case_id,
      'ulpDeadline', case when s.enabled then s.ulp_deadline end,
      'retaliationFlagged', true,
      'stewardNotified', s.steward_notified,
      'ulpWarningDays', s.warning_days,
      'ulpCriticalDays', s.critical_days) order by s.ulp_deadline, s.case_id)
    from (
      select c.id as case_id,
        private.organization_feature_enabled(c.organization_id, 'features.casework.ulp_deadline') as enabled,
        coalesce(
          min(f.ulp_deadline) filter (where f.ulp_deadline >= current_date),
          max(f.ulp_deadline)) as ulp_deadline,
        bool_or(f.staff_notified_at is not null) as steward_notified,
        t.warning_days,
        t.critical_days
      from public.member_cases c
      join public.casework_retaliation_flags f on f.case_id = c.id and f.status in ('open', 'confirmed')
      cross join lateral private.casework_ulp_thresholds(c.organization_id) t
      where c.user_id = caller
      group by c.id, c.organization_id, t.warning_days, t.critical_days
    ) s
  ), '[]'::jsonb);
end;

end;
$function$;

-- Newest source: 20260906020000_private_upload_workflow_gates.sql
create or replace function public.get_form_filing_status(p_form_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  rec record;
  current_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into rec from public.member_forms f where f.id = p_form_id;
  if not found or not (public.form_is_owned_by_caller(p_form_id)
    or (rec.status in ('submitted', 'in_review', 'approved')
      and public.member_has_role(array['steward'])
      and public.staff_can_see_user(rec.user_id, 'steward'))) then
    raise exception 'form unavailable' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  return pg_catalog.jsonb_build_object(
    'formId', rec.id, 'status', rec.status,
    'filerSigned', exists (select 1 from private.member_form_signatures s
      where s.form_id = rec.id and s.signer_kind = 'filer'
        and s.signer_user_id = rec.user_id and s.content_digest = current_digest),
    'filerSignedAt', rec.filer_signed_at,
    'contentDigest', rec.content_digest,
    'artifactDigest', rec.artifact_digest,
    'artifactApprovedAt', rec.artifact_approved_at,
    'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ff.id, 'bucketId', ff.bucket_id, 'objectName', ff.object_name,
      'filename', ff.filename, 'mimeType', ff.mime_type,
      'sizeBytes', ff.size_bytes, 'confirmedAt', ff.confirmed_at,
      'scanCurrent', private.private_upload_is_current(ff.bucket_id, ff.object_name))
      order by ff.created_at, ff.id) from public.member_form_files ff
      where ff.form_id = rec.id), '[]'::jsonb));
end;
end;
$function$;

-- Newest source: 20260725190000_mfa_guard_cosign_rpcs.sql
create or replace function public.cosign_invite_preview(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  frec record;
  filer_name text;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): pre-accept disclosure of filer name + summary; the guard precedes every read.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select id, status into inv
    from public.member_form_cosigners
    where form_id = p_form_id
      and status in ('invited','reaffirm_needed','accepted')
      and (cosigner_user_id = caller or (caller_email <> '' and invited_email = caller_email))
    order by invited_at desc limit 1;
  if inv.id is null then
    raise exception 'no co-sign invitation for you on this form' using errcode='22023';
  end if;

  select user_id, template_key, answers into frec
    from public.member_forms where id = p_form_id;
  select full_name into filer_name from public.member_profiles where id = frec.user_id;

  return pg_catalog.jsonb_build_object(
    'formId', p_form_id,
    'template', frec.template_key,
    'inviteStatus', inv.status,
    'summary', pg_catalog.left(coalesce(frec.answers->>'summary',''), 500),
    'filerName', coalesce(nullif(pg_catalog.btrim(coalesce(filer_name,'')),''), 'A member')
  );
end;
end;
$function$;

-- Newest source: 20260924200000_member_support_chapterless_org_resolution.sql
create or replace function public.get_member_support_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

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
end;
end;
$function$;

-- Newest source: 20260924170200_member_steward_roster_and_contact.sql
create or replace function public.get_member_chapter_stewards()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  chapter_label text;
begin
  if caller is null or not private.mfa_satisfied()
     or private.current_member_organization() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;
  select c.name into chapter_label from public.chapters c where c.id = caller_chapter;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.steward_id,
      'name', profile.full_name,
      'roleLabel', 'steward',
      'chapterId', caller_chapter,
      'chapterLabel', chapter_label,
      'acceptsAppointments', exists (
        select 1 from public.member_appointment_schedules s
        where s.steward_id = e.steward_id and s.accepting
      ),
      'contact', pg_catalog.jsonb_build_object(
        'conversation', true,
        'email', case when coalesce(pref.share_email, false) then pref.contact_email end,
        'phone', case when coalesce(pref.share_phone, false) then pref.contact_phone end
      )
    ) order by profile.full_name, e.steward_id)
    from private.member_roster_stewards_for_chapter(caller_chapter) e
    left join public.member_profiles profile on profile.id = e.steward_id
    left join public.steward_contact_preferences pref on pref.steward_user_id = e.steward_id
  ), '[]'::jsonb);
end;

end;
$$;

-- Newest source: 20261002144000_recommended_nearest_steward.sql, repaired in c3b3f4b97a
create or replace function public.recommend_organization_coverage(
  p_chapter_id text,
  p_at timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  nearest boolean;
  chosen record;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.is_organization_member(organization)
    or not exists (
      select 1 from public.chapters c
      where c.id = p_chapter_id and c.organization_id = organization
    ) then
    raise exception 'chapter coverage unavailable' using errcode = '42501';
  end if;
  nearest := private.organization_feature_enabled(organization, 'features.casework.nearest_steward_matching');

  select r.id, (r.config ->> 'stewardUserId')::uuid as steward_user_id,
    'override'::text as source,
    case when nearest then private.steward_proximity_rank(organization, caller, (r.config ->> 'stewardUserId')::uuid) end as rank
  into chosen
  from public.organization_coordination_records r
  join private.member_roster_stewards_for_chapter(p_chapter_id) eligible
    on eligible.steward_id = (r.config ->> 'stewardUserId')::uuid
  where r.organization_id = organization and r.chapter_id = p_chapter_id
    and r.kind = 'coverage_override' and r.status = 'active'
    and coalesce((r.config ->> 'available')::boolean, true)
    and p_at >= (r.config ->> 'startsAt')::timestamptz
    and p_at < (r.config ->> 'endsAt')::timestamptz
  order by case when nearest then private.steward_proximity_rank(organization, caller, (r.config ->> 'stewardUserId')::uuid) end nulls last,
    r.updated_at desc, r.id desc limit 1;

  if not found then
    select r.id, (r.config ->> 'stewardUserId')::uuid as steward_user_id,
      'schedule'::text as source,
      case when nearest then private.steward_proximity_rank(organization, caller, (r.config ->> 'stewardUserId')::uuid) end as rank
    into chosen
    from public.organization_coordination_records r
    join private.member_roster_stewards_for_chapter(p_chapter_id) eligible
      on eligible.steward_id = (r.config ->> 'stewardUserId')::uuid
    cross join lateral (
      select p_at at time zone coalesce(nullif(r.config ->> 'timezone', ''), 'America/New_York') as local_at
    ) local_time
    where r.organization_id = organization and r.chapter_id = p_chapter_id
      and r.kind = 'coverage_schedule' and r.status = 'active'
      and extract(dow from local_time.local_at)::integer = (r.config ->> 'dayOfWeek')::integer
      and (extract(hour from local_time.local_at)::integer * 60
        + extract(minute from local_time.local_at)::integer)
        between (r.config ->> 'startMinute')::integer
          and ((r.config ->> 'endMinute')::integer - 1)
    order by coalesce((r.config ->> 'priority')::integer, 0) desc,
      case when nearest then private.steward_proximity_rank(organization, caller, (r.config ->> 'stewardUserId')::uuid) end nulls last,
      r.updated_at desc, r.id desc limit 1;
  end if;

  if chosen.steward_user_id is null and nearest then
    select null::uuid as id, e.steward_id as steward_user_id, 'nearest'::text as source,
      private.steward_proximity_rank(organization, caller, e.steward_id) as rank
    into chosen
    from private.member_roster_stewards_for_chapter(p_chapter_id) e
    where e.steward_id is distinct from caller
    order by private.steward_proximity_rank(organization, caller, e.steward_id), e.steward_id
    limit 1;
  end if;

  if chosen.steward_user_id is null then
    return pg_catalog.jsonb_build_object(
      'state', 'uncovered', 'chapterId', p_chapter_id,
      'recommendedUserId', null
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'state', case when chosen.source = 'nearest' then 'nearest' else 'covered' end,
    'chapterId', p_chapter_id,
    'recommendedUserId', chosen.steward_user_id,
    'source', chosen.source, 'recordId', chosen.id,
    'contactRoute', 'member_message',
    'matchLevel', case chosen.rank when 0 then 'work_location' when 1 then 'department' when 2 then 'chapter' end,
    -- Name and opted-in routes only for a chapter the caller belongs to, the
    -- same audience as the Find my steward roster.
    'steward', case when exists (
      select 1 from public.member_chapter_memberships cm
      where cm.user_id = caller and cm.chapter_id = p_chapter_id and cm.status = 'active'
    ) then (
      select pg_catalog.jsonb_build_object(
        'name', coalesce(profile.full_name, ''),
        'contact', pg_catalog.jsonb_build_object(
          'conversation', true,
          'email', case when coalesce(pref.share_email, false) then pref.contact_email end,
          'phone', case when coalesce(pref.share_phone, false) then pref.contact_phone end))
      from (select 1) one
      left join public.member_profiles profile on profile.id = chosen.steward_user_id
      left join public.steward_contact_preferences pref on pref.steward_user_id = chosen.steward_user_id
    ) end
  );
end;

end;
$function$;

-- Newest source: 20261001020000_connected_workflow_shortcuts.sql
create or replace function public.list_member_event_contact_messages(
  p_event_id text,
  p_participant_id uuid default null,
  p_cursor text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  src jsonb;
  ev public.member_events%rowtype;
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  cursor_json jsonb;
  cursor_at timestamptz;
  cursor_id uuid;
  organizer_side boolean := false;
  items jsonb := '[]'::jsonb;
  fetched integer := 0;
  next_cursor text := null;
  row_data record;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_cursor is not null then
    begin
      cursor_json := p_cursor::jsonb;
      cursor_at := (cursor_json ->> 0)::timestamptz;
      cursor_id := (cursor_json ->> 1)::uuid;
      if cursor_at is null or cursor_id is null then raise exception 'bad cursor'; end if;
    exception when others then
      perform private.cw_fail('invalid_input', '22023', 'invalid cursor', 'cursor');
    end;
  end if;
  -- Source access and tenant membership are re-proven BEFORE any body is read.
  -- A participant keeps their own history after opting out or after a
  -- cancellation only while the event itself is still readable to them.
  if private.current_member_organization() is null then
    return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null, 'available', false);
  end if;
  src := private.cw_resolve_source(caller, 'event', p_event_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null, 'available', false);
  end if;
  select e.* into ev from public.member_events e where e.id = src ->> 'id';
  -- The organizer reads only with fresh authorization for an explicitly named,
  -- currently consenting participant; a participant reads their own history.
  if ev.organizer_id = caller then
    if p_participant_id is null
       or not private.cw_event_organizer_ok(caller, ev.id)
       or not private.cw_event_contact_ready(p_participant_id, ev.id) then
      return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null, 'available', false);
    end if;
    organizer_side := true;
  elsif p_participant_id is not null and p_participant_id <> caller then
    return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null, 'available', false);
  end if;

  -- The words come from the canonical message row, and only rows the existing
  -- private-conversation read predicate still lets THIS caller see. A redaction
  -- tombstone therefore reads as removed here exactly as it does in the inbox.
  for row_data in
    select m.id, m.body, m.redacted_at, m.created_at, m.sender_id, l.sender_role
    from private.member_event_contact_links l
    join public.member_messages m on m.id = l.message_id
    where l.event_id = ev.id
      and case when organizer_side
        then l.organizer_id = caller and l.participant_id = p_participant_id
        else l.participant_id = caller end
      and private.can_read_message_source(caller, 'private', m.id, null, null)
      and (cursor_at is null or (m.created_at, m.id) < (cursor_at, cursor_id))
    order by m.created_at desc, m.id desc
    limit lim + 1
  loop
    fetched := fetched + 1;
    if fetched <= lim then
      items := items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', row_data.id,
        'mine', row_data.sender_id = caller,
        'senderRole', row_data.sender_role,
        'body', case when row_data.redacted_at is null then row_data.body else '' end,
        'redacted', row_data.redacted_at is not null,
        'createdAt', row_data.created_at));
    else
      next_cursor := pg_catalog.jsonb_build_array(
        (items -> (lim - 1)) ->> 'createdAt', (items -> (lim - 1)) ->> 'id')::text;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('items', items, 'nextCursor', next_cursor, 'available', true);
end;

end;
$function$;

-- Newest source: 20260925620000_clause_grievance_counts_equality_join.sql
create or replace function public.list_contract_clause_grievance_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  org uuid := private.mi1_require_selected_organization();
  v_actor uuid := (select auth.uid());
  staff boolean;
  steward_hat boolean;
  coordinator_chapters text[];
  staff_organization uuid;
  organization_officer boolean;
  granted_cases uuid[];
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Same clause visibility as public.list_contract_clauses.
  staff := private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  );

  -- Caller-only inputs of the member_cases SELECT policies, resolved once.
  -- mfa_assurance is already satisfied by the gate above.
  steward_hat := coalesce(public.member_has_role(array['steward']), false);
  coordinator_chapters := array(select private.staff_visible_chapter_scope('coordinator'));
  staff_organization := private.current_mobile_staff_organization();
  organization_officer := coalesce(
    private.has_organization_role(staff_organization, array['advisor', 'admin', 'vp']),
    false
  );
  granted_cases := array(
    select g.case_id
    from public.casework_access_grants g
    where g.grantee_user_id = v_actor
      and g.revoked_at is null
  );

  -- Each visible case's articles are normalized and split into tokens ONCE,
  -- then joined to the caller-visible clause articles on equality. The
  -- 20260925110500 body re-ran the regexp_replace for every (clause, case)
  -- pair as a LIKE join filter, so its cost grew with clauses x cases.
  return coalesce((
    with visible_cases as (
      select cs.id,
             ',' || pg_catalog.regexp_replace(
               pg_catalog.lower(pg_catalog.btrim(cs.articles)),
               '[[:space:]]*[,;/]+[[:space:]]*',
               ',',
               'g'
             ) || ',' as line
      from public.member_cases cs
      left join public.member_profiles case_owner
        on coordinator_chapters <> '{}'::text[]
       and case_owner.id = cs.user_id
      where cs.organization_id = org
        and cs.articles is not null
        and pg_catalog.btrim(cs.articles) <> ''
        and (
          -- member_cases_select_own
          cs.user_id = v_actor
          -- member_cases_select_steward
          or (cs.steward_user_id = v_actor and steward_hat)
          -- member_cases_select_coordinator
          or (
            case_owner.chapter_id = any(coordinator_chapters)
            and (
              not cs.is_restricted
              or cs.coordinator_user_id = v_actor
              or (
                cs.organization_id is not null
                and cs.organization_id = staff_organization
                and organization_officer
              )
              or cs.id = any(granted_cases)
            )
          )
        )
    ),
    case_articles as (
      select v.id as case_id, token.article
      from visible_cases v
      cross join lateral pg_catalog.unnest(
        pg_catalog.string_to_array(pg_catalog.btrim(v.line, ','), ',')
      ) as token(article)
      where token.article <> ''
    ),
    -- Counted per token before the clause join and materialized, so the join
    -- only ever sees distinct tokens: the planner cannot rescan member_cases
    -- (or re-run the regexp) once per clause article when statistics are thin.
    token_counts as materialized (
      select ca.article, pg_catalog.count(distinct ca.case_id)::integer as n
      from case_articles ca
      group by ca.article
    ),
    visible_articles as (
      select distinct pg_catalog.lower(pg_catalog.btrim(c.article)) as article
      from public.contract_clauses c
      where c.organization_id = org
        and (staff or c.status = 'published')
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'article', counts.article,
      'count', counts.n
    ) order by counts.article)
    from (
      select a.article, t.n
      from visible_articles a
      join token_counts t on t.article = a.article
    ) counts
  ), '[]'::jsonb);
end;

end;
$function$;

-- Newest source: 20260917133000_casework_procedures_retire_w2.sql
create or replace function public.casework_get_case_procedure(p_case_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
begin
  perform private.member_pin_require_full_session();

declare v_case public.member_cases%rowtype; v_procedure uuid;
begin
  perform private.casework_require_mfa();
  if (select auth.uid()) is null or not private.casework_can_read(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  v_procedure := private.casework_resolve_procedure(v_case.organization_id, v_case.chapter_id, v_case.case_type);
  if v_procedure is null then return null; end if;
  -- The resolved procedure plus the case's position in it, so every plane
  -- renders the same allowed transition(s) the RPC will accept.
  return private.casework_procedure_json(v_procedure) || jsonb_build_object(
    'case_step', v_case.step,
    'allowed_next_steps', coalesce((select jsonb_agg(s.key order by s.position)
      from private.casework_allowed_next_steps(v_procedure, v_case.step) s), '[]'::jsonb));
end;

end;
$function$;

-- Case children authorize through this shared helper; fail closed before
-- evaluating their ownership/staff predicates. Existing full-session rules stay.
create or replace function private.casework_can_read(p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select not private.member_pin_session_restricted()
    and (private.casework_member_owns(p_case_id) or private.casework_staff_can_access(p_case_id));
$function$;

-- D6: assistant history cannot be read or written directly with a PIN session.
create policy member_pin_step_up on public.member_guide_threads
as restrictive for all to authenticated
using (not (select private.member_pin_session_restricted()))
with check (not (select private.member_pin_session_restricted()));
create policy member_pin_step_up on public.member_guide_messages
as restrictive for all to authenticated
using (not (select private.member_pin_session_restricted()))
with check (not (select private.member_pin_session_restricted()));
create trigger member_pin_step_up before insert or update or delete on public.member_guide_threads
for each statement execute function private.member_pin_step_up_statement();
create trigger member_pin_step_up before insert or update or delete on public.member_guide_messages
for each statement execute function private.member_pin_step_up_statement();

create or replace function public.save_member_guide_exchange(p_thread_id uuid, p_question text, p_answer text, p_sources jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  active_thread_id uuid := p_thread_id;
  clean_question text := pg_catalog.btrim(coalesce(p_question, ''));
  clean_answer text := pg_catalog.btrim(coalesce(p_answer, ''));
  clean_sources jsonb := null;
begin
  perform private.member_pin_require_full_session();
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): persists the caller's private Compass guide history.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_question) not between 1 and 1200 then
    raise exception 'question must be between 1 and 1200 characters' using errcode = '22023';
  end if;

  if pg_catalog.char_length(clean_answer) not between 1 and 4000 then
    raise exception 'answer must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if p_sources is not null
     and pg_catalog.jsonb_typeof(p_sources) = 'array'
     and pg_catalog.length(p_sources::text) <= 4000 then
    clean_sources := p_sources;
  end if;

  if active_thread_id is null then
    insert into public.member_guide_threads (user_id, title)
    values (caller, pg_catalog.left(clean_question, 120))
    returning id into active_thread_id;
  else
    perform 1
    from public.member_guide_threads
    where id = active_thread_id
      and user_id = caller
    for update;

    if not found then
      raise exception 'guide conversation not found' using errcode = '22023';
    end if;
  end if;

  insert into public.member_guide_messages (thread_id, user_id, role, body, sources)
  values
    (active_thread_id, caller, 'user', clean_question, null),
    (active_thread_id, caller, 'assistant', clean_answer, clean_sources);

  update public.member_guide_threads
  set updated_at = now()
  where id = active_thread_id
    and user_id = caller;

  return active_thread_id;
end;
end;
$function$;

comment on policy member_pin_step_up on public.member_guide_threads is 'Assistant history requires a full session; restricted PIN sessions cannot read or write it.';
comment on policy member_pin_step_up on public.member_guide_messages is 'Assistant history requires a full session; restricted PIN sessions cannot read or write it.';

-- Newest native share destination reader; own-case titles also need step-up.
create or replace function public.list_share_case_destinations(p_limit integer default 100)
returns table(id uuid, user_id uuid, reference text, title text, status text, updated_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();
declare
  v_actor uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit,100),1),100);
begin
  if v_actor is null then return; end if;
  return query
  with actor_scope as materialized (
    select
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  staff_visible as (
    select c.id
    from public.member_profiles case_owner
    join public.member_cases c on c.user_id = case_owner.id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted or c.coordinator_user_id = v_actor
        or (c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s))
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ), visible_ids as (
    select c.id from public.member_cases c where c.user_id = v_actor
    union
    select c.id from public.member_cases c
      where c.steward_user_id = v_actor and (select s.steward_hat from actor_scope s)
    union
    select s.id from staff_visible s
  )
  select c.id, c.user_id, c.reference, c.title, c.status, c.updated_at
  from visible_ids v join public.member_cases c on c.id = v.id
  where (select s.mfa_satisfied from actor_scope s)
  order by c.updated_at desc, c.id
  limit v_limit;
end;
end;
$function$;
-- Extended definer sweep: former steward preferences and file metadata also
-- contain protected member content, even without a directly selected case row.

-- Newest source: 20260924170200_member_steward_roster_and_contact.sql
create or replace function public.get_my_steward_contact_visibility()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  row_found public.steward_contact_preferences%rowtype;
begin
  -- Reading one's own row needs only an MFA-assured session. A steward who has
  -- lost the chapter, the organization or the role must still be able to see
  -- what they shared so they can withdraw it; nobody else's row is reachable.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into row_found from public.steward_contact_preferences p where p.steward_user_id = caller;
  return pg_catalog.jsonb_build_object(
    'shareEmail', coalesce(row_found.share_email, false),
    'sharePhone', coalesce(row_found.share_phone, false),
    'contactEmail', row_found.contact_email,
    'contactPhone', row_found.contact_phone
  );
end;

end;
$$;

-- Newest source: 20260906190000_sensitive_content_envelopes.sql
create or replace function public.sensitive_case_upload_target(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.member_pin_require_full_session();

declare f public.member_case_files%rowtype; org uuid;
begin
  perform private.casework_require_mfa();
  select * into f from public.member_case_files where id = p_file_id
    and uploaded_by = (select auth.uid()) and confirmed_at is null and removal_requested_at is null;
  if f.id is null then raise exception 'file unavailable' using errcode = '42501'; end if;
  select organization_id into org from public.member_cases where id = f.case_id;
  if org is distinct from private.mi1_require_selected_organization()
    or not (f.user_id = (select auth.uid()) or (public.staff_can_see_user(f.user_id, 'coordinator')
      and private.casework_staff_can_access(f.case_id))) then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  return to_jsonb(f) || jsonb_build_object('organization_id', org);
end;
end;
$$;

-- Newest source: 20260906024000_knowledge_source_verdict_gates.sql
create or replace function public.authorize_private_upload_inspection(p_kind text, p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if p_kind in ('case', 'form') then
    perform private.member_pin_require_full_session();
  end if;

declare
  actor uuid := (select auth.uid());
  target jsonb;
  allowed boolean := false;
  object storage.objects%rowtype;
  quota private.private_upload_inspection_limits%rowtype;
  attempt private.private_upload_inspection_attempts%rowtype;
  attempt_id uuid := extensions.gen_random_uuid();
  checked_at timestamptz := pg_catalog.now();
begin
  -- A caller that is not an authenticated end user has no business here at
  -- all, and says nothing about any file by being refused.
  if (select auth.role()) is distinct from 'authenticated' or actor is null then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  -- A STALE MFA SESSION IS A FACT ABOUT THE CALLER, NOT ABOUT ANY ROW.
  -- It is evaluated before p_file_id is looked at, so answering it distinctly
  -- reveals nothing about whether that file exists, belongs to this actor, or
  -- was removed — the enumeration surface is unchanged. Every row-shaped
  -- refusal below stays merged into one indistinguishable 42501: unknown,
  -- foreign, removed and unauthorized all answer identically.
  --
  -- Making this one distinguishable is what lets a client tell "verify it is
  -- you" from "this file is not available to you". Native durable recovery
  -- needed exactly that: after the service reconciler deletes a rejected
  -- upload's row, the missing row produced the same refusal as a stale MFA
  -- session, so the client kept a recovery marker no amount of
  -- reauthentication could ever clear (see apps/mobile/src/services/
  -- attachments.ts). It is returned rather than raised so it travels as a
  -- structured answer alongside 'busy' and 'rateLimited', and it is returned
  -- BEFORE any lookup, lock or quota charge.
  if not private.mfa_satisfied() then
    return pg_catalog.jsonb_build_object('reauthRequired', true);
  end if;
  if p_kind = 'case' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_member_case_object(f.bucket_id, f.object_name)
        or private.can_write_member_case_object(f.bucket_id, f.object_name)
    into target, allowed from public.member_case_files f
    where f.id = p_file_id and f.removal_requested_at is null and f.cleanup_requested_at is null;
  elsif p_kind = 'task' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_chapter_task_object(f.bucket_id, f.object_name)
        or private.can_write_chapter_task_object(f.bucket_id, f.object_name)
    into target, allowed from public.chapter_task_files f
    where f.id = p_file_id and f.removal_requested_at is null and f.cleanup_requested_at is null;
  elsif p_kind = 'form' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_member_form_object(f.bucket_id, f.object_name)
        or private.can_write_member_form_object(f.bucket_id, f.object_name)
    into target, allowed from public.member_form_files f
    where f.id = p_file_id and f.deletion_requested_at is null;
  elsif p_kind = 'knowledge' then
    select pg_catalog.jsonb_build_object('bucketId', 'organization-knowledge', 'objectName', f.storage_path,
      'filename', f.file_name, 'mimeType', f.mime_type, 'sizeBytes', f.byte_size, 'sha256', f.content_sha256),
      private.can_insert_organization_knowledge_object('organization-knowledge', f.storage_path)
        or private.can_read_organization_knowledge_object('organization-knowledge', f.storage_path)
    into target, allowed from public.organization_knowledge_files f
    where f.id = p_file_id and f.storage_kind = 'organization_storage';
  end if;
  -- Unknown, foreign, removed and unauthorized identities have one response.
  if target is null or allowed is distinct from true then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  -- Serialize an actor's quota before taking any Storage lock. All functions
  -- that touch both object and attempt rows lock Storage first, then attempt.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private-upload:' || actor::text, 509));
  select * into object from storage.objects
  where bucket_id = target->>'bucketId' and name = target->>'objectName' for update;
  if object.id is null then raise exception 'file unavailable' using errcode = '42501'; end if;
  -- Knowledge preparation reserves name/size/digest before MIME is recorded.
  -- The immutable Storage declaration is still only a claim: the inspector
  -- validates it against the filename and the actual downloaded bytes.
  if target->>'mimeType' is null then
    target := target || pg_catalog.jsonb_build_object('mimeType', object.metadata->>'mimetype');
  end if;
  if private.private_upload_is_current(object.bucket_id, object.name) then
    return pg_catalog.jsonb_build_object('fileId', p_file_id, 'current', true);
  end if;
  select * into attempt from private.private_upload_inspection_attempts a where a.object_id = object.id for update;
  if attempt.completed_at is null and attempt.expires_at > checked_at then
    return pg_catalog.jsonb_build_object('busy', true);
  end if;
  insert into private.private_upload_inspection_limits(user_id, hour_started, hour_count, day_started, day_count)
  values(actor, checked_at, 0, checked_at, 0) on conflict (user_id) do nothing;
  select * into quota from private.private_upload_inspection_limits where user_id = actor for update;
  if quota.hour_started <= checked_at - interval '1 hour' then quota.hour_started := checked_at; quota.hour_count := 0; end if;
  if quota.day_started <= checked_at - interval '24 hours' then quota.day_started := checked_at; quota.day_count := 0; end if;
  if quota.hour_count >= 20 or quota.day_count >= 100 then
    return pg_catalog.jsonb_build_object('rateLimited', true);
  end if;
  update private.private_upload_inspection_limits set hour_started = quota.hour_started, hour_count = quota.hour_count + 1,
    day_started = quota.day_started, day_count = quota.day_count + 1 where user_id = actor;
  insert into private.private_upload_inspection_attempts(object_id, id, object_version, bucket_id, object_name, actor_user_id, expires_at)
  values(object.id, attempt_id, object.version, object.bucket_id, object.name, actor, checked_at + interval '60 seconds')
  on conflict (object_id) do update set id = excluded.id, object_version = excluded.object_version,
    actor_user_id = excluded.actor_user_id, expires_at = excluded.expires_at, completed_at = null;
  return target || pg_catalog.jsonb_build_object('fileId', p_file_id, 'attemptId', attempt_id,
    'objectId', object.id, 'objectVersion', object.version, 'current', false);
end;
end;
$function$;

-- D6 adds these triggers after the original PIN lifecycle review above.
-- They refuse only restricted caller sessions and leave full-session/service
-- referential actions unchanged, using the already reviewed statement helper.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'trigger' and s.schema_name = 'public'
  and s.table_name in ('member_guide_threads', 'member_guide_messages')
  and s.object_name = 'member_pin_step_up'
on conflict do nothing;

do $assert_pin_history_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after PIN history guards';
  end if;
end
$assert_pin_history_review$;

commit;
