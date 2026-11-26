-- Union Ground SAMPLE demo seed (owner directive, 2026-08-24).
--
-- WHAT THIS IS
-- A ledgered, service_role-only seed lane for the "Union Ground" sales
-- demo: one FICTIONAL pre-unionization workplace rendered inside the current
-- product schema in the isolated SAMPLE project so web and native apps sign in
-- against real rows. The scenario is deliberately NOT a union local:
--   * one potential chapter ('presg', "Union Ground");
--   * a bargaining-unit roster of employees who are organizing but are not
--     union members (member_count, default 1000);
--   * an organizing committee (committee_count, default 30) who carry the
--     'steward' role so every steward-equivalent surface lights up;
--   * four years of history: chapter-scoped events, ballots, pulses and
--     broadcasts, chapter channels and a task board, per-employee issue
--     cases, steward requests, guide threads, rights progress, points,
--     workload receipts and a very active message stream.
-- Everything is derived deterministically from (run_id, ordinal) exactly like
-- the member-stress lane this file is modeled on (20260721210635 and
-- 20260726000000), so every phase is idempotent and removal is symmetric.
--
-- SAFETY RULES INHERITED FROM THE STRESS LANE (each one is a live hazard)
-- * SEEDED NOTIFICATION KIND IS FROZEN AT 'general'. outbound_enabled is TRUE
--   in deployed projects and the dispatch cron runs every 5 minutes; a typed kind on
--   synthetic rows would attempt real provider sends. Additionally, every
--   demo profile is written with EVERY typed notification pref explicitly
--   false, so app triggers that legitimately fire during a live demo
--   (task assignment, steward-request fan-out, deadline crons) can never
--   enqueue an outbound delivery for a demo identity. Trigger-minted typed
--   rows created inside a seeding transaction are swept before commit
--   (they all carry created_at = now(); seeded history is strictly older).
-- * POINTS ARE MINTED BY DIRECT BACKDATED INSERT, never through
--   member_action_log (award_member_points stamps occurred_at = now() and
--   enforces weekly caps). member_action_log rows stay action_kind 'seed'.
-- * STEWARD REQUESTS ARE INSERTED IN THEIR FINAL STATUS, never UPDATEd, so
--   the award-on-acknowledgment trigger cannot fire at now().
-- * TEARDOWN IS SYMMETRIC. Per-employee rows hang off auth.users with
--   ON DELETE CASCADE; org rows all carry the 'presg' chapter id or a
--   'presg-' id prefix and are deleted explicitly after the users are gone.
--
-- IMPERSONATION NOTE. chapter_spaces/chapter_threads/chapter_thread_posts and
-- chapter_tasks stamp identity from auth.uid() in BEFORE triggers
-- (stamp_product_identity, prepare_chapter_task) and refuse anonymous writes.
-- The channel/task seeding functions therefore set a transaction-local
-- request.jwt.claims for the ledgered author being written. The service_role
-- authorization check always runs BEFORE the first impersonation in each
-- function, and set_config(..., true) dies with the transaction.
-- chapter_tasks.created_at is trigger-forced to now() and immutable, so the
-- task board is seeded as a live current board (start/due dates carry the
-- history) rather than a backdated one.
--
-- ROLLBACK (copy-paste)
--   drop function if exists public.presg_demo_remove_batch(uuid, integer, text, text);
--   drop function if exists public.presg_demo_begin_remove(uuid, text, text);
--   drop function if exists public.presg_demo_verify(uuid, text);
--   drop function if exists public.presg_demo_status(uuid);
--   drop function if exists public.presg_demo_enrich_batch(uuid, text, integer, integer, text, text);
--   drop function if exists public.presg_demo_seed_channels(uuid, text, text);
--   drop function if exists public.presg_demo_seed_org(uuid, text, text);
--   drop function if exists public.presg_demo_apply_batch(uuid, integer, integer, text, text, text);
--   drop function if exists public.presg_demo_begin(uuid, text, integer, integer, integer, text, text, text);
--   drop function if exists private.presg_demo_sweep_trigger_rows(uuid);
--   drop function if exists private.presg_demo_impersonate(uuid);
--   drop function if exists private.presg_demo_receipt_code(text);
--   drop function if exists private.presg_demo_full_name(uuid, integer);
--   drop function if exists private.presg_demo_first_name(uuid, integer);
--   drop function if exists private.presg_demo_last_name(uuid, integer);
--   drop function if exists private.presg_demo_joined_at(uuid, integer, integer);
--   drop function if exists private.presg_demo_email(uuid, integer);
--   drop function if exists private.presg_demo_user_id(uuid, integer);
--   drop function if exists private.presg_demo_authorize(text, text);
--   drop function if exists private.presg_demo_protected_snapshot(uuid);
--   drop table if exists private.presg_demo_ledger;
--   drop table if exists private.presg_demo_runs;

set local lock_timeout = '5s';

-- ------------------------------------------------------------ 1. run ledger --

create table private.presg_demo_runs (
  id uuid primary key,
  dataset_version text not null,
  target_ref text not null,
  member_count integer not null check (member_count between 1 and 2000),
  committee_count integer not null check (committee_count between 1 and member_count),
  login_count integer not null check (login_count between 0 and member_count),
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('ledgered', 'applying', 'applied', 'verified', 'removing', 'removed')),
  protected_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz,
  removed_at timestamptz
);

create table private.presg_demo_ledger (
  run_id uuid not null references private.presg_demo_runs(id) on delete restrict,
  ordinal integer not null check (ordinal > 0),
  user_id uuid not null,
  email text not null,
  committee boolean not null,
  login_capable boolean not null,
  created_at timestamptz not null default now(),
  primary key (run_id, ordinal),
  unique (run_id, user_id),
  unique (run_id, email)
);

revoke all on table private.presg_demo_runs, private.presg_demo_ledger
  from public, anon, authenticated, service_role;

-- --------------------------------------------------- 2. deterministic helpers --
-- private.member_stress_uuid / _rand / _pick and the name pool from the stress
-- lane are reused: they are pure functions of their seed text and carry no
-- stress-run state. Every presg seed string is namespaced ':presg:' so the two
-- lanes can never derive the same identity.

create function private.presg_demo_user_id(p_run_id uuid, p_ordinal integer)
returns uuid
language sql
immutable
strict
set search_path = ''
as $$
  select private.member_stress_uuid(p_run_id::text || ':presg:user:' || p_ordinal::text);
$$;

create function private.presg_demo_email(p_run_id uuid, p_ordinal integer)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select 'presg-' || pg_catalog.substr(pg_catalog.replace(p_run_id::text, '-', ''), 1, 8) || '-' ||
    pg_catalog.lpad(p_ordinal::text, 4, '0') || '@loadtest.example.com';
$$;

create function private.presg_demo_first_name(p_run_id uuid, p_ordinal integer)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select v.value from private.member_stress_name_pool v
  where v.part = 'first'
    and v.idx = private.member_stress_pick(p_run_id::text || ':presg:first:' || p_ordinal::text,
      (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'first'));
$$;

create function private.presg_demo_last_name(p_run_id uuid, p_ordinal integer)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select v.value from private.member_stress_name_pool v
  where v.part = 'last'
    and v.idx = private.member_stress_pick(p_run_id::text || ':presg:last:' || p_ordinal::text,
      (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'last'));
$$;

create function private.presg_demo_full_name(p_run_id uuid, p_ordinal integer)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select private.presg_demo_first_name(p_run_id, p_ordinal) || ' ' ||
    private.presg_demo_last_name(p_run_id, p_ordinal);
$$;

-- The campaign clock: t0 = now() - 4 years. Committee members joined in the
-- first ~11 weeks; employees signed on across the following ~3.5 years, which
-- is what makes participation curves rise instead of appearing fully formed.
create function private.presg_demo_joined_at(p_run_id uuid, p_ordinal integer, p_committee integer)
returns timestamptz
language sql
stable
strict
set search_path = ''
as $$
  select pg_catalog.now() - interval '1460 days'
    + case when p_ordinal <= p_committee
        then ((3 + private.member_stress_pick(p_run_id::text || ':presg:join:' || p_ordinal::text, 77)) || ' days')::interval
        else ((30 + private.member_stress_pick(p_run_id::text || ':presg:join:' || p_ordinal::text, 1270)) || ' days')::interval
      end
    + ((6 + private.member_stress_pick(p_run_id::text || ':presg:joinh:' || p_ordinal::text, 12)) || ' hours')::interval;
$$;

