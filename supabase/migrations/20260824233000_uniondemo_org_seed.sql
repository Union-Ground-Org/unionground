-- Union Demo Org SAMPLE seed (owner directive, 2026-08-24, session b5d3b971).
--
-- WHAT THIS IS
-- A ledgered, service_role-only seed lane for a FICTIONAL statewide union
-- local rendered inside the live product schema, so the web app and the
-- iOS/Android member apps can sign in against real rows at real scale:
--   * 20 chapters ('ud-*' ids, every name labeled "(SAMPLE)");
--   * 30,000 members with real sign-in (member_count, exact);
--   * 800 stewards (steward_count, exact) distributed per chapter, with a
--     coordinator, advisor and admin per chapter and one org VP;
--   * four years of very active history: chapter events with rising RSVP and
--     check-in participation, closed and open ballots with receipts, pulses,
--     an org-wide weekly-cadence broadcast archive with read receipts,
--     chapter channels and task boards, per-member grievance cases with
--     updates, steward requests, steward appointment desks with booked
--     appointments, forms, workload receipts, rights progress, guide
--     threads, backdated points and a busy direct-message stream.
-- This lane is a sibling of the Union Ground lane (20260824090000): the
-- same run/ledger/verify/remove skeleton, the same deterministic
-- (run_id, ordinal) derivation via the member-stress helpers, extended with a
-- per-run chapter map so one run spans twenty chapters. The two lanes are
-- namespaced (':ud:' vs ':presg:') and can never derive the same identity.
--
-- SAFETY RULES INHERITED FROM THE STRESS AND PRESG LANES (live hazards)
-- * SEEDED NOTIFICATION KIND IS FROZEN AT 'general'. outbound_enabled is TRUE
--   in production and the dispatch cron runs every 5 minutes; a typed kind on
--   synthetic rows would attempt real provider sends. Every demo profile is
--   written with EVERY typed notification pref explicitly false, so app
--   triggers that legitimately fire during a live demo can never enqueue an
--   outbound delivery for a demo identity. Trigger-minted typed rows created
--   inside a seeding transaction are swept before commit (they all carry
--   created_at = now(); seeded history is strictly older).
-- * POINTS ARE MINTED BY DIRECT BACKDATED INSERT, never through
--   member_action_log (award_member_points stamps occurred_at = now() and
--   enforces weekly caps). member_action_log rows stay action_kind 'seed'.
-- * STEWARD REQUESTS ARE INSERTED IN THEIR FINAL STATUS, never UPDATEd, so
--   the award-on-acknowledgment trigger cannot fire at now().
-- * APPOINTMENTS: member_appointments carries GiST exclusion constraints on
--   confirmed rows. Upcoming confirmed appointments are derived one-per-
--   steward from disjoint (steward, slot) tuples and guarded by NOT EXISTS,
--   so a re-run can never collide with the exclusion constraints. Past
--   appointments are completed/no_show, which the constraints ignore.
-- * TEARDOWN IS SYMMETRIC. Per-member rows hang off auth.users with
--   ON DELETE CASCADE; org rows all carry a mapped 'ud-*' chapter id or a
--   'ud-' id prefix and are deleted explicitly after the users are gone.
--
-- IMPERSONATION NOTE. chapter_spaces/chapter_threads/chapter_thread_posts and
-- chapter_tasks stamp identity from auth.uid() in BEFORE triggers and refuse
-- anonymous writes. The channel/task seeding function therefore sets a
-- transaction-local request.jwt.claims for the ledgered author being written.
-- The service_role authorization check always runs BEFORE the first
-- impersonation in each function, and set_config(..., true) dies with the
-- transaction. chapter_tasks.created_at is trigger-forced to now() and
-- immutable, so each chapter board is seeded as a live current board
-- (start/due dates carry the history) rather than a backdated one.
--
-- ROLLBACK (copy-paste)
--   drop function if exists public.uniondemo_remove_batch(uuid, integer, text, text);
--   drop function if exists public.uniondemo_begin_remove(uuid, text, text);
--   drop function if exists public.uniondemo_verify(uuid, text);
--   drop function if exists public.uniondemo_status(uuid);
--   drop function if exists public.uniondemo_enrich_batch(uuid, text, integer, integer, text, text);
--   drop function if exists public.uniondemo_seed_channels(uuid, integer, text, text);
--   drop function if exists public.uniondemo_seed_org(uuid, integer, text, text);
--   drop function if exists public.uniondemo_apply_batch(uuid, integer, integer, text, text, text);
--   drop function if exists public.uniondemo_begin(uuid, text, integer, integer, integer, text, text, text);
--   drop function if exists private.uniondemo_sweep_trigger_rows(uuid);
--   drop function if exists private.uniondemo_impersonate(uuid);
--   drop function if exists private.uniondemo_receipt_code(text);
--   drop function if exists private.uniondemo_full_name(uuid, integer);
--   drop function if exists private.uniondemo_first_name(uuid, integer);
--   drop function if exists private.uniondemo_last_name(uuid, integer);
--   drop function if exists private.uniondemo_joined_at(uuid, integer, boolean);
--   drop function if exists private.uniondemo_email(uuid, integer);
--   drop function if exists private.uniondemo_user_id(uuid, integer);
--   drop function if exists private.uniondemo_authorize(text, text);
--   drop function if exists private.uniondemo_protected_snapshot(uuid);
--   drop table if exists private.uniondemo_ledger;
--   drop table if exists private.uniondemo_chapters;
--   drop table if exists private.uniondemo_runs;

set local lock_timeout = '5s';

-- ------------------------------------------------------------ 1. run ledger --

create table private.uniondemo_runs (
  id uuid primary key,
  dataset_version text not null,
  target_ref text not null,
  member_count integer not null check (member_count between 100 and 40000),
  steward_count integer not null check (steward_count between 60 and member_count),
  login_count integer not null check (login_count between 0 and member_count),
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('ledgered', 'applying', 'applied', 'verified', 'removing', 'removed')),
  protected_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz,
  removed_at timestamptz
);

-- The per-run chapter map: contiguous ordinal blocks per chapter, exact-sum
-- member and steward counts. Downstream phases read this instead of
-- recomputing the distribution.
create table private.uniondemo_chapters (
  run_id uuid not null references private.uniondemo_runs(id) on delete restrict,
  chapter_index integer not null check (chapter_index between 1 and 20),
  chapter_id text not null,
  chapter_name text not null,
  agency text not null,
  first_ordinal integer not null check (first_ordinal > 0),
  member_count integer not null check (member_count > 0),
  steward_count integer not null check (steward_count >= 3),
  primary key (run_id, chapter_index),
  unique (run_id, chapter_id)
);

create table private.uniondemo_ledger (
  run_id uuid not null references private.uniondemo_runs(id) on delete restrict,
  ordinal integer not null check (ordinal > 0),
  user_id uuid not null,
  email text not null,
  chapter_index integer not null,
  chapter_id text not null,
  steward boolean not null,
  officer text check (officer in ('coordinator', 'advisor', 'admin', 'vp')),
  login_capable boolean not null,
  created_at timestamptz not null default now(),
  primary key (run_id, ordinal),
  unique (run_id, user_id),
  unique (run_id, email)
);

revoke all on table private.uniondemo_runs, private.uniondemo_chapters, private.uniondemo_ledger
  from public, anon, authenticated, service_role;

-- --------------------------------------------------- 2. deterministic helpers --
-- private.member_stress_uuid / _rand / _pick and the stress name pool are
-- reused: pure functions of their seed text, no run state. Every seed string
-- here is namespaced ':ud:' so no other lane can derive the same identity.

create function private.uniondemo_user_id(p_run_id uuid, p_ordinal integer)
returns uuid
language sql
immutable
strict
set search_path = ''
as $$
  select private.member_stress_uuid(p_run_id::text || ':ud:user:' || p_ordinal::text);
$$;

create function private.uniondemo_email(p_run_id uuid, p_ordinal integer)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select 'ud-' || pg_catalog.substr(pg_catalog.replace(p_run_id::text, '-', ''), 1, 8) || '-' ||
    pg_catalog.lpad(p_ordinal::text, 5, '0') || '@loadtest.example.com';
$$;

create function private.uniondemo_first_name(p_run_id uuid, p_ordinal integer)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select v.value from private.member_stress_name_pool v
  where v.part = 'first'
    and v.idx = private.member_stress_pick(p_run_id::text || ':ud:first:' || p_ordinal::text,
      (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'first'));
$$;

create function private.uniondemo_last_name(p_run_id uuid, p_ordinal integer)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select v.value from private.member_stress_name_pool v
  where v.part = 'last'
    and v.idx = private.member_stress_pick(p_run_id::text || ':ud:last:' || p_ordinal::text,
      (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'last'));
$$;

create function private.uniondemo_full_name(p_run_id uuid, p_ordinal integer)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select private.uniondemo_first_name(p_run_id, p_ordinal) || ' ' ||
    private.uniondemo_last_name(p_run_id, p_ordinal);
$$;

-- A mature local's tenure curve: most members (and almost every steward)
-- predate the four-year activity window (t0 = now() - 1460 days); the rest
-- joined during it, which is what makes participation curves rise. Activity
-- for pre-window members starts at t0.
create function private.uniondemo_joined_at(p_run_id uuid, p_ordinal integer, p_steward boolean)
returns timestamptz
language sql
stable
strict
set search_path = ''
as $$
  select case
    when private.member_stress_rand(p_run_id::text || ':ud:legacy:' || p_ordinal::text)
        < case when p_steward then 0.88 else 0.62 end
      then pg_catalog.now() - interval '1460 days'
        - ((30 + private.member_stress_pick(p_run_id::text || ':ud:join:' || p_ordinal::text, 2900)) || ' days')::interval
    else pg_catalog.now() - interval '1460 days'
      + ((private.member_stress_pick(p_run_id::text || ':ud:join:' || p_ordinal::text, 1430)) || ' days')::interval
  end
  + ((6 + private.member_stress_pick(p_run_id::text || ':ud:joinh:' || p_ordinal::text, 12)) || ' hours')::interval;
$$;

-- Ballot receipts are constrained to '^SG-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$'.
create function private.uniondemo_receipt_code(p_seed text)
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

