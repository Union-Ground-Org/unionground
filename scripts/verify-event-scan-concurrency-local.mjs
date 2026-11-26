import { readFileSync } from "node:fs";
import process from "node:process";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));
const sourceUrl = new URL(databaseUrl);

const migration = readFileSync("supabase/migrations/20260812231000_event_scan_acceptance_repair.sql", "utf8");
const ids = {
  steward: "50900000-0000-4000-8000-000000000501",
  member: "50900000-0000-4000-8000-000000000502",
};
const eventId = "event-scan-concurrency-proof";
const token = "ABC1234";
const memberName = "Concurrency Proof Member";

const bootstrap = `
  create schema auth;
  create schema extensions;
  create schema private;
  create extension pgcrypto with schema extensions;
  create function auth.jwt() returns jsonb language sql stable set search_path = '' as $$
    select coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
  $$;
  create function auth.uid() returns uuid language sql stable set search_path = '' as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $$;
  create function private.mfa_satisfied() returns boolean language sql stable security definer set search_path = '' as $$
    select auth.jwt() ->> 'aal' = 'aal2'
  $$;
  create table public.chapters (id text primary key, region text);
  create table public.member_profiles (id uuid primary key, full_name text not null, chapter_id text);
  create table public.member_roles (
    id bigint generated always as identity primary key,
    user_id uuid not null,
    role text not null,
    chapter_id text
  );
  create function public.member_has_role(p_roles text[]) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1 from public.member_roles
      where user_id = auth.uid() and role = any(p_roles)
    )
  $$;
  create table public.member_events (
    id text primary key,
    chapter_id text not null,
    starts_at timestamptz not null,
    cancelled_at timestamptz,
    is_public boolean not null default false,
    is_public_across_agencies boolean not null default false
  );
  create table private.member_event_checkin_tokens (
    id bigint generated always as identity primary key,
    event_id text not null,
    user_id uuid not null,
    token_hash text not null,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    consumed_by uuid
  );
  create table public.member_event_checkins (
    event_id text not null,
    user_id uuid not null,
    scanned_by uuid,
    unique (event_id, user_id)
  );
  create table public.member_action_log (
    user_id uuid not null,
    action_key text not null,
    action_kind text not null,
    unique (user_id, action_key)
  );
  create table public.member_point_events (user_id uuid not null, action_key text not null, points integer not null);
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function beginAsScanner(client) {
  await client.query("begin");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
    sub: ids.steward,
    role: "authenticated",
    aal: "aal2",
  })]);
  await client.query("set local role authenticated");
}

async function seed(admin) {
  await admin.query("truncate public.member_event_checkins, public.member_action_log, public.member_point_events, private.member_event_checkin_tokens, public.member_events, public.member_roles, public.member_profiles restart identity");
  await admin.query("insert into public.member_profiles (id, full_name, chapter_id) values ($1, 'Concurrency Proof Steward', 'wor'), ($2, $3, 'wor')", [ids.steward, ids.member, memberName]);
  // The production schema currently has one row per user/role. This disposable
  // probe deliberately permits the plausible future multi-scope shape and
  // proves that the final emitter picks the exact chapter deterministically.
  await admin.query(`
    insert into public.member_roles (user_id, role, chapter_id)
    values ($1, 'steward', null), ($1, 'steward', 'bos'), ($1, 'steward', 'wor')
  `, [ids.steward]);
  await admin.query("insert into public.member_events (id, chapter_id, starts_at) values ($1, 'wor', now())", [eventId]);
  await admin.query(`
    insert into private.member_event_checkin_tokens (event_id, user_id, token_hash, expires_at)
    values ($1, $2, pg_catalog.encode(extensions.digest($3, 'sha256'), 'hex'), now() + interval '5 minutes')
  `, [eventId, ids.member, token]);
}

async function waitForLock(admin, applicationName) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const activity = await admin.query(`
      select wait_event_type
      from pg_catalog.pg_stat_activity
      where datname = current_database() and application_name = $1
    `, [applicationName]);
    if (activity.rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${applicationName} never waited on a row decision lock`);
}

async function assertNoMutation(admin, error, expectedState, expectedDetail, label) {
  assert(error, `${label}: scan unexpectedly succeeded`);
  assert(error.code === expectedState, `${label}: expected SQLSTATE ${expectedState}, got ${error.code || "none"}`);
  assert(error.detail === expectedDetail, `${label}: expected ${expectedDetail}, got ${error.detail || "none"}`);
  assert(!JSON.stringify({ message: error.message, detail: error.detail }).includes(memberName), `${label}: refusal must not expose the member name`);
  const state = await admin.query(`
    select
      (select pg_catalog.bool_and(consumed_at is null) from private.member_event_checkin_tokens) as tokens_intact,
      (select pg_catalog.count(*)::int from public.member_event_checkins) as checkins,
      (select pg_catalog.count(*)::int from public.member_action_log) as actions
  `);
  assert(state.rows[0].tokens_intact === true, `${label}: a refused scan consumed its token`);
  assert(state.rows[0].checkins === 0, `${label}: a refused scan created a check-in`);
  assert(state.rows[0].actions === 0, `${label}: a refused scan created an action log`);
}

