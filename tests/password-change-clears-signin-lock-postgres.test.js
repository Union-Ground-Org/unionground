// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import passwordHandler from "../api/auth-password-signin.js";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

// BUG-UG-FAILED-SIGNIN-LOCK-SURVIVES-COMPLETED-RESET-20261112: five
// wrong passwords locked an address on the app route and on the direct Auth
// grant, and the owner's completed reset did not lift either lock.
const read = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const original = read("20261002015000_survey_review_privacy_floor_and_signin_throttle");
const restored = read("20261002135600_restore_review_hotfixes");
const refunds = read("20261019174000_password_signin_success_refunds");
const migrationName = "20261113114000_password_change_clears_signin_lock";
const migration = read(migrationName);
// #9036: the function waits at most one second for a throttle lock.
const lockTimeoutMigration = read(readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .find(name => name.endsWith("_account_recovery_notice_mail_and_reset_lock_timeout.sql")).replace(/\.sql$/u, ""));
const lockTimeoutStatement = lockTimeoutMigration.match(/^alter function private\.clear_password_signin_lock_after_password_change\(\) set lock_timeout = '1s';$/mu)[0];
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const owner = { id: "10000000-0000-4000-8000-000000000001", email: "owner@example.invalid" };
const other = { id: "10000000-0000-4000-8000-000000000002", email: "other@example.invalid" };
const ownerNetwork = "ipv4:198.51.100.7";

