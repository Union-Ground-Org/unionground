import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const PINNED_POSTGRES_IMAGE = "postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const REPRESENTATIVE_MEMBERS = 1_000;
const OTHER_MEMBERS = 4_000;
const REPRESENTATIVE_POINT_EVENTS_PER_MEMBER = 80;
const BURST_CONCURRENCY = 32;
const BURST_STATEMENT_TIMEOUT_MS = 750;
const oldMigration = readFileSync("supabase/migrations/20260728171500_chapter_standing_rpc.sql", "utf8");
const repairMigration = readFileSync("supabase/migrations/20260904053000_chapter_standing_burst_repair.sql", "utf8");

function runDocker(args, label) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function choosePort() {
  const start = 56000 + ((process.pid * 31) % 4000);
  for (let offset = 0; offset < 4000; offset += 1) {
    const port = 56000 + ((start - 56000 + offset) % 4000);
    if (await portIsFree(port)) return port;
  }
  throw new Error("chapter-standing proof could not find a free loopback port");
}

function requireLoopback(databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error(`Refusing chapter-standing proof against non-local host ${parsed.hostname}`);
  }
  if (Number(parsed.port) < 56000 || Number(parsed.port) > 59999 || parsed.pathname !== "/postgres") {
    throw new Error("Refusing chapter-standing proof outside its owned disposable port/database boundary");
  }
  return parsed;
}

async function startPostgres() {
  runDocker(["version", "--format", "{{.Server.Version}}"], "chapter-standing proof requires Docker");
  const port = await choosePort();
  const containerName = `chapter-standing-proof-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    runDocker([
      "run", "--detach", "--rm", "--name", containerName,
      "--label", "net.unionground.test-fixture=chapter-standing-burst",
      "--env", "POSTGRES_PASSWORD=postgres",
      "--publish", `127.0.0.1:${port}:5432`, PINNED_POSTGRES_IMAGE,
    ], "chapter-standing proof could not start its digest-pinned database");
    started = true;
    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    requireLoopback(databaseUrl);
    let lastError;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const probe = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 500 });
      try {
        await probe.connect();
        await probe.query("select 1");
        await probe.end();
        return { containerName, databaseUrl };
      } catch (error) {
        lastError = error;
        await probe.end().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`chapter-standing proof database did not become ready: ${lastError?.message || "unknown error"}`);
  } catch (error) {
    if (started) spawnSync("docker", ["rm", "--force", containerName], { encoding: "utf8" });
    throw error;
  }
}

const bootstrap = `
  create schema auth;
  create schema private;
  create role authenticated nologin;
  create role anon nologin;
  create function auth.uid() returns uuid language sql stable set search_path = '' as $$
    select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function private.mfa_satisfied() returns boolean language sql stable security definer set search_path = '' as $$
    select pg_catalog.current_setting('request.jwt.claim.aal', true) = 'aal2'
  $$;
  create table public.member_profiles (id uuid primary key, chapter_id text);
  create index member_profiles_chapter_idx on public.member_profiles(chapter_id);
  create table public.member_point_events (
    id bigint generated always as identity primary key,
    user_id uuid not null,
    action_key text not null,
    action_kind text not null,
    points integer not null,
    occurred_at timestamptz not null,
    unique (user_id, action_key)
  );
  create index member_point_events_user_occurred_idx
    on public.member_point_events(user_id, occurred_at desc);
`;

const userId = (ordinal) => `50900000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;

async function setCaller(client, ordinal, aal = "aal2") {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId(ordinal)]);
  await client.query("select set_config('request.jwt.claim.aal', $1, false)", [aal]);
  await client.query("set role authenticated");
}

function canonicalStanding(value) {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  return copy;
}

async function readStandings(client, ordinals) {
  const results = [];
  for (const ordinal of ordinals) {
    await setCaller(client, ordinal);
    const value = (await client.query("select public.get_chapter_standing() as standing")).rows[0].standing;
    results.push(canonicalStanding(value));
  }
  await client.query("reset role");
  return results;
}

function flattenPlan(node, out = []) {
  out.push(node);
  for (const child of node.Plans || []) flattenPlan(child, out);
  return out;
}