create function private.uniondemo_authorize(p_target_ref text, p_confirm_token text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'union demo RPC requires service_role';
  end if;
  if p_target_ref <> 'productionprojectref' then
    raise exception 'union demo target mismatch';
  end if;
  if p_confirm_token <> 'SEED_UNION_DEMO_ORG_SAMPLE_30K' then
    raise exception 'union demo confirmation mismatch';
  end if;
end;
$$;

-- Transaction-local identity for the trigger-stamped chapter surfaces. The
-- setting dies with the transaction; the service_role check in every public
-- entry point runs before the first call.
create function private.uniondemo_impersonate(p_user_id uuid)
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
-- inside this transaction sits exactly at now(). Deleting >= now() removes
-- trigger noise and nothing else.
create function private.uniondemo_sweep_trigger_rows(p_run_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  swept bigint;
begin
  delete from public.member_notification_deliveries d
  using private.uniondemo_ledger l
  where l.run_id = p_run_id and d.user_id = l.user_id and d.created_at >= pg_catalog.now();

  delete from public.member_notifications n
  using private.uniondemo_ledger l
  where l.run_id = p_run_id and n.user_id = l.user_id and n.created_at >= pg_catalog.now();
  get diagnostics swept = row_count;
  return swept;
end;
$$;

create function private.uniondemo_protected_snapshot(p_run_id uuid)
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
    -- Scope: REAL users only. Synthetic identities from any seed lane
    -- (uniondemo, presg, member-stress) are excluded — each lane already
    -- guards its own rows, identity collisions are preflighted against ALL of
    -- auth.users, and walking a 100k-user stress dataset per snapshot pushed
    -- begin/status/verify past the hosted API gateway timeout.
    where not coalesce(users.raw_app_meta_data ?| array[
      'uniondemo_run_id', 'presg_demo_run_id', 'member_stress_run_id'], false)
  ) snapshot;
$$;

-- ------------------------------------------------------------- 3. begin -------

create function public.uniondemo_begin(
  p_run_id uuid,
  p_dataset_version text,
  p_member_count integer,
  p_steward_count integer,
  p_login_count integer,
  p_config_hash text,
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
  existing_run private.uniondemo_runs%rowtype;
  collision_count bigint;
  ledger_count bigint;
  chapter record;
  member_counts integer[] := array[]::integer[];
  steward_counts integer[] := array[]::integer[];
  firsts integer[] := array[]::integer[];
  assigned integer := 0;
  stewards_assigned integer := 0;
  cursor_ordinal integer := 1;
  i integer;
  guard integer := 0;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  if p_member_count not between 100 and 40000
    or p_steward_count not between 60 and p_member_count
    or p_login_count not between 0 and p_member_count then
    raise exception 'invalid member, steward or login count';
  end if;
  if p_dataset_version <> 'uniondemo-v1' or p_config_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid dataset version or config hash';
  end if;

  select * into existing_run from private.uniondemo_runs where id = p_run_id;
  if found then
    if existing_run.dataset_version <> p_dataset_version
      or existing_run.member_count <> p_member_count
      or existing_run.steward_count <> p_steward_count
      or existing_run.login_count <> p_login_count
      or existing_run.config_hash <> p_config_hash
      or existing_run.target_ref <> p_target_ref then
      raise exception 'run id already exists with different configuration';
    end if;
    select pg_catalog.count(*) into ledger_count from private.uniondemo_ledger where run_id = p_run_id;
    if ledger_count <> p_member_count then raise exception 'existing run has incomplete ledger'; end if;
    if existing_run.state = 'removed' then
      select pg_catalog.count(*) into collision_count
      from private.uniondemo_ledger ledger
      join auth.users users on users.id = ledger.user_id or pg_catalog.lower(users.email) = ledger.email
      where ledger.run_id = p_run_id;
      if collision_count <> 0 then raise exception 'restart preflight found existing auth collisions'; end if;
      if exists (select 1 from private.uniondemo_runs where id <> p_run_id and state <> 'removed') then
        raise exception 'another union demo run is active';
      end if;
      update private.uniondemo_runs
      set state = 'ledgered', protected_snapshot = private.uniondemo_protected_snapshot(p_run_id),
        updated_at = pg_catalog.now(), verified_at = null, removed_at = null
      where id = p_run_id;
      return jsonb_build_object('run_id', p_run_id, 'state', 'ledgered', 'ledger_rows', ledger_count,
        'resumed', false, 'restarted', true);
    end if;
    return jsonb_build_object('run_id', p_run_id, 'state', existing_run.state, 'ledger_rows', ledger_count, 'resumed', true);
  end if;

  if exists (select 1 from private.uniondemo_runs where state <> 'removed') then
    raise exception 'another union demo run is active';
  end if;

  with manifest as (
    select private.uniondemo_user_id(p_run_id, ordinal) as user_id,
      private.uniondemo_email(p_run_id, ordinal) as email
    from generate_series(1, p_member_count) ordinal
  )
  select pg_catalog.count(*) into collision_count
  from manifest
  join auth.users users on users.id = manifest.user_id or pg_catalog.lower(users.email) = manifest.email;
  if collision_count <> 0 then raise exception 'preflight found existing auth collisions'; end if;

  insert into private.uniondemo_runs (
    id, dataset_version, target_ref, member_count, steward_count, login_count, config_hash, state, protected_snapshot
  ) values (
    p_run_id, p_dataset_version, p_target_ref, p_member_count, p_steward_count, p_login_count, p_config_hash,
    'ledgered', private.uniondemo_protected_snapshot(p_run_id)
  );

  -- The 20-chapter map. Weights sum to exactly 1000; member and steward
  -- remainders are corrected so both totals are EXACT — 30,000 and 800 are
  -- the product promise, not approximations.
  for chapter in
    select * from (values
      (1,  'ud-wor-dds',   'Riverbend Care Services (SAMPLE)',       'Care Services', 72),
      (2,  'ud-bos-dds',   'Stonebridge Care Services (SAMPLE)',     'Care Services', 85),
      (3,  'ud-spr-dds',   'Lakeside Care Services (SAMPLE)',        'Care Services', 60),
      (4,  'ud-dcf-bos',   'Stonebridge Family Services (SAMPLE)',   'Family Services', 68),
      (5,  'ud-dmh-bos',   'Stonebridge Health Services (SAMPLE)',   'Health Services', 55),
      (6,  'ud-dta-bos',   'Stonebridge Benefits Office (SAMPLE)',   'Benefits Office', 50),
      (7,  'ud-dds-cape',  'Seaward Islands Care Services (SAMPLE)', 'Care Services', 30),
      (8,  'ud-dds-mer',   'Mill Valley Care Services (SAMPLE)',     'Care Services', 52),
      (9,  'ud-dds-berk',  'Highland Hills Care Services (SAMPLE)',  'Care Services', 28),
      (10, 'ud-dcf-wor',   'Riverbend Family Services (SAMPLE)',     'Family Services', 48),
      (11, 'ud-dcf-spr',   'Lakeside Family Services (SAMPLE)',      'Family Services', 45),
      (12, 'ud-dcf-ns',    'Eastbrook Family Services (SAMPLE)',     'Family Services', 42),
      (13, 'ud-dmh-metro', 'Stonebridge Metro Health Services (SAMPLE)','Health Services', 58),
      (14, 'ud-dmh-west',  'West Ridge Health Services (SAMPLE)',    'Health Services', 40),
      (15, 'ud-dmh-se',    'South Bay Health Services (SAMPLE)',     'Health Services', 38),
      (16, 'ud-dmh-cen',   'Midland Health Services (SAMPLE)',       'Health Services', 36),
      (17, 'ud-dta-spr',   'Lakeside Benefits Office (SAMPLE)',      'Benefits Office', 35),
      (18, 'ud-dta-wor',   'Riverbend Benefits Office (SAMPLE)',     'Benefits Office', 34),
      (19, 'ud-dta-cape',  'Seaward Islands Benefits Office (SAMPLE)','Benefits Office', 24),
      (20, 'ud-ma-north',  'Northern Rehab Services (SAMPLE)',       'Rehab Services', 100)
    ) c(idx, id, name, agency, weight)
    order by c.idx
  loop
    member_counts := member_counts || ((p_member_count * chapter.weight) / 1000);
    steward_counts := steward_counts || greatest((p_steward_count * chapter.weight) / 1000, 3);
  end loop;

  select pg_catalog.sum(v) into assigned from unnest(member_counts) v;
  i := 1;
  while assigned < p_member_count loop
    member_counts[i] := member_counts[i] + 1;
    assigned := assigned + 1;
    i := (i % 20) + 1;
  end loop;

  select pg_catalog.sum(v) into stewards_assigned from unnest(steward_counts) v;
  i := 1;
  while stewards_assigned <> p_steward_count loop
    guard := guard + 1;
    if guard > 100000 then raise exception 'steward distribution did not converge'; end if;
    if stewards_assigned < p_steward_count then
      if steward_counts[i] < member_counts[i] then
        steward_counts[i] := steward_counts[i] + 1;
        stewards_assigned := stewards_assigned + 1;
      end if;
    elsif steward_counts[i] > 3 then
      steward_counts[i] := steward_counts[i] - 1;
      stewards_assigned := stewards_assigned - 1;
    end if;
    i := (i % 20) + 1;
  end loop;

  for i in 1..20 loop
    if steward_counts[i] > member_counts[i] then
      raise exception 'chapter % steward count exceeds member count', i;
    end if;
    firsts := firsts || cursor_ordinal;
    cursor_ordinal := cursor_ordinal + member_counts[i];
  end loop;

  insert into private.uniondemo_chapters
    (run_id, chapter_index, chapter_id, chapter_name, agency, first_ordinal, member_count, steward_count)
  select p_run_id, c.idx, c.id, c.name, c.agency, firsts[c.idx], member_counts[c.idx], steward_counts[c.idx]
  from (values
    (1,  'ud-wor-dds',   'Riverbend Care Services (SAMPLE)',       'Care Services'),
    (2,  'ud-bos-dds',   'Stonebridge Care Services (SAMPLE)',     'Care Services'),
    (3,  'ud-spr-dds',   'Lakeside Care Services (SAMPLE)',        'Care Services'),
    (4,  'ud-dcf-bos',   'Stonebridge Family Services (SAMPLE)',   'Family Services'),
    (5,  'ud-dmh-bos',   'Stonebridge Health Services (SAMPLE)',   'Health Services'),
    (6,  'ud-dta-bos',   'Stonebridge Benefits Office (SAMPLE)',   'Benefits Office'),
    (7,  'ud-dds-cape',  'Seaward Islands Care Services (SAMPLE)', 'Care Services'),
    (8,  'ud-dds-mer',   'Mill Valley Care Services (SAMPLE)',     'Care Services'),
    (9,  'ud-dds-berk',  'Highland Hills Care Services (SAMPLE)',  'Care Services'),
    (10, 'ud-dcf-wor',   'Riverbend Family Services (SAMPLE)',     'Family Services'),
    (11, 'ud-dcf-spr',   'Lakeside Family Services (SAMPLE)',      'Family Services'),
    (12, 'ud-dcf-ns',    'Eastbrook Family Services (SAMPLE)',     'Family Services'),
    (13, 'ud-dmh-metro', 'Stonebridge Metro Health Services (SAMPLE)','Health Services'),
    (14, 'ud-dmh-west',  'West Ridge Health Services (SAMPLE)',    'Health Services'),
    (15, 'ud-dmh-se',    'South Bay Health Services (SAMPLE)',     'Health Services'),
    (16, 'ud-dmh-cen',   'Midland Health Services (SAMPLE)',       'Health Services'),
    (17, 'ud-dta-spr',   'Lakeside Benefits Office (SAMPLE)',      'Benefits Office'),
    (18, 'ud-dta-wor',   'Riverbend Benefits Office (SAMPLE)',     'Benefits Office'),
    (19, 'ud-dta-cape',  'Seaward Islands Benefits Office (SAMPLE)','Benefits Office'),
    (20, 'ud-ma-north',  'Northern Rehab Services (SAMPLE)',       'Rehab Services')
  ) c(idx, id, name, agency);

  -- The ledger: stewards are the first steward_count ordinals of each chapter
  -- block; block positions 1-3 carry chapter officers and chapter 1 position 4
  -- carries the org VP.
  insert into private.uniondemo_ledger
    (run_id, ordinal, user_id, email, chapter_index, chapter_id, steward, officer, login_capable)
  select
    p_run_id, o.ordinal,
    private.uniondemo_user_id(p_run_id, o.ordinal),
    private.uniondemo_email(p_run_id, o.ordinal),
    c.chapter_index, c.chapter_id,
    o.ordinal < c.first_ordinal + c.steward_count,
    case o.ordinal - c.first_ordinal
      when 0 then 'coordinator'
      when 1 then 'advisor'
      when 2 then 'admin'
      when 3 then case when c.chapter_index = 1 then 'vp' else null end
      else null end,
    o.ordinal <= p_login_count
  from generate_series(1, p_member_count) o(ordinal)
  join private.uniondemo_chapters c
    on c.run_id = p_run_id
    and o.ordinal between c.first_ordinal and c.first_ordinal + c.member_count - 1;

  select pg_catalog.count(*) into ledger_count from private.uniondemo_ledger where run_id = p_run_id;
  if ledger_count <> p_member_count then raise exception 'ledger creation incomplete'; end if;
  if (select pg_catalog.count(*) from private.uniondemo_ledger where run_id = p_run_id and steward) <> p_steward_count then
    raise exception 'steward assignment incomplete';
  end if;
  return jsonb_build_object('run_id', p_run_id, 'state', 'ledgered', 'ledger_rows', ledger_count,
    'stewards', p_steward_count, 'chapters', 20, 'resumed', false);
end;
$$;

-- ------------------------------------------------------- 4. apply (accounts) --

create function public.uniondemo_apply_batch(
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
  run private.uniondemo_runs%rowtype;
  password_hash text;
  selected_count integer;
  collision_count integer;
  mapped_chapters integer;
  total_users bigint;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then
    raise exception 'run cannot be applied in state %', run.state;
  end if;
  if p_start_ordinal < 1 or p_batch_count not between 1 and 2000 then raise exception 'invalid batch range'; end if;
  select pg_catalog.count(*) into mapped_chapters
  from private.uniondemo_chapters map
  join public.chapters ch on ch.id = map.chapter_id
  where map.run_id = p_run_id;
  if mapped_chapters <> 20 then
    raise exception 'union demo chapters missing: run uniondemo_seed_org for every chapter first';
  end if;

  select pg_catalog.count(*) into selected_count from private.uniondemo_ledger
  where run_id = p_run_id and ordinal between lo and hi;
  if selected_count = 0 then raise exception 'empty batch'; end if;

  select pg_catalog.count(*) into collision_count
  from private.uniondemo_ledger ledger
  join auth.users users on users.id = ledger.user_id or pg_catalog.lower(users.email) = ledger.email
  where ledger.run_id = p_run_id
    and ledger.ordinal between lo and hi
    and (users.id <> ledger.user_id or pg_catalog.lower(users.email) <> ledger.email
      or coalesce(users.raw_app_meta_data ->> 'uniondemo_run_id', '') <> p_run_id::text);
  if collision_count <> 0 then raise exception 'batch preflight found non-owned auth rows'; end if;

  if exists (
    select 1 from private.uniondemo_ledger
    where run_id = p_run_id and login_capable and ordinal between lo and hi
  ) then
    if pg_catalog.char_length(coalesce(p_password, '')) < 24 then raise exception 'demo password is too short'; end if;
    password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  end if;

  update private.uniondemo_runs set state = 'applying', updated_at = pg_catalog.now()
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
      'uniondemo_run_id', p_run_id::text, 'uniondemo_ordinal', ledger.ordinal),
    jsonb_build_object(
      'first_name', private.uniondemo_first_name(p_run_id, ledger.ordinal),
      'full_name', private.uniondemo_full_name(p_run_id, ledger.ordinal),
      'name', private.uniondemo_full_name(p_run_id, ledger.ordinal),
      'initials', pg_catalog.upper(pg_catalog.left(private.uniondemo_first_name(p_run_id, ledger.ordinal), 1)
        || pg_catalog.left(private.uniondemo_last_name(p_run_id, ledger.ordinal), 1)),
      'chapter_id', ledger.chapter_id),
    pg_catalog.now(), pg_catalog.now(), false, false
  from private.uniondemo_ledger ledger
  where ledger.run_id = p_run_id and ledger.ordinal between lo and hi
  on conflict do nothing;

  insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at)
  select
    private.member_stress_uuid(p_run_id::text || ':ud:identity:' || ledger.ordinal::text),
    ledger.user_id::text, ledger.user_id,
    jsonb_build_object('sub', ledger.user_id::text, 'email', ledger.email, 'email_verified', true,
      'phone_verified', false, 'uniondemo_run_id', p_run_id::text),
    'email', pg_catalog.now(), pg_catalog.now()
  from private.uniondemo_ledger ledger
  join auth.users users on users.id = ledger.user_id
  where ledger.run_id = p_run_id and ledger.ordinal between lo and hi
  on conflict do nothing;

  -- Whatever shape handle_new_member carries in this environment, a demo
  -- account starts from a clean slate: the enrichment phases own ALL history.
  delete from public.member_cases c using private.uniondemo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and c.user_id = l.user_id;
  delete from public.member_messages m using private.uniondemo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and m.user_id = l.user_id;
  delete from public.member_conversations c using private.uniondemo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and c.user_id = l.user_id;
  delete from public.member_notifications n using private.uniondemo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and n.user_id = l.user_id;
  delete from public.member_rights_progress r using private.uniondemo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and r.user_id = l.user_id;
  delete from public.member_action_log a using private.uniondemo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi and a.user_id = l.user_id;
  delete from public.member_point_events e using private.uniondemo_ledger l
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
    private.uniondemo_first_name(p_run_id, l.ordinal),
    private.uniondemo_full_name(p_run_id, l.ordinal),
    pg_catalog.upper(pg_catalog.left(private.uniondemo_first_name(p_run_id, l.ordinal), 1)
      || pg_catalog.left(private.uniondemo_last_name(p_run_id, l.ordinal), 1)),
    case when l.steward then 'Steward · ' else 'Member · ' end || map.agency,
    extract(year from private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward))::integer,
    l.chapter_id,
    case when private.member_stress_rand(p_run_id::text || ':ud:lang:' || l.ordinal::text) < 0.12 then 'es' else 'en' end,
    '{"deadlines": false, "cases": false, "forms": false, "votes": false, "events": false, "tasks": false, "appointments": false, "workload": false}'::jsonb,
    greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), pg_catalog.now() - interval '1460 days'),
    greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), pg_catalog.now() - interval '1460 days')
  from private.uniondemo_ledger l
  join private.uniondemo_chapters map on map.run_id = l.run_id and map.chapter_index = l.chapter_index
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

  select pg_catalog.count(*) into total_users from auth.users users
  join private.uniondemo_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id
    and users.raw_app_meta_data ->> 'uniondemo_run_id' = p_run_id::text;
  if total_users = run.member_count then
    update private.uniondemo_runs set state = 'applied', updated_at = pg_catalog.now() where id = p_run_id;
  end if;
  return jsonb_build_object('selected', selected_count, 'auth_users', total_users,
    'state', case when total_users = run.member_count then 'applied' else 'applying' end);