describe.skipIf(!postgresBin)("a changed password lifts its own failed sign-in lock", () => {
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
      create table auth.users (
        id uuid primary key, email text, encrypted_password text,
        recovery_token text, recovery_sent_at timestamptz, last_sign_in_at timestamptz
      );
    `);
    // The real counter, route reservation and Auth hook, as on Main.
    await db.client.query(original.slice(original.indexOf("create table private.auth_attempt_throttle_key"),
      original.indexOf("create function public.consume_password_signin_attempt")));
    const start = restored.indexOf("create or replace function public.consume_password_signin_attempt");
    await db.client.query(restored.slice(start, restored.indexOf("-- ===========================================================================", start)));
    const exhausted = restored.indexOf("create function private.auth_attempt_exhausted");
    const hookEnd = restored.indexOf("$function$;", restored.indexOf("create function public.auth_password_verification_attempt_hook", exhausted)) + "$function$;".length;
    await db.client.query(restored.slice(exhausted, hookEnd));
    await db.client.query(refunds);
    // This migration's function and trigger; its lifecycle-review rows need the
    // full schema and are proven by the database proof run.
    await db.client.query(migration.slice(migration.indexOf("create function private.clear_password_signin_lock_after_password_change"),
      migration.indexOf("-- Reviewed trigger surface")));
    await db.client.query(lockTimeoutStatement);
  }, 120000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.client.query("truncate private.auth_attempt_throttle, private.password_signin_reservations, auth.users");
    await db.client.query("insert into auth.users (id, email, encrypted_password) values ($1,$2,'old-hash'),($3,$4,'old-hash')",
      [owner.id, owner.email, other.id, other.email]);
  });

  const hook = async (user, valid) => (await db.client.query(
    "select public.auth_password_verification_attempt_hook($1::jsonb) r", [{ user_id: user.id, valid }])).rows[0].r.decision;
  const route = async (user, network) => (await db.client.query(
    "select public.reserve_password_signin_attempt($1,$2) r", [user.email, network])).rows[0].r.allowed;
  // The drill: five wrong passwords for one address, from six networks, on both paths.
  const lockOut = async user => {
    for (let index = 0; index < 5; index++) {
      expect(await route(user, `ipv4:203.0.113.${10 + index}`)).toBe(true);
      expect(await hook(user, false)).toBe("continue");
    }
    expect(await route(user, "ipv4:203.0.113.15")).toBe(false);
    expect(await hook(user, false)).toBe("reject");
  };
  const setPassword = async (user, hash) => db.client.query("update auth.users set encrypted_password = $2 where id = $1", [user.id, hash]);
  const buckets = async () => (await db.client.query(
    "select scope, count(*)::int n from private.auth_attempt_throttle group by scope order by scope")).rows;

  it("matches the database contract for the function and its auth.users trigger", async () => {
    const entry = contract.functions.find(item => item.sig === "private.clear_password_signin_lock_after_password_change()");
    expect(entry).toMatchObject({ secdef: true, exec: "" });
    const { rows: [row] } = await db.client.query(`
      select p.prosecdef, p.proconfig, md5(p.prosrc) source_md5, lower(pg_get_functiondef(p.oid)) definition,
        array(select r from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r, p.oid, 'EXECUTE')) grantees,
        exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_execute
      from pg_proc p where p.oid = 'private.clear_password_signin_lock_after_password_change()'::regprocedure`);
    expect(row.prosecdef).toBe(true);
    expect(entry.config).toEqual(["lock_timeout=1s"]);
    expect(row.proconfig).toEqual([contract.functionSweeps.searchPathLiteral, ...entry.config]);
    expect(row.grantees).toEqual([]);
    expect(row.public_execute).toBe(false);
    expect(row.source_md5).toBe(entry.sourceMd5);
    const code = row.definition.replace(/--[^\n]*/g, "");
    for (const needle of entry.bodyContains) expect(code).toContain(needle.toLowerCase());
    for (const needle of entry.bodyForbids) expect(code).not.toContain(needle.toLowerCase());

    const trigger = contract.triggers.find(item => item.table === "users" && item.name === "password_change_clears_signin_lock");
    expect(trigger).toMatchObject({ schema: "auth", function: "private.clear_password_signin_lock_after_password_change",
      timing: "AFTER", events: "UPDATE", forEachRow: true, enabled: "O", whenClause: true });
    const { rows: [installed] } = await db.client.query(`
      select pg_get_triggerdef(t.oid) def, t.tgenabled::text enabled from pg_trigger t
      where t.tgrelid = 'auth.users'::regclass and t.tgname = 'password_change_clears_signin_lock'`);
    expect(installed.enabled).toBe("O");
    expect(installed.def).toContain("AFTER UPDATE OF encrypted_password ON auth.users FOR EACH ROW WHEN");
    // The lifecycle inventory reviews both new objects in the migration itself.
    expect(migration).toContain("object_name = 'password_change_clears_signin_lock'");
    expect(migration).toContain("object_name = 'clear_password_signin_lock_after_password_change()'");
    expect(migration).toContain("private.account_lifecycle_referential_action_trigger_issues()");
  });

  it("refuses the right password on both paths while locked, then lets the owner in after a completed reset", async () => {
    await lockOut(owner);
    expect(await route(owner, ownerNetwork)).toBe(false);
    expect(await hook(owner, true)).toBe("reject");

    await setPassword(owner, "new-hash");

    expect(await route(owner, ownerNetwork)).toBe(true);
    expect(await hook(owner, true)).toBe("continue");
  });

  it("lets the owner in through the real sign-in route after the reset, where it answered 429 before", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "secret");
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      let value;
      if (String(url).endsWith("/reserve_password_signin_attempt")) value = (await db.client.query(
        "select public.reserve_password_signin_attempt($1,$2) r", [body.p_email, body.p_network])).rows[0].r;
      else if (String(url).endsWith("/refund_password_signin_attempt")) value = (await db.client.query(
        "select public.refund_password_signin_attempt($1) r", [body.p_reservation])).rows[0].r;
      else if (String(url).includes("grant_type=password")) value = { access_token: "a", refresh_token: "r" };
      else throw new Error(`unexpected request ${url}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
    }));
    const signIn = async () => {
      const response = { status: vi.fn().mockReturnThis(), setHeader() {}, end: vi.fn() };
      await passwordHandler({ method: "POST", headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN,
        "x-vercel-forwarded-for": "198.51.100.7" }, body: { email: owner.email, password: "long-password" } }, response);
      return response.status.mock.calls[0][0];
    };
    try {
      await lockOut(owner);
      expect(await signIn()).toBe(429);
      await setPassword(owner, "new-hash");
      expect(await signIn()).toBe(200);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it("keeps the lock through a reset that was requested or begun but never set a password", async () => {
    await lockOut(owner);
    await db.client.query("update auth.users set recovery_token = 'token', recovery_sent_at = now(), last_sign_in_at = now() where id = $1", [owner.id]);
    await setPassword(owner, "old-hash");
    expect(await route(owner, ownerNetwork)).toBe(false);
    expect(await hook(owner, true)).toBe("reject");
  });

  it("lifts only the changed account's two buckets, never another address or a network", async () => {
    await lockOut(owner);
    await lockOut(other);
    expect(await buckets()).toEqual([
      { scope: "password-hook-account", n: 2 }, { scope: "password-signin-email", n: 2 }, { scope: "password-signin-network", n: 6 },
    ]);

    await setPassword(owner, "new-hash");

    expect(await buckets()).toEqual([
      { scope: "password-hook-account", n: 1 }, { scope: "password-signin-email", n: 1 }, { scope: "password-signin-network", n: 6 },
    ]);
    expect(await route(other, ownerNetwork)).toBe(false);
    expect(await hook(other, true)).toBe("reject");
  });

  it("limits the address again when wrong attempts follow the completed reset", async () => {
    await lockOut(owner);
    await setPassword(owner, "new-hash");
    await lockOut(owner);
    expect(await route(owner, ownerNetwork)).toBe(false);
    expect(await hook(owner, true)).toBe("reject");
  });

  it("never blocks the password change when the throttle cannot be read or written", async () => {
    await lockOut(owner);
    for (const breakage of [
      "delete from private.auth_attempt_throttle_key",
      "alter table private.auth_attempt_throttle rename to auth_attempt_throttle_unavailable",
    ]) {
      await db.client.query("begin");
      try {
        await db.client.query(breakage);
        await setPassword(owner, `new-hash-${breakage.length}`);
        const { rows: [row] } = await db.client.query("select encrypted_password from auth.users where id = $1", [owner.id]);
        expect(row.encrypted_password).toBe(`new-hash-${breakage.length}`);
      } finally { await db.client.query("rollback"); }
    }
  });

  // SEC-UG-ACCOUNT-RECOVERY-NOTICE-AND-RESET-LOCK-GAPS-20261117
  // (#9036): a sign-in attempt holding the address bucket's advisory lock
  // must not let the request's statement timeout cancel, and so roll back,
  // the password change. The trigger gives up on the lock after one second,
  // the change commits, and that bucket is left to expire with its window.
  const throttleLockKey = async (scope, subject) => (await db.client.query(`
    select pg_catalog.hashtextextended('auth-attempt-throttle:' || $1 || ':' || pg_catalog.encode(extensions.hmac(
      pg_catalog.convert_to($1 || ':' || $2, 'UTF8'), (select k.secret from private.auth_attempt_throttle_key k where k.id), 'sha256'), 'hex'), 509)::text key`,
  [scope, subject])).rows[0].key;
  const holdLock = async key => {
    const holder = new pg.Client({ host: db.client.host, port: db.client.port, user: db.client.user, database: db.client.database });
    await holder.connect();
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock($1::bigint)", [key]);
    return holder;
  };
  const passwordOf = async user => (await db.client.query("select encrypted_password from auth.users where id = $1", [user.id])).rows[0].encrypted_password;

  it("commits the password change while another session holds the throttle lock, and the lock lifts on a later change", async () => {
    await lockOut(owner);
    const holder = await holdLock(await throttleLockKey("password-signin-email", owner.email));
    try {
      await db.client.query("set statement_timeout = '4s'");
      const started = Date.now();
      await setPassword(owner, "new-hash");
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await passwordOf(owner)).toBe("new-hash");
    } finally {
      await db.client.query("reset statement_timeout");
      await holder.query("rollback");
      await holder.end();
    }
    // The held bucket was left in place to expire with its window.
    expect(await route(owner, ownerNetwork)).toBe(false);
    await setPassword(owner, "newer-hash");
    expect(await route(owner, ownerNetwork)).toBe(true);
    expect(await hook(owner, true)).toBe("continue");
  });

  it("would roll the password change back under the same held lock without the function's lock timeout", async () => {
    await lockOut(owner);
    const holder = await holdLock(await throttleLockKey("password-signin-email", owner.email));
    await db.client.query("begin");
    try {
      await db.client.query("alter function private.clear_password_signin_lock_after_password_change() reset lock_timeout");
      await db.client.query("set local statement_timeout = '1500ms'");
      await expect(setPassword(owner, "new-hash")).rejects.toMatchObject({ code: "57014" });
    } finally {
      await db.client.query("rollback");
      await holder.query("rollback");
      await holder.end();
    }
    expect(await passwordOf(owner)).toBe("old-hash");
  });

  it("matches the address the way the route normalizes it", async () => {
    await db.client.query("update auth.users set email = ' Owner@Example.Invalid ' where id = $1", [owner.id]);
    await lockOut(owner);
    await setPassword(owner, "new-hash");
    expect(await route({ email: "owner@example.invalid" }, ownerNetwork)).toBe(true);
  });

  it("is not callable by any client role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.client.query(`set role ${role}`);
      try {
        await expect(db.client.query("select * from private.auth_attempt_throttle")).rejects.toMatchObject({ code: "42501" });
      } finally { await db.client.query("reset role"); }
    }
    const { rows: [row] } = await db.client.query(`
      select array(select r from unnest(array['anon','authenticated','service_role']) r
        where has_function_privilege(r, 'private.clear_password_signin_lock_after_password_change()'::regprocedure, 'EXECUTE')) grantees`);
    expect(row.grantees).toEqual([]);
  });
});