-- Ballot receipts are constrained to '^SG-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$'.
create function private.presg_demo_receipt_code(p_seed text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  digest text := pg_catalog.md5(p_seed);
  body text := '';
  i integer;
begin
  for i in 0..7 loop
    body := body || pg_catalog.substr(alphabet,
      ((('x' || pg_catalog.substr(digest, i * 2 + 1, 2))::bit(8)::integer) % 32) + 1, 1);
  end loop;
  return 'SG-' || pg_catalog.substr(body, 1, 4) || '-' || pg_catalog.substr(body, 5, 4);
end;
$$;

create function private.presg_demo_authorize(p_target_ref text, p_confirm_token text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'presg demo RPC requires service_role';
  end if;
  if p_target_ref <> 'sampledemoprojectref' then
    raise exception 'presg demo target mismatch';
  end if;
  if p_confirm_token <> 'SEED_UNION_GROUND_SAMPLE_DEMO' then
    raise exception 'presg demo confirmation mismatch';
  end if;
end;
$$;

-- Transaction-local identity for the trigger-stamped chapter surfaces. The
-- setting dies with the transaction; the service_role check in every public
-- entry point runs before the first call.
create function private.presg_demo_impersonate(p_user_id uuid)
returns void
language sql
volatile
strict
set search_path = ''
as $$
  select pg_catalog.set_config('request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
$$;

-- Seeded history is strictly older than now(); anything a trigger minted
-- inside this transaction (task.assigned, steward.request.new fan-out) sits
-- exactly at now(). Deleting >= now() removes trigger noise and nothing else.
create function private.presg_demo_sweep_trigger_rows(p_run_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  swept bigint;
begin
  delete from public.member_notification_deliveries d
  using private.presg_demo_ledger l
  where l.run_id = p_run_id and d.user_id = l.user_id and d.created_at >= pg_catalog.now();

  delete from public.member_notifications n
  using private.presg_demo_ledger l
  where l.run_id = p_run_id and n.user_id = l.user_id and n.created_at >= pg_catalog.now();
  get diagnostics swept = row_count;
  return swept;
end;
$$;

create function private.presg_demo_protected_snapshot(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(snapshot) order by snapshot.email, snapshot.id), '[]'::jsonb)
  from (
    select
      users.id,
      pg_catalog.lower(users.email) as email,
      (select pg_catalog.count(*) from public.member_profiles rows where rows.id = users.id) as profiles,
      (select pg_catalog.count(*) from public.member_notifications rows where rows.user_id = users.id) as notifications,
      (select pg_catalog.count(*) from public.member_conversations rows where rows.user_id = users.id) as conversations,
      (select pg_catalog.count(*) from public.member_messages rows where rows.user_id = users.id) as messages,
      (select pg_catalog.count(*) from public.member_cases rows where rows.user_id = users.id) as cases
    from auth.users users
    where coalesce(users.raw_app_meta_data ->> 'presg_demo_run_id', '') <> p_run_id::text
  ) snapshot;
$$;

-- ------------------------------------------------------------- 3. begin -------

create function public.presg_demo_begin(
  p_run_id uuid,
  p_dataset_version text,
  p_member_count integer,
  p_committee_count integer,
  p_login_count integer,
  p_config_hash text,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '120s'
as $$
declare
  existing_run private.presg_demo_runs%rowtype;
  collision_count bigint;
  ledger_count bigint;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  if p_member_count not between 1 and 2000
    or p_committee_count not between 1 and p_member_count
    or p_login_count not between 0 and p_member_count then
    raise exception 'invalid member, committee or login count';
  end if;
  if p_dataset_version <> 'presg-demo-v2-function-parity' or p_config_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid dataset version or config hash';
  end if;

  select * into existing_run from private.presg_demo_runs where id = p_run_id;
  if found then
    if existing_run.dataset_version <> p_dataset_version
      or existing_run.member_count <> p_member_count
      or existing_run.committee_count <> p_committee_count
      or existing_run.login_count <> p_login_count
      or existing_run.config_hash <> p_config_hash
      or existing_run.target_ref <> p_target_ref then
      raise exception 'run id already exists with different configuration';
    end if;
    select pg_catalog.count(*) into ledger_count from private.presg_demo_ledger where run_id = p_run_id;
    if ledger_count <> p_member_count then raise exception 'existing run has incomplete ledger'; end if;
    if existing_run.state = 'removed' then
      select pg_catalog.count(*) into collision_count
      from private.presg_demo_ledger ledger
      join auth.users users on users.id = ledger.user_id or pg_catalog.lower(users.email) = ledger.email
      where ledger.run_id = p_run_id;
      if collision_count <> 0 then raise exception 'restart preflight found existing auth collisions'; end if;
      if exists (select 1 from private.presg_demo_runs where id <> p_run_id and state <> 'removed') then
        raise exception 'another presg demo run is active';
      end if;
      update private.presg_demo_runs
      set state = 'ledgered', protected_snapshot = private.presg_demo_protected_snapshot(p_run_id),
        updated_at = pg_catalog.now(), verified_at = null, removed_at = null
      where id = p_run_id;
      return jsonb_build_object('run_id', p_run_id, 'state', 'ledgered', 'ledger_rows', ledger_count,
        'resumed', false, 'restarted', true);
    end if;
    return jsonb_build_object('run_id', p_run_id, 'state', existing_run.state, 'ledger_rows', ledger_count, 'resumed', true);
  end if;

  if exists (select 1 from private.presg_demo_runs where state <> 'removed') then
    raise exception 'another presg demo run is active';
  end if;

  with manifest as (
    select private.presg_demo_user_id(p_run_id, ordinal) as user_id,
      private.presg_demo_email(p_run_id, ordinal) as email
    from generate_series(1, p_member_count) ordinal
  )
  select pg_catalog.count(*) into collision_count
  from manifest
  join auth.users users on users.id = manifest.user_id or pg_catalog.lower(users.email) = manifest.email;
  if collision_count <> 0 then raise exception 'preflight found existing auth collisions'; end if;

  insert into private.presg_demo_runs (
    id, dataset_version, target_ref, member_count, committee_count, login_count, config_hash, state, protected_snapshot
  ) values (
    p_run_id, p_dataset_version, p_target_ref, p_member_count, p_committee_count, p_login_count, p_config_hash,
    'ledgered', private.presg_demo_protected_snapshot(p_run_id)
  );

  insert into private.presg_demo_ledger (run_id, ordinal, user_id, email, committee, login_capable)
  select p_run_id, ordinal, private.presg_demo_user_id(p_run_id, ordinal),
    private.presg_demo_email(p_run_id, ordinal), ordinal <= p_committee_count, ordinal <= p_login_count
  from generate_series(1, p_member_count) ordinal;

  select pg_catalog.count(*) into ledger_count from private.presg_demo_ledger where run_id = p_run_id;
  if ledger_count <> p_member_count then raise exception 'ledger creation incomplete'; end if;
  return jsonb_build_object('run_id', p_run_id, 'state', 'ledgered', 'ledger_rows', ledger_count, 'resumed', false);
end;
$$;

-- ------------------------------------------------------- 4. apply (accounts) --

create function public.presg_demo_apply_batch(
  p_run_id uuid,
  p_start_ordinal integer,
  p_batch_count integer,
  p_password text,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  password_hash text;
  selected_count integer;
  collision_count integer;
  total_users bigint;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.presg_demo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then
    raise exception 'run cannot be applied in state %', run.state;
  end if;
  if p_start_ordinal < 1 or p_batch_count not between 1 and 2000 then raise exception 'invalid batch range'; end if;
  if not exists (select 1 from public.chapters where id = 'presg') then
    raise exception 'presg chapter missing: run presg_demo_seed_org first';
  end if;

  select pg_catalog.count(*) into selected_count from private.presg_demo_ledger
  where run_id = p_run_id and ordinal between lo and hi;
  if selected_count = 0 then raise exception 'empty batch'; end if;

  select pg_catalog.count(*) into collision_count
  from private.presg_demo_ledger ledger
  join auth.users users on users.id = ledger.user_id or pg_catalog.lower(users.email) = ledger.email
  where ledger.run_id = p_run_id
    and ledger.ordinal between lo and hi
    and (users.id <> ledger.user_id or pg_catalog.lower(users.email) <> ledger.email
      or coalesce(users.raw_app_meta_data ->> 'presg_demo_run_id', '') <> p_run_id::text);
  if collision_count <> 0 then raise exception 'batch preflight found non-owned auth rows'; end if;

  if exists (
    select 1 from private.presg_demo_ledger
    where run_id = p_run_id and login_capable and ordinal between lo and hi
  ) then
    if pg_catalog.char_length(coalesce(p_password, '')) < 24 then raise exception 'demo password is too short'; end if;
    password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  end if;

  update private.presg_demo_runs set state = 'applying', updated_at = pg_catalog.now()
  where id = p_run_id and state = 'ledgered';

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous
  )
  select
    '00000000-0000-0000-0000-000000000000'::uuid,
    ledger.user_id, 'authenticated', 'authenticated', ledger.email,
    case when ledger.login_capable then password_hash else '' end,
    pg_catalog.now(), '', '', '', '',
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'),
      'presg_demo_run_id', p_run_id::text, 'presg_demo_ordinal', ledger.ordinal),
    jsonb_build_object(
      'first_name', private.presg_demo_first_name(p_run_id, ledger.ordinal),
      'full_name', private.presg_demo_full_name(p_run_id, ledger.ordinal),
      'name', private.presg_demo_full_name(p_run_id, ledger.ordinal),
      'initials', pg_catalog.upper(pg_catalog.left(private.presg_demo_first_name(p_run_id, ledger.ordinal), 1)
        || pg_catalog.left(private.presg_demo_last_name(p_run_id, ledger.ordinal), 1)),
      'chapter_id', 'presg'),
    pg_catalog.now(), pg_catalog.now(), false, false
  from private.presg_demo_ledger ledger
  where ledger.run_id = p_run_id and ledger.ordinal between lo and hi
  on conflict do nothing;

  insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at)
  select
    private.member_stress_uuid(p_run_id::text || ':presg:identity:' || ledger.ordinal::text),
    ledger.user_id::text, ledger.user_id,
    jsonb_build_object('sub', ledger.user_id::text, 'email', ledger.email, 'email_verified', true,
      'phone_verified', false, 'presg_demo_run_id', p_run_id::text),
    'email', pg_catalog.now(), pg_catalog.now()
  from private.presg_demo_ledger ledger
  join auth.users users on users.id = ledger.user_id
  where ledger.run_id = p_run_id and ledger.ordinal between lo and hi
  on conflict do nothing;

  -- Whatever shape handle_new_member carries in this environment, a demo
  -- account starts from a clean slate: the enrichment phases own ALL history.
  delete from public.member_cases c using private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and c.user_id = l.user_id;
  delete from public.member_messages m using private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and m.user_id = l.user_id;
  delete from public.member_conversations c using private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and c.user_id = l.user_id;
  delete from public.member_notifications n using private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and n.user_id = l.user_id;
  delete from public.member_rights_progress r using private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and r.user_id = l.user_id;
  delete from public.member_action_log a using private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and a.user_id = l.user_id;
  delete from public.member_point_events e using private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and e.user_id = l.user_id;

  -- The profile IS the egress guard: every typed notification pref is
  -- explicitly false, which private.enqueue_notification_deliveries honors
  -- before any provider queue write.
  insert into public.member_profiles (
    id, first_name, full_name, initials, role_line, member_since, chapter_id,
    language, notification_prefs, created_at, updated_at
  )
  select
    l.user_id,
    private.presg_demo_first_name(p_run_id, l.ordinal),
    private.presg_demo_full_name(p_run_id, l.ordinal),
    pg_catalog.upper(pg_catalog.left(private.presg_demo_first_name(p_run_id, l.ordinal), 1)
      || pg_catalog.left(private.presg_demo_last_name(p_run_id, l.ordinal), 1)),
    (array[
      'Direct Support Professional','Residential Counselor','Program Coordinator',
      'Overnight Support Staff','Day Services Specialist','Community Support Worker',
      'Facilities & Kitchen','Transportation Aide'
    ])[1 + private.member_stress_pick(p_run_id::text || ':presg:role:' || l.ordinal::text, 8)]
      || ' · Union Ground',
    extract(year from private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count))::integer,
    'presg',
    case when private.member_stress_rand(p_run_id::text || ':presg:lang:' || l.ordinal::text) < 0.12 then 'es' else 'en' end,
    '{"deadlines": false, "cases": false, "forms": false, "votes": false, "events": false, "tasks": false, "appointments": false, "workload": false}'::jsonb,
    private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count),
    private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count)
  from private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi
  on conflict (id) do update set
    first_name = excluded.first_name,
    full_name = excluded.full_name,
    initials = excluded.initials,
    role_line = excluded.role_line,
    member_since = excluded.member_since,
    chapter_id = excluded.chapter_id,
    language = excluded.language,
    notification_prefs = excluded.notification_prefs,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;

  insert into public.organization_memberships (organization_id, user_id, status, created_at)
  select private.member_stress_uuid(p_run_id::text || ':presg:organization'), l.user_id, 'active',
    private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count)
  from private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi
  on conflict (organization_id, user_id) do update set status = 'active', revoked_at = null;

  insert into public.member_chapter_memberships
    (user_id, chapter_id, status, pinned, last_selected_at, joined_at)
  select l.user_id, 'presg', 'active', true, pg_catalog.now(),
    private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count)
  from private.presg_demo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null, pinned = true, last_selected_at = excluded.last_selected_at;

  select pg_catalog.count(*) into total_users from auth.users users
  join private.presg_demo_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id
    and users.raw_app_meta_data ->> 'presg_demo_run_id' = p_run_id::text;
  if total_users = run.member_count then
    update private.presg_demo_runs set state = 'applied', updated_at = pg_catalog.now() where id = p_run_id;
  end if;
  return jsonb_build_object('selected', selected_count, 'auth_users', total_users,
    'state', case when total_users = run.member_count then 'applied' else 'applying' end);
end;
$$;

-- --------------------------------------------------------- 5. org backbone ---
-- Chapter, workstreams, four years of chapter-scoped events, closed and open
-- ballots and pulses, and the broadcast archive. No auth users are required,
-- so this runs immediately after begin. Notice-sent stamps are written for
-- past items so the notification crons treat the backfill as already handled;
-- upcoming items are left for the crons, whose sends are suppressed for demo
-- identities by the all-false profile prefs.