end;
$$;

-- --------------------------------------------------------- 5. org backbone ---
-- One chapter per call (the driver loops 1..20): the chapter row, its
-- workstreams, four years of chapter-scoped events, closed and open ballots
-- and pulses. The org-wide broadcast archive is seeded with chapter 1
-- (member_broadcasts has no chapter column). Notice-sent stamps are written
-- for past items so the notification crons treat the backfill as already
-- handled; upcoming items are left for the crons, whose sends are suppressed
-- for demo identities by the all-false profile prefs.

create function public.uniondemo_seed_org(
  p_run_id uuid,
  p_chapter_index integer,
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
  run private.uniondemo_runs%rowtype;
  chapter private.uniondemo_chapters%rowtype;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
  seed text;
  ck text;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.uniondemo_runs where id = p_run_id;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then
    raise exception 'run cannot seed org content in state %', run.state;
  end if;
  select * into chapter from private.uniondemo_chapters
  where run_id = p_run_id and chapter_index = p_chapter_index;
  if not found then raise exception 'unknown union demo chapter index %', p_chapter_index; end if;
  seed := p_run_id::text || ':ch' || p_chapter_index::text;
  ck := pg_catalog.lpad(p_chapter_index::text, 2, '0');

  insert into public.chapters (id, name, region, is_default, order_index)
  values (chapter.chapter_id, chapter.chapter_name, 'Statewide (SAMPLE)', false, 200 + p_chapter_index)
  on conflict (id) do nothing;

  insert into public.chapter_workstreams (id, chapter_id, name, created_by, created_at)
  select private.member_stress_uuid(seed || ':ud:ws:' || w.name), chapter.chapter_id, w.name, null, t0
  from unnest(array['Chapter', 'Communications', 'Organizing', 'Grievances', 'Bargaining', 'Safety']) w(name)
  on conflict (chapter_id, name) do nothing;

  -- Monthly chapter meetings across the whole window.
  insert into public.member_events (id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, reminder_notice_sent_at)
  select
    'ud-evt-' || ck || '-cm-' || pg_catalog.lpad(n::text, 2, '0'),
    'Chapter meeting — ' || pg_catalog.to_char(t0 + ((n * 30 + 9) || ' days')::interval, 'Mon YYYY'),
    t0 + ((n * 30 + 9) || ' days')::interval + interval '18 hours',
    (array['Chapter hall + Zoom', 'Union office · Room 2', 'Program site community room'])[1 + (n % 3)],
    'Officer reports, grievance and bargaining updates, member Q&A.',
    'SG-U' || ck || 'M' || pg_catalog.lpad(n::text, 2, '0'),
    p_chapter_index * 1000 + n, chapter.chapter_id, false,
    t0 + ((n * 30 + 8) || ' days')::interval
  from generate_series(0, 47) g(n)
  on conflict (id) do nothing;

  -- Quarterly steward trainings.
  insert into public.member_events (id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, reminder_notice_sent_at)
  select
    'ud-evt-' || ck || '-tr-' || pg_catalog.lpad(n::text, 2, '0'),
    'Steward training — ' || pg_catalog.to_char(t0 + ((n * 91 - 12) || ' days')::interval, 'Mon YYYY'),
    t0 + ((n * 91 - 12) || ' days')::interval + interval '17 hours 30 minutes',
    'Union office · Training room',
    'Weingarten rights, Step 1 practice, and casework intake for chapter stewards.',
    'SG-U' || ck || 'T' || pg_catalog.lpad(n::text, 2, '0'),
    p_chapter_index * 1000 + 100 + n, chapter.chapter_id, false,
    t0 + ((n * 91 - 13) || ' days')::interval
  from generate_series(1, 16) g(n)
  on conflict (id) do nothing;

  -- Twice-a-year actions and rallies.
  insert into public.member_events (id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, reminder_notice_sent_at)
  select
    'ud-evt-' || ck || '-ac-' || n::text,
    (array['Caseload-relief rally', 'Contract action day', 'Community solidarity picnic', 'Legislative lobby day'])[1 + (n % 4)]
      || ' — ' || pg_catalog.to_char(t0 + ((n * 182 - 20) || ' days')::interval, 'Mon YYYY'),
    t0 + ((n * 182 - 20) || ' days')::interval + interval '16 hours',
    (array['State House steps', 'Agency headquarters', 'City park pavilion'])[1 + (n % 3)],
    'Chapter turnout event: bring a coworker and wear your chapter shirt.',
    'SG-U' || ck || 'A' || n::text,
    p_chapter_index * 1000 + 200 + n, chapter.chapter_id, true,
    t0 + ((n * 182 - 21) || ' days')::interval
  from generate_series(1, 8) g(n)
  on conflict (id) do nothing;

  -- Upcoming: the next meeting, training and action are live for RSVPs.
  insert into public.member_events (id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, reminder_notice_sent_at)
  values
    ('ud-evt-' || ck || '-nx-1', 'Chapter meeting',
     pg_catalog.now() + ((3 + (p_chapter_index % 7)) || ' days')::interval + interval '18 hours',
     'Chapter hall + Zoom', 'Bargaining survey vote and contract update.',
     'SG-U' || ck || 'N1', p_chapter_index * 1000 + 300, chapter.chapter_id, false, null),
    ('ud-evt-' || ck || '-nx-2', 'New-steward training',
     pg_catalog.now() + ((8 + (p_chapter_index % 5)) || ' days')::interval + interval '17 hours',
     'Union office · Training room', 'Module 3 — Weingarten rights and Step 1 practice.',
     'SG-U' || ck || 'N2', p_chapter_index * 1000 + 301, chapter.chapter_id, true, null),
    ('ud-evt-' || ck || '-nx-3', 'Caseload-relief rally',
     pg_catalog.now() + ((13 + (p_chapter_index % 9)) || ' days')::interval + interval '16 hours',
     'State House steps', 'Statewide action for enforceable caseload caps.',
     'SG-U' || ck || 'N3', p_chapter_index * 1000 + 302, chapter.chapter_id, true, null)
  on conflict (id) do nothing;

  -- Eight closed ballots (semiannual) plus one open vote per chapter.
  insert into public.member_ballots (id, title, body, closes_at, active, order_index, quorum_target,
    chapter_id, campaign_state, published_at, closed_at,
    opened_notice_sent_at, closing_notice_sent_at, results_notice_sent_at)
  select
    'ud-ballot-' || ck || '-' || pg_catalog.lpad(n::text, 2, '0'),
    (array[
      'Ratify the chapter action budget priorities',
      'Approve the bargaining survey priorities',
      'Chapter officer election — approve the slate',
      'Ratify the contract tentative agreement',
      'Adopt the strike-readiness assessment',
      'Approve the organizing fund allocation',
      'Ratify the memorandum on telework',
      'Approve the chapter bylaws amendments'
    ])[1 + ((n - 1) % 8)] || ' (' || pg_catalog.to_char(t0 + ((n * 175) || ' days')::interval, 'Mon YYYY') || ')',
    'Chapter vote for ' || chapter.chapter_name || ': review the materials in the broadcast archive, then cast your ballot.',
    t0 + ((n * 175) || ' days')::interval, false,
    41000 + p_chapter_index * 20 + n,
    greatest(chapter.member_count * 2 / 5, 10),
    chapter.chapter_id, 'closed',
    t0 + ((n * 175 - 21) || ' days')::interval, t0 + ((n * 175) || ' days')::interval,
    t0 + ((n * 175 - 21) || ' days')::interval, t0 + ((n * 175 - 1) || ' days')::interval, t0 + ((n * 175) || ' days')::interval
  from generate_series(1, 8) g(n)
  on conflict (id) do nothing;

  insert into public.member_ballots (id, title, body, closes_at, active, order_index, quorum_target,
    chapter_id, campaign_state, published_at, closed_at,
    opened_notice_sent_at, closing_notice_sent_at, results_notice_sent_at)
  values (
    'ud-ballot-' || ck || '-live',
    'Ratify the ' || pg_catalog.to_char(pg_catalog.now(), 'YYYY') || ' chapter action budget priorities',
    'Open vote for ' || chapter.chapter_name || ': ratify how the chapter spends its action budget this year.',
    pg_catalog.now() + ((6 + (p_chapter_index % 6)) || ' days')::interval, true,
    41000 + p_chapter_index * 20 + 9,
    greatest(chapter.member_count * 2 / 5, 10),
    chapter.chapter_id, 'open',
    pg_catalog.now() - interval '6 days', null,
    pg_catalog.now() - interval '6 days', null, null)
  on conflict (id) do nothing;

  insert into public.member_ballot_options (id, ballot_id, label, order_index)
  select b.id || o.suffix, b.id, o.label, o.ord
  from public.member_ballots b
  cross join (values
    ('-yes', 'Yes — ratify', 1), ('-no', 'No — reject', 2), ('-abstain', 'Abstain', 3)
  ) o(suffix, label, ord)
  where b.id like 'ud-ballot-' || ck || '-%'
  on conflict (id) do nothing;

  -- Quarterly member pulses plus one live pulse per chapter.
  insert into public.member_surveys (id, title, body, closes_at, active, order_index,
    chapter_id, campaign_state, published_at, closed_at)
  select
    'ud-pulse-' || ck || '-' || pg_catalog.lpad(n::text, 2, '0'),
    (array[
      'Which support would help newer members most?',
      'How is mandated overtime affecting your week?',
      'Which contract article needs enforcement first?',
      'Would you attend a weekend action?'
    ])[1 + (n % 4)] || ' (' || pg_catalog.to_char(t0 + ((n * 170) || ' days')::interval, 'Mon YYYY') || ')',
    'Two questions, thirty seconds. Chapter results are shared at the next meeting.',
    t0 + ((n * 170) || ' days')::interval, false,
    42000 + p_chapter_index * 20 + n, chapter.chapter_id, 'closed',
    t0 + ((n * 170 - 18) || ' days')::interval,
    t0 + ((n * 170) || ' days')::interval
  from generate_series(1, 8) g(n)
  on conflict (id) do nothing;

  insert into public.member_surveys (id, title, body, closes_at, active, order_index,
    chapter_id, campaign_state, published_at, closed_at)
  values ('ud-pulse-' || ck || '-live', 'Which support would help newer members most?',
    'Your answer shapes the mentoring program the chapter pilots this fall.',
    pg_catalog.now() + ((9 + (p_chapter_index % 5)) || ' days')::interval, true,
    42000 + p_chapter_index * 20 + 9, chapter.chapter_id, 'open',
    pg_catalog.now() - interval '4 days', null)
  on conflict (id) do nothing;

  insert into public.member_survey_options (id, survey_id, label, order_index)
  select s.id || '-' || o.ord, s.id, o.label, o.ord
  from public.member_surveys s
  cross join (values
    ('A member mentor', 1), ('More rights training', 2), ('Weekly steward office hours', 3), ('Better meeting times', 4)
  ) o(label, ord)
  where s.id like 'ud-pulse-' || ck || '-%'
  on conflict (id) do nothing;

  -- The org-wide broadcast archive rides with chapter 1: a weekly-cadence
  -- update for four years (member_broadcasts has no chapter column, so these
  -- are org-wide on purpose — one statewide voice, plus Spanish issues).
  -- Reserved order-index band 40000+ so the demo rows can never collide with
  -- live rows or the presg band. (member_ballots and member_surveys order
  -- indexes are ALSO globally unique — they live in the reserved 41000+ and
  -- 42000+ bands above for the same reason.)
  if p_chapter_index = 1 then
    insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, created_by, locale)
    select
      'ud-bc-' || pg_catalog.lpad(n::text, 3, '0'),
      (array['Statewide local', 'Bargaining team', 'Steward council'])[1 + (n % 3)],
      case when n % 14 = 0
        then 'Actualización estatal — semana ' || n::text
        else (array[
          'Bargaining update #' || n::text,
          'Contract enforcement wins this week',
          'Steward office hours schedule',
          'Caseload-relief campaign update',
          'Know your Weingarten rights',
          'Legislative report: what moved',
          'New member welcome and orientation dates',
          'Health & safety walkthrough results',
          'Grievance clinic openings',
          'Member spotlight and chapter wins'
        ])[1 + (n % 10)]
      end,
      case when n % 14 = 0
        then 'Resumen semanal para todos los capítulos: negociaciones, casos y próximos pasos.'
        else (array[
          'The team held the line on caseload caps at this week''s session. Full recap and the next open bargaining date inside.',
          'Three grievances settled at Step 2 this week, including a full back-pay award. Details and what they mean for your worksite.',
          'Weekly steward office hours run at every chapter office and on Zoom. Bring discipline or scheduling questions.',
          'Two more legislators signed on to the caseload-relief bill this week. Here is the whip count and your next call.',
          'If a meeting could lead to discipline, you can ask for a steward before answering. Save this one.',
          'The committee testified at the State House hearing; the recording and written testimony are linked inside.',
          'Orientation runs the first Tuesday of every month at every chapter office. Bring a new coworker.',
          'Walkthrough findings and the fixes management committed to, with deadlines members can hold them to.',
          'Drop-in grievance clinics have open slots this month. A steward will help you prepare a filing.',
          'Wins from every chapter this week, and the members who made them happen.'
        ])[1 + (n % 10)]
      end,
      t0 + ((n * 7) || ' days')::interval + interval '17 hours',
      40000 + n, null,
      case when n % 14 = 0 then 'es' else 'en' end
    from generate_series(1, 207) g(n)
    on conflict (id) do nothing;
  end if;

  return jsonb_build_object(
    'chapter', chapter.chapter_id,
    'events', (select pg_catalog.count(*) from public.member_events where chapter_id = chapter.chapter_id),
    'ballots', (select pg_catalog.count(*) from public.member_ballots where chapter_id = chapter.chapter_id and id like 'ud-ballot-%'),
    'surveys', (select pg_catalog.count(*) from public.member_surveys where chapter_id = chapter.chapter_id and id like 'ud-pulse-%'),
    'broadcasts', (select pg_catalog.count(*) from public.member_broadcasts where id like 'ud-bc-%'));