async function run() {
  const fixture = await startPostgres();
  const source = new Client({ connectionString: fixture.databaseUrl, application_name: "chapter-standing-source" });
  let scratchName;
  const clients = [];
  try {
    await source.connect();
    scratchName = `chapter_standing_verify_${process.pid}`;
    assert.match(scratchName, /^chapter_standing_verify_\d+$/);
    await source.query(`create database ${scratchName} template template0`);
    const scratch = new URL(requireLoopback(fixture.databaseUrl));
    scratch.pathname = `/${scratchName}`;
    const setup = new Client({ connectionString: scratch.toString(), application_name: "chapter-standing-setup" });
    clients.push(setup);
    await setup.connect();
    await setup.query(bootstrap);
    await setup.query(`
      insert into public.member_profiles(id, chapter_id)
      select ('50900000-0000-4000-8000-' || pg_catalog.lpad(g::text, 12, '0'))::uuid,
        case
          when g <= ${REPRESENTATIVE_MEMBERS + 1} then 'presg'
          when g <= ${REPRESENTATIVE_MEMBERS + 25} then 'under-floor'
          when g = ${REPRESENTATIVE_MEMBERS + 26} then null
          else 'other-' || ((g - ${REPRESENTATIVE_MEMBERS + 27}) / 1000)::text
        end
      from pg_catalog.generate_series(1, ${REPRESENTATIVE_MEMBERS + OTHER_MEMBERS + 26}) g;

      insert into public.member_point_events(user_id, action_key, action_kind, points, occurred_at)
      select profile.id, 'representative-' || event_no::text, 'seed',
        1 + ((event_no * 7 + profile.ordinal) % 40),
        (pg_catalog.date_trunc('quarter', pg_catalog.now() at time zone 'America/New_York') at time zone 'America/New_York')
          - ((event_no * 13) % 1095 + 1) * interval '1 day'
      from (
        select g as ordinal,
          ('50900000-0000-4000-8000-' || pg_catalog.lpad(g::text, 12, '0'))::uuid as id
        from pg_catalog.generate_series(1, ${REPRESENTATIVE_MEMBERS + OTHER_MEMBERS + 26}) g
        where g <> ${REPRESENTATIVE_MEMBERS + 1}
          and g <> ${REPRESENTATIVE_MEMBERS + 26}
      ) profile
      cross join pg_catalog.generate_series(1, ${REPRESENTATIVE_POINT_EVENTS_PER_MEMBER}) event_no;
      analyze public.member_profiles;
      analyze public.member_point_events;
    `);
    await setup.query(oldMigration);

    const callers = [1, Math.floor(REPRESENTATIVE_MEMBERS / 2), REPRESENTATIVE_MEMBERS,
      REPRESENTATIVE_MEMBERS + 1, REPRESENTATIVE_MEMBERS + 2, REPRESENTATIVE_MEMBERS + 26];
    const oldResults = await readStandings(setup, callers);
    await setCaller(setup, 1, "aal1");
    await assert.rejects(
      setup.query("select public.get_chapter_standing()"),
      (error) => error.code === "42501",
    );
    await setup.query("reset role");

    const oldBody = (await setup.query(
      "select pg_catalog.pg_get_functiondef('public.get_chapter_standing()'::regprocedure) as body",
    )).rows[0].body;
    assert.equal((oldBody.match(/from public\.member_point_events/g) || []).length, 3,
      "historical function no longer demonstrates the three ledger reads this repair targets");

    await setup.query(repairMigration);
    await setup.query("analyze public.member_point_events");
    const newResults = await readStandings(setup, callers);
    assert.deepEqual(newResults, oldResults, "setwise repair changed an authorized standing result");
    await setCaller(setup, 1, "aal1");
    await assert.rejects(
      setup.query("select public.get_chapter_standing()"),
      (error) => error.code === "42501",
    );
    await setup.query("reset role");

    const planResult = await setup.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      select e.user_id, pg_catalog.sum(e.points)::bigint as total
      from public.member_point_events e
      join public.member_profiles p on p.id = e.user_id
      where p.chapter_id = 'presg'
        and e.occurred_at >= (pg_catalog.date_trunc('quarter', pg_catalog.now() at time zone 'America/New_York') - interval '3 months') at time zone 'America/New_York'
        and e.occurred_at < pg_catalog.date_trunc('quarter', pg_catalog.now() at time zone 'America/New_York') at time zone 'America/New_York'
      group by e.user_id`);
    const plan = planResult.rows[0]["QUERY PLAN"][0];
    const planNodes = flattenPlan(plan.Plan);
    assert.ok(planNodes.some((node) => node["Index Name"] === "member_point_events_occurred_user_cover_idx"),
      "quarter aggregation did not use the new range-leading covering index");
    assert.ok(plan["Execution Time"] < BURST_STATEMENT_TIMEOUT_MS,
      `single representative plan exceeded ${BURST_STATEMENT_TIMEOUT_MS} ms`);

    const burstUrl = scratch.toString();
    const burst = Array.from({ length: BURST_CONCURRENCY }, (_, index) => new Client({
      connectionString: burstUrl,
      application_name: `chapter-standing-burst-${index + 1}`,
    }));
    clients.push(...burst);
    await Promise.all(burst.map((client) => client.connect()));
    await Promise.all(burst.map(async (client, index) => {
      await client.query(`set statement_timeout = '${BURST_STATEMENT_TIMEOUT_MS}ms'`);
      await setCaller(client, (index % REPRESENTATIVE_MEMBERS) + 1);
    }));
    const burstStarted = performance.now();
    const burstResults = await Promise.all(burst.map(async (client) => {
      const value = (await client.query("select public.get_chapter_standing() as standing")).rows[0].standing;
      return canonicalStanding(value);
    }));
    const burstWallMs = performance.now() - burstStarted;
    assert.equal(burstResults.length, BURST_CONCURRENCY);
    assert.ok(burstResults.every((value) => value.enoughData === true));
    assert.ok(burstWallMs < BURST_STATEMENT_TIMEOUT_MS,
      `32-call representative burst took ${burstWallMs.toFixed(1)} ms`);

    process.stdout.write(JSON.stringify({
      outcome: "PASS",
      representativeMembers: REPRESENTATIVE_MEMBERS,
      pointEventsPerMember: REPRESENTATIVE_POINT_EVENTS_PER_MEMBER,
      burstConcurrency: BURST_CONCURRENCY,
      statementTimeoutMs: BURST_STATEMENT_TIMEOUT_MS,
      burstWallMs: Number(burstWallMs.toFixed(1)),
      planExecutionMs: Number(plan["Execution Time"].toFixed(1)),
      parityCases: oldResults.length,
    }) + "\n");
  } finally {
    await Promise.all(clients.map((client) => client.query("reset role").catch(() => {})));
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
    if (source._connected && scratchName) {
      await source.query("select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where datname = $1", [scratchName]).catch(() => {});
      await source.query(`drop database if exists ${scratchName}`).catch(() => {});
    }
    await source.end().catch(() => {});
    runDocker(["rm", "--force", fixture.containerName], "chapter-standing proof could not remove its owned container");
  }
}

await run();