create function public.presg_demo_seed_org(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
  seed text;
  organization_id uuid := private.member_stress_uuid(p_run_id::text || ':presg:organization');
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.presg_demo_runs where id = p_run_id;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then
    raise exception 'run cannot seed org content in state %', run.state;
  end if;
  seed := p_run_id::text;

  insert into public.organizations (id, slug, name, status)
  values (organization_id, 'union-ground', 'Union Ground Organizing Committee', 'active')
  on conflict (id) do update set name = excluded.name, status = 'active', updated_at = pg_catalog.now();

  insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
  values ('presg', 'Union Ground', 'Union Ground', false, 90, organization_id, 'union-ground')
  on conflict (id) do nothing;

  insert into public.chapter_workstreams (id, chapter_id, name, created_by, created_at)
  select private.member_stress_uuid(seed || ':presg:ws:' || w.name), 'presg', w.name, null, t0
  from unnest(array['General', 'Outreach', 'House visits', 'Meetings & actions', 'Election readiness']) w(name)
  on conflict (chapter_id, name) do nothing;

  -- Monthly organizing committee meetings across the whole campaign.
  insert into public.member_events (id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, reminder_notice_sent_at)
  select
    'presg-evt-cm-' || pg_catalog.lpad(n::text, 2, '0'),
    'Organizing committee meeting — ' || pg_catalog.to_char(t0 + ((n * 30 + 12) || ' days')::interval, 'Mon YYYY'),
    t0 + ((n * 30 + 12) || ' days')::interval + interval '18 hours',
    (array['Community Room — Main St', 'Riverside Program Hub', 'Day Services Center'])[1 + (n % 3)],
    'Card count review, issue tracker triage, and turnout assignments for the next action.',
    'SG-PCM' || pg_catalog.lpad(n::text, 2, '0'),
    100 + n, 'presg', false,
    t0 + ((n * 30 + 11) || ' days')::interval
  from generate_series(0, 47) g(n)
  on conflict (id) do nothing;

  -- Quarterly all-staff organizing meetings.
  insert into public.member_events (id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, reminder_notice_sent_at)
  select
    'presg-evt-ah-' || pg_catalog.lpad(n::text, 2, '0'),
    'All-staff organizing meeting — ' || pg_catalog.to_char(t0 + ((n * 91 - 10) || ' days')::interval, 'Mon YYYY'),
    t0 + ((n * 91 - 10) || ' days')::interval + interval '17 hours 30 minutes',
    'Community Room — Main St',
    'Open meeting for every Union Ground employee: campaign progress, questions, next steps.',
    'SG-PAH' || pg_catalog.lpad(n::text, 2, '0'),
    200 + n, 'presg', false,
    t0 + ((n * 91 - 11) || ' days')::interval
  from generate_series(1, 16) g(n)
  on conflict (id) do nothing;

  -- Weekend house-visit blitzes and the big actions.
  insert into public.member_events (id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, reminder_notice_sent_at)
  select
    'presg-evt-bl-' || n::text,
    'Weekend house-visit blitz #' || n::text,
    t0 + ((n * 220) || ' days')::interval + interval '10 hours',
    'Riverside Program Hub',
    'Pair up, take a route, and have real one-on-one conversations with coworkers at home.',
    'SG-PBL' || n::text, 300 + n, 'presg', false,
    t0 + ((n * 220 - 1) || ' days')::interval
  from generate_series(1, 6) g(n)
  on conflict (id) do nothing;

  insert into public.member_events (id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, reminder_notice_sent_at)
  values
    ('presg-evt-ac-1', 'Sticker day — wear your button', t0 + interval '300 days' + interval '8 hours',
     'All Union Ground sites', 'Every supporter wears the button on the same shift. Management counts too.',
     'SG-PAC1', 401, 'presg', false, t0 + interval '299 days'),
    ('presg-evt-ac-2', 'Petition delivery to management', t0 + interval '700 days' + interval '12 hours',
     'Main Street Program Site', 'The committee delivers the staffing petition with every signature attached.',
     'SG-PAC2', 402, 'presg', false, t0 + interval '699 days'),
    ('presg-evt-ac-3', 'Rally: fair schedules now', t0 + interval '1100 days' + interval '16 hours',
     'City Hall steps', 'Coworkers, families and community supporters rally for posted, predictable schedules.',
     'SG-PAC3', 403, 'presg', false, t0 + interval '1099 days'),
    ('presg-evt-ac-4', 'March on the boss — staffing levels', t0 + interval '1400 days' + interval '15 hours',
     'Main Street Program Site', 'A majority delegation presents the staffing-levels demand letter together.',
     'SG-PAC4', 404, 'presg', false, t0 + interval '1399 days'),
    ('presg-evt-nx-1', 'Organizing committee meeting — next', pg_catalog.now() + interval '5 days' + interval '18 hours',
     'Community Room — Main St', 'Final vote-drive assignments and the readiness wall review.',
     'SG-PNXT1', 501, 'presg', false, null),
    ('presg-evt-nx-2', 'All-staff organizing meeting', pg_catalog.now() + interval '12 days' + interval '17 hours',
     'Community Room — Main St', 'Everything you want to know before the election window opens.',
     'SG-PNXT2', 502, 'presg', false, null),
    ('presg-evt-nx-3', 'Card count celebration', pg_catalog.now() + interval '19 days' + interval '18 hours',
     'Riverside Program Hub', 'We crossed the threshold — come celebrate and pick up your vote-week kit.',
     'SG-PNXT3', 503, 'presg', false, null)
  on conflict (id) do nothing;

  -- Campaign ballots: five closed milestones and one open vote.
  insert into public.member_ballots (id, title, body, closes_at, active, order_index, quorum_target,
    chapter_id, campaign_state, published_at, closed_at,
    opened_notice_sent_at, closing_notice_sent_at, results_notice_sent_at)
  values
    ('presg-ballot-mission', 'Adopt our organizing mission and values',
     'The statement of why we are organizing at Union Ground, drafted from the first listening round.',
     t0 + interval '120 days', false, 901, 200, 'presg', 'closed',
     t0 + interval '99 days', t0 + interval '120 days',
     t0 + interval '99 days', t0 + interval '119 days', t0 + interval '120 days'),
    ('presg-ballot-demands', 'Ratify the platform of workplace demands',
     'Staffing levels, posted schedules, pay steps and safety: the platform the committee will carry.',
     t0 + interval '420 days', false, 902, 300, 'presg', 'closed',
     t0 + interval '399 days', t0 + interval '420 days',
     t0 + interval '399 days', t0 + interval '419 days', t0 + interval '420 days'),
    ('presg-ballot-public', 'Go public with the campaign',
     'Decide together whether the campaign comes out of one-on-ones and into the open.',
     t0 + interval '760 days', false, 903, 400, 'presg', 'closed',
     t0 + interval '739 days', t0 + interval '760 days',
     t0 + interval '739 days', t0 + interval '759 days', t0 + interval '760 days'),
    ('presg-ballot-petition', 'Authorize filing the election petition',
     'Authorize the committee to file for a representation election when the card count is ready.',
     t0 + interval '1050 days', false, 904, 450, 'presg', 'closed',
     t0 + interval '1029 days', t0 + interval '1050 days',
     t0 + interval '1029 days', t0 + interval '1049 days', t0 + interval '1050 days'),
    ('presg-ballot-pledge', 'Adopt the community support pledge',
     'The pledge local families, providers and neighbors are being asked to sign.',
     t0 + interval '1300 days', false, 905, 500, 'presg', 'closed',
     t0 + interval '1279 days', t0 + interval '1300 days',
     t0 + interval '1279 days', t0 + interval '1299 days', t0 + interval '1300 days'),
    ('presg-ballot-priorities', 'Set the first-contract survey priorities',
     'Rank what the bargaining survey leads with once we win the election.',
     pg_catalog.now() + interval '9 days', true, 906, 600, 'presg', 'open',
     pg_catalog.now() - interval '5 days', null,
     pg_catalog.now() - interval '5 days', null, null)
  on conflict (id) do nothing;

  insert into public.member_ballot_options (id, ballot_id, label, order_index)
  select b.id || o.suffix, b.id, o.label, o.ord
  from (values
    ('presg-ballot-mission'), ('presg-ballot-demands'), ('presg-ballot-public'),
    ('presg-ballot-petition'), ('presg-ballot-pledge'), ('presg-ballot-priorities')
  ) b(id)
  cross join (values
    ('-yes', 'Approve', 1), ('-no', 'Do not approve', 2), ('-abstain', 'Abstain', 3)
  ) o(suffix, label, ord)
  on conflict (id) do nothing;

  -- Quarterly pulses, plus one live pulse.
  insert into public.member_surveys (id, title, body, closes_at, active, order_index,
    chapter_id, campaign_state, published_at, closed_at)
  select
    'presg-pulse-' || pg_catalog.lpad(n::text, 2, '0'),
    (array[
      'How confident do you feel about the campaign?',
      'Is management pressure affecting your shift?',
      'Which issue matters most this quarter?',
      'Would you attend a weekend action?'
    ])[1 + (n % 4)] || ' (' || pg_catalog.to_char(t0 + ((n * 170) || ' days')::interval, 'Mon YYYY') || ')',
    'Two questions, thirty seconds, committee eyes only.',
    t0 + ((n * 170) || ' days')::interval, false,
    910 + n, 'presg', 'closed',
    t0 + ((n * 170 - 18) || ' days')::interval,
    t0 + ((n * 170) || ' days')::interval
  from generate_series(1, 8) g(n)
  on conflict (id) do nothing;

  insert into public.member_surveys (id, title, body, closes_at, active, order_index,
    chapter_id, campaign_state, published_at, closed_at)
  values ('presg-pulse-live', 'How ready is your program for the vote?',
    'Your answer sets where the committee spends its last two weeks.',
    pg_catalog.now() + interval '11 days', true, 909, 'presg', 'open',
    pg_catalog.now() - interval '4 days', null)
  on conflict (id) do nothing;

  insert into public.member_survey_options (id, survey_id, label, order_index)
  select s.id || '-' || o.ord, s.id, o.label, o.ord
  from public.member_surveys s
  cross join (values
    ('Strong and growing', 1), ('Steady', 2), ('Unsure', 3), ('Worried', 4)
  ) o(label, ord)
  where s.id like 'presg-pulse-0%'
  on conflict (id) do nothing;

  insert into public.member_survey_options (id, survey_id, label, order_index)
  values
    ('presg-pulse-live-1', 'presg-pulse-live', 'Ready now', 1),
    ('presg-pulse-live-2', 'presg-pulse-live', 'Close — a few more conversations', 2),
    ('presg-pulse-live-3', 'presg-pulse-live', 'Need help from the committee', 3)
  on conflict (id) do nothing;

  -- The broadcast archive: a committee update roughly every two weeks for four
  -- years. member_broadcasts.order_index is globally unique, so the demo rows
  -- live in their own 1000+ band. A handful are Spanish-locale.
  insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, created_by, locale,
    organization_id, chapter_id, audience_scope)
  select
    'presg-bc-' || pg_catalog.lpad(n::text, 3, '0'),
    (array['Organizing committee', 'Committee captains', 'Union Ground organizing'])[1 + (n % 3)],
    case when n % 16 = 0
      then 'Actualización de la campaña — semana ' || n::text
      else (array[
        'Campaign update — week ' || n::text,
        'Committee meeting recap',
        'Card count milestone',
        'Know your rights refresher',
        'Action this week',
        'New supporters joined',
        'What management said, and what is true',
        'Community support keeps growing'
      ])[1 + (n % 8)]
    end,
    case when n % 16 = 0
      then 'Resumen para la semana ' || n::text || ': avances del comité, próximos pasos y cómo participar.'
      else (array[
        'Here is where the campaign stands this week, what changed, and the one thing to do next.',
        'Highlights from the committee meeting: issue tracker, turnout numbers, and assignments.',
        'Another floor crossed majority support this week. Thank your coworkers who had the conversations.',
        'Reminder: you have the legal right to talk about organizing on breaks and off the clock.',
        'One action this week. Details inside — bring a coworker who has not come before.',
        'Welcome to everyone who signed on this week. A committee member will say hello on your shift.',
        'A rumor is going around. Here is the claim, and here is the fact, with the source.',
        'Two more community organizations signed the support pledge this week.'
      ])[1 + (n % 8)]
    end,
    t0 + ((n * 15) || ' days')::interval + interval '17 hours',
    1000 + n, null,
    case when n % 16 = 0 then 'es' else 'en' end,
    organization_id, 'presg', 'organization'
  from generate_series(1, 96) g(n)
  on conflict (id) do nothing;

  return jsonb_build_object(
    'chapter', 'presg',
    'events', (select pg_catalog.count(*) from public.member_events where chapter_id = 'presg'),
    'ballots', (select pg_catalog.count(*) from public.member_ballots where id like 'presg-ballot-%'),
    'surveys', (select pg_catalog.count(*) from public.member_surveys where id like 'presg-pulse-%'),
    'broadcasts', (select pg_catalog.count(*) from public.member_broadcasts where id like 'presg-bc-%'));
