// @vitest-environment node
// REQ-UG-RELEASE-HOLD-ON-ENTRY-SCREEN-CONTROLS-20261112 (#8465).
//
// 20261112102500 adds the two platform-only provider definitions
// (features.identity_providers.apple and .google) and
// public.get_entry_screen_release_state(), the one read the sign-in screens'
// options route makes with the publishable key: whether the Apple button, the
// Google button and the single sign-on control (features.security.sso) are
// released. On an owned disposable database, inside one rolled-back
// transaction: held, released and missing rows, and no other held switch
// showing through.
//
// REQ-UG-HOLD-APPLE-AND-GOOGLE-ENTRY-BUTTONS-20261112 (#8483): a later
// data-only migration holds the two provider buttons with no date, so on Main
// the read answers apple false, google false and sso true. Its guard refuses a
// database where either provider row is missing.
//
// REQ-UG-HOLD-RELEASE-CALENDAR-SWITCHES-20261112 (#8579): the release
// calendar migration holds features.security.sso with no date as well, so on
// Main all three controls are held and the read answers all three false.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "entry_screen_release_state";
const KEYS = { apple: "features.identity_providers.apple", google: "features.identity_providers.google", sso: "features.security.sso" };
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const HOLD_MIGRATION = "hold_identity_provider_buttons";
const holdSql = stripComments(loadMigrationSql(HOLD_MIGRATION));
// The migration's one statement, run by the live cases inside their own
// transaction.
const HOLD_BLOCK = holdSql.slice(holdSql.indexOf("do $hold$"), holdSql.indexOf("$hold$;") + "$hold$;".length);

describe("entry screen release state migration (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));
  const fn = sql.slice(sql.indexOf("create function public.get_entry_screen_release_state()"), sql.indexOf("$function$;") + 11);

  it("ships one atomic migration that holds nothing", () => {
    expect(findMigrationName(MIGRATION)).toBe("20261112102500_entry_screen_release_state.sql");
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/release_at\s*=/);
    expect(sql).not.toMatch(/\bupdate public\.platform_setting_definitions\b/);
  });

  it("adds both provider rows as platform-only booleans, default on and not member-visible", () => {
    for (const key of [KEYS.apple, KEYS.google]) {
      expect(sql).toMatch(new RegExp(`\\('${key.replaceAll(".", "\\.")}', 'boolean', '[^']+',\\s*'[^']+',\\s*'true', null, null, null, \\d+, 'security', false, false\\)`));
    }
  });

  it("reads only the three keys' release times, as a definer with an empty search path", () => {
    expect(fn).toMatch(/security definer\s+set search_path = ''/);
    expect(fn).toContain("d.key in ('features.identity_providers.apple', 'features.identity_providers.google', 'features.security.sso')");
    expect(fn).toContain("(d.release_at is null or d.release_at <= pg_catalog.now())");
    expect(fn).not.toMatch(/organization_setting_values|default_value|auth\.|organization_id/);
  });

  it("grants execute to anon and authenticated only, and pins that in the contract", () => {
    expect(sql).toContain("revoke all on function public.get_entry_screen_release_state() from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_entry_screen_release_state() to anon, authenticated;");
    expect(contract.functions.find((row) => row.sig === "public.get_entry_screen_release_state()")).toMatchObject({ exec: "anon,authenticated", secdef: true });
    expect(contract.mfaCoverage.exempt).toHaveProperty("get_entry_screen_release_state");
  });
});

