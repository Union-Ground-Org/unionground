-- Union Demo Org SAMPLE seed additive organization/function-parity upgrade.
--
-- The original base migration is intentionally preserved verbatim at
-- 20260824233000 because that exact version and SQL are recorded in the
-- deployed database. This later migration must remain safe after that base:
-- it only replaces functions whose bodies changed for the isolated SAMPLE
-- project and organization-scoped schema. It does not recreate or clear the
-- private run, chapter, or ledger tables, so an existing run remains intact.
--
-- CREATE OR REPLACE preserves each function's owner and service_role-only
-- grants established by the base migration.
--
-- The changed functions cover:
--   * exact SAMPLE-project authorization;
--   * function-parity dataset and unlabelled SAMPLE-origin chapter names;
--   * organization/chapter memberships for seeded identities;
--   * organization-scoped chapters and broadcasts;
--   * chapter- and organization-scoped role grants.

create or replace function private.uniondemo_authorize(p_target_ref text, p_confirm_token text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'union demo RPC requires service_role';
  end if;
  if p_target_ref <> 'sampledemoprojectref' then
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

create or replace function public.uniondemo_begin(
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
  if p_dataset_version <> 'uniondemo-v2-function-parity' or p_config_hash !~ '^[0-9a-f]{64}$' then
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
      (1,  'ud-wor-dds',   'Riverbend Care Services',                'Care Services', 72),
      (2,  'ud-bos-dds',   'Stonebridge Care Services',              'Care Services', 85),
      (3,  'ud-spr-dds',   'Lakeside Care Services',                 'Care Services', 60),
      (4,  'ud-dcf-bos',   'Stonebridge Family Services',            'Family Services', 68),
      (5,  'ud-dmh-bos',   'Stonebridge Health Services',            'Health Services', 55),
      (6,  'ud-dta-bos',   'Stonebridge Benefits Office',            'Benefits Office', 50),
      (7,  'ud-dds-cape',  'Seaward Islands Care Services',          'Care Services', 30),
      (8,  'ud-dds-mer',   'Mill Valley Care Services',              'Care Services', 52),
      (9,  'ud-dds-berk',  'Highland Hills Care Services',           'Care Services', 28),
      (10, 'ud-dcf-wor',   'Riverbend Family Services',              'Family Services', 48),
      (11, 'ud-dcf-spr',   'Lakeside Family Services',               'Family Services', 45),
      (12, 'ud-dcf-ns',    'Eastbrook Family Services',              'Family Services', 42),
      (13, 'ud-dmh-metro', 'Stonebridge Metro Health Services',      'Health Services', 58),
      (14, 'ud-dmh-west',  'West Ridge Health Services',             'Health Services', 40),
      (15, 'ud-dmh-se',    'South Bay Health Services',              'Health Services', 38),
      (16, 'ud-dmh-cen',   'Midland Health Services',                'Health Services', 36),
      (17, 'ud-dta-spr',   'Lakeside Benefits Office',               'Benefits Office', 35),
      (18, 'ud-dta-wor',   'Riverbend Benefits Office',              'Benefits Office', 34),
      (19, 'ud-dta-cape',  'Seaward Islands Benefits Office',        'Benefits Office', 24),
      (20, 'ud-ma-north',  'Northern Rehab Services',                'Rehab Services', 100)
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
    (1,  'ud-wor-dds',   'Riverbend Care Services',                'Care Services'),
    (2,  'ud-bos-dds',   'Stonebridge Care Services',              'Care Services'),
    (3,  'ud-spr-dds',   'Lakeside Care Services',                 'Care Services'),
    (4,  'ud-dcf-bos',   'Stonebridge Family Services',            'Family Services'),
    (5,  'ud-dmh-bos',   'Stonebridge Health Services',            'Health Services'),
    (6,  'ud-dta-bos',   'Stonebridge Benefits Office',            'Benefits Office'),
    (7,  'ud-dds-cape',  'Seaward Islands Care Services',          'Care Services'),
    (8,  'ud-dds-mer',   'Mill Valley Care Services',              'Care Services'),
    (9,  'ud-dds-berk',  'Highland Hills Care Services',           'Care Services'),
    (10, 'ud-dcf-wor',   'Riverbend Family Services',              'Family Services'),
    (11, 'ud-dcf-spr',   'Lakeside Family Services',               'Family Services'),
    (12, 'ud-dcf-ns',    'Eastbrook Family Services',              'Family Services'),
    (13, 'ud-dmh-metro', 'Stonebridge Metro Health Services',      'Health Services'),
    (14, 'ud-dmh-west',  'West Ridge Health Services',             'Health Services'),
    (15, 'ud-dmh-se',    'South Bay Health Services',              'Health Services'),
    (16, 'ud-dmh-cen',   'Midland Health Services',                'Health Services'),
    (17, 'ud-dta-spr',   'Lakeside Benefits Office',               'Benefits Office'),
    (18, 'ud-dta-wor',   'Riverbend Benefits Office',              'Benefits Office'),
    (19, 'ud-dta-cape',  'Seaward Islands Benefits Office',        'Benefits Office'),
    (20, 'ud-ma-north',  'Northern Rehab Services',                'Rehab Services')
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

create or replace function public.uniondemo_apply_batch(
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

  insert into public.organization_memberships (organization_id, user_id, status, created_at)
  select private.member_stress_uuid(p_run_id::text || ':ud:organization'), l.user_id, 'active',
    greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), pg_catalog.now() - interval '1460 days')
  from private.uniondemo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi
  on conflict (organization_id, user_id) do update set status = 'active', revoked_at = null;

  insert into public.member_chapter_memberships
    (user_id, chapter_id, status, pinned, last_selected_at, joined_at)
  select l.user_id, l.chapter_id, 'active', true, pg_catalog.now(),
    greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), pg_catalog.now() - interval '1460 days')
  from private.uniondemo_ledger l
  where l.run_id = p_run_id and l.ordinal between lo and hi
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null, pinned = true, last_selected_at = excluded.last_selected_at;

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