end;
$$;

-- --------------------------------------------- 6. channels and the task board --

create function public.presg_demo_seed_channels(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
  seed text;
  lead_user uuid;
  author record;
  tasks_seeded boolean := false;
  thread_count bigint;
  post_count bigint;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.presg_demo_runs where id = p_run_id;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied before channels seed (state %)', run.state;
  end if;
  seed := p_run_id::text;
  lead_user := private.presg_demo_user_id(p_run_id, 1);

  -- Spaces: stamp_product_identity resolves the chapter from the acting
  -- member's profile, so the committee lead acts for the create.
  perform private.presg_demo_impersonate(lead_user);
  insert into public.chapter_spaces (id, chapter_id, name, description, created_at, updated_at)
  select private.member_stress_uuid(seed || ':presg:space:' || s.name), 'presg', s.name, s.descr, t0 + interval '40 days', t0 + interval '40 days'
  from (values
    ('General', 'Campaign-wide conversation for every Union Ground supporter.'),
    ('Organizing committee', 'Committee coordination: assessments, assignments, and follow-through.'),
    ('Actions & turnout', 'Planning and turnout threads for every action and meeting.'),
    ('Questions & support', 'No such thing as a silly question. Ask here, a committee member answers.')
  ) s(name, descr)
  on conflict (chapter_id, name) do nothing;

  -- Threads, per deterministic creator so created_by is a real ledgered
  -- identity. Thread timestamps are backdated; the bump trigger will keep
  -- updated_at current, which reads as a live board.
  for author in
    select distinct 1 + private.member_stress_pick(seed || ':presg:thcr:' || t::text,
      run.committee_count) as ordinal
    from generate_series(1, 130) t
  loop
    perform private.presg_demo_impersonate(private.presg_demo_user_id(p_run_id, author.ordinal));
    insert into public.chapter_threads (id, space_id, chapter_id, title, kind, status, resolved_at, pinned_at, created_at, updated_at)
    select
      private.member_stress_uuid(seed || ':presg:thread:' || t::text),
      private.member_stress_uuid(seed || ':presg:space:' ||
        (array['General', 'General', 'Organizing committee', 'Actions & turnout', 'Questions & support'])
          [1 + private.member_stress_pick(seed || ':presg:thsp:' || t::text, 5)]),
      'presg',
      case when t = 1 then 'Read first: how we talk to each other here'
           when t = 2 then 'Campaign timeline and key dates'
           else (array[
        'Why we are organizing',
        'Schedule changes without notice — collect your stories',
        'Committee meeting recap and next steps',
        'Turnout plan for the all-staff meeting',
        'Questions from the overnight shift',
        'Health insurance costs went up again',
        'How card signing works',
        'Your rights in captive-audience meetings',
        'Management response tracker',
        'Welcome, new supporters',
        'Petition language — feedback wanted',
        'House-visit debrief',
        'Break coverage at the day program',
        'What a first contract could fix',
        'Support pledge from local groups',
        'Overtime distribution is not transparent',
        'Preparing for the vote',
        'One-on-one conversation tips',
        'Staffing levels and safety',
        'Mileage reimbursement is months behind',
        'Shout-outs and wins this week',
        'Election filing checklist',
        'After the vote: what comes next',
        'Rumor control — post what you heard'
      ])[1 + private.member_stress_pick(seed || ':presg:thti:' || t::text, 24)]
        || ' · #' || t::text end,
      (array['topic', 'topic', 'topic', 'issue', 'issue', 'decision'])
        [1 + private.member_stress_pick(seed || ':presg:thki:' || t::text, 6)],
      case when private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395) > 240
        and private.member_stress_rand(seed || ':presg:thst:' || t::text) < 0.7
        then 'resolved' else 'open' end,
      case when private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395) > 240
        and private.member_stress_rand(seed || ':presg:thst:' || t::text) < 0.7
        then t0 + interval '45 days' + ((private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395) + 35) || ' days')::interval
        else null end,
      case when t <= 2 then pg_catalog.now() - interval '3 days' else null end,
      t0 + interval '45 days' + ((private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395)) || ' days')::interval,
      t0 + interval '45 days' + ((private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395)) || ' days')::interval
    from generate_series(1, 130) t
    where 1 + private.member_stress_pick(seed || ':presg:thcr:' || t::text, run.committee_count) = author.ordinal
    on conflict (id) do nothing;
  end loop;

  -- Posts: ~45 per thread, mostly committee voices with employee replies. The
  -- author plan is derived once into a transaction-scoped table, then written
  -- one author at a time so stamp_product_identity records the real author_id.
  create temp table if not exists presg_post_plan on commit drop as
  select
    private.member_stress_uuid(seed || ':presg:post:' || t::text || ':' || p::text) as id,
    private.member_stress_uuid(seed || ':presg:thread:' || t::text) as thread_id,
    case when private.member_stress_rand(seed || ':presg:powho:' || t::text || ':' || p::text) < 0.72
      then 1 + private.member_stress_pick(seed || ':presg:poc:' || t::text || ':' || p::text, run.committee_count)
      else run.committee_count + 1 + private.member_stress_pick(seed || ':presg:poe:' || t::text || ':' || p::text,
        greatest(run.member_count - run.committee_count, 1))
    end as author_ordinal,
    t0 + interval '45 days'
      + ((private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395)) || ' days')::interval
      + ((p * (1 + private.member_stress_pick(seed || ':presg:posp:' || t::text, 4))) || ' days')::interval
      + ((private.member_stress_pick(seed || ':presg:poh:' || t::text || ':' || p::text, 14)) || ' hours')::interval as created_at,
    (array[
      'Adding my story to this thread — same thing happened on my unit last month.',
      'I can take the second-floor list this week. Who wants to pair up?',
      'We talked about this at the committee meeting; the short version is below.',
      'Three more coworkers said yes after the weekend visits.',
      'Posting the recap so night shift is not left out of the loop.',
      'Remember: on breaks and off the clock, this conversation is protected.',
      'The tracker is updated. Two commitments still open for Thursday.',
      'Management posted a new flyer in the break room. Bring a photo here.',
      'This is exactly the kind of thing a first contract can fix.',
      'Welcome to the new folks in this thread — glad you are here.',
      'I read the petition draft; one sentence needs to be plainer.',
      'Count me in for turnout calls tomorrow evening.',
      'Same on overnights — we have been short two people for weeks.',
      'The community pledge got two more signatures at the farmers market.',
      'Let us keep this thread to facts we can source, and label the rest as rumor.',
      'Great one-on-one today. The tip about listening first really works.'
    ])[1 + private.member_stress_pick(seed || ':presg:pob1:' || t::text || ':' || p::text, 16)]
    || case when private.member_stress_rand(seed || ':presg:pob2:' || t::text || ':' || p::text) < 0.6
      then ' ' || (array[
        'Details in the next committee recap.',
        'Reply here if you can help.',
        'I will follow up on shift tomorrow.',
        'Ping a captain if anything is unclear.',
        'More at Thursday''s meeting.',
        'Thanks everyone — this is how we win.'
      ])[1 + private.member_stress_pick(seed || ':presg:pob3:' || t::text || ':' || p::text, 6)]
      else '' end as body
  from generate_series(1, 130) t
  cross join lateral generate_series(1, 20 + private.member_stress_pick(seed || ':presg:pon:' || t::text, 50)) s(p);

  for author in select distinct author_ordinal as ordinal from pg_temp.presg_post_plan order by 1
  loop
    perform private.presg_demo_impersonate(private.presg_demo_user_id(p_run_id, author.ordinal));
    insert into public.chapter_thread_posts (id, thread_id, chapter_id, author_id, body, created_at)
    select plan.id, plan.thread_id, 'presg', private.presg_demo_user_id(p_run_id, author.ordinal), plan.body, plan.created_at
    from pg_temp.presg_post_plan plan
    where plan.author_ordinal = author.ordinal
    on conflict (id) do nothing;
  end loop;

  -- The committee task board. prepare_chapter_task forces created_at = now()
  -- and makes it immutable, so this is seeded as the LIVE board: start and due
  -- dates carry the four-year spread, statuses carry the mix. Re-runs are
  -- guarded by presence because task numbering is a counter, not a natural key.
  if not exists (select 1 from public.chapter_tasks where chapter_id = 'presg') then
    tasks_seeded := true;
    for author in
      select distinct 1 + private.member_stress_pick(seed || ':presg:tkcr:' || k::text,
        run.committee_count) as ordinal
      from generate_series(1, 90) k
    loop
      perform private.presg_demo_impersonate(private.presg_demo_user_id(p_run_id, author.ordinal));
      insert into public.chapter_tasks (id, chapter_id, title, description, status, priority, workstream,
        assignee_id, start_date, due_date, progress, blocked, milestone, order_index, task_number)
      select
        private.member_stress_uuid(seed || ':presg:task:' || k::text),
        'presg',
        (array[
          'Map the second floor, one conversation at a time',
          'Follow up with the night shift crew',
          'Print window signs and buttons',
          'Confirm the hall booking for the all-staff meeting',
          'Draft the staffing petition text',
          'One-on-ones: transportation team',
          'Update the assessment wall',
          'Prep the captive-audience meeting response',
          'Translate the flyer to Spanish',
          'Refresh the call tree',
          'Welcome packet for new supporters',
          'Collect schedule-change stories',
          'Book childcare for the all-staff meeting',
          'Update the community media list',
          'Collect questions for the legal briefing',
          'Turnout calls for Thursday',
          'Inoculation training plan',
          'Election filing checklist review'
        ])[1 + (k % 18)] || ' · T' || k::text,
        'Campaign task tracked by the organizing committee.',
        case when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.5 then 'done'
             when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.68 then 'in_progress'
             when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.84 then 'to_do'
             when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.94 then 'backlog'
             else 'needs_review' end,
        (array['low', 'medium', 'medium', 'high'])[1 + private.member_stress_pick(seed || ':presg:tkpr:' || k::text, 4)],
        (array['General', 'Outreach', 'House visits', 'Meetings & actions', 'Election readiness'])
          [1 + private.member_stress_pick(seed || ':presg:tkws:' || k::text, 5)],
        private.presg_demo_user_id(p_run_id, 1 + private.member_stress_pick(seed || ':presg:tkas:' || k::text, run.committee_count)),
        case when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.5
          then (pg_catalog.now() - ((30 + private.member_stress_pick(seed || ':presg:tksd:' || k::text, 1370)) || ' days')::interval)::date
          else (pg_catalog.now() - ((private.member_stress_pick(seed || ':presg:tksd:' || k::text, 21)) || ' days')::interval)::date end,
        case when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.5
          then (pg_catalog.now() - ((9 + private.member_stress_pick(seed || ':presg:tksd:' || k::text, 1370)) || ' days')::interval)::date + 21
          else (pg_catalog.now() + ((3 + private.member_stress_pick(seed || ':presg:tkdd:' || k::text, 24)) || ' days')::interval)::date end,
        case when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.5 then 100
             when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.68
               then 20 + private.member_stress_pick(seed || ':presg:tkpg:' || k::text, 70)
             else 0 end,
        private.member_stress_rand(seed || ':presg:tkbl:' || k::text) < 0.05,
        k % 12 = 0,
        k, 0
      from generate_series(1, 90) g(k)
      where 1 + private.member_stress_pick(seed || ':presg:tkcr:' || k::text, run.committee_count) = author.ordinal;
    end loop;

    insert into public.chapter_task_comments (id, task_id, chapter_id, author_id, body, created_at)
    select
      private.member_stress_uuid(seed || ':presg:tkcm:' || k::text || ':' || c::text),
      private.member_stress_uuid(seed || ':presg:task:' || k::text),
      'presg',
      private.presg_demo_user_id(p_run_id, 1 + private.member_stress_pick(seed || ':presg:tkca:' || k::text || ':' || c::text, run.committee_count)),
      (array[
        'On it — will report back at the next committee meeting.',
        'Done for my floor; two conversations still open on nights.',
        'Blocked until we hear back about the hall. Chasing it.',
        'Handing this to a captain with more contacts on that team.',
        'Numbers updated on the wall chart.',
        'Can someone double-check the Spanish version?'
      ])[1 + private.member_stress_pick(seed || ':presg:tkcb:' || k::text || ':' || c::text, 6)],
      pg_catalog.now() - ((private.member_stress_pick(seed || ':presg:tkct:' || k::text || ':' || c::text, 46) + 1) || ' hours')::interval
    from generate_series(1, 90) g(k)
    cross join lateral generate_series(1, private.member_stress_pick(seed || ':presg:tkcn:' || k::text, 4)) s(c)
    on conflict (id) do nothing;
  end if;

  perform private.presg_demo_sweep_trigger_rows(p_run_id);

  select pg_catalog.count(*) into thread_count from public.chapter_threads where chapter_id = 'presg';
  select pg_catalog.count(*) into post_count from public.chapter_thread_posts where chapter_id = 'presg';
  return jsonb_build_object(
    'spaces', (select pg_catalog.count(*) from public.chapter_spaces where chapter_id = 'presg'),
    'threads', thread_count,
    'posts', post_count,
    'tasks', (select pg_catalog.count(*) from public.chapter_tasks where chapter_id = 'presg'),
    'tasks_seeded_this_call', tasks_seeded);