async function runRace({ label, mutate, state, detail }, admin, scanner, mutator) {
  await seed(admin);
  await mutator.query("begin");
  await mutator.query(mutate.sql, mutate.params || []);
  await beginAsScanner(scanner);
  const applicationName = `event-scan-${label.replaceAll(" ", "-")}`;
  await scanner.query("select set_config('application_name', $1, false)", [applicationName]);
  const outcomePromise = scanner.query("select public.scan_event_checkin($1, $2) as value", [eventId, token])
    .then((result) => ({ result }), (error) => ({ error }));
  await waitForLock(admin, applicationName);
  await mutator.query("commit");
  const outcome = await outcomePromise;
  await scanner.query("rollback");
  await assertNoMutation(admin, outcome.error, state, detail, label);
}

const scratchName = `event_scan_verify_${process.pid}`;
assert(/^event_scan_verify_\d+$/.test(scratchName), "unsafe scratch database name");
const scratchUrlValue = new URL(sourceUrl);
scratchUrlValue.pathname = `/${scratchName}`;
const scratchUrl = scratchUrlValue.toString();
const sourceAdmin = new Client({ connectionString: databaseUrl, application_name: "event-scan-proof-source-admin" });
const connections = [];
let created = false;

try {
  await sourceAdmin.connect();
  await sourceAdmin.query(`create database ${scratchName} template template0`);
  created = true;
  const admin = new Client({ connectionString: scratchUrl, application_name: "event-scan-proof-admin" });
  const scanner = new Client({ connectionString: scratchUrl, application_name: "event-scan-proof-scanner" });
  const mutator = new Client({ connectionString: scratchUrl, application_name: "event-scan-proof-mutator" });
  connections.push(admin, scanner, mutator);
  await Promise.all(connections.map((connection) => connection.connect()));
  await Promise.all(connections.map((connection) => connection.query("set statement_timeout = '10s'")));
  await admin.query(bootstrap);
  await admin.query(migration);

  await seed(admin);
  await beginAsScanner(scanner);
  const multiGrant = (await scanner.query("select public.scan_event_checkin($1, $2) as value", [eventId, token])).rows[0].value;
  assert(multiGrant.memberName === memberName, "multi-grant exact-chapter selection did not authorize the valid scan");
  await scanner.query("rollback");

  const races = [
    {
      label: "role revocation",
      mutate: { sql: "delete from public.member_roles where user_id = $1 and role = 'steward'", params: [ids.steward] },
      state: "42501",
      detail: "scan_not_steward",
    },
    {
      label: "event cancellation",
      mutate: { sql: "update public.member_events set cancelled_at = now() where id = $1", params: [eventId] },
      state: "22023",
      detail: "scan_event_cancelled",
    },
    {
      label: "event reschedule",
      mutate: { sql: "update public.member_events set starts_at = now() + interval '1 day' where id = $1", params: [eventId] },
      state: "22023",
      detail: "scan_code_invalid",
    },
    {
      label: "member profile move",
      mutate: { sql: "update public.member_profiles set chapter_id = 'bos' where id = $1", params: [ids.member] },
      state: "22023",
      detail: "scan_code_invalid",
    },
    {
      label: "member profile deletion",
      mutate: { sql: "delete from public.member_profiles where id = $1", params: [ids.member] },
      state: "22023",
      detail: "scan_code_invalid",
    },
  ];
  for (const race of races) await runRace(race, admin, scanner, mutator);
  console.log("PASS: event scan multi-grant selection and five two-connection races refused before mutation; scratch database isolated and removable.");
} finally {
  await Promise.all(connections.map((connection) => connection.query("rollback").catch(() => {})));
  await Promise.all(connections.map((connection) => connection.end().catch(() => {})));
  if (created) {
    await sourceAdmin.query("select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where datname = $1", [scratchName]).catch(() => {});
    await sourceAdmin.query(`drop database if exists ${scratchName}`).catch(() => {});
    const residue = await sourceAdmin.query("select 1 from pg_catalog.pg_database where datname = $1", [scratchName]);
    assert(residue.rowCount === 0, "scratch event-scan database was not removed");
  }
  await sourceAdmin.end().catch(() => {});
}