end;
$$;

-- --------------------------------------------- 6. channels and the task board --
-- One chapter per call (the driver loops 1..20). Spaces, threads with a busy
-- multi-year post stream, and a live task board per chapter.

create function public.uniondemo_seed_channels(
  p_run_id uuid,
  p_chapter_index integer,
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
  run private.uniondemo_runs%rowtype;
  chapter private.uniondemo_chapters%rowtype;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
  seed text;
  author record;
  tasks_seeded boolean := false;
  thread_count bigint;
  post_count bigint;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.uniondemo_runs where id = p_run_id;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied before channels seed (state %)', run.state;
  end if;
  select * into chapter from private.uniondemo_chapters
  where run_id = p_run_id and chapter_index = p_chapter_index;
  if not found then raise exception 'unknown union demo chapter index %', p_chapter_index; end if;
  seed := p_run_id::text || ':ch' || p_chapter_index::text;

  -- Spaces: stamp_product_identity resolves the chapter from the acting
  -- member's profile, so the chapter coordinator (block position 1) acts.
  perform private.uniondemo_impersonate(private.uniondemo_user_id(p_run_id, chapter.first_ordinal));
  insert into public.chapter_spaces (id, chapter_id, name, description, created_at, updated_at)
  select private.member_stress_uuid(seed || ':ud:space:' || s.name), chapter.chapter_id, s.name, s.descr,
    t0 + interval '30 days', t0 + interval '30 days'
  from (values
    ('Workplace issues', 'Ongoing chapter conversations about scheduling, safety, and workload.'),
    ('Steward corner', 'Steward coordination: casework triage, coverage, and training.'),
    ('Actions & turnout', 'Planning and turnout threads for every chapter action and meeting.'),
    ('Contract & bargaining', 'Article questions, enforcement wins, and bargaining updates.')
  ) s(name, descr)
  on conflict (chapter_id, name) do nothing;

  -- Threads, per deterministic creator (a chapter steward) so created_by is a
  -- real ledgered identity.
  for author in
    select distinct chapter.first_ordinal + private.member_stress_pick(seed || ':ud:thcr:' || t::text,
      chapter.steward_count) as ordinal
    from generate_series(1, 40) t
  loop
    perform private.uniondemo_impersonate(private.uniondemo_user_id(p_run_id, author.ordinal));
    insert into public.chapter_threads (id, space_id, chapter_id, title, kind, status, resolved_at, pinned_at, created_at, updated_at)
    select
      private.member_stress_uuid(seed || ':ud:thread:' || t::text),
      private.member_stress_uuid(seed || ':ud:space:' ||
        (array['Workplace issues', 'Workplace issues', 'Steward corner', 'Actions & turnout', 'Contract & bargaining'])
          [1 + private.member_stress_pick(seed || ':ud:thsp:' || t::text, 5)]),
      chapter.chapter_id,
      case when t = 1 then 'Read first: how this chapter uses its channels'
           else (array[
        'Overtime scheduling and notice',
        'Short-notice mandation tracker',
        'Steward coverage for the overnight shift',
        'Turnout plan for the chapter meeting',
        'Telework article questions',
        'Health insurance costs went up again',
        'Grievance clinic debrief',
        'Your rights in investigatory meetings',
        'Management response tracker',
        'Welcome, new members',
        'Bargaining survey — what should lead?',
        'Caseload caps campaign check-in',
        'Break coverage at the day program',
        'Mileage reimbursement is months behind',
        'Shout-outs and wins this week',
        'Safety walkthrough follow-ups',
        'New-steward training questions',
        'Contract enforcement wins thread'
      ])[1 + private.member_stress_pick(seed || ':ud:thti:' || t::text, 18)]
        || ' · #' || t::text end,
      (array['topic', 'topic', 'topic', 'issue', 'issue', 'decision'])
        [1 + private.member_stress_pick(seed || ':ud:thki:' || t::text, 6)],
      case when private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395) > 240
        and private.member_stress_rand(seed || ':ud:thst:' || t::text) < 0.7
        then 'resolved' else 'open' end,
      case when private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395) > 240
        and private.member_stress_rand(seed || ':ud:thst:' || t::text) < 0.7
        then t0 + interval '35 days' + ((private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395) + 35) || ' days')::interval
        else null end,
      case when t = 1 then pg_catalog.now() - interval '3 days' else null end,
      t0 + interval '35 days' + ((private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395)) || ' days')::interval,
      t0 + interval '35 days' + ((private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395)) || ' days')::interval
    from generate_series(1, 40) t
    where chapter.first_ordinal + private.member_stress_pick(seed || ':ud:thcr:' || t::text, chapter.steward_count) = author.ordinal
    on conflict (id) do nothing;
  end loop;

  -- Posts: ~18 per thread, steward voices with member replies. The author
  -- plan is derived once into a transaction-scoped table, then written one
  -- author at a time so stamp_product_identity records the real author_id.
  create temp table if not exists uniondemo_post_plan on commit drop as
  select
    private.member_stress_uuid(seed || ':ud:post:' || t::text || ':' || p::text) as id,
    private.member_stress_uuid(seed || ':ud:thread:' || t::text) as thread_id,
    case when private.member_stress_rand(seed || ':ud:powho:' || t::text || ':' || p::text) < 0.45
      then chapter.first_ordinal + private.member_stress_pick(seed || ':ud:poc:' || t::text || ':' || p::text, chapter.steward_count)
      else chapter.first_ordinal + chapter.steward_count
        + private.member_stress_pick(seed || ':ud:poe:' || t::text || ':' || p::text,
            greatest(chapter.member_count - chapter.steward_count, 1))
    end as author_ordinal,
    t0 + interval '35 days'
      + ((private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395)) || ' days')::interval
      + ((p * (1 + private.member_stress_pick(seed || ':ud:posp:' || t::text, 5))) || ' days')::interval
      + ((private.member_stress_pick(seed || ':ud:poh:' || t::text || ':' || p::text, 14)) || ' hours')::interval as created_at,
    (array[
      'Adding my unit''s numbers to this thread — same pattern here.',
      'The steward on that floor is tracking it; bring dates and shifts.',
      'We raised this at labor-management; the short version is below.',
      'Three more members signed the enforcement petition this week.',
      'Posting the recap so second shift is not left out of the loop.',
      'Remember: if the meeting could lead to discipline, ask for a steward first.',
      'The tracker is updated. Two commitments still open for Thursday.',
      'Management posted a new memo in the break room. Bring a photo here.',
      'This is exactly what Article 8.3 is for — file it, do not absorb it.',
      'Welcome to the new members in this thread — glad you are here.',
      'I read the survey draft; one question needs to be plainer.',
      'Count me in for turnout calls tomorrow evening.',
      'Same on overnights — we have been short two people for weeks.',
      'The clinic had openings Thursday; a steward will help you file.',
      'Let us keep this thread to facts we can source.',
      'Great meeting tonight — notes and assignments inside.'
    ])[1 + private.member_stress_pick(seed || ':ud:pob1:' || t::text || ':' || p::text, 16)]
    || case when private.member_stress_rand(seed || ':ud:pob2:' || t::text || ':' || p::text) < 0.6
      then ' ' || (array[
        'Details in the next chapter briefing.',
        'Reply here if you can help.',
        'I will follow up on shift tomorrow.',
        'Ping a steward if anything is unclear.',
        'More at Thursday''s meeting.',
        'Thanks everyone — this is how we win.'
      ])[1 + private.member_stress_pick(seed || ':ud:pob3:' || t::text || ':' || p::text, 6)]
      else '' end as body
  from generate_series(1, 40) t
  cross join lateral generate_series(1, 8 + private.member_stress_pick(seed || ':ud:pon:' || t::text, 20)) s(p);

  for author in select distinct author_ordinal as ordinal from pg_temp.uniondemo_post_plan order by 1
  loop
    perform private.uniondemo_impersonate(private.uniondemo_user_id(p_run_id, author.ordinal));
    insert into public.chapter_thread_posts (id, thread_id, chapter_id, author_id, body, created_at)
    select plan.id, plan.thread_id, chapter.chapter_id, private.uniondemo_user_id(p_run_id, author.ordinal),
      plan.body, plan.created_at
    from pg_temp.uniondemo_post_plan plan
    where plan.author_ordinal = author.ordinal
    on conflict (id) do nothing;
  end loop;
  drop table if exists uniondemo_post_plan;

  -- The chapter task board. prepare_chapter_task forces created_at = now()
  -- and makes it immutable, so this is seeded as the LIVE board: start and due
  -- dates carry the four-year spread, statuses carry the mix. Re-runs are
  -- guarded by presence because task numbering is a counter, not a natural key.
  if not exists (select 1 from public.chapter_tasks where chapter_id = chapter.chapter_id) then
    tasks_seeded := true;
    for author in
      select distinct chapter.first_ordinal + private.member_stress_pick(seed || ':ud:tkcr:' || k::text,
        chapter.steward_count) as ordinal
      from generate_series(1, 45) k
    loop
      perform private.uniondemo_impersonate(private.uniondemo_user_id(p_run_id, author.ordinal));
      insert into public.chapter_tasks (id, chapter_id, title, description, status, priority, workstream,
        assignee_id, start_date, due_date, progress, blocked, milestone, order_index, task_number)
      select
        private.member_stress_uuid(seed || ':ud:task:' || k::text),
        chapter.chapter_id,
        (array[
          'Prepare the chapter meeting',
          'Publish the weekly briefing',
          'Phone-bank lapsed members',
          'Audit steward coverage map',
          'Draft the bargaining survey',
          'Update rights one-pagers',
          'Schedule the grievance clinic',
          'Verify event check-in codes',
          'Refresh the new-member packet',
          'Plan the caseload-relief action',
          'Translate member notices',
          'Reconcile RSVP lists',
          'Prep labor-management agenda',
          'Collect mandation stories',
          'Update the steward contact roster'
        ])[1 + (k % 15)] || ' · T' || k::text,
        'Chapter operations task tracked by the steward team.',
        case when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.5 then 'done'
             when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.68 then 'in_progress'
             when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.84 then 'to_do'
             when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.94 then 'backlog'
             else 'needs_review' end,
        (array['low', 'medium', 'medium', 'high'])[1 + private.member_stress_pick(seed || ':ud:tkpr:' || k::text, 4)],
        (array['Chapter', 'Communications', 'Organizing', 'Grievances', 'Bargaining', 'Safety'])
          [1 + private.member_stress_pick(seed || ':ud:tkws:' || k::text, 6)],
        private.uniondemo_user_id(p_run_id,
          chapter.first_ordinal + private.member_stress_pick(seed || ':ud:tkas:' || k::text, chapter.steward_count)),
        case when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.5
          then (pg_catalog.now() - ((30 + private.member_stress_pick(seed || ':ud:tksd:' || k::text, 1370)) || ' days')::interval)::date
          else (pg_catalog.now() - ((private.member_stress_pick(seed || ':ud:tksd:' || k::text, 21)) || ' days')::interval)::date end,
        case when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.5
          then (pg_catalog.now() - ((9 + private.member_stress_pick(seed || ':ud:tksd:' || k::text, 1370)) || ' days')::interval)::date + 21
          else (pg_catalog.now() + ((3 + private.member_stress_pick(seed || ':ud:tkdd:' || k::text, 24)) || ' days')::interval)::date end,
        case when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.5 then 100
             when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.68
               then 20 + private.member_stress_pick(seed || ':ud:tkpg:' || k::text, 70)
             else 0 end,
        private.member_stress_rand(seed || ':ud:tkbl:' || k::text) < 0.05,
        k % 11 = 0,
        k, 0
      from generate_series(1, 45) g(k)
      where chapter.first_ordinal + private.member_stress_pick(seed || ':ud:tkcr:' || k::text, chapter.steward_count) = author.ordinal;
    end loop;

    insert into public.chapter_task_comments (id, task_id, chapter_id, author_id, body, created_at)
    select
      private.member_stress_uuid(seed || ':ud:tkcm:' || k::text || ':' || c::text),
      private.member_stress_uuid(seed || ':ud:task:' || k::text),
      chapter.chapter_id,
      private.uniondemo_user_id(p_run_id,
        chapter.first_ordinal + private.member_stress_pick(seed || ':ud:tkca:' || k::text || ':' || c::text, chapter.steward_count)),
      (array[
        'On it — will report back at the next steward meeting.',
        'Done for my floor; two follow-ups still open on nights.',
        'Blocked until we hear back about the hall. Chasing it.',
        'Handing this to the steward with more contacts on that team.',
        'Numbers updated on the coverage map.',
        'Can someone double-check the Spanish version?'
      ])[1 + private.member_stress_pick(seed || ':ud:tkcb:' || k::text || ':' || c::text, 6)],
      pg_catalog.now() - ((private.member_stress_pick(seed || ':ud:tkct:' || k::text || ':' || c::text, 46) + 1) || ' hours')::interval
    from generate_series(1, 45) g(k)
    cross join lateral generate_series(1, private.member_stress_pick(seed || ':ud:tkcn:' || k::text, 4)) s(c)
    on conflict (id) do nothing;
  end if;

  perform private.uniondemo_sweep_trigger_rows(p_run_id);

  select pg_catalog.count(*) into thread_count from public.chapter_threads where chapter_id = chapter.chapter_id;
  select pg_catalog.count(*) into post_count from public.chapter_thread_posts where chapter_id = chapter.chapter_id;
  return jsonb_build_object(
    'chapter', chapter.chapter_id,
    'spaces', (select pg_catalog.count(*) from public.chapter_spaces where chapter_id = chapter.chapter_id),
    'threads', thread_count,
    'posts', post_count,
    'tasks', (select pg_catalog.count(*) from public.chapter_tasks where chapter_id = chapter.chapter_id),
    'tasks_seeded_this_call', tasks_seeded);