end;
$$;

-- --------------------------------------------------- 7. per-employee history --

create function public.presg_demo_enrich_batch(
  p_run_id uuid,
  p_phase text,
  p_start_ordinal integer,
  p_batch_count integer,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
  touched bigint := 0;
  seed text := p_run_id::text;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 2000 or p_start_ordinal < 1 then
    raise exception 'invalid enrichment batch range';
  end if;
  select * into run from private.presg_demo_runs where id = p_run_id;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied to enrich (state %)', run.state;
  end if;

  if p_phase = 'roles' then
    -- The organizing committee: chapter-scoped steward equivalents. The lead
    -- also carries coordinator+admin and the second seat carries advisor so
    -- every staff surface has at least one working demo identity.
    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, 'steward', 'presg',
      private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) + interval '30 days', null
    from private.presg_demo_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.committee
    on conflict (user_id, role) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, extra.role, 'presg', t0 + interval '120 days', null
    from private.presg_demo_ledger l
    join (values (1, 'coordinator'), (1, 'admin'), (2, 'advisor')) extra(ordinal, role)
      on extra.ordinal = l.ordinal
    where l.run_id = p_run_id and l.ordinal between lo and hi
    on conflict (user_id, role) do nothing;

    insert into public.member_role_chapters (user_id, role, chapter_id, granted_at, granted_by)
    select r.user_id, r.role, 'presg', r.granted_at, r.granted_by
    from public.member_roles r
    join private.presg_demo_ledger l on l.user_id = r.user_id and l.run_id = p_run_id
    where l.ordinal between lo and hi
    on conflict (user_id, role, chapter_id) do nothing;

    insert into public.organization_role_grants (organization_id, user_id, role, granted_at, granted_by)
    select private.member_stress_uuid(p_run_id::text || ':presg:organization'), r.user_id, r.role,
      r.granted_at, r.granted_by
    from public.member_roles r
    join private.presg_demo_ledger l on l.user_id = r.user_id and l.run_id = p_run_id
    where l.ordinal between lo and hi
    on conflict (organization_id, user_id, role) do nothing;

  elsif p_phase = 'texture' then
    -- Conversations with the committee plus the notification feed. Seeded
    -- notifications stay kind 'general' — the outbound rule at the top of
    -- this file — and read like the campaign.
    with tgt as (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    convs as (
      select t.*, slot.n as slot, slot.title, slot.initials,
        private.member_stress_uuid(t.s || ':presg:conv:' || slot.n::text) as conv_id,
        4 + (case when t.committee then 24 else 0 end)
          + private.member_stress_pick(t.s || ':presg:msgs:' || slot.n::text,
              case when t.committee then 60 else 16 end) as msg_count
      from tgt t
      cross join (values
        (1, 'Organizing committee', 'OC'),
        (2, 'Committee captains', 'CC'),
        (3, 'Membership questions', 'MQ')
      ) slot(n, title, initials)
      where slot.n = 1
        or (slot.n = 2 and t.committee)
        or (slot.n = 3 and not t.committee
            and private.member_stress_rand(t.s || ':presg:conv3') < 0.35)
    ),
    conv_ins as (
      insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at)
      select c.conv_id, c.user_id, c.title, c.initials,
        c.joined + interval '2 days',
        c.joined + interval '2 days'
          + (((c.msg_count - 1)::double precision / c.msg_count)
             * extract(epoch from (pg_catalog.now() - interval '1 day' - (c.joined + interval '2 days'))) || ' seconds')::interval
      from convs c
      on conflict (id) do nothing
      returning 1
    )
    select pg_catalog.count(*) into touched from conv_ins;

    with tgt as (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    convs as (
      select t.*, slot.n as slot,
        private.member_stress_uuid(t.s || ':presg:conv:' || slot.n::text) as conv_id,
        4 + (case when t.committee then 24 else 0 end)
          + private.member_stress_pick(t.s || ':presg:msgs:' || slot.n::text,
              case when t.committee then 60 else 16 end) as msg_count
      from tgt t
      cross join (values (1), (2), (3)) slot(n)
      where slot.n = 1
        or (slot.n = 2 and t.committee)
        or (slot.n = 3 and not t.committee
            and private.member_stress_rand(t.s || ':presg:conv3') < 0.35)
    ),
    msgs as (
      select c.*, m.i,
        c.joined + interval '2 days'
          + (((m.i - 1)::double precision / c.msg_count)
             * extract(epoch from (pg_catalog.now() - interval '1 day' - (c.joined + interval '2 days'))) || ' seconds')::interval
          as msg_at,
        private.member_stress_rand(c.s || ':presg:mwho:' || c.slot::text || ':' || m.i::text) < 0.48 as from_member
      from convs c
      cross join lateral generate_series(1, c.msg_count) m(i)
    )
    insert into public.member_messages (id, conversation_id, user_id, sender_kind, sender_name, body, read_at, created_at)
    select
      private.member_stress_uuid(m.s || ':presg:msg:' || m.slot::text || ':' || m.i::text),
      m.conv_id, m.user_id,
      case when m.from_member then 'member' else 'steward' end,
      case when m.from_member
        then private.presg_demo_full_name(p_run_id, m.ordinal)
        else private.presg_demo_full_name(p_run_id,
          1 + private.member_stress_pick(m.s || ':presg:mstw:' || m.slot::text || ':' || m.i::text, run.committee_count))
      end,
      (array[
        'Thanks for signing on — want to grab five minutes before your shift this week?',
        'Quick check-in: how did the conversation with your coworker go?',
        'The committee meets Thursday at 6. Can you make it?',
        'I logged the schedule story you told me. It is going in the tracker.',
        'What questions do you have before the all-staff meeting?',
        'Two people on your team asked about card signing — can you introduce me?',
        'Reminder that this stays between us until we go public.',
        'That meeting they pulled you into: you had the right to stay silent about the campaign.',
        'We hit the next card milestone. Do not post it publicly yet.',
        'Can you take a turnout list for Thursday? Ten names, all your floor.',
        'The petition text is ready for feedback in the channel.',
        'Welcome! A captain covers your program — expect a hello this week.',
        'I can talk after 7 most nights, whatever works for you.',
        'Yes — count me in for the weekend visits.',
        'I was nervous about the button but three of us wore it together.',
        'Management asked me about the union today. I said we can talk on my break.',
        'My coworker wants to sign. What is the next step?',
        'Got it, I will bring the stories to the meeting.',
        'The night shift feels left out — can someone come by at 11?',
        'Thanks for checking in. This week was rough but we are still in.',
        'I read the rights lesson — the captive-audience part was new to me.',
        'Adding two names to the turnout list now.',
        'Done. Both conversations went better than expected.',
        'See you Thursday.'
      ])[1 + private.member_stress_pick(m.s || ':presg:mbody:' || m.slot::text || ':' || m.i::text, 24)],
      case when m.i >= m.msg_count - 1 and not m.from_member
             and private.member_stress_rand(m.s || ':presg:mrd:' || m.slot::text || ':' || m.i::text) < 0.55
        then null
        else m.msg_at + interval '9 hours' end,
      m.msg_at
    from msgs m
    on conflict (id) do nothing;

    with tgt as (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    feed as (
      select t.*, n.i,
        pg_catalog.now()
          - ((pg_catalog.floor(pg_catalog.power(private.member_stress_rand(t.s || ':presg:nage:' || n.i::text), 2) * 150) + 1) || ' days')::interval
          - ((private.member_stress_pick(t.s || ':presg:nhr:' || n.i::text, 22) + 1) || ' hours')::interval as at
      from tgt t
      cross join lateral generate_series(1,
        case when t.committee then 24 + private.member_stress_pick(t.s || ':presg:nn', 26)
             else 4 + private.member_stress_pick(t.s || ':presg:nn', 14) end) n(i)
    )
    insert into public.member_notifications (id, user_id, title, body, kind, read_at, created_at)
    select
      private.member_stress_uuid(f.s || ':presg:ntf:' || f.i::text),
      f.user_id,
      (array[
        'New reply in your chapter thread',
        'Card count milestone reached',
        'Committee meeting tomorrow',
        'Your issue report was received',
        'All-staff meeting RSVP is open',
        'New rights lesson: captive-audience meetings',
        'Petition draft ready for review',
        'House-visit debrief posted',
        'Election readiness checklist updated',
        'Thanks for talking with your coworkers'
      ])[1 + private.member_stress_pick(f.s || ':presg:nti:' || f.i::text, 10)],
      (array[
        'A committee member replied to the thread you follow.',
        'Another floor crossed majority support this week.',
        'Agenda and location are posted in the Actions channel.',
        'A committee member picked it up and will follow through with you.',
        'Reserve your spot so we can plan the room and childcare.',
        'Three minutes on what management can and cannot do in mandatory meetings.',
        'Read the draft and leave one comment before Friday.',
        'Weekend numbers and the next route list are in the channel.',
        'Two items left before the filing window opens.',
        'Every one-on-one moves the campaign. Log it when you can.'
      ])[1 + private.member_stress_pick(f.s || ':presg:nbo:' || f.i::text, 10)],
      'general',
      case when private.member_stress_rand(f.s || ':presg:nrd:' || f.i::text) < 0.62
        then f.at + ((1 + private.member_stress_pick(f.s || ':presg:nrh:' || f.i::text, 60)) || ' hours')::interval
        else null end,
      f.at
    from feed f
    on conflict (id) do nothing;

  elsif p_phase = 'casework' then
    -- Workplace issues tracked with the committee. Pre-union: the legal
    -- grounding is the NLRA, not contract articles, and the assigned
    -- "steward" is a committee member.
    with tgt as (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    cased as (
      select t.*, c.slot,
        private.member_stress_uuid(t.s || ':presg:case:' || c.slot::text) as case_id,
        private.member_stress_pick(t.s || ':presg:ctype:' || c.slot::text, 6) as type_idx,
        t.joined + interval '20 days'
          + ((private.member_stress_pick(t.s || ':presg:cage:' || c.slot::text,
              greatest((extract(epoch from (pg_catalog.now() - t.joined)) / 86400)::integer - 30, 1))) || ' days')::interval as opened,
        1 + private.member_stress_pick(t.s || ':presg:cstw:' || c.slot::text, run.committee_count) as steward_ordinal
      from tgt t
      cross join (values (1), (2)) c(slot)
      where (c.slot = 1 and private.member_stress_rand(t.s || ':presg:hascase')
              < case when t.committee then 0.55 else 0.30 end)
         or (c.slot = 2 and private.member_stress_rand(t.s || ':presg:hascase2') < 0.08)
    ),
    case_ins as (
      insert into public.member_cases (id, user_id, reference, title, deadline, case_type, articles, step,
        status, steward_user_id, steward_name, assigned_at, created_at, updated_at,
        deadline_notice_7_sent_at, deadline_notice_3_sent_at, deadline_notice_1_sent_at)
      select
        c.case_id, c.user_id,
        'PSG-' || pg_catalog.to_char(c.opened, 'YYYY') || '-' || pg_catalog.lpad((c.ordinal * 2 - 2 + c.slot)::text, 5, '0'),
        (array[
          'Schedule changed without notice',
          'Unsafe overnight staffing',
          'Chronic short-staffing on the unit',
          'Missing overtime pay',
          'Written up after speaking up',
          'Hours cut after wearing a button'
        ])[1 + c.type_idx],
        case when c.opened > pg_catalog.now() - interval '75 days'
          then (pg_catalog.now() + ((5 + private.member_stress_pick(c.s || ':presg:cdl:' || c.slot::text, 40)) || ' days')::interval)::date
          else (c.opened + interval '45 days')::date end,
        (array['Scheduling', 'Safety', 'Staffing', 'Pay accuracy', 'Discipline', 'Retaliation'])[1 + c.type_idx],
        (array[
          'NLRA §7 — protected concerted activity',
          'OSHA general duty · NLRA §7',
          'NLRA §7 — protected concerted activity',
          'FLSA wage claim · NLRA §7',
          'NLRA §8(a)(1) — interference',
          'NLRA §8(a)(3) — retaliation'
        ])[1 + c.type_idx],
        case when c.opened > pg_catalog.now() - interval '75 days'
          then (array['Documenting', 'Raised with management', 'Group action planned'])
            [1 + private.member_stress_pick(c.s || ':presg:cstep:' || c.slot::text, 3)]
          else 'Closed' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then 'active' else 'resolved' end,
        private.presg_demo_user_id(p_run_id, c.steward_ordinal),
        private.presg_demo_full_name(p_run_id, c.steward_ordinal),
        c.opened + interval '2 days',
        c.opened,
        c.opened + interval '9 days',
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '38 days' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '42 days' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '44 days' end
      from cased c
      on conflict (id) do nothing
      returning 1
    )
    select pg_catalog.count(*) into touched from case_ins;

    insert into public.member_case_updates (id, case_id, user_id, body, created_at)
    select
      private.member_stress_uuid(l.user_id::text || ':presg:cu:' || c.id::text || ':' || g.i::text),
      c.id, c.user_id,
      (array[
        'Logged the incident with dates, shifts and witnesses.',
        'Committee raised it in the group meeting with the program director.',
        'Management promised a written answer by Friday. Clock started.',
        'Added to the petition evidence pack with the member''s consent.',
        'Fixed — schedule restored. Keeping the documentation anyway.',
        'Escalating: three coworkers reported the same thing this month.'
      ])[1 + private.member_stress_pick(seed || ':presg:cub:' || c.id::text || ':' || g.i::text, 6)],
      c.created_at + ((g.i * (5 + private.member_stress_pick(seed || ':presg:cud:' || c.id::text || ':' || g.i::text, 12))) || ' days')::interval
    from private.presg_demo_ledger l
    join public.member_cases c on c.user_id = l.user_id
    cross join lateral generate_series(1, 1 + private.member_stress_pick(seed || ':presg:cun:' || c.id::text, 3)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and c.reference like 'PSG-%'
    on conflict (id) do nothing;

    -- Help requests to the committee, inserted in FINAL status (the
    -- award-on-acknowledgment trigger is UPDATE-only and must stay silent).
    insert into public.member_steward_requests (id, user_id, lesson_id, status, created_at, acknowledged_at, closed_at, handled_by)
    select
      private.member_stress_uuid(t.s || ':presg:sreq'),
      t.user_id,
      case when private.member_stress_rand(t.s || ':presg:srl') < 0.5 then null
        else (select les.id from public.member_rights_lessons les
          order by les.id
          offset private.member_stress_pick(t.s || ':presg:srlx',
            greatest((select pg_catalog.count(*)::integer from public.member_rights_lessons), 1))
          limit 1) end,
      case when private.member_stress_rand(t.s || ':presg:srs') < 0.12 then 'requested'
           when private.member_stress_rand(t.s || ':presg:srs') < 0.56 then 'acknowledged'
           else 'closed' end,
      case when private.member_stress_rand(t.s || ':presg:srs') < 0.12
        then pg_catalog.now() - ((1 + private.member_stress_pick(t.s || ':presg:srd', 9)) || ' days')::interval
        else t.joined + interval '15 days'
          + ((private.member_stress_pick(t.s || ':presg:srd',
              greatest((extract(epoch from (pg_catalog.now() - t.joined)) / 86400)::integer - 20, 1))) || ' days')::interval
      end,
      case when private.member_stress_rand(t.s || ':presg:srs') >= 0.12
        then t.joined + interval '16 days' end,
      case when private.member_stress_rand(t.s || ':presg:srs') >= 0.56
        then t.joined + interval '19 days' end,
      private.presg_demo_user_id(p_run_id, 1 + private.member_stress_pick(t.s || ':presg:srh', run.committee_count))
    from (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi and not l.committee
    ) t
    where private.member_stress_rand(t.s || ':presg:hasreq') < 0.45
    on conflict (id) do nothing;

    perform private.presg_demo_sweep_trigger_rows(p_run_id);

  elsif p_phase = 'participation' then
    -- Participation rises across the campaign: the engagement probability is
    -- scaled by how far into the four years each event or vote sits, and
    -- nobody participates in anything dated before they signed on.
    insert into public.member_event_rsvps (event_id, user_id, status, created_at, updated_at)
    select e.id, l.user_id,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:rs:' || e.id) < 0.9
        then 'going' else 'not_going' end,
      e.starts_at - ((2 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:rt:' || e.id, 10)) || ' days')::interval,
      e.starts_at - ((2 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:rt:' || e.id, 10)) || ' days')::interval
    from private.presg_demo_ledger l
    cross join public.member_events e
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.chapter_id = 'presg'
      and private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) < e.starts_at - interval '3 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:rv:' || e.id)
        < case when l.committee then 0.92
            else 0.05 + 0.32 * least(extract(epoch from (e.starts_at - (pg_catalog.now() - interval '1460 days')))
              / extract(epoch from interval '1460 days'), 1.0) end
    on conflict (event_id, user_id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_event_checkins (event_id, user_id, checked_in_at, scanned_by)
    select r.event_id, r.user_id, e.starts_at + interval '11 minutes', null
    from public.member_event_rsvps r
    join public.member_events e on e.id = r.event_id
    join private.presg_demo_ledger l on l.user_id = r.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.chapter_id = 'presg'
      and e.starts_at < pg_catalog.now()
      and r.status = 'going'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:ci:' || r.event_id) < 0.66
    on conflict (event_id, user_id) do nothing;

    insert into public.member_ballot_votes (ballot_id, option_id, user_id, submitted_at)
    select b.id, o.id, l.user_id,
      coalesce(b.closed_at, pg_catalog.now())
        - ((1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:bd:' || b.id, 12)) || ' days')::interval
    from private.presg_demo_ledger l
    cross join public.member_ballots b
    join public.member_ballot_options o on o.ballot_id = b.id
      and o.order_index = 1 + case
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:bo:' || b.id) < 0.78 then 0
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:bo:' || b.id) < 0.93 then 1
        else 2 end
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and b.id like 'presg-ballot-%'
      and private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) < b.closes_at - interval '2 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:bv:' || b.id)
        < case when l.committee then 0.97
            when b.active then 0.42
            else 0.35 + 0.45 * least(extract(epoch from (b.closes_at - (pg_catalog.now() - interval '1460 days')))
              / extract(epoch from interval '1460 days'), 1.0) end
    on conflict (ballot_id, user_id) do nothing;

    insert into public.member_ballot_receipts (id, ballot_id, user_id, receipt_code, counted, issued_at)
    select
      private.member_stress_uuid(seed || ':' || l.ordinal::text || ':presg:brc:' || v.ballot_id),
      v.ballot_id, v.user_id,
      private.presg_demo_receipt_code(seed || ':' || l.ordinal::text || ':presg:brcode:' || v.ballot_id),
      true, v.submitted_at
    from public.member_ballot_votes v
    join private.presg_demo_ledger l on l.user_id = v.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and v.ballot_id like 'presg-ballot-%'
    on conflict (ballot_id, user_id) do nothing;

    insert into public.member_survey_responses (survey_id, option_id, user_id, submitted_at)
    select s.id, o.id, l.user_id,
      coalesce(s.closed_at, pg_catalog.now())
        - ((1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:sd:' || s.id, 12)) || ' days')::interval
    from private.presg_demo_ledger l
    cross join public.member_surveys s
    join public.member_survey_options o on o.survey_id = s.id
      and o.order_index = 1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:so:' || s.id,
        (select pg_catalog.count(*)::integer from public.member_survey_options o2 where o2.survey_id = s.id))
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and s.id like 'presg-pulse-%'
      and private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) < s.closes_at - interval '2 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:sv:' || s.id)
        < case when l.committee then 0.95 when s.active then 0.30 else 0.55 end
    on conflict (survey_id, user_id) do nothing;

    insert into public.member_broadcast_receipts (broadcast_id, user_id, read_at)
    select b.id, l.user_id,
      b.published_at + ((private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:brr:' || b.id, 96) + 2) || ' hours')::interval
    from private.presg_demo_ledger l
    cross join public.member_broadcasts b
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and b.id like 'presg-bc-%'
      and private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) < b.published_at
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:brd:' || b.id)
        < case when l.committee then 0.9 else 0.6 end
    on conflict (broadcast_id, user_id) do nothing;

    insert into public.member_forms (id, user_id, template_key, template_version, status, answers, step,
      submitted_at, created_at, updated_at)
    select
      private.member_stress_uuid(t.s || ':presg:form:' || f.slot::text),
      t.user_id, ft.key, ft.version,
      (array['approved', 'approved', 'submitted', 'draft'])[1 + private.member_stress_pick(t.s || ':presg:fs:' || f.slot::text, 4)],
      '{}'::jsonb, 0,
      case when (array['approved', 'approved', 'submitted', 'draft'])[1 + private.member_stress_pick(t.s || ':presg:fs:' || f.slot::text, 4)] = 'draft'
        then null else t.joined + ((30 + private.member_stress_pick(t.s || ':presg:fd:' || f.slot::text, 300)) || ' days')::interval end,
      t.joined + ((30 + private.member_stress_pick(t.s || ':presg:fd:' || f.slot::text, 300)) || ' days')::interval,
      t.joined + ((30 + private.member_stress_pick(t.s || ':presg:fd:' || f.slot::text, 300)) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join (values (1), (2)) f(slot)
    join lateral (
      select ftpl.key, ftpl.version from public.form_templates ftpl where ftpl.active
      order by ftpl.key
      offset private.member_stress_pick(t.s || ':presg:ft:' || f.slot::text,
        greatest((select pg_catalog.count(*)::integer from public.form_templates where active), 1))
      limit 1
    ) ft on true
    where (f.slot = 1 and (t.committee or private.member_stress_rand(t.s || ':presg:hasform') < 0.22))
       or (f.slot = 2 and t.committee)
    on conflict (id) do nothing;

    insert into public.member_workload_logs (id, user_id, priority, pending, unread_docs, todos, referrals,
      ce_activities, assistance_requests, aged_cases, weekly_assigned, employment, pt_hours, receipt_code,
      created_at, logged_on)
    select
      private.member_stress_uuid(t.s || ':presg:wl'),
      t.user_id,
      private.member_stress_pick(t.s || ':presg:wp', 10),
      private.member_stress_pick(t.s || ':presg:wpe', 30),
      private.member_stress_pick(t.s || ':presg:wu', 20),
      private.member_stress_pick(t.s || ':presg:wt', 25),
      private.member_stress_pick(t.s || ':presg:wr', 10),
      private.member_stress_pick(t.s || ':presg:wc', 6),
      private.member_stress_pick(t.s || ':presg:wa', 8),
      private.member_stress_pick(t.s || ':presg:wg', 12),
      10 + private.member_stress_pick(t.s || ':presg:ww', 20),
      case when private.member_stress_rand(t.s || ':presg:we') < 0.85 then 'full_time' else 'part_time' end,
      case when private.member_stress_rand(t.s || ':presg:we') < 0.85 then null
        else (16 + private.member_stress_pick(t.s || ':presg:wph', 24))::smallint end,
      pg_catalog.substr(pg_catalog.md5(t.s || ':presg:wrc'), 1, 8),
      pg_catalog.now() - ((private.member_stress_pick(t.s || ':presg:wd', 90) + 1) || ' days')::interval,
      (pg_catalog.now() - ((private.member_stress_pick(t.s || ':presg:wd', 90) + 1) || ' days')::interval)::date
    from (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    where private.member_stress_rand(t.s || ':presg:haswl') < 0.15
    on conflict (id) do nothing;

  elsif p_phase = 'history' then
    -- Backdated activity: the action log stays action_kind 'seed' so the
    -- award trigger returns immediately; points are minted directly with
    -- occurred_at at least 8 days back, outside every weekly cap window.
    insert into public.member_action_log (id, user_id, action_key, action_kind, occurred_at)
    select
      private.member_stress_uuid(t.s || ':presg:log:' || g.i::text),
      t.user_id, 'presg-log-' || t.ordinal::text || '-' || g.i::text, 'seed',
      t.joined + ((private.member_stress_pick(t.s || ':presg:logd:' || g.i::text,
        greatest(t.age_days - 2, 1))) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined,
        (extract(epoch from (pg_catalog.now() - private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count))) / 86400)::integer as age_days
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join lateral generate_series(1,
      case when t.committee then 30 + private.member_stress_pick(t.s || ':presg:logn', 30)
           else 6 + private.member_stress_pick(t.s || ':presg:logn', 14) end) g(i)
    on conflict (id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_point_events (id, user_id, action_key, action_kind, points, occurred_at)
    select
      private.member_stress_uuid(t.s || ':presg:pt:' || g.i::text),
      t.user_id, 'presg-hist-' || t.ordinal::text || '-' || g.i::text,
      (array['message', 'rsvp', 'checkin', 'survey', 'vote', 'rights', 'case', 'steward'])
        [1 + private.member_stress_pick(t.s || ':presg:ptk:' || g.i::text, 8)],
      (array[2, 5, 8, 10, 15, 20, 25, 40])[1 + private.member_stress_pick(t.s || ':presg:ptk:' || g.i::text, 8)],
      pg_catalog.now() - ((8 + private.member_stress_pick(t.s || ':presg:ptd:' || g.i::text,
        greatest(t.age_days - 10, 1))) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        (extract(epoch from (pg_catalog.now() - private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count))) / 86400)::integer as age_days
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join lateral generate_series(1,
      case when t.committee then 40 + private.member_stress_pick(t.s || ':presg:ptn', 70)
           else 1 + private.member_stress_pick(t.s || ':presg:ptn', 18) end) g(i)
    on conflict (user_id, action_key) do nothing;

    insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
    select les.id, l.user_id,
      case when l.committee then array[0, 1, 2]
        else case private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:rp:' || les.id, 3)
          when 0 then array[0]
          when 1 then array[0, 1]
          else array[0, 1, 2]
        end end
    from private.presg_demo_ledger l
    cross join public.member_rights_lessons les
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and (l.committee or private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:rl:' || les.id) < 0.42)
    on conflict (lesson_id, user_id) do nothing;

    with topics as (
      select * from (values
        (0, 'Can they fire me for organizing?',
            'Retaliation for protected concerted activity is illegal under the NLRA. Document everything and tell a committee member the same day.'),
        (1, 'What is a captive-audience meeting?',
            'A mandatory meeting where management argues against the union. You have rights about what you must answer; here they are with citations.'),
        (2, 'How does a union election work?',
            'Cards, the petition, the campaign window, and the secret-ballot vote — the whole timeline in plain language.'),
        (3, 'What are authorization cards?',
            'A signed card says you want the union to represent you. Signatures are confidential from the employer.'),
        (4, 'Can my manager ask me about the union?',
            'They can talk; they cannot interrogate, threaten, promise or spy. The TIPS rule, explained.'),
        (5, 'What would dues cost?',
            'Nobody pays dues until there is a first contract that members vote to approve.'),
        (6, 'What happens after we win the vote?',
            'Certification, bargaining committee elections, and the survey that sets contract priorities.'),
        (7, 'Is my signature confidential?',
            'Yes — cards go to the labor board, never to the employer.')
      ) v(idx, q, a)
    ),
    gthreads as (
      select t.ordinal, t.user_id, t.s, t.joined, g.i,
        private.member_stress_uuid(t.s || ':presg:gt:' || g.i::text) as thread_id,
        private.member_stress_pick(t.s || ':presg:gtt:' || g.i::text, 8) as topic_idx,
        t.joined + ((10 + private.member_stress_pick(t.s || ':presg:gtd:' || g.i::text,
          greatest(t.age_days - 12, 1))) || ' days')::interval as at
      from (
        select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
          private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined,
          (extract(epoch from (pg_catalog.now() - private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count))) / 86400)::integer as age_days
        from private.presg_demo_ledger l
        where l.run_id = p_run_id and l.ordinal between lo and hi
      ) t
      cross join lateral generate_series(1,
        case when t.committee then 2 + private.member_stress_pick(t.s || ':presg:gtn', 3)
             else 1 end) g(i)
      where t.committee or private.member_stress_rand(t.s || ':presg:hasgt') < 0.22
    ),
    thread_ins as (
      insert into public.member_guide_threads (id, user_id, title, created_at, updated_at)
      select g.thread_id, g.user_id, topics.q, g.at, g.at
      from gthreads g join topics on topics.idx = g.topic_idx
      on conflict (id) do nothing
      returning 1
    )
    insert into public.member_guide_messages (id, thread_id, user_id, role, body, created_at)
    select
      private.member_stress_uuid(g.s || ':presg:gm:' || g.i::text || ':' || m.n::text),
      g.thread_id, g.user_id, m.role,
      case when m.role = 'user' then topics.q else topics.a end,
      g.at + m.offs
    from gthreads g
    join topics on topics.idx = g.topic_idx
    cross join (values ('user', interval '0 seconds', 1), ('assistant', interval '8 seconds', 2)) m(role, offs, n)
    on conflict (id) do nothing;

  else
    raise exception 'unknown presg enrichment phase %', p_phase;
  end if;

  return jsonb_build_object('phase', p_phase, 'from', lo, 'to', hi, 'touched', touched);
end;
$$;

-- ------------------------------------------------------ 8. status and verify --

create function public.presg_demo_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '180s'
as $$
declare
  run private.presg_demo_runs%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'presg demo RPC requires service_role'; end if;
  select * into run from private.presg_demo_runs where id = p_run_id;
  if not found then raise exception 'unknown presg demo run'; end if;
  return jsonb_build_object(
    'run_id', run.id,
    'state', run.state,
    'members_expected', run.member_count,
    'committee_expected', run.committee_count,
    'logins_expected', run.login_count,
    'ledger_rows', (select pg_catalog.count(*) from private.presg_demo_ledger where run_id = p_run_id),
    'auth_users', (select pg_catalog.count(*) from auth.users u join private.presg_demo_ledger l on l.user_id = u.id where l.run_id = p_run_id),
    'profiles', (select pg_catalog.count(*) from public.member_profiles p join private.presg_demo_ledger l on l.user_id = p.id where l.run_id = p_run_id),
    'steward_roles', (select pg_catalog.count(*) from public.member_roles r join private.presg_demo_ledger l on l.user_id = r.user_id where l.run_id = p_run_id and r.role = 'steward'),
    'conversations', (select pg_catalog.count(*) from public.member_conversations c join private.presg_demo_ledger l on l.user_id = c.user_id where l.run_id = p_run_id),
    'messages', (select pg_catalog.count(*) from public.member_messages m join private.presg_demo_ledger l on l.user_id = m.user_id where l.run_id = p_run_id),
    'notifications', (select pg_catalog.count(*) from public.member_notifications n join private.presg_demo_ledger l on l.user_id = n.user_id where l.run_id = p_run_id),
    'cases', (select pg_catalog.count(*) from public.member_cases c join private.presg_demo_ledger l on l.user_id = c.user_id where l.run_id = p_run_id),
    'steward_requests', (select pg_catalog.count(*) from public.member_steward_requests s join private.presg_demo_ledger l on l.user_id = s.user_id where l.run_id = p_run_id),
    'event_rsvps', (select pg_catalog.count(*) from public.member_event_rsvps r join private.presg_demo_ledger l on l.user_id = r.user_id where l.run_id = p_run_id),
    'event_checkins', (select pg_catalog.count(*) from public.member_event_checkins c join private.presg_demo_ledger l on l.user_id = c.user_id where l.run_id = p_run_id),
    'ballot_votes', (select pg_catalog.count(*) from public.member_ballot_votes v join private.presg_demo_ledger l on l.user_id = v.user_id where l.run_id = p_run_id),
    'ballot_receipts', (select pg_catalog.count(*) from public.member_ballot_receipts b join private.presg_demo_ledger l on l.user_id = b.user_id where l.run_id = p_run_id),
    'survey_responses', (select pg_catalog.count(*) from public.member_survey_responses s join private.presg_demo_ledger l on l.user_id = s.user_id where l.run_id = p_run_id),
    'broadcast_receipts', (select pg_catalog.count(*) from public.member_broadcast_receipts b join private.presg_demo_ledger l on l.user_id = b.user_id where l.run_id = p_run_id),
    'forms', (select pg_catalog.count(*) from public.member_forms f join private.presg_demo_ledger l on l.user_id = f.user_id where l.run_id = p_run_id),
    'point_events', (select pg_catalog.count(*) from public.member_point_events e join private.presg_demo_ledger l on l.user_id = e.user_id where l.run_id = p_run_id),
    'action_log', (select pg_catalog.count(*) from public.member_action_log a join private.presg_demo_ledger l on l.user_id = a.user_id where l.run_id = p_run_id),
    'rights_progress', (select pg_catalog.count(*) from public.member_rights_progress r join private.presg_demo_ledger l on l.user_id = r.user_id where l.run_id = p_run_id),
    'guide_threads', (select pg_catalog.count(*) from public.member_guide_threads t join private.presg_demo_ledger l on l.user_id = t.user_id where l.run_id = p_run_id),
    'org_events', (select pg_catalog.count(*) from public.member_events where chapter_id = 'presg'),
    'org_ballots', (select pg_catalog.count(*) from public.member_ballots where id like 'presg-ballot-%'),
    'org_broadcasts', (select pg_catalog.count(*) from public.member_broadcasts where id like 'presg-bc-%'),
    'org_threads', (select pg_catalog.count(*) from public.chapter_threads where chapter_id = 'presg'),
    'org_thread_posts', (select pg_catalog.count(*) from public.chapter_thread_posts where chapter_id = 'presg'),
    'org_tasks', (select pg_catalog.count(*) from public.chapter_tasks where chapter_id = 'presg'),
    'protected_unchanged', run.protected_snapshot = private.presg_demo_protected_snapshot(p_run_id));
end;
$$;

create function public.presg_demo_verify(p_run_id uuid, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  result jsonb;
  typed_kinds bigint;
  deliveries bigint;
  fresh_points bigint;
  cases_total bigint;
  cases_distinct bigint;
  guarded_prefs bigint;
  login_rows bigint;
  password_sample bigint;
  sample_size integer;
  passed boolean;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'presg demo RPC requires service_role'; end if;
  if pg_catalog.char_length(coalesce(p_password, '')) < 24 then raise exception 'demo password is too short'; end if;
  select * into run from private.presg_demo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('applied', 'verified') then raise exception 'run is not fully applied'; end if;

  result := public.presg_demo_status(p_run_id);

  select pg_catalog.count(*) into typed_kinds
  from public.member_notifications n
  join private.presg_demo_ledger l on l.user_id = n.user_id and l.run_id = p_run_id
  where n.kind <> 'general';

  select pg_catalog.count(*) into deliveries
  from public.member_notification_deliveries d
  join private.presg_demo_ledger l on l.user_id = d.user_id and l.run_id = p_run_id;

  select pg_catalog.count(*) into fresh_points
  from public.member_point_events e
  join private.presg_demo_ledger l on l.user_id = e.user_id and l.run_id = p_run_id
  where e.occurred_at >= pg_catalog.date_trunc('week', pg_catalog.now());

  select pg_catalog.count(*), pg_catalog.count(distinct c.reference)
    into cases_total, cases_distinct
  from public.member_cases c
  join private.presg_demo_ledger l on l.user_id = c.user_id and l.run_id = p_run_id;

  select pg_catalog.count(*) into guarded_prefs
  from public.member_profiles p
  join private.presg_demo_ledger l on l.user_id = p.id and l.run_id = p_run_id
  where p.notification_prefs @> '{"deadlines": false, "cases": false, "forms": false, "votes": false, "events": false, "tasks": false, "appointments": false, "workload": false}'::jsonb;

  -- bcrypt comparison is ~100ms per row; a deterministic sample proves the
  -- shared password while the cheap count proves every login row is non-empty.
  sample_size := least(run.login_count, 20);
  select pg_catalog.count(*) into password_sample
  from auth.users u
  join private.presg_demo_ledger l on l.user_id = u.id
  where l.run_id = p_run_id and l.login_capable and l.ordinal <= sample_size
    -- The CASE is load-bearing: without it the planner may evaluate crypt()
    -- against a non-login row's empty hash first and raise "invalid salt".
    and case when u.encrypted_password like '$2%'
      then u.encrypted_password = extensions.crypt(p_password, u.encrypted_password)
      else false end;

  select pg_catalog.count(*) into login_rows
  from auth.users u
  join private.presg_demo_ledger l on l.user_id = u.id
  where l.run_id = p_run_id and l.login_capable and u.encrypted_password <> '';

  passed :=
    (result ->> 'ledger_rows')::bigint = run.member_count
    and (result ->> 'auth_users')::bigint = run.member_count
    and (result ->> 'profiles')::bigint = run.member_count
    and (result ->> 'steward_roles')::bigint = run.committee_count
    and guarded_prefs = run.member_count
    and typed_kinds = 0
    and deliveries = 0
    and fresh_points = 0
    and cases_total = cases_distinct
    and password_sample = sample_size
    and login_rows = run.login_count
    and (result ->> 'conversations')::bigint >= run.member_count
    and (result ->> 'messages')::bigint >= run.member_count * 4
    and (result ->> 'org_events')::bigint >= 60
    and (result ->> 'org_ballots')::bigint = 6
    and (result ->> 'org_broadcasts')::bigint >= 90
    and (result ->> 'org_threads')::bigint >= 100
    and (result ->> 'org_thread_posts')::bigint >= 1500
    and (result ->> 'protected_unchanged')::boolean;

  if passed then
    update private.presg_demo_runs
    set state = 'verified', verified_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_run_id;
  end if;
  return result || jsonb_build_object(
    'typed_notification_kinds', typed_kinds,
    'outbound_deliveries', deliveries,
    'points_in_current_week', fresh_points,
    'cases_distinct_refs', cases_distinct,
    'guarded_prefs', guarded_prefs,
    'password_sample', password_sample,
    'password_sample_size', sample_size,
    'login_rows', login_rows,
    'state', case when passed then 'verified' else run.state end,
    'ok', passed);
end;
$$;

-- ------------------------------------------------------------- 9. removal ----

create function public.presg_demo_begin_remove(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '120s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  collision_count bigint;
  remaining bigint;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.presg_demo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state = 'removed' then return jsonb_build_object('state', 'removed', 'remaining', 0, 'resumed', true); end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified', 'removing') then
    raise exception 'run cannot be removed';
  end if;
  if run.protected_snapshot <> private.presg_demo_protected_snapshot(p_run_id) then
    raise exception 'non-demo user snapshot changed; removal stopped';
  end if;
  select pg_catalog.count(*) into collision_count
  from auth.users users
  join private.presg_demo_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id
    and (pg_catalog.lower(users.email) <> ledger.email
      or coalesce(users.raw_app_meta_data ->> 'presg_demo_run_id', '') <> p_run_id::text);
  if collision_count <> 0 then raise exception 'removal preflight found non-owned auth rows'; end if;
  update private.presg_demo_runs set state = 'removing', updated_at = pg_catalog.now() where id = p_run_id;
  select pg_catalog.count(*) into remaining from auth.users users
  join private.presg_demo_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  return jsonb_build_object('state', 'removing', 'remaining', remaining, 'resumed', run.state = 'removing');
end;
$$;

create function public.presg_demo_remove_batch(
  p_run_id uuid,
  p_batch_count integer,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  deleted_count bigint;
  remaining bigint;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 2000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.presg_demo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state = 'removed' then return jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed'); end if;
  if run.state <> 'removing' then raise exception 'removal preflight has not passed'; end if;

  -- The task board and channels are removed BEFORE any auth user: deleting a
  -- user first would cascade SET NULL onto chapter_tasks identity columns,
  -- fire the audit trigger, and insert an activity row whose actor_id is the
  -- identity mid-delete — a foreign-key violation. Idempotent per batch call.
  delete from public.chapter_task_activity where chapter_id = 'presg';
  delete from public.chapter_task_comments where chapter_id = 'presg';
  delete from public.chapter_task_assignments where chapter_id = 'presg';
  delete from public.chapter_task_subtasks where chapter_id = 'presg';
  delete from public.chapter_task_attachments where chapter_id = 'presg';
  delete from public.chapter_task_files where chapter_id = 'presg';
  delete from public.chapter_task_messages where chapter_id = 'presg';
  delete from public.chapter_task_watchers where chapter_id = 'presg';
  delete from public.chapter_task_dependencies where chapter_id = 'presg';
  delete from public.chapter_task_template_details where chapter_id = 'presg';
  delete from public.chapter_tasks where chapter_id = 'presg';
  delete from public.chapter_thread_posts where chapter_id = 'presg';
  delete from public.chapter_threads where chapter_id = 'presg';
  delete from public.chapter_space_members m
    using public.chapter_spaces s where s.id = m.space_id and s.chapter_id = 'presg';
  delete from public.chapter_spaces where chapter_id = 'presg';

  with selected as (
    select users.id
    from auth.users users
    join private.presg_demo_ledger ledger on ledger.user_id = users.id
    where ledger.run_id = p_run_id
      and pg_catalog.lower(users.email) = ledger.email
      and users.raw_app_meta_data ->> 'presg_demo_run_id' = p_run_id::text
    order by ledger.ordinal
    limit p_batch_count
  ), deleted as (
    delete from auth.users users using selected where users.id = selected.id returning users.id
  ) select pg_catalog.count(*) into deleted_count from deleted;

  select pg_catalog.count(*) into remaining from auth.users users
  join private.presg_demo_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;

  if remaining = 0 then
    if run.protected_snapshot <> private.presg_demo_protected_snapshot(p_run_id) then
      raise exception 'non-demo user snapshot changed during removal';
    end if;

    -- Org sweep. Every row below is chapter-scoped to 'presg' or carries a
    -- 'presg-' id prefix; the users (and so every user-cascading row) are
    -- already gone. Anything a real identity somehow attached to the demo
    -- chapter stops the sweep instead of being deleted.
    if exists (select 1 from public.member_profiles where chapter_id = 'presg') then
      raise exception 'a live profile still references the presg chapter; sweep stopped';
    end if;
    if exists (select 1 from public.member_ballot_votes where ballot_id like 'presg-ballot-%') then
      raise exception 'presg ballots still hold votes from non-demo identities; sweep stopped';
    end if;

    delete from private.chapter_task_number_counters where chapter_id = 'presg';
    delete from public.chapter_workstreams where chapter_id = 'presg';
    delete from public.member_event_checkins c
      using public.member_events e where e.id = c.event_id and e.chapter_id = 'presg';
    delete from public.member_event_rsvps r
      using public.member_events e where e.id = r.event_id and e.chapter_id = 'presg';
    delete from public.member_events where chapter_id = 'presg';
    delete from public.member_ballot_receipts where ballot_id like 'presg-ballot-%';
    delete from public.member_ballot_options where ballot_id like 'presg-ballot-%';
    delete from public.member_ballots where id like 'presg-ballot-%';
    delete from public.member_survey_responses where survey_id like 'presg-pulse-%';
    delete from public.member_survey_options where survey_id like 'presg-pulse-%';
    delete from public.member_surveys where id like 'presg-pulse-%';
    delete from public.member_broadcast_receipts where broadcast_id like 'presg-bc-%';
    delete from public.member_broadcasts where id like 'presg-bc-%';
    delete from public.chapters where id = 'presg';

    update private.presg_demo_runs
    set state = 'removed', removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_run_id;
  end if;
  return jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
end;
$$;

-- ------------------------------------------------------------- 10. grants ----

revoke all on function private.presg_demo_user_id(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_email(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_first_name(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_last_name(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_full_name(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_joined_at(uuid, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_receipt_code(text) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_authorize(text, text) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_impersonate(uuid) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_sweep_trigger_rows(uuid) from public, anon, authenticated, service_role;
revoke all on function private.presg_demo_protected_snapshot(uuid) from public, anon, authenticated, service_role;

revoke all on function public.presg_demo_begin(uuid, text, integer, integer, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.presg_demo_apply_batch(uuid, integer, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.presg_demo_seed_org(uuid, text, text) from public, anon, authenticated;
revoke all on function public.presg_demo_seed_channels(uuid, text, text) from public, anon, authenticated;
revoke all on function public.presg_demo_enrich_batch(uuid, text, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.presg_demo_status(uuid) from public, anon, authenticated;
revoke all on function public.presg_demo_verify(uuid, text) from public, anon, authenticated;
revoke all on function public.presg_demo_begin_remove(uuid, text, text) from public, anon, authenticated;
revoke all on function public.presg_demo_remove_batch(uuid, integer, text, text) from public, anon, authenticated;

grant execute on function public.presg_demo_begin(uuid, text, integer, integer, integer, text, text, text) to service_role;
grant execute on function public.presg_demo_apply_batch(uuid, integer, integer, text, text, text) to service_role;
grant execute on function public.presg_demo_seed_org(uuid, text, text) to service_role;
grant execute on function public.presg_demo_seed_channels(uuid, text, text) to service_role;
grant execute on function public.presg_demo_enrich_batch(uuid, text, integer, integer, text, text) to service_role;
grant execute on function public.presg_demo_status(uuid) to service_role;
grant execute on function public.presg_demo_verify(uuid, text) to service_role;
grant execute on function public.presg_demo_begin_remove(uuid, text, text) to service_role;
grant execute on function public.presg_demo_remove_batch(uuid, integer, text, text) to service_role;

-- CONTRACT COORDINATION (scripts/db-contract.json): every public presg_demo_*
-- function gets a functions entry (secdef, exec "service_role", inline
-- statement_timeout in config); the private helpers get exec "" entries; the
-- two private tables get empty tableGrants entries alongside the stress pair.
-- tests/presg-demo-seed.test.js pins this file.
