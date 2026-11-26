import { readFileSync } from "node:fs";
import process from "node:process";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));
const migrationFiles = [
  "supabase/migrations/20260812091000_staff_mfa_policy.sql",
  "supabase/migrations/20260812113000_compass_ai_governance.sql",
];
const exactArgs = ["vercel-ai-gateway", "google/gemini-3-flash", true, true];
const sourceUrl = new URL(databaseUrl);

// The primary proof above applies against the complete local Supabase schema
// and rolls back. Concurrency needs two sessions, which cannot see uncommitted
// DDL, so it runs in a disposable database with only the exact pre-governance
// substrate these two migrations depend on. Keeping this substrate explicit
// avoids copying Supabase's database-pinned extensions and unrelated function
// configuration into a database where those objects are forbidden.
const concurrencyBootstrap = `
  create schema auth;
  create schema extensions;
  create schema private;
  create extension pgcrypto with schema extensions;
  create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
  create type auth.factor_status as enum ('unverified', 'verified');
  create function auth.jwt() returns jsonb language sql stable set search_path = '' as $$
    select coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
  $$;
  create function auth.uid() returns uuid language sql stable set search_path = '' as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $$;
  create table auth.users (id uuid primary key);
  create table auth.mfa_factors (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    friendly_name text,
    factor_type auth.factor_type not null,
    status auth.factor_status not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
  );
  create table public.member_profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    full_name text not null,
    chapter_id text
  );
  create table public.member_roles (
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null,
    chapter_id text,
    primary key (user_id, role)
  );
  create table public.member_admin_audit (
    id uuid primary key default extensions.gen_random_uuid(),
    actor uuid,
    action text not null,
    target_user uuid,
    detail jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint member_admin_audit_action_check check (
      action in ('grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa',
                 'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward')
    )
  );
  create table public.member_ai_requests (
    id uuid primary key default extensions.gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now()
  );
  create function private.mfa_satisfied()
  returns boolean language sql stable security definer set search_path = '' as $$
    select case when auth.jwt() ->> 'aal' = 'aal2' then true else not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid() and f.status = 'verified' and f.factor_type = 'totp'
    ) end
  $$;
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectSqlState(client, name, sql, params, state) {
  await client.query(`savepoint ${name}`);
  try {
    await client.query(sql, params);
    throw new Error(`${name}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${name}: expected SQLSTATE ${state}, got ${error.code || error.message}`);
  } finally {
    await client.query(`rollback to savepoint ${name}`);
    await client.query(`release savepoint ${name}`);
  }
}

async function asRole(client, role, userId = null) {
  await client.query("reset role");
  if (userId) {
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role, aal: "aal2" })]);
  } else {
    await client.query("select set_config('request.jwt.claim.sub', '', true)");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
  }
  await client.query(`set local role ${role}`);
}

async function runConcurrencyProof() {
  const scratchName = `compass_governance_verify_${process.pid}`;
  assert(/^compass_governance_verify_\d+$/.test(scratchName), "unsafe scratch database name");
  const scratchUrlValue = new URL(sourceUrl);
  scratchUrlValue.pathname = `/${scratchName}`;
  const scratchUrl = scratchUrlValue.toString();
  const admin = new Client({ connectionString: databaseUrl, application_name: "compass-governance-proof-admin" });
  const connections = [];
  let created = false;
  try {
    await admin.connect();
    await admin.query(`create database ${scratchName} template template0`);
    created = true;

    const setup = new Client({ connectionString: scratchUrl, application_name: "compass-governance-proof-setup" });
    connections.push(setup);
    await setup.connect();
    await setup.query(concurrencyBootstrap);
    for (const file of migrationFiles) await setup.query(readFileSync(file, "utf8"));
    const userId = "50900000-0000-4000-8000-000000000005";
    await setup.query("begin");
    await setup.query("insert into auth.users (id) values ($1)", [userId]);
    await setup.query("insert into public.member_profiles (id, full_name, chapter_id) values ($1, 'Local concurrency proof', 'wor')", [userId]);
    await setup.query(`
      insert into public.member_roles (user_id, role, chapter_id)
      values ($1, 'admin', 'wor'), ($1, 'steward', 'wor')
      on conflict (user_id, role) do update set chapter_id = excluded.chapter_id
    `, [userId]);
    await setup.query(`
      insert into auth.mfa_factors
        (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values (extensions.gen_random_uuid(), $1, 'governance-concurrency-proof', 'totp', 'verified', now(), now())
    `, [userId]);
    await asRole(setup, "authenticated", userId);
    await setup.query(
      "select public.attest_compass_ai_provider('LOCAL-CONCURRENCY-PROOF', now() + interval '1 day', true, true, 'verified')",
    );
    await setup.query("select public.set_compass_ai_role_limit('steward', 1)");
    await setup.query("select public.set_compass_ai_enabled(true)");
    await setup.query("commit");

    const reserveClients = [1, 2].map((index) => new Client({
      connectionString: scratchUrl,
      application_name: `compass-reserve-proof-${index}`,
    }));
    connections.push(...reserveClients);
    await Promise.all(reserveClients.map((connection) => connection.connect()));
    await Promise.all(reserveClients.map((connection) => connection.query("set role service_role")));
    const reservationResults = await Promise.all(reserveClients.map(async (connection) => (await connection.query(
      "select public.reserve_compass_ai_request($1, $2, $3, $4, $5) as value",
      [userId, ...exactArgs],
    )).rows[0].value));
    const allowed = reservationResults.filter((result) => result.id);
    const denied = reservationResults.filter((result) => result.id === null && result.cause === "role");
    assert(allowed.length === 1 && denied.length === 1, "global lock must allow exactly one final role-cap reservation");

    const pause = new Client({ connectionString: scratchUrl, application_name: "compass-pause-proof" });
    const dispatch = new Client({ connectionString: scratchUrl, application_name: "compass-dispatch-proof" });
    connections.push(pause, dispatch);
    await Promise.all([pause.connect(), dispatch.connect()]);
    await pause.query("begin");
    await asRole(pause, "authenticated", userId);
    await pause.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509))");
    await dispatch.query("set role service_role");
    const dispatchPromise = dispatch.query(
      "select public.authorize_compass_ai_dispatch($1, $2, $3, $4, $5, $6) as value",
      [allowed[0].id, userId, ...exactArgs],
    );

    let observedWaiting = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await admin.query(`
        select wait_event_type, wait_event
        from pg_catalog.pg_stat_activity
        where datname = $1 and application_name = 'compass-dispatch-proof'
      `, [scratchName]);
      if (activity.rows.some((row) => row.wait_event_type === "Lock" && row.wait_event === "advisory")) {
        observedWaiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(observedWaiting, "dispatch did not wait behind the governance advisory lock");
    await pause.query("select public.set_compass_ai_enabled(false)");
    await pause.query("commit");
    const dispatched = (await dispatchPromise).rows[0].value;
    assert(dispatched.authorized === false && dispatched.cause === "disabled", "pause committed before dispatch must deny dispatch");
    console.log("Compass AI governance two-connection concurrency proof passed.");
  } finally {
    await Promise.all(connections.map((connection) => connection.end().catch(() => {})));
    if (created) {
      await admin.query("select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where datname = $1", [scratchName]).catch(() => {});
      await admin.query(`drop database if exists ${scratchName}`).catch(() => {});
      const residue = await admin.query("select 1 from pg_catalog.pg_database where datname = $1", [scratchName]);
      assert(residue.rowCount === 0, "scratch concurrency database was not removed");
    }
    await admin.end().catch(() => {});
  }
}

const client = new Client({ connectionString: databaseUrl });
let rolledBack = false;
try {
  await client.connect();
  await client.query("begin");
  for (const file of migrationFiles) await client.query(readFileSync(file, "utf8"));

  const seed = await client.query("select id from public.member_profiles order by id limit 1");
  assert(seed.rowCount === 1, "local database needs one member profile");
  const adminId = seed.rows[0].id;

  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id)
    values ($1, 'admin', 'wor'), ($1, 'steward', 'wor')
    on conflict (user_id, role) do update set chapter_id = excluded.chapter_id
  `, [adminId]);
  // node-postgres uses the extended protocol as soon as parameters exist, and
  // PostgreSQL accepts exactly one statement in that protocol. Keep each
  // parameterized fixture write a single statement so the proof exercises the
  // schema rather than failing in the driver before SQL reaches it.
  await client.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (extensions.gen_random_uuid(), $1, 'governance-local-proof', 'totp', 'verified', now(), now())
  `, [adminId]);

  await asRole(client, "authenticated", adminId);
  const initial = (await client.query("select public.get_compass_ai_governance() as value")).rows[0].value;
  assert(initial.enabled === false, "policy must arrive disabled");
  assert(initial.attestationReady === false, "policy must arrive unattested");
  assert(initial.attestations.length === 0, "migration must not seed an attestation");

  await expectSqlState(
    client,
    "enable_without_attestation",
    "select public.set_compass_ai_enabled(true)",
    [],
    "55000",
  );
  await expectSqlState(
    client,
    "attest_without_both_confirmations",
    "select public.attest_compass_ai_provider($1, now() + interval '1 day', true, false, 'verified')",
    ["LOCAL-PROOF-REJECTED"],
    "22023",
  );

  const evidence = "LOCAL-ROLLBACK-PROOF-509";
  await client.query(
    "select public.attest_compass_ai_provider($1, now() + interval '1 day', true, true, 'verified')",
    [evidence],
  );
  await client.query("select public.set_compass_ai_role_limit('admin', 7)");
  await client.query("select public.set_compass_ai_role_limit('steward', 3)");
  await client.query("select public.set_compass_ai_enabled(true)");

  await asRole(client, "service_role");
  const wrongConfig = (await client.query(
    "select public.reserve_compass_ai_request($1, $2, $3, $4, $5) as value",
    [adminId, "unknown-gateway", ...exactArgs.slice(1)],
  )).rows[0].value;
  assert(wrongConfig.id === null && wrongConfig.cause === "config", "unknown provider config must fail closed");

  const reserve = async (userId = adminId) => (await client.query(
    "select public.reserve_compass_ai_request($1, $2, $3, $4, $5) as value",
    [userId, ...exactArgs],
  )).rows[0].value;
  const first = await reserve();
  const second = await reserve();
  const third = await reserve();
  const fourth = await reserve();
  assert(first.role === "steward" && first.limit === 3, "strictest assigned role limit must win");
  assert(second.id && third.id, "three requests should fit the strict limit");
  assert(fourth.id === null && fourth.cause === "role" && fourth.limit === 3, "fourth request must be denied");

  const firstDispatch = (await client.query(
    "select public.authorize_compass_ai_dispatch($1, $2, $3, $4, $5, $6) as value",
    [first.id, adminId, ...exactArgs],
  )).rows[0].value;
  const repeatDispatch = (await client.query(
    "select public.authorize_compass_ai_dispatch($1, $2, $3, $4, $5, $6) as value",
    [first.id, adminId, ...exactArgs],
  )).rows[0].value;
  assert(firstDispatch.authorized === true, "first dispatch should be authorized");
  assert(repeatDispatch.authorized === false && repeatDispatch.cause === "reservation", "reservation replay must fail");

  // Exercise the missing-config branch while the earlier, intentionally
  // ordered policy and attestation gates are satisfied. Restore the fixture
  // before the remaining dispatch checks.
  await asRole(client, "postgres");
  await client.query("delete from public.compass_ai_role_limits where role = 'steward'");
  await asRole(client, "service_role");
  const missingRole = await reserve();
  assert(missingRole.id === null && missingRole.cause === "role_unconfigured", "missing assigned-role config must fail closed");
  await asRole(client, "postgres");
  await client.query("insert into public.compass_ai_role_limits (role, hourly_limit) values ('steward', 3)");

  await asRole(client, "authenticated", adminId);
  await client.query("select public.set_compass_ai_enabled(false)");
  await asRole(client, "service_role");
  const killedDispatch = (await client.query(
    "select public.authorize_compass_ai_dispatch($1, $2, $3, $4, $5, $6) as value",
    [second.id, adminId, ...exactArgs],
  )).rows[0].value;
  assert(killedDispatch.authorized === false && killedDispatch.cause === "disabled", "kill switch must stop an already-reserved dispatch");

  await asRole(client, "authenticated", adminId);
  await client.query(
    "select public.attest_compass_ai_provider($1, null, false, false, 'revoked')",
    ["LOCAL-ROLLBACK-REVOCATION"],
  );
  await expectSqlState(
    client,
    "enable_after_revocation",
    "select public.set_compass_ai_enabled(true)",
    [],
    "55000",
  );
  const afterRevoke = (await client.query("select public.get_compass_ai_governance() as value")).rows[0].value;
  assert(afterRevoke.attestationReady === false, "latest revocation must invalidate the verified attestation");
  assert(afterRevoke.attestations.length === 2, "attestation history must be append-only");

  await asRole(client, "postgres");
  const audit = await client.query(`
    select action, detail
    from public.member_admin_audit
    where actor = $1
      and action in ('set_compass_ai_enabled', 'set_compass_ai_role_limit', 'attest_compass_ai_provider')
  `, [adminId]);
  assert(audit.rowCount >= 6, "every material governance change must be audited");
  assert(!JSON.stringify(audit.rows).includes(evidence), "shared audit metadata must not copy attestation evidence");

  await asRole(client, "postgres");
  await client.query("rollback");
  rolledBack = true;

  const residue = await client.query("select to_regclass('public.compass_ai_policy') as policy");
  assert(residue.rows[0].policy === null, "governance proof must leave the local database unchanged");
  console.log("Compass AI governance local proof passed (all changes rolled back).");
} finally {
  if (!rolledBack) {
    try { await client.query("rollback"); } catch { /* connection may already be closed */ }
  }
  await client.end().catch(() => {});
}

await runConcurrencyProof();
