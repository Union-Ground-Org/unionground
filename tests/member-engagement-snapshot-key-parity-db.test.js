// @vitest-environment node
//
// DEBT-UG-EMPTY-TENANT-SNAPSHOT-RETURNS-RETIRED-KEYWORD-HITS-20260921
//
// 20260907122000 retired keyword alerts and rewrote the scoped member snapshot
// without its keyword-hit key, but the no-organization branch of
// public.get_member_engagement_snapshot (20260829020000) kept emitting it. The
// snapshot's shape therefore depended on whether the caller had an
// organization. 20260925630400 re-emits that wrapper without the key; this file
// proves on a disposable database that both branches now return the same
// top-level keys and that no installed function still builds the retired key.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const PREDECESSOR = "supabase/migrations/20260829020000_member_engagement_empty_tenant_boundary.sql";
const MIGRATION = "supabase/migrations/20260925630400_member_engagement_snapshot_empty_tenant_key_parity.sql";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const RETIRED_LINE = "      'keywordHits', '[]'::jsonb,\n";

function snapshotDeclaration(sql, lead) {
  const start = sql.indexOf(`${lead} public.get_member_engagement_snapshot()`);
  expect(start, lead).toBeGreaterThan(-1);
  const end = sql.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "$function$;".length);
}

describe("member engagement snapshot key parity (static)", () => {
  it("re-emits the 20260829020000 wrapper minus exactly the retired keyword line", () => {
    const predecessor = snapshotDeclaration(read(PREDECESSOR), "create function");
    const migration = read(MIGRATION);
    const replacement = snapshotDeclaration(migration, "create or replace function");
    expect(predecessor).toContain(RETIRED_LINE);
    expect(replacement).toBe(
      predecessor
        .replace("create function public.", "create or replace function public.")
        .replace(RETIRED_LINE, ""),
    );
    expect(migration.trimStart()).toMatch(/^--/);
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(stripComments(migration)).not.toMatch(/\bgrant\b|\brevoke\b/i);
  });
});

const ID = {
  org: "50925630-0000-4000-8000-000000000001",
  member: "50925630-0000-4000-8000-000000000101",
  newcomer: "50925630-0000-4000-8000-000000000102",
  memberSession: "50925630-0000-4000-8000-000000000201",
  newcomerSession: "50925630-0000-4000-8000-000000000202",
};
const CHAPTER = "snapshot-key-parity-chapter";
const EMPTY_TENANT_KEYS = ["actions", "briefings", "livePolls", "pulsePrompts", "quarterlyGate", "surveys", "workspace"];
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member engagement snapshot key parity on a disposable database", () => {
  let db;

  async function as(claims, statement, values = []) {
    await db.query("savepoint snapshot_key_parity");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint snapshot_key_parity");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint snapshot_key_parity");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  const claimsFor = (sub, sessionId, aal = "aal2") => ({ sub, role: "authenticated", session_id: sessionId, aal });

  async function snapshot(sub, sessionId) {
    const result = await as(claimsFor(sub, sessionId), "select public.get_member_engagement_snapshot() snapshot");
    expect(result, result.message).toMatchObject({ code: "" });
    return result.rows[0].snapshot;
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-engagement-snapshot-key-parity-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      `insert into auth.users (id,email) values
        ($1,'snapshot-parity-member@example.invalid'),
        ($2,'snapshot-parity-newcomer@example.invalid')`,
      [ID.member, ID.newcomer],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'snapshot-key-parity-org','Snapshot key parity proof org',$2)",
      [ID.org, ID.member],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,92563)",
      [CHAPTER, ID.org],
    );
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, ID.member]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ID.member, CHAPTER]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ID.member, CHAPTER]);
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now())",
      [ID.memberSession, ID.member, ID.newcomerSession, ID.newcomer],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values (gen_random_uuid(),$1,'member-totp','totp','verified',now(),now()),
              (gen_random_uuid(),$2,'newcomer-totp','totp','verified',now(),now())`,
      [ID.member, ID.newcomer],
    );
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("an account with no organization and an onboarded member receive the same top-level keys", async () => {
    const tenant = await as(claimsFor(ID.newcomer, ID.newcomerSession), "select private.current_member_organization() org");
    expect(tenant.rows[0]?.org ?? null).toBeNull();
    const empty = await snapshot(ID.newcomer, ID.newcomerSession);
    const populated = await snapshot(ID.member, ID.memberSession);
    expect(Object.keys(empty).sort()).toEqual(Object.keys(populated).sort());
  });

  it("the empty-tenant snapshot keeps its honest empty state and carries no retired keyword payload", async () => {
    const empty = await snapshot(ID.newcomer, ID.newcomerSession);
    expect(Object.keys(empty).sort()).toEqual(EMPTY_TENANT_KEYS);
    expect(empty).not.toHaveProperty("keywordHits");
    expect(empty).toMatchObject({
      surveys: [], pulsePrompts: [], livePolls: [], actions: [], briefings: [],
      quarterlyGate: { surveyId: null, required: false, completed: false, unlocked: true },
      workspace: { moduleOrder: ["inbox", "surveys", "tasks", "cases"], hiddenModules: [] },
    });
  });

  it("no installed public or private function builds the retired keyword payload keys", async () => {
    const { rows } = await db.query(`
      select n.nspname || '.' || p.proname as name
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and (p.prosrc like '%''keywordHits''%' or p.prosrc like '%''keywordMonitors''%')
      order by 1`);
    expect(rows.map((row) => row.name)).toEqual([]);
  });

  it("keeps the authentication, MFA and execute-grant gates", async () => {
    const anonymous = await as({ role: "authenticated" }, "select public.get_member_engagement_snapshot() snapshot");
    expect(anonymous.code).toBe("42501");
    expect(anonymous.message).toMatch(/authentication required/);
    const singleFactor = await as(claimsFor(ID.newcomer, ID.newcomerSession, "aal1"), "select public.get_member_engagement_snapshot() snapshot");
    expect(singleFactor.code).toBe("42501");
    expect(singleFactor.message).toMatch(/mfa required/);
    const { rows } = await db.query(`
      select pg_catalog.has_function_privilege('anon', 'public.get_member_engagement_snapshot()', 'execute') anon_exec,
             pg_catalog.has_function_privilege('authenticated', 'public.get_member_engagement_snapshot()', 'execute') authenticated_exec,
             pg_catalog.has_function_privilege('service_role', 'public.get_member_engagement_snapshot()', 'execute') service_exec`);
    expect(rows[0]).toEqual({ anon_exec: false, authenticated_exec: true, service_exec: false });
  });
});
