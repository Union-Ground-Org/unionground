// @vitest-environment node
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import passwordHandler from "../api/auth-password-signin.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () =>
  (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const read = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const original = read("20261002015000_survey_review_privacy_floor_and_signin_throttle");
const restored = read("20261002135600_restore_review_hotfixes");
const migration = read("20261019174000_password_signin_success_refunds");
// #8605 re-emits the reservation so its stale-row cleanup picks its rows once.
const boundedCleanups = read("20261113123500_bounded_cleanups_pick_rows_once");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const email = "member@example.invalid";
const network = "ipv4:203.0.113.9";

describe.skipIf(!postgresBin)("successful password grant refunds in PostgreSQL", () => {
  let db;
  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    await db.client.query(`
      create schema private; create schema auth; create schema extensions;
      create extension pgcrypto with schema extensions;
      create role anon; create role authenticated; create role service_role;
      create function auth.jwt() returns jsonb language sql stable as
        $$ select '{"role":"service_role"}'::jsonb $$;
      create function private.organization_limit(uuid, text) returns integer language sql as
        $$ select case when $2 like '%ip_hour' then 20 else 5 end $$;
    `);
    // Execute the real generic counter, current consume RPC and Auth backstop.
    await db.client.query(original.slice(original.indexOf("create table private.auth_attempt_throttle_key"),
      original.indexOf("create function public.consume_password_signin_attempt")));
    const start = restored.indexOf("create or replace function public.consume_password_signin_attempt");
    const end = restored.indexOf("-- ===========================================================================", start);
    await db.client.query(restored.slice(start, end));
    const exhausted = restored.indexOf("create function private.auth_attempt_exhausted");
    const hook = restored.indexOf("create function public.auth_password_verification_attempt_hook", exhausted);
    const hookEnd = restored.indexOf("$function$;", hook) + "$function$;".length;
    await db.client.query(restored.slice(exhausted, hookEnd));
    await db.client.query(migration);
    const reserveStart = boundedCleanups.indexOf("create or replace function public.reserve_password_signin_attempt(");
    await db.client.query(boundedCleanups.slice(reserveStart, boundedCleanups.indexOf("\n$function$;", reserveStart) + 12));
  }, 120000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.client.query("truncate private.auth_attempt_throttle, private.password_signin_reservations");
  });

  const reserve = async (address = email, bucket = network) => (await db.client.query(
    "select public.reserve_password_signin_attempt($1,$2) r", [address, bucket])).rows[0].r;
  const refund = async id => (await db.client.query(
    "select public.refund_password_signin_attempt($1) r", [id])).rows[0].r;
  const counts = async () => (await db.client.query(
    "select scope, attempt_count from private.auth_attempt_throttle order by scope")).rows;

  it("matches the installed reservation/refund definitions and grants to the database contract", async () => {
    const entries = contract.functions.filter(entry => /^public\.(reserve|refund)_password_signin_attempt\(/.test(entry.sig));
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const { rows: [row] } = await db.client.query(`
        select p.prosecdef, p.proconfig, md5(p.prosrc) source_md5,
          lower(pg_get_functiondef(p.oid)) definition,
          array(select r from unnest(array['anon','authenticated','service_role']) r
            where has_function_privilege(r, p.oid, 'EXECUTE')) grantees,
          exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $1
      `, [entry.sig]);
      expect(row, entry.sig).toBeDefined();
      expect(row.prosecdef).toBe(entry.secdef);
      expect(row.proconfig).toEqual([contract.functionSweeps.searchPathLiteral]);
      expect(row.grantees).toEqual(entry.exec.split(","));
      expect(row.public_execute).toBe(false);
      expect(row.source_md5).toBe(entry.sourceMd5);
      const code = row.definition.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
      for (const needle of entry.bodyContains) expect(code).toContain(needle.toLowerCase());
      for (const needle of entry.bodyForbids) expect(code).not.toContain(needle.toLowerCase());
    }
    const tableEntries = contract.tableGrants.filter(entry => entry.table === "private.password_signin_reservations");
    expect(tableEntries.map(entry => entry.role).sort()).toEqual(["anon", "authenticated", "service_role"]);
    for (const entry of tableEntries) {
      const { rows: [row] } = await db.client.query(`
        select array(select privilege from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
          where has_table_privilege($1, $2, privilege)) privileges
      `, [entry.role, entry.table]);
      expect(row.privileges).toEqual(entry.privileges.split(",").filter(Boolean));
      expect(row.privileges).toEqual([]);
    }
  });

  it("runs 21 successful grants on one network through the real web/native handler and SQL", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "secret");
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      let value;
      if (String(url).endsWith("/reserve_password_signin_attempt")) value = await reserve(body.p_email, body.p_network);
      else if (String(url).endsWith("/refund_password_signin_attempt")) value = await refund(body.p_reservation);
      else if (String(url).includes("grant_type=password")) value = { access_token: "a", refresh_token: "r" };
      else throw new Error(`unexpected request ${url}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
    }));
    try {
      // Same address too: repeated web and phone sign-ins must not spend its cap.
      for (let index = 0; index < 21; index++) {
        const response = { status: vi.fn().mockReturnThis(), setHeader() {}, end: vi.fn() };
        await passwordHandler({ method: "POST", headers: { host: "app.unionground.test", origin: "https://app.unionground.test",
          "x-vercel-forwarded-for": "203.0.113.9" },
        body: { email, password: "long-password", client: ["web", "ios", "android"][index % 3] } }, response);
        expect(response.status).toHaveBeenCalledWith(200);
      }
      expect(await counts()).toEqual([]);
      expect((await db.client.query("select count(*)::int n from private.password_signin_reservations")).rows[0].n).toBe(0);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it("keeps five failures per normalized address and twenty per network", async () => {
    for (let index = 0; index < 5; index++) expect((await reserve()).allowed).toBe(true);
    expect(await reserve(` ${email.toUpperCase()} `)).toEqual({ allowed: false });
    for (let index = 6; index < 20; index++) {
      expect((await reserve(`member${index}@example.invalid`)).allowed).toBe(true);
    }
    expect(await reserve("fresh@example.invalid")).toEqual({ allowed: false });
    // Rejected network attempts do not consume the fresh address's allowance.
    expect((await reserve("fresh@example.invalid", "unknown")).allowed).toBe(true);
  });

  it("refunds only one success and never clears previous or concurrent failures", async () => {
    await reserve();
    const success = await reserve();
    await reserve();
    expect(await refund(success.reservation)).toBe(true);
    expect(await refund(success.reservation)).toBe(false);
    expect((await counts()).map(row => row.attempt_count)).toEqual([2, 2]);
    for (let index = 0; index < 3; index++) expect((await reserve()).allowed).toBe(true);
    expect((await reserve()).allowed).toBe(false);
  });

  it("serializes concurrent reservations and duplicate refunds across connections", async () => {
    const sessions = await Promise.all(Array.from({ length: 8 }, async () => {
      const client = new pg.Client(db.client.connectionParameters);
      await client.connect();
      return client;
    }));
    try {
      const attempts = await Promise.all(sessions.map(async client => (await client.query(
        "select public.reserve_password_signin_attempt($1,$2) r", [email, network])).rows[0].r));
      expect(attempts.filter(attempt => attempt.allowed)).toHaveLength(5);
      const id = attempts.find(attempt => attempt.allowed).reservation;
      const refunds = await Promise.all(sessions.map(async client => (await client.query(
        "select public.refund_password_signin_attempt($1) r", [id])).rows[0].r));
      expect(refunds.filter(Boolean)).toHaveLength(1);
      expect((await counts()).find(row => row.scope === "password-signin-email").attempt_count).toBe(4);
    } finally { await Promise.all(sessions.map(client => client.end())); }
  });

  it("opens the next hourly window and refuses late refunds against its failures", async () => {
    const old = await reserve();
    await db.client.query("update private.auth_attempt_throttle set window_started_at = window_started_at - interval '61 minutes'");
    expect((await reserve()).allowed).toBe(true);
    expect(await refund(old.reservation)).toBe(true);
    expect((await counts()).map(row => row.attempt_count)).toEqual([1, 1]);
  });

  it("preserves independent network and email window resets", async () => {
    await reserve();
    const success = await reserve();
    await db.client.query("update private.auth_attempt_throttle set window_started_at = window_started_at - interval '61 minutes' where scope = 'password-signin-network'");
    await reserve();
    await refund(success.reservation);
    expect((await counts()).map(row => row.attempt_count)).toEqual([2, 1]);
  });

  it("does not refund the independent Auth hook account lockout", async () => {
    const event = { user_id: "10000000-0000-4000-8000-000000000001", valid: false };
    const hook = async valid => (await db.client.query(
      "select public.auth_password_verification_attempt_hook($1::jsonb) r", [{ ...event, valid }])).rows[0].r;
    for (let index = 0; index < 5; index++) await hook(false);
    const success = await reserve();
    await refund(success.reservation);
    expect(await hook(true)).toMatchObject({ decision: "reject" });
  });

  it("exposes neither reservations nor refunds to browser roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.client.query(`set role ${role}`);
      try {
        await expect(reserve()).rejects.toMatchObject({ code: "42501" });
        await expect(refund("00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({ code: "42501" });
        await expect(db.client.query("select * from private.password_signin_reservations")).rejects.toMatchObject({ code: "42501" });
      } finally { await db.client.query("reset role"); }
    }
  });
});