end;
$$;

-- ----------------------------------------------------- 7. per-member history --

create function public.uniondemo_enrich_batch(
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
  run private.uniondemo_runs%rowtype;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
  touched bigint := 0;
  seed text := p_run_id::text;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 2000 or p_start_ordinal < 1 then
    raise exception 'invalid enrichment batch range';
  end if;
  select * into run from private.uniondemo_runs where id = p_run_id;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied to enrich (state %)', run.state;
  end if;

  if p_phase = 'roles' then
    -- Stewards, chapter officers and the org VP, all chapter-scoped. Steward
    -- appointment desks (schedule + weekly windows) ride along so the booking
    -- surfaces are live.
    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, 'steward', l.chapter_id,
      greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward) + interval '60 days', t0 + interval '10 days'), null
    from private.uniondemo_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.steward
    on conflict (user_id, role) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, l.officer, l.chapter_id, t0 + interval '30 days', null
    from private.uniondemo_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.officer is not null
    on conflict (user_id, role) do nothing;

    insert into public.member_appointment_schedules
      (steward_id, timezone, min_notice_minutes, buffer_before_minutes, buffer_after_minutes, max_per_day, accepting, created_at, updated_at)
    select l.user_id, 'America/New_York', 240, 10, 10, 6, true, t0 + interval '30 days', t0 + interval '30 days'
    from private.uniondemo_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.steward
    on conflict (steward_id) do nothing;

    insert into public.member_appointment_windows (id, steward_id, weekday, start_minute, end_minute)
    select
      private.member_stress_uuid(seed || ':ud:apwin:' || l.ordinal::text || ':' || w.n::text),
      l.user_id,
      ((l.ordinal + w.n * 2) % 5) + 1,
      540 + ((l.ordinal + w.n) % 4) * 60,
      780 + ((l.ordinal + w.n) % 4) * 60
    from private.uniondemo_ledger l
    cross join (values (1), (2)) w(n)
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.steward
    on conflict (id) do nothing;

  elsif p_phase = 'texture' then
    -- Conversations with the chapter steward team plus the notification feed.
    -- Seeded notifications stay kind 'general' — the outbound rule at the top
    -- of this file.
    with tgt as (
      select l.ordinal, l.user_id, l.steward, l.chapter_index, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    convs as (
      select t.*, slot.n as slot, slot.title, slot.initials,
        private.member_stress_uuid(t.s || ':ud:conv:' || slot.n::text) as conv_id,
        3 + (case when t.steward then 18 else 0 end)
          + private.member_stress_pick(t.s || ':ud:msgs:' || slot.n::text,
              case when t.steward then 40 else 10 end) as msg_count
      from tgt t
      cross join (values
        (1, 'Chapter steward', 'CS'),
        (2, 'Steward team', 'ST'),
        (3, 'Grievance follow-up', 'GF')
      ) slot(n, title, initials)
      where slot.n = 1
        or (slot.n = 2 and t.steward)
        or (slot.n = 3 and not t.steward
            and private.member_stress_rand(t.s || ':ud:conv3') < 0.25)
    ),
    conv_ins as (
      insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at)
      select c.conv_id, c.user_id, c.title, c.initials,
        c.active_from + interval '2 days',
        c.active_from + interval '2 days'
          + (((c.msg_count - 1)::double precision / c.msg_count)
             * extract(epoch from (pg_catalog.now() - interval '1 day' - (c.active_from + interval '2 days'))) || ' seconds')::interval
      from convs c
      on conflict (id) do nothing
      returning 1
    )
    select pg_catalog.count(*) into touched from conv_ins;

    with tgt as (
      select l.ordinal, l.user_id, l.steward, l.chapter_index, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    convs as (
      select t.*, slot.n as slot,
        private.member_stress_uuid(t.s || ':ud:conv:' || slot.n::text) as conv_id,
        3 + (case when t.steward then 18 else 0 end)
          + private.member_stress_pick(t.s || ':ud:msgs:' || slot.n::text,
              case when t.steward then 40 else 10 end) as msg_count
      from tgt t
      cross join (values (1), (2), (3)) slot(n)
      where slot.n = 1
        or (slot.n = 2 and t.steward)
        or (slot.n = 3 and not t.steward
            and private.member_stress_rand(t.s || ':ud:conv3') < 0.25)
    ),
    msgs as (
      select c.*, m.i,
        c.active_from + interval '2 days'
          + (((m.i - 1)::double precision / c.msg_count)
             * extract(epoch from (pg_catalog.now() - interval '1 day' - (c.active_from + interval '2 days'))) || ' seconds')::interval
          as msg_at,
        private.member_stress_rand(c.s || ':ud:mwho:' || c.slot::text || ':' || m.i::text) < 0.48 as from_member
      from convs c
      cross join lateral generate_series(1, c.msg_count) m(i)
    )
    insert into public.member_messages (id, conversation_id, user_id, sender_kind, sender_name, body, read_at, created_at)
    select
      private.member_stress_uuid(m.s || ':ud:msg:' || m.slot::text || ':' || m.i::text),
      m.conv_id, m.user_id,
      case when m.from_member then 'member' else 'steward' end,
      case when m.from_member
        then private.uniondemo_full_name(p_run_id, m.ordinal)
        else private.uniondemo_full_name(p_run_id,
          (select c2.first_ordinal from private.uniondemo_chapters c2
            where c2.run_id = p_run_id and c2.chapter_index = m.chapter_index)
          + private.member_stress_pick(m.s || ':ud:mstw:' || m.slot::text || ':' || m.i::text,
              (select c2.steward_count from private.uniondemo_chapters c2
                where c2.run_id = p_run_id and c2.chapter_index = m.chapter_index)))
      end,
      (array[
        'My supervisor changed the posted schedule again without the contract notice.',
        'Can you check whether this write-up followed Article 12?',
        'We were short-staffed on the overnight again — third time this month.',
        'I was told to attend a meeting tomorrow. Should a steward come?',
        'The overtime list skipped me twice. Who tracks equalization?',
        'My telework day was cancelled without the notice window.',
        'Thanks for flagging it — I pulled the posted schedule and I am comparing it against Article 8.',
        'Bring every notice they handed you; receipt is not agreement.',
        'I filed the paperwork today and copied the coordinator.',
        'Yes — do not answer substantive questions until I am in the room.',
        'The employer owes a written answer by the end of next week.',
        'Logged. If it happens again this pay period we escalate to Step 2.',
        'The grievance clinic has openings Thursday — want me to book you in?',
        'Your Step 2 hearing is confirmed for next Tuesday at 10.',
        'The back-pay award landed — check your next stub and tell me if it is short.',
        'New steward office hours start Wednesday at noon on Zoom.',
        'I read the rights lesson — the investigatory meeting part was new to me.',
        'Adding two names to the turnout list now.',
        'Done. Both conversations went better than expected.',
        'See you Thursday at the chapter meeting.'
      ])[1 + private.member_stress_pick(m.s || ':ud:mbody:' || m.slot::text || ':' || m.i::text, 20)],
      case when m.i >= m.msg_count - 1 and not m.from_member
             and private.member_stress_rand(m.s || ':ud:mrd:' || m.slot::text || ':' || m.i::text) < 0.55
        then null
        else m.msg_at + interval '9 hours' end,
      m.msg_at
    from msgs m
    on conflict (id) do nothing;

    with tgt as (
      select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    feed as (
      select t.*, n.i,
        pg_catalog.now()
          - ((pg_catalog.floor(pg_catalog.power(private.member_stress_rand(t.s || ':ud:nage:' || n.i::text), 2) * 200) + 1) || ' days')::interval
          - ((private.member_stress_pick(t.s || ':ud:nhr:' || n.i::text, 22) + 1) || ' hours')::interval as at
      from tgt t
      cross join lateral generate_series(1,
        case when t.steward then 20 + private.member_stress_pick(t.s || ':ud:nn', 24)
             else 5 + private.member_stress_pick(t.s || ':ud:nn', 12) end) n(i)
    )
    insert into public.member_notifications (id, user_id, title, body, kind, read_at, created_at)
    select
      private.member_stress_uuid(f.s || ':ud:ntf:' || f.i::text),
      f.user_id,
      (array[
        'Ballot closes soon',
        'New chapter update',
        'Event reminder',
        'Case update posted',
        'Steward replied',
        'Form status changed',
        'New reply in your chapter thread',
        'Steward office hours tomorrow',
        'Grievance clinic openings',
        'New rights lesson available'
      ])[1 + private.member_stress_pick(f.s || ':ud:nti:' || f.i::text, 10)],
      (array[
        'Cast your vote before the chapter ballot closes this week.',
        'The latest chapter broadcast is ready in your feed.',
        'A chapter event you RSVP''d to starts soon.',
        'Your steward posted an update on your open case.',
        'Your steward answered your message — read it when you can.',
        'A form you filed moved to its next status.',
        'A steward replied to the thread you follow.',
        'Weekly office hours run at noon on Zoom and at the office.',
        'Drop-in slots are open this Thursday; a steward will help you file.',
        'Three minutes on your rights in investigatory meetings.'
      ])[1 + private.member_stress_pick(f.s || ':ud:nbo:' || f.i::text, 10)],
      'general',
      case when private.member_stress_rand(f.s || ':ud:nrd:' || f.i::text) < 0.66
        then f.at + ((1 + private.member_stress_pick(f.s || ':ud:nrh:' || f.i::text, 60)) || ' hours')::interval
        else null end,
      f.at
    from feed f
    on conflict (id) do nothing;

  elsif p_phase = 'casework' then
    -- Grievances worked by chapter stewards under the contract, plus steward
    -- requests and the appointment desks' bookings.
    with tgt as (
      select l.ordinal, l.user_id, l.steward, l.chapter_index, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from,
        c.first_ordinal, c.steward_count
      from private.uniondemo_ledger l
      join private.uniondemo_chapters c on c.run_id = l.run_id and c.chapter_index = l.chapter_index
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    cased as (
      select t.*, c.slot,
        private.member_stress_uuid(t.s || ':ud:case:' || c.slot::text) as case_id,
        private.member_stress_pick(t.s || ':ud:ctype:' || c.slot::text, 6) as type_idx,
        t.active_from + interval '15 days'
          + ((private.member_stress_pick(t.s || ':ud:cage:' || c.slot::text,
              greatest((extract(epoch from (pg_catalog.now() - t.active_from)) / 86400)::integer - 25, 1))) || ' days')::interval as opened,
        t.first_ordinal + private.member_stress_pick(t.s || ':ud:cstw:' || c.slot::text, t.steward_count) as steward_ordinal
      from tgt t
      cross join (values (1), (2)) c(slot)
      where (c.slot = 1 and private.member_stress_rand(t.s || ':ud:hascase')
              < case when t.steward then 0.40 else 0.26 end)
         or (c.slot = 2 and private.member_stress_rand(t.s || ':ud:hascase2') < 0.07)
    ),
    case_ins as (
      insert into public.member_cases (id, user_id, reference, title, deadline, case_type, articles, step,
        status, steward_user_id, steward_name, coordinator_user_id, coordinator_name,
        assigned_at, created_at, updated_at,
        deadline_notice_7_sent_at, deadline_notice_3_sent_at, deadline_notice_1_sent_at)
      select
        c.case_id, c.user_id,
        'UD-' || pg_catalog.to_char(c.opened, 'YYYY') || '-' || pg_catalog.lpad((c.ordinal * 2 - 2 + c.slot)::text, 6, '0'),
        (array[
          'Schedule changed without notice',
          'Overtime equalization skipped',
          'Discipline without just cause',
          'Telework day cancelled',
          'Unsafe staffing on the unit',
          'Retaliation after filing'
        ])[1 + c.type_idx],
        case when c.opened > pg_catalog.now() - interval '75 days'
          then (pg_catalog.now() + ((5 + private.member_stress_pick(c.s || ':ud:cdl:' || c.slot::text, 40)) || ' days')::interval)::date
          else (c.opened + interval '45 days')::date end,
        (array['Scheduling', 'Overtime', 'Discipline', 'Telework', 'Safety', 'Retaliation'])[1 + c.type_idx],
        (array[
          'Article 7 — Hours of Work',
          'Article 8.3 — Overtime equalization',
          'Article 12 — Discipline · Article 3 — Union Rights',
          'Article 15 — Telework',
          'Article 16 — Health and Safety',
          'Article 12 — Discipline · Article 3 — Union Rights'
        ])[1 + c.type_idx],
        case when c.opened > pg_catalog.now() - interval '75 days'
          then (array['Step 1', 'Step 2', 'Step 2', 'Step 3'])
            [1 + private.member_stress_pick(c.s || ':ud:cstep:' || c.slot::text, 4)]
          else 'Closed' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then 'active' else 'resolved' end,
        private.uniondemo_user_id(p_run_id, c.steward_ordinal),
        private.uniondemo_full_name(p_run_id, c.steward_ordinal),
        private.uniondemo_user_id(p_run_id, c.first_ordinal),
        private.uniondemo_full_name(p_run_id, c.first_ordinal),
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
      private.member_stress_uuid(l.user_id::text || ':ud:cu:' || c.id::text || ':' || g.i::text),
      c.id, c.user_id,
      (array[
        'Logged the incident with dates, shifts and witnesses.',
        'Step 1 filed; the employer''s written answer is due in 10 days.',
        'Step 1 denied without records; appealing to Step 2.',
        'Step 2 hearing held; we documented the just-cause defects.',
        'Settled — schedule restored and back pay agreed. Keeping the documentation.',
        'Escalating: three coworkers reported the same violation this month.'
      ])[1 + private.member_stress_pick(seed || ':ud:cub:' || c.id::text || ':' || g.i::text, 6)],
      c.created_at + ((g.i * (5 + private.member_stress_pick(seed || ':ud:cud:' || c.id::text || ':' || g.i::text, 12))) || ' days')::interval
    from private.uniondemo_ledger l
    join public.member_cases c on c.user_id = l.user_id
    cross join lateral generate_series(1, 1 + private.member_stress_pick(seed || ':ud:cun:' || c.id::text, 3)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and c.reference like 'UD-%'
    on conflict (id) do nothing;

    -- Steward requests, inserted in FINAL status (the award-on-acknowledgment
    -- trigger is UPDATE-only and must stay silent).
    insert into public.member_steward_requests (id, user_id, lesson_id, status, created_at, acknowledged_at, closed_at, handled_by)
    select
      private.member_stress_uuid(t.s || ':ud:sreq'),
      t.user_id,
      case when private.member_stress_rand(t.s || ':ud:srl') < 0.5 then null
        else (select les.id from public.member_rights_lessons les
          order by les.id
          offset private.member_stress_pick(t.s || ':ud:srlx',
            greatest((select pg_catalog.count(*)::integer from public.member_rights_lessons), 1))
          limit 1) end,
      case when private.member_stress_rand(t.s || ':ud:srs') < 0.10 then 'requested'
           when private.member_stress_rand(t.s || ':ud:srs') < 0.52 then 'acknowledged'
           else 'closed' end,
      case when private.member_stress_rand(t.s || ':ud:srs') < 0.10
        then pg_catalog.now() - ((1 + private.member_stress_pick(t.s || ':ud:srd', 9)) || ' days')::interval
        else t.active_from + interval '15 days'
          + ((private.member_stress_pick(t.s || ':ud:srd',
              greatest((extract(epoch from (pg_catalog.now() - t.active_from)) / 86400)::integer - 20, 1))) || ' days')::interval
      end,
      case when private.member_stress_rand(t.s || ':ud:srs') >= 0.10
        then t.active_from + interval '16 days' end,
      case when private.member_stress_rand(t.s || ':ud:srs') >= 0.52
        then t.active_from + interval '19 days' end,
      private.uniondemo_user_id(p_run_id, t.first_ordinal + private.member_stress_pick(t.s || ':ud:srh', t.steward_count))
    from (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from,
        c.first_ordinal, c.steward_count
      from private.uniondemo_ledger l
      join private.uniondemo_chapters c on c.run_id = l.run_id and c.chapter_index = l.chapter_index
      where l.run_id = p_run_id and l.ordinal between lo and hi and not l.steward
    ) t
    where private.member_stress_rand(t.s || ':ud:hasreq') < 0.38
    on conflict (id) do nothing;

    -- Appointment history: past appointments are completed/no_show (ignored
    -- by the exclusion constraints); every steward gets exactly ONE upcoming
    -- confirmed booking, booked by the member sitting steward_count positions
    -- after them in the block, in a slot derived from the steward's own block
    -- position — disjoint by construction.
    insert into public.member_appointments (id, user_id, steward_id, chapter_id, appointment_type,
      duration_minutes, starts_at, ends_at, status, routed_via, reason_category, created_at, updated_at)
    select
      private.member_stress_uuid(t.s || ':ud:appt:past'),
      t.user_id,
      private.uniondemo_user_id(p_run_id, t.first_ordinal + private.member_stress_pick(t.s || ':ud:apstw', t.steward_count)),
      t.chapter_id,
      (array['office_hours', 'grievance_followup', 'onboarding', 'contract_questions'])
        [1 + private.member_stress_pick(t.s || ':ud:aptype', 4)],
      (array[20, 30, 45])[1 + private.member_stress_pick(t.s || ':ud:apdur', 3)]::smallint,
      t.past_at,
      t.past_at + ((array[20, 30, 45])[1 + private.member_stress_pick(t.s || ':ud:apdur', 3)] || ' minutes')::interval,
      case when private.member_stress_rand(t.s || ':ud:apst') < 0.88 then 'completed' else 'no_show' end,
      case when private.member_stress_rand(t.s || ':ud:aprt') < 0.5 then 'steward' else 'chapter' end,
      (array['general', 'pay', 'scheduling', 'safety', 'discipline'])
        [1 + private.member_stress_pick(t.s || ':ud:aprc', 5)],
      t.past_at - interval '6 days',
      t.past_at
    from (
      select l.ordinal, l.user_id, l.chapter_id, seed || ':' || l.ordinal::text as s,
        c.first_ordinal, c.steward_count,
        pg_catalog.date_trunc('hour',
          greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0)
          + interval '30 days'
          + ((private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:apd',
              greatest((extract(epoch from (pg_catalog.now()
                - greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0))) / 86400)::integer - 40, 1))) || ' days')::interval) as past_at
      from private.uniondemo_ledger l
      join private.uniondemo_chapters c on c.run_id = l.run_id and c.chapter_index = l.chapter_index
      where l.run_id = p_run_id and l.ordinal between lo and hi
        and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:hasappt') < 0.20
        -- Members active less than ~45 days would produce a "completed"
        -- appointment dated in the future; they simply have none yet.
        and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0)
          < pg_catalog.now() - interval '45 days'
    ) t
    on conflict (id) do nothing;

    insert into public.member_appointments (id, user_id, steward_id, chapter_id, appointment_type,
      duration_minutes, starts_at, ends_at, status, routed_via, reason_category, created_at, updated_at)
    select
      private.member_stress_uuid(seed || ':ud:appt:up:' || s.ordinal::text),
      b.user_id,
      s.user_id,
      s.chapter_id,
      'contract_questions', 30::smallint,
      up.starts_at, up.starts_at + interval '30 minutes',
      'confirmed',
      'chapter', 'general',
      pg_catalog.now() - interval '2 days',
      pg_catalog.now() - interval '2 days'
    from private.uniondemo_ledger s
    join private.uniondemo_chapters c on c.run_id = s.run_id and c.chapter_index = s.chapter_index
    join private.uniondemo_ledger b on b.run_id = s.run_id and b.ordinal = s.ordinal + c.steward_count
    cross join lateral (
      select pg_catalog.date_trunc('day', pg_catalog.now())
        + ((3 + ((s.ordinal - c.first_ordinal) % 10)) || ' days')::interval
        + ((9 + (((s.ordinal - c.first_ordinal) / 10) % 8)) || ' hours')::interval as starts_at
    ) up
    where s.run_id = p_run_id and s.ordinal between lo and hi and s.steward
      and b.chapter_index = s.chapter_index
      and not exists (select 1 from public.member_appointments a
        where a.id = private.member_stress_uuid(seed || ':ud:appt:up:' || s.ordinal::text));

    insert into public.member_appointment_events (id, appointment_id, actor, action, detail, created_at)
    select
      private.member_stress_uuid(seed || ':ud:apev:' || a.id::text),
      a.id, a.user_id, 'booked', '{}'::jsonb, a.created_at
    from public.member_appointments a
    join private.uniondemo_ledger l on l.user_id = a.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and a.chapter_id like 'ud-%'
    on conflict (id) do nothing;

    perform private.uniondemo_sweep_trigger_rows(p_run_id);

  elsif p_phase = 'participation' then
    -- Participation in the member's OWN chapter, scaled by recency so the
    -- curves rise; nobody participates in anything dated before they were
    -- active. Stewards participate at near-total rates.
    insert into public.member_event_rsvps (event_id, user_id, status, created_at, updated_at)
    select e.id, l.user_id,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:rs:' || e.id) < 0.9
        then 'going' else 'not_going' end,
      e.starts_at - ((2 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:rt:' || e.id, 10)) || ' days')::interval,
      e.starts_at - ((2 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:rt:' || e.id, 10)) || ' days')::interval
    from private.uniondemo_ledger l
    join public.member_events e on e.chapter_id = l.chapter_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.id like 'ud-evt-%'
      and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) < e.starts_at - interval '3 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:rv:' || e.id)
        < case when l.steward then 0.85
            else 0.06 + 0.20 * greatest(least(extract(epoch from (e.starts_at - t0))
              / extract(epoch from interval '1460 days'), 1.0), 0.0) end
    on conflict (event_id, user_id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_event_checkins (event_id, user_id, checked_in_at, scanned_by)
    select r.event_id, r.user_id, e.starts_at + interval '11 minutes', null
    from public.member_event_rsvps r
    join public.member_events e on e.id = r.event_id
    join private.uniondemo_ledger l on l.user_id = r.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.id like 'ud-evt-%'
      and e.starts_at < pg_catalog.now()
      and r.status = 'going'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:ci:' || r.event_id) < 0.64
    on conflict (event_id, user_id) do nothing;

    insert into public.member_ballot_votes (ballot_id, option_id, user_id, submitted_at)
    select b.id, o.id, l.user_id,
      coalesce(b.closed_at, pg_catalog.now())
        - ((1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:bd:' || b.id, 12)) || ' days')::interval
    from private.uniondemo_ledger l
    join public.member_ballots b on b.chapter_id = l.chapter_id
    join public.member_ballot_options o on o.ballot_id = b.id
      and o.order_index = 1 + case
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:bo:' || b.id) < 0.72 then 0
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:bo:' || b.id) < 0.92 then 1
        else 2 end
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and b.id like 'ud-ballot-%'
      and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) < b.closes_at - interval '2 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:bv:' || b.id)
        < case when l.steward then 0.96
            when b.active then 0.38
            else 0.30 + 0.35 * greatest(least(extract(epoch from (b.closes_at - t0))
              / extract(epoch from interval '1460 days'), 1.0), 0.0) end
    on conflict (ballot_id, user_id) do nothing;

    insert into public.member_ballot_receipts (id, ballot_id, user_id, receipt_code, counted, issued_at)
    select
      private.member_stress_uuid(seed || ':' || l.ordinal::text || ':ud:brc:' || v.ballot_id),
      v.ballot_id, v.user_id,
      private.uniondemo_receipt_code(seed || ':' || l.ordinal::text || ':ud:brcode:' || v.ballot_id),
      true, v.submitted_at
    from public.member_ballot_votes v
    join private.uniondemo_ledger l on l.user_id = v.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and v.ballot_id like 'ud-ballot-%'
    on conflict (ballot_id, user_id) do nothing;

    insert into public.member_survey_responses (survey_id, option_id, user_id, submitted_at)
    select s.id, o.id, l.user_id,
      coalesce(s.closed_at, pg_catalog.now())
        - ((1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:sd:' || s.id, 12)) || ' days')::interval
    from private.uniondemo_ledger l
    join public.member_surveys s on s.chapter_id = l.chapter_id
    join public.member_survey_options o on o.survey_id = s.id
      and o.order_index = 1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:so:' || s.id,
        (select pg_catalog.count(*)::integer from public.member_survey_options o2 where o2.survey_id = s.id))
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and s.id like 'ud-pulse-%'
      and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) < s.closes_at - interval '2 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:sv:' || s.id)
        < case when l.steward then 0.92 when s.active then 0.28 else 0.45 end
    on conflict (survey_id, user_id) do nothing;

    insert into public.member_broadcast_receipts (broadcast_id, user_id, read_at)
    select b.id, l.user_id,
      b.published_at + ((private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:brr:' || b.id, 96) + 2) || ' hours')::interval
    from private.uniondemo_ledger l
    cross join public.member_broadcasts b
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and b.id like 'ud-bc-%'
      and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) < b.published_at
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:brd:' || b.id)
        < case when l.steward then 0.85 else 0.48 end
    on conflict (broadcast_id, user_id) do nothing;

    -- member_forms_one_active_idx allows ONE draft/returned form per
    -- (user, template): slot 2 is always approved, so at most one seeded
    -- draft can ever exist per member.
    insert into public.member_forms (id, user_id, template_key, template_version, status, answers, step,
      submitted_at, created_at, updated_at)
    select
      private.member_stress_uuid(t.s || ':ud:form:' || f.slot::text),
      t.user_id, ft.key, ft.version,
      case when f.slot = 2 then 'approved'
        else (array['approved', 'approved', 'submitted', 'draft'])[1 + private.member_stress_pick(t.s || ':ud:fs:' || f.slot::text, 4)] end,
      '{}'::jsonb, 0,
      case when f.slot <> 2
        and (array['approved', 'approved', 'submitted', 'draft'])[1 + private.member_stress_pick(t.s || ':ud:fs:' || f.slot::text, 4)] = 'draft'
        then null else t.active_from + ((30 + private.member_stress_pick(t.s || ':ud:fd:' || f.slot::text, 300)) || ' days')::interval end,
      t.active_from + ((30 + private.member_stress_pick(t.s || ':ud:fd:' || f.slot::text, 300)) || ' days')::interval,
      t.active_from + ((30 + private.member_stress_pick(t.s || ':ud:fd:' || f.slot::text, 300)) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join (values (1), (2)) f(slot)
    join lateral (
      select ftpl.key, ftpl.version from public.form_templates ftpl where ftpl.active
      order by ftpl.key
      offset private.member_stress_pick(t.s || ':ud:ft:' || f.slot::text,
        greatest((select pg_catalog.count(*)::integer from public.form_templates where active), 1))
      limit 1
    ) ft on true
    where (f.slot = 1 and (t.steward or private.member_stress_rand(t.s || ':ud:hasform') < 0.20))
       or (f.slot = 2 and t.steward)
    on conflict (id) do nothing;

    insert into public.member_workload_logs (id, user_id, priority, pending, unread_docs, todos, referrals,
      ce_activities, assistance_requests, aged_cases, weekly_assigned, employment, pt_hours, receipt_code,
      created_at, logged_on)
    select
      private.member_stress_uuid(t.s || ':ud:wl'),
      t.user_id,
      private.member_stress_pick(t.s || ':ud:wp', 10),
      private.member_stress_pick(t.s || ':ud:wpe', 30),
      private.member_stress_pick(t.s || ':ud:wu', 20),
      private.member_stress_pick(t.s || ':ud:wt', 25),
      private.member_stress_pick(t.s || ':ud:wr', 10),
      private.member_stress_pick(t.s || ':ud:wc', 6),
      private.member_stress_pick(t.s || ':ud:wa', 8),
      private.member_stress_pick(t.s || ':ud:wg', 12),
      10 + private.member_stress_pick(t.s || ':ud:ww', 20),
      case when private.member_stress_rand(t.s || ':ud:we') < 0.85 then 'full_time' else 'part_time' end,
      case when private.member_stress_rand(t.s || ':ud:we') < 0.85 then null
        else (16 + private.member_stress_pick(t.s || ':ud:wph', 24))::smallint end,
      pg_catalog.substr(pg_catalog.md5(t.s || ':ud:wrc'), 1, 8),
      pg_catalog.now() - ((private.member_stress_pick(t.s || ':ud:wd', 90) + 1) || ' days')::interval,
      (pg_catalog.now() - ((private.member_stress_pick(t.s || ':ud:wd', 90) + 1) || ' days')::interval)::date
    from (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    where private.member_stress_rand(t.s || ':ud:haswl') < 0.14
    on conflict (id) do nothing;

  elsif p_phase = 'history' then
    -- Backdated activity: the action log stays action_kind 'seed' so the
    -- award trigger returns immediately; points are minted directly with
    -- occurred_at at least 8 days back, outside every weekly cap window.
    insert into public.member_action_log (id, user_id, action_key, action_kind, occurred_at)
    select
      private.member_stress_uuid(t.s || ':ud:log:' || g.i::text),
      t.user_id, 'ud-log-' || t.ordinal::text || '-' || g.i::text, 'seed',
      t.active_from + ((private.member_stress_pick(t.s || ':ud:logd:' || g.i::text,
        greatest(t.age_days - 2, 1))) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from,
        (extract(epoch from (pg_catalog.now() - greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0))) / 86400)::integer as age_days
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join lateral generate_series(1,
      case when t.steward then 24 + private.member_stress_pick(t.s || ':ud:logn', 30)
           else 5 + private.member_stress_pick(t.s || ':ud:logn', 12) end) g(i)
    on conflict (id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_point_events (id, user_id, action_key, action_kind, points, occurred_at)
    select
      private.member_stress_uuid(t.s || ':ud:pt:' || g.i::text),
      t.user_id, 'ud-hist-' || t.ordinal::text || '-' || g.i::text,
      (array['message', 'rsvp', 'checkin', 'survey', 'vote', 'rights', 'case', 'steward'])
        [1 + private.member_stress_pick(t.s || ':ud:ptk:' || g.i::text, 8)],
      (array[2, 5, 8, 10, 15, 20, 25, 40])[1 + private.member_stress_pick(t.s || ':ud:ptk:' || g.i::text, 8)],
      pg_catalog.now() - ((8 + private.member_stress_pick(t.s || ':ud:ptd:' || g.i::text,
        greatest(t.age_days - 10, 1))) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s,
        (extract(epoch from (pg_catalog.now() - greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0))) / 86400)::integer as age_days
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join lateral generate_series(1,
      case when t.steward then 36 + private.member_stress_pick(t.s || ':ud:ptn', 60)
           else 1 + private.member_stress_pick(t.s || ':ud:ptn', 15) end) g(i)
    on conflict (user_id, action_key) do nothing;

    insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
    select les.id, l.user_id,
      case when l.steward then array[0, 1, 2]
        else case private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:rp:' || les.id, 3)
          when 0 then array[0]
          when 1 then array[0, 1]
          else array[0, 1, 2]
        end end
    from private.uniondemo_ledger l
    cross join public.member_rights_lessons les
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and (l.steward or private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:rl:' || les.id) < 0.40)
    on conflict (lesson_id, user_id) do nothing;

    with topics as (
      select * from (values
        (0, 'What are my Weingarten rights?',
            'If a meeting could lead to discipline, you may request a steward before answering. Ask clearly and stop answering substantive questions until representation arrives.'),
        (1, 'How long do I have to file a grievance?',
            'A grievance must be filed within 21 calendar days of the event or of when you reasonably learned of it. Your steward tracks the deadlines with you.'),
        (2, 'Can they change my schedule without notice?',
            'Article 7 sets the posting and notice windows. Save the posted schedule and document when each change was delivered, then talk to your steward.'),
        (3, 'How does overtime equalization work?',
            'Article 8.3 requires rotation from the posted list. If you were skipped, the remedy is make-up hours — file it, do not absorb it.'),
        (4, 'What does just cause mean for discipline?',
            'Article 12 requires progressive discipline with proof. Signature on a notice confirms receipt only, never agreement.'),
        (5, 'How do I request telework?',
            'Article 15 sets the request and response windows. A denial must be in writing with a reason you can grieve.'),
        (6, 'What happens at a Step 2 hearing?',
            'The employer owes a written answer after the hearing. Bring your documentation; your steward presents the contract violations.'),
        (7, 'How do chapter ballots work?',
            'Ballots are chapter-scoped with a quorum target and a receipt code you can verify. Results publish after close.')
      ) v(idx, q, a)
    ),
    gthreads as (
      select t.ordinal, t.user_id, t.s, t.active_from, g.i,
        private.member_stress_uuid(t.s || ':ud:gt:' || g.i::text) as thread_id,
        private.member_stress_pick(t.s || ':ud:gtt:' || g.i::text, 8) as topic_idx,
        t.active_from + ((10 + private.member_stress_pick(t.s || ':ud:gtd:' || g.i::text,
          greatest(t.age_days - 12, 1))) || ' days')::interval as at
      from (
        select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s,
          greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from,
          (extract(epoch from (pg_catalog.now() - greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0))) / 86400)::integer as age_days
        from private.uniondemo_ledger l
        where l.run_id = p_run_id and l.ordinal between lo and hi
      ) t
      cross join lateral generate_series(1,
        case when t.steward then 2 + private.member_stress_pick(t.s || ':ud:gtn', 3)
             else 1 end) g(i)
      where t.steward or private.member_stress_rand(t.s || ':ud:hasgt') < 0.20
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
      private.member_stress_uuid(g.s || ':ud:gm:' || g.i::text || ':' || m.n::text),
      g.thread_id, g.user_id, m.role,
      case when m.role = 'user' then topics.q else topics.a end,
      g.at + m.offs
    from gthreads g
    join topics on topics.idx = g.topic_idx
    cross join (values ('user', interval '0 seconds', 1), ('assistant', interval '8 seconds', 2)) m(role, offs, n)
    on conflict (id) do nothing;

  else
    raise exception 'unknown union demo enrichment phase %', p_phase;
  end if;

  return jsonb_build_object('phase', p_phase, 'from', lo, 'to', hi, 'touched', touched);
end;
$$;

-- ------------------------------------------------------ 8. status and verify --

create function public.uniondemo_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '180s'
as $$
declare
  run private.uniondemo_runs%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'union demo RPC requires service_role'; end if;
  select * into run from private.uniondemo_runs where id = p_run_id;
  if not found then raise exception 'unknown union demo run'; end if;
  return jsonb_build_object(
    'run_id', run.id,
    'state', run.state,
    'members_expected', run.member_count,
    'stewards_expected', run.steward_count,
    'logins_expected', run.login_count,
    'ledger_rows', (select pg_catalog.count(*) from private.uniondemo_ledger where run_id = p_run_id),
    'chapters', (select pg_catalog.count(*) from public.chapters ch join private.uniondemo_chapters map on map.chapter_id = ch.id where map.run_id = p_run_id),
    'auth_users', (select pg_catalog.count(*) from auth.users u join private.uniondemo_ledger l on l.user_id = u.id where l.run_id = p_run_id),
    'profiles', (select pg_catalog.count(*) from public.member_profiles p join private.uniondemo_ledger l on l.user_id = p.id where l.run_id = p_run_id),
    'steward_roles', (select pg_catalog.count(*) from public.member_roles r join private.uniondemo_ledger l on l.user_id = r.user_id where l.run_id = p_run_id and r.role = 'steward'),
    'officer_roles', (select pg_catalog.count(*) from public.member_roles r join private.uniondemo_ledger l on l.user_id = r.user_id where l.run_id = p_run_id and r.role in ('coordinator', 'advisor', 'admin', 'vp')),
    'conversations', (select pg_catalog.count(*) from public.member_conversations c join private.uniondemo_ledger l on l.user_id = c.user_id where l.run_id = p_run_id),
    'messages', (select pg_catalog.count(*) from public.member_messages m join private.uniondemo_ledger l on l.user_id = m.user_id where l.run_id = p_run_id),
    'notifications', (select pg_catalog.count(*) from public.member_notifications n join private.uniondemo_ledger l on l.user_id = n.user_id where l.run_id = p_run_id),
    'cases', (select pg_catalog.count(*) from public.member_cases c join private.uniondemo_ledger l on l.user_id = c.user_id where l.run_id = p_run_id),
    'steward_requests', (select pg_catalog.count(*) from public.member_steward_requests s join private.uniondemo_ledger l on l.user_id = s.user_id where l.run_id = p_run_id),
    'appointments', (select pg_catalog.count(*) from public.member_appointments a join private.uniondemo_ledger l on l.user_id = a.user_id where l.run_id = p_run_id),
    'event_rsvps', (select pg_catalog.count(*) from public.member_event_rsvps r join private.uniondemo_ledger l on l.user_id = r.user_id where l.run_id = p_run_id),
    'event_checkins', (select pg_catalog.count(*) from public.member_event_checkins c join private.uniondemo_ledger l on l.user_id = c.user_id where l.run_id = p_run_id),
    'ballot_votes', (select pg_catalog.count(*) from public.member_ballot_votes v join private.uniondemo_ledger l on l.user_id = v.user_id where l.run_id = p_run_id),
    'ballot_receipts', (select pg_catalog.count(*) from public.member_ballot_receipts b join private.uniondemo_ledger l on l.user_id = b.user_id where l.run_id = p_run_id),
    'survey_responses', (select pg_catalog.count(*) from public.member_survey_responses s join private.uniondemo_ledger l on l.user_id = s.user_id where l.run_id = p_run_id),
    'broadcast_receipts', (select pg_catalog.count(*) from public.member_broadcast_receipts b join private.uniondemo_ledger l on l.user_id = b.user_id where l.run_id = p_run_id),
    'forms', (select pg_catalog.count(*) from public.member_forms f join private.uniondemo_ledger l on l.user_id = f.user_id where l.run_id = p_run_id),
    'point_events', (select pg_catalog.count(*) from public.member_point_events e join private.uniondemo_ledger l on l.user_id = e.user_id where l.run_id = p_run_id),
    'action_log', (select pg_catalog.count(*) from public.member_action_log a join private.uniondemo_ledger l on l.user_id = a.user_id where l.run_id = p_run_id),
    'rights_progress', (select pg_catalog.count(*) from public.member_rights_progress r join private.uniondemo_ledger l on l.user_id = r.user_id where l.run_id = p_run_id),
    'guide_threads', (select pg_catalog.count(*) from public.member_guide_threads t join private.uniondemo_ledger l on l.user_id = t.user_id where l.run_id = p_run_id),
    'org_events', (select pg_catalog.count(*) from public.member_events where id like 'ud-evt-%'),
    'org_ballots', (select pg_catalog.count(*) from public.member_ballots where id like 'ud-ballot-%'),
    'org_broadcasts', (select pg_catalog.count(*) from public.member_broadcasts where id like 'ud-bc-%'),
    'org_threads', (select pg_catalog.count(*) from public.chapter_threads t join private.uniondemo_chapters map on map.chapter_id = t.chapter_id where map.run_id = p_run_id),
    'org_thread_posts', (select pg_catalog.count(*) from public.chapter_thread_posts t join private.uniondemo_chapters map on map.chapter_id = t.chapter_id where map.run_id = p_run_id),
    'org_tasks', (select pg_catalog.count(*) from public.chapter_tasks t join private.uniondemo_chapters map on map.chapter_id = t.chapter_id where map.run_id = p_run_id),
    'protected_unchanged', run.protected_snapshot = private.uniondemo_protected_snapshot(p_run_id));
end;
$$;

create function public.uniondemo_verify(p_run_id uuid, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.uniondemo_runs%rowtype;
  result jsonb;
  typed_kinds bigint;
  deliveries bigint;
  fresh_points bigint;
  cases_total bigint;
  cases_distinct bigint;
  guarded_prefs bigint;
  chapter_mismatches bigint;
  login_rows bigint;
  password_sample bigint;
  sample_size integer;
  passed boolean;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'union demo RPC requires service_role'; end if;
  if pg_catalog.char_length(coalesce(p_password, '')) < 24 then raise exception 'demo password is too short'; end if;
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('applied', 'verified') then raise exception 'run is not fully applied'; end if;

  result := public.uniondemo_status(p_run_id);

  select pg_catalog.count(*) into typed_kinds
  from public.member_notifications n
  join private.uniondemo_ledger l on l.user_id = n.user_id and l.run_id = p_run_id
  where n.kind <> 'general';

  select pg_catalog.count(*) into deliveries
  from public.member_notification_deliveries d
  join private.uniondemo_ledger l on l.user_id = d.user_id and l.run_id = p_run_id;

  select pg_catalog.count(*) into fresh_points
  from public.member_point_events e
  join private.uniondemo_ledger l on l.user_id = e.user_id and l.run_id = p_run_id
  where e.occurred_at >= pg_catalog.date_trunc('week', pg_catalog.now());

  select pg_catalog.count(*), pg_catalog.count(distinct c.reference)
    into cases_total, cases_distinct
  from public.member_cases c
  join private.uniondemo_ledger l on l.user_id = c.user_id and l.run_id = p_run_id;

  select pg_catalog.count(*) into guarded_prefs
  from public.member_profiles p
  join private.uniondemo_ledger l on l.user_id = p.id and l.run_id = p_run_id
  where p.notification_prefs @> '{"deadlines": false, "cases": false, "forms": false, "votes": false, "events": false, "tasks": false, "appointments": false, "workload": false}'::jsonb;

  -- The 20-chapter distribution is exact: every chapter's profile count must
  -- equal its mapped member count.
  select pg_catalog.count(*) into chapter_mismatches
  from private.uniondemo_chapters map
  where map.run_id = p_run_id
    and map.member_count <> (
      select pg_catalog.count(*) from public.member_profiles p
      join private.uniondemo_ledger l on l.user_id = p.id and l.run_id = p_run_id
      where p.chapter_id = map.chapter_id);

  sample_size := least(run.login_count, 20);
  select pg_catalog.count(*) into password_sample
  from auth.users u
  join private.uniondemo_ledger l on l.user_id = u.id
  where l.run_id = p_run_id and l.login_capable and l.ordinal <= sample_size
    -- The CASE is load-bearing: without it the planner may evaluate crypt()
    -- against a non-login row's empty hash first and raise "invalid salt".
    and case when u.encrypted_password like '$2%'
      then u.encrypted_password = extensions.crypt(p_password, u.encrypted_password)
      else false end;

  select pg_catalog.count(*) into login_rows
  from auth.users u
  join private.uniondemo_ledger l on l.user_id = u.id
  where l.run_id = p_run_id and l.login_capable and u.encrypted_password <> '';

  passed :=
    (result ->> 'ledger_rows')::bigint = run.member_count
    and (result ->> 'auth_users')::bigint = run.member_count
    and (result ->> 'profiles')::bigint = run.member_count
    and (result ->> 'chapters')::bigint = 20
    and (result ->> 'steward_roles')::bigint = run.steward_count
    and (result ->> 'officer_roles')::bigint = 61
    and chapter_mismatches = 0
    and guarded_prefs = run.member_count
    and typed_kinds = 0
    and deliveries = 0
    and fresh_points = 0
    and cases_total = cases_distinct
    and password_sample = sample_size
    and login_rows = run.login_count
    and (result ->> 'conversations')::bigint >= run.member_count
    and (result ->> 'messages')::bigint >= run.member_count * 4
    and (result ->> 'org_events')::bigint >= 20 * 60
    and (result ->> 'org_ballots')::bigint = 20 * 9
    and (result ->> 'org_broadcasts')::bigint >= 200
    and (result ->> 'org_threads')::bigint >= 20 * 30
    and (result ->> 'org_thread_posts')::bigint >= 20 * 300
    and (result ->> 'org_tasks')::bigint >= 20 * 40
    and (result ->> 'appointments')::bigint >= run.steward_count
    and (result ->> 'protected_unchanged')::boolean;

  if passed then
    update private.uniondemo_runs
    set state = 'verified', verified_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_run_id;
  end if;
  return result || jsonb_build_object(
    'typed_notification_kinds', typed_kinds,
    'outbound_deliveries', deliveries,
    'points_in_current_week', fresh_points,
    'cases_distinct_refs', cases_distinct,
    'guarded_prefs', guarded_prefs,
    'chapter_mismatches', chapter_mismatches,
    'password_sample', password_sample,
    'password_sample_size', sample_size,
    'login_rows', login_rows,
    'state', case when passed then 'verified' else run.state end,
    'ok', passed);
end;
$$;

-- ------------------------------------------------------------- 9. removal ----

create function public.uniondemo_begin_remove(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '180s'
as $$
declare
  run private.uniondemo_runs%rowtype;
  collision_count bigint;
  remaining bigint;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state = 'removed' then return jsonb_build_object('state', 'removed', 'remaining', 0, 'resumed', true); end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified', 'removing') then
    raise exception 'run cannot be removed';
  end if;
  if run.protected_snapshot <> private.uniondemo_protected_snapshot(p_run_id) then
    raise exception 'non-demo user snapshot changed; removal stopped';
  end if;
  select pg_catalog.count(*) into collision_count
  from auth.users users
  join private.uniondemo_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id
    and (pg_catalog.lower(users.email) <> ledger.email
      or coalesce(users.raw_app_meta_data ->> 'uniondemo_run_id', '') <> p_run_id::text);
  if collision_count <> 0 then raise exception 'removal preflight found non-owned auth rows'; end if;
  update private.uniondemo_runs set state = 'removing', updated_at = pg_catalog.now() where id = p_run_id;
  select pg_catalog.count(*) into remaining from auth.users users
  join private.uniondemo_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  return jsonb_build_object('state', 'removing', 'remaining', remaining, 'resumed', run.state = 'removing');
end;
$$;

create function public.uniondemo_remove_batch(
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
  run private.uniondemo_runs%rowtype;
  deleted_count bigint;
  remaining bigint;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 2000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state = 'removed' then return jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed'); end if;
  if run.state <> 'removing' then raise exception 'removal preflight has not passed'; end if;

  -- The task boards and channels are removed BEFORE any auth user: deleting a
  -- user first would cascade SET NULL onto chapter_tasks identity columns,
  -- fire the audit trigger, and insert an activity row whose actor_id is the
  -- identity mid-delete — a foreign-key violation. Idempotent per batch call.
  delete from public.chapter_task_activity t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_comments t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_assignments t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_subtasks t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_attachments t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_files t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_messages t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_watchers t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_dependencies t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_template_details t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_tasks t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_thread_posts t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_threads t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_space_members m
    using public.chapter_spaces s, private.uniondemo_chapters map
    where map.run_id = p_run_id and s.chapter_id = map.chapter_id and s.id = m.space_id;
  delete from public.chapter_spaces s using private.uniondemo_chapters map
    where map.run_id = p_run_id and s.chapter_id = map.chapter_id;

  with selected as (
    select users.id
    from auth.users users
    join private.uniondemo_ledger ledger on ledger.user_id = users.id
    where ledger.run_id = p_run_id
      and pg_catalog.lower(users.email) = ledger.email
      and users.raw_app_meta_data ->> 'uniondemo_run_id' = p_run_id::text
    order by ledger.ordinal
    limit p_batch_count
  ), deleted as (
    delete from auth.users users using selected where users.id = selected.id returning users.id
  ) select pg_catalog.count(*) into deleted_count from deleted;

  select pg_catalog.count(*) into remaining from auth.users users
  join private.uniondemo_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;

  if remaining = 0 then
    if run.protected_snapshot <> private.uniondemo_protected_snapshot(p_run_id) then
      raise exception 'non-demo user snapshot changed during removal';
    end if;

    -- Org sweep. Every row below is scoped to a mapped 'ud-*' chapter id or a
    -- 'ud-' id prefix; the users (and so every user-cascading row) are
    -- already gone. Anything a real identity somehow attached to a demo
    -- chapter stops the sweep instead of being deleted.
    if exists (select 1 from public.member_profiles p
        join private.uniondemo_chapters map on map.chapter_id = p.chapter_id
        where map.run_id = p_run_id) then
      raise exception 'a live profile still references a union demo chapter; sweep stopped';
    end if;
    if exists (select 1 from public.member_ballot_votes where ballot_id like 'ud-ballot-%') then
      raise exception 'union demo ballots still hold votes from non-demo identities; sweep stopped';
    end if;

    delete from private.chapter_task_number_counters c using private.uniondemo_chapters map
      where map.run_id = p_run_id and c.chapter_id = map.chapter_id;
    delete from public.chapter_workstreams w using private.uniondemo_chapters map
      where map.run_id = p_run_id and w.chapter_id = map.chapter_id;
    delete from public.member_event_checkins c
      using public.member_events e where e.id = c.event_id and e.id like 'ud-evt-%';
    delete from public.member_event_rsvps r
      using public.member_events e where e.id = r.event_id and e.id like 'ud-evt-%';
    delete from public.member_events where id like 'ud-evt-%';
    delete from public.member_ballot_receipts where ballot_id like 'ud-ballot-%';
    delete from public.member_ballot_options where ballot_id like 'ud-ballot-%';
    delete from public.member_ballots where id like 'ud-ballot-%';
    delete from public.member_survey_responses where survey_id like 'ud-pulse-%';
    delete from public.member_survey_options where survey_id like 'ud-pulse-%';
    delete from public.member_surveys where id like 'ud-pulse-%';
    delete from public.member_broadcast_receipts where broadcast_id like 'ud-bc-%';
    delete from public.member_broadcasts where id like 'ud-bc-%';
    delete from public.chapters ch using private.uniondemo_chapters map
      where map.run_id = p_run_id and ch.id = map.chapter_id;

    update private.uniondemo_runs
    set state = 'removed', removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_run_id;
  end if;
  return jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
end;
$$;

-- ------------------------------------------------------------- 10. grants ----

revoke all on function private.uniondemo_user_id(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_email(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_first_name(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_last_name(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_full_name(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_joined_at(uuid, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_receipt_code(text) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_authorize(text, text) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_impersonate(uuid) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_sweep_trigger_rows(uuid) from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_protected_snapshot(uuid) from public, anon, authenticated, service_role;

revoke all on function public.uniondemo_begin(uuid, text, integer, integer, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.uniondemo_apply_batch(uuid, integer, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.uniondemo_seed_org(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.uniondemo_seed_channels(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.uniondemo_enrich_batch(uuid, text, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.uniondemo_status(uuid) from public, anon, authenticated;
revoke all on function public.uniondemo_verify(uuid, text) from public, anon, authenticated;
revoke all on function public.uniondemo_begin_remove(uuid, text, text) from public, anon, authenticated;
revoke all on function public.uniondemo_remove_batch(uuid, integer, text, text) from public, anon, authenticated;

grant execute on function public.uniondemo_begin(uuid, text, integer, integer, integer, text, text, text) to service_role;
grant execute on function public.uniondemo_apply_batch(uuid, integer, integer, text, text, text) to service_role;
grant execute on function public.uniondemo_seed_org(uuid, integer, text, text) to service_role;
grant execute on function public.uniondemo_seed_channels(uuid, integer, text, text) to service_role;
grant execute on function public.uniondemo_enrich_batch(uuid, text, integer, integer, text, text) to service_role;
grant execute on function public.uniondemo_status(uuid) to service_role;
grant execute on function public.uniondemo_verify(uuid, text) to service_role;
grant execute on function public.uniondemo_begin_remove(uuid, text, text) to service_role;
grant execute on function public.uniondemo_remove_batch(uuid, integer, text, text) to service_role;

-- CONTRACT COORDINATION (scripts/db-contract.json): every public uniondemo_*
-- function gets a functions entry (secdef, exec "service_role", inline
-- statement_timeout in config); the private helpers get exec "" entries; the
-- three private tables get empty tableGrants entries alongside the stress and
-- presg families. tests/uniondemo-seed.test.js pins this file.