describe("hold of the Apple and Google buttons migration (static)", () => {
  it("is one atomic data-only migration, applied after the rows exist, that holds only the two provider keys with no date", () => {
    expect(findMigrationName(HOLD_MIGRATION)).toMatch(/^\d{14}_hold_identity_provider_buttons\.sql$/);
    expect(findMigrationName(HOLD_MIGRATION) > findMigrationName(MIGRATION)).toBe(true);
    expect(holdSql.trimStart().startsWith("begin;")).toBe(true);
    expect(holdSql.trimEnd().endsWith("commit;")).toBe(true);
    expect(holdSql.match(/\bupdate\b/g)).toHaveLength(1);
    expect(HOLD_BLOCK).toMatch(/update public\.platform_setting_definitions\s+set release_at = 'infinity'\s+where key in \('features\.identity_providers\.apple', 'features\.identity_providers\.google'\)\s+and value_kind = 'boolean';/);
    expect(holdSql).not.toContain(KEYS.sso);
    expect(holdSql).not.toMatch(/\b(?:create|alter|drop|grant|revoke|insert|delete|truncate)\b/);
  });

  it("refuses to finish unless both rows were held", () => {
    expect(HOLD_BLOCK).toMatch(/get diagnostics held = row_count;\s+if held <> 2 then\s+raise exception 'expected to hold 2 provider definitions, held %', held using errcode = '55000';/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("entry screen release state on an owned disposable database", () => {
  let db;

  async function as(role, sql, params = []) {
    await db.query("savepoint entry_release_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
      await db.query(`set local role ${role}`);
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint entry_release_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint entry_release_call");
      await db.query("release savepoint entry_release_call");
      return { code: error.code, message: error.message };
    }
  }
  const state = (role = "anon") => as(role, "select public.get_entry_screen_release_state() as data");
  const hold = (key, at) => db.query("update public.platform_setting_definitions set release_at = $2::timestamptz where key = $1", [key, at]);
  // Main holds all three (#8483, #8579), so a case about another state starts
  // by releasing all three inside its own savepoint.
  const releaseAll = () => db.query("update public.platform_setting_definitions set release_at = null where key = any($1::text[])", [Object.values(KEYS)]);
  const releaseTimes = async () => (await db.query(
    "select key, release_at::text as release_at from public.platform_setting_definitions where key = any($1::text[]) order by key",
    [Object.values(KEYS)],
  )).rows;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "entry-screen-release-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout='60s'");
    await db.query("set local lock_timeout='15s'");
  });

  afterAll(async () => {
    await db?.query("rollback").catch(() => undefined);
    await db?.end();
  });

  it("installs both provider rows as platform-only booleans", async () => {
    const rows = (await db.query(
      "select key, value_kind, default_value, organization_editable, member_visible from public.platform_setting_definitions where key = any($1::text[]) order by key",
      [[KEYS.apple, KEYS.google]],
    )).rows;
    expect(rows).toEqual([
      { key: KEYS.apple, value_kind: "boolean", default_value: true, organization_editable: false, member_visible: false },
      { key: KEYS.google, value_kind: "boolean", default_value: true, organization_editable: false, member_visible: false },
    ]);
  });

  it("holds both provider buttons (#8483) and single sign-on (#8579) with no date on Main", async () => {
    expect(await releaseTimes()).toEqual([
      { key: KEYS.apple, release_at: "infinity" },
      { key: KEYS.google, release_at: "infinity" },
      { key: KEYS.sso, release_at: "infinity" },
    ]);
    expect(await state("anon")).toEqual({ code: "", data: { apple: false, google: false, sso: false } });
    expect(await state("authenticated")).toEqual({ code: "", data: { apple: false, google: false, sso: false } });
  });

  it("refuses the hold on a database missing a provider row, and holds both when re-run", async () => {
    await db.query("savepoint guard_case");
    try {
      await releaseAll();
      await db.query("delete from public.platform_setting_definitions where key = $1", [KEYS.google]);
      await db.query("savepoint guard_call");
      await expect(db.query(HOLD_BLOCK)).rejects.toMatchObject({ code: "55000", message: "expected to hold 2 provider definitions, held 1" });
      await db.query("rollback to savepoint guard_call");
      expect(await releaseTimes()).toEqual([{ key: KEYS.apple, release_at: null }, { key: KEYS.sso, release_at: null }]);
    } finally {
      await db.query("rollback to savepoint guard_case");
    }
    await db.query("savepoint rerun_case");
    try {
      await releaseAll();
      await db.query(HOLD_BLOCK);
      await db.query(HOLD_BLOCK);
      expect(await releaseTimes()).toEqual([
        { key: KEYS.apple, release_at: "infinity" },
        { key: KEYS.google, release_at: "infinity" },
        { key: KEYS.sso, release_at: null },
      ]);
    } finally {
      await db.query("rollback to savepoint rerun_case");
    }
  });

  it("is callable by anon and authenticated only", async () => {
    const grants = (await db.query(
      `select r as role, has_function_privilege(r, 'public.get_entry_screen_release_state()', 'execute') as can
       from unnest(array['anon', 'authenticated', 'service_role']) r order by r`,
    )).rows;
    expect(grants).toEqual([
      { role: "anon", can: true },
      { role: "authenticated", can: true },
      { role: "service_role", can: false },
    ]);
    const publicAcl = (await db.query(
      "select count(*)::int as n from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.get_entry_screen_release_state()'::regprocedure and a.grantee = 0",
    )).rows[0].n;
    expect(publicAcl).toBe(0);
  });

  it("answers every control released once nothing is held, for anon and authenticated", async () => {
    await db.query("savepoint released_case");
    try {
      await releaseAll();
      expect(await state("anon")).toEqual({ code: "", data: { apple: true, google: true, sso: true } });
      expect(await state("authenticated")).toEqual({ code: "", data: { apple: true, google: true, sso: true } });
    } finally {
      await db.query("rollback to savepoint released_case");
    }
  });

  it("answers a held control as not released and releases it once its time passes", async () => {
    await db.query("savepoint held_case");
    try {
      await releaseAll();
      await hold(KEYS.apple, "infinity");
      await hold(KEYS.google, "2999-01-01 09:00 America/New_York");
      await hold(KEYS.sso, "2999-01-01 09:00 America/New_York");
      expect((await state()).data).toEqual({ apple: false, google: false, sso: false });
      await hold(KEYS.google, "2000-01-01 09:00 America/New_York");
      await hold(KEYS.sso, null);
      expect((await state()).data).toEqual({ apple: false, google: true, sso: true });
    } finally {
      await db.query("rollback to savepoint held_case");
    }
  });

  it("answers a missing row as not released", async () => {
    await db.query("savepoint missing_case");
    try {
      await releaseAll();
      await db.query("delete from public.platform_setting_definitions where key = $1", [KEYS.google]);
      expect((await state()).data).toEqual({ apple: true, google: false, sso: true });
    } finally {
      await db.query("rollback to savepoint missing_case");
    }
  });

  it("reveals no other held switch", async () => {
    await db.query("savepoint other_case");
    try {
      await releaseAll();
      const others = (await db.query(
        "select key from public.platform_setting_definitions where value_kind = 'boolean' and key <> all($1::text[]) order by key",
        [Object.values(KEYS)],
      )).rows.map((row) => row.key);
      expect(others.length).toBeGreaterThan(0);
      await db.query("update public.platform_setting_definitions set release_at = 'infinity' where key = any($1::text[])", [others]);
      const answer = await state();
      expect(answer.data).toEqual({ apple: true, google: true, sso: true });
      expect(Object.keys(answer.data).sort()).toEqual(["apple", "google", "sso"]);
    } finally {
      await db.query("rollback to savepoint other_case");
    }
  });
});