create or replace function public.uniondemo_seed_org(
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
  organization_id uuid := private.member_stress_uuid(p_run_id::text || ':ud:organization');
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

  insert into public.organizations (id, slug, name, status)
  values (organization_id, 'tamarack-public-service', 'Tamarack Public Service Union', 'active')
  on conflict (id) do update set name = excluded.name, status = 'active', updated_at = pg_catalog.now();

  insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
  values (chapter.chapter_id, chapter.chapter_name, 'Statewide', false, 200 + p_chapter_index,
    organization_id, chapter.chapter_id)
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
    insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, created_by, locale,
      organization_id, chapter_id, audience_scope)
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
      case when n % 14 = 0 then 'es' else 'en' end,
      organization_id, chapter.chapter_id, 'organization'
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

create or replace function public.uniondemo_enrich_batch(
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

    insert into public.member_role_chapters (user_id, role, chapter_id, granted_at, granted_by)
    select r.user_id, r.role, l.chapter_id, r.granted_at, r.granted_by
    from public.member_roles r
    join private.uniondemo_ledger l on l.user_id = r.user_id and l.run_id = p_run_id
    where l.ordinal between lo and hi
    on conflict (user_id, role, chapter_id) do nothing;

    insert into public.organization_role_grants (organization_id, user_id, role, granted_at, granted_by)
    select private.member_stress_uuid(p_run_id::text || ':ud:organization'), r.user_id, r.role,
      r.granted_at, r.granted_by
    from public.member_roles r
    join private.uniondemo_ledger l on l.user_id = r.user_id and l.run_id = p_run_id
    where l.ordinal between lo and hi
    on conflict (organization_id, user_id, role) do nothing;

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
