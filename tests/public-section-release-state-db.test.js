// @vitest-environment node
// REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117 (#9038), part 1.
//
// The public_page_section_switches migration adds four platform-only section
// definitions (features.public_pages.*), created held with no date, and
// public.get_public_section_release_state(), the read /api/public-sections
// makes with the publishable key: the short names of the released sections,
// never a held one. On an owned disposable database, inside one rolled-back
// transaction: held, dated, released and missing rows, no other switch showing
// through, the release tool's function accepting the new keys, and the guard.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "public_page_section_switches";
const SECTIONS = ["sign_in_design_2", "sign_in_design_3", "sign_in_design_4", "unions_map_3d"];
const KEYS = SECTIONS.map((section) => `features.public_pages.${section}`);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const sql = stripComments(loadMigrationSql(MIGRATION));
const fn = sql.slice(sql.indexOf("create function public.get_public_section_release_state()"), sql.indexOf("$function$;") + 11);
const GUARD = sql.slice(sql.indexOf("do $guard$"), sql.indexOf("$guard$;") + "$guard$;".length);

describe("public page section switches migration (static)", () => {
  it("ships one atomic migration that updates no existing row", () => {
    expect(findMigrationName(MIGRATION)).toMatch(/^\d{14}_public_page_section_switches\.sql$/);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/\bupdate\b/);
    expect(sql).not.toMatch(/\bon conflict\b/);
  });

  it("adds the four sections as platform-only booleans, default on, not member-visible, held with no date", () => {
    for (const key of KEYS) {
      expect(sql).toMatch(new RegExp(`\\('${key.replaceAll(".", "\\.")}', 'boolean', '[^']+',\\s*'[^']+',\\s*'true', null, null, null, \\d+, 'general', false, false, 'infinity'\\)`));
    }
  });

  it("reads only features.public_pages.* release times, as a definer with an empty search path", () => {
    expect(fn).toMatch(/security definer\s+set search_path = ''/);
    expect(fn).toContain("pg_catalog.starts_with(d.key, 'features.public_pages.')");
    expect(fn).toContain("(d.release_at is null or d.release_at <= pg_catalog.now())");
    expect(fn).toContain("pg_catalog.substr(d.key, 23)");
    expect("features.public_pages.".length + 1).toBe(23);
    expect(fn).not.toMatch(/organization_setting_values|default_value|auth\.|organization_id/);
  });

  it("grants execute to anon and authenticated only, and pins that in the contract", () => {
    expect(sql).toContain("revoke all on function public.get_public_section_release_state() from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_public_section_release_state() to anon, authenticated;");
    expect(contract.functions.find((row) => row.sig === "public.get_public_section_release_state()")).toMatchObject({ exec: "anon,authenticated", secdef: true });
    expect(contract.mfaCoverage.exempt).toHaveProperty("get_public_section_release_state");
  });

  it("refuses to finish unless all four sections are held and none reads released", () => {
    expect(GUARD).toMatch(/if held <> 4 then\s+raise exception 'expected 4 held public-page sections, found %', held using errcode = '55000';/);
    expect(GUARD).toContain("if public.get_public_section_release_state() <> '{\"released\": []}'::jsonb then");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("public page section release state on an owned disposable database", () => {
  let db;

  async function as(role, text, params = []) {
    await db.query("savepoint section_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
      await db.query(`set local role ${role}`);
      const result = await db.query(text, params);
      await db.query("reset role");
      await db.query("release savepoint section_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint section_call");
      await db.query("release savepoint section_call");
      return { code: error.code, message: error.message };
    }
  }
  const state = (role = "anon") => as(role, "select public.get_public_section_release_state() as data");
  const hold = (key, at) => db.query("update public.platform_setting_definitions set release_at = $2::timestamptz where key = $1", [key, at]);
  async function inCase(name, run) {
    await db.query(`savepoint ${name}`);
    try {
      await run();
    } finally {
      await db.query(`rollback to savepoint ${name}`);
    }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "public-section-release-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout='60s'");
    await db.query("set local lock_timeout='15s'");
  });

  afterAll(async () => {
    await db?.query("rollback").catch(() => undefined);
    await db?.end();
  });

  it("installs the four sections as platform-only booleans, held with no date", async () => {
    const rows = (await db.query(
      `select key, value_kind, default_value, organization_editable, member_visible, release_at::text as release_at
       from public.platform_setting_definitions where key = any($1::text[]) order by key`,
      [KEYS],
    )).rows;
    expect(rows).toEqual(KEYS.map((key) => ({
      key, value_kind: "boolean", default_value: true, organization_editable: false, member_visible: false, release_at: "infinity",
    })));
  });

  it("names no section on Main, for anon and authenticated", async () => {
    expect(await state("anon")).toEqual({ code: "", data: { released: [] } });
    expect(await state("authenticated")).toEqual({ code: "", data: { released: [] } });
  });

  it("is callable by anon and authenticated only", async () => {
    const grants = (await db.query(
      `select r as role, has_function_privilege(r, 'public.get_public_section_release_state()', 'execute') as can
       from unnest(array['anon', 'authenticated', 'service_role']) r order by r`,
    )).rows;
    expect(grants).toEqual([
      { role: "anon", can: true },
      { role: "authenticated", can: true },
      { role: "service_role", can: false },
    ]);
    const publicAcl = (await db.query(
      "select count(*)::int as n from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.get_public_section_release_state()'::regprocedure and a.grantee = 0",
    )).rows[0].n;
    expect(publicAcl).toBe(0);
  });

  it("names a section once its release time passes, in key order, and never a held or dated one", async () => {
    await inCase("released_case", async () => {
      await hold(KEYS[3], null);
      await hold(KEYS[0], "2000-01-01 09:00 America/New_York");
      await hold(KEYS[1], "2999-01-01 09:00 America/New_York");
      expect((await state()).data).toEqual({ released: ["sign_in_design_2", "unions_map_3d"] });
      for (const key of KEYS) await hold(key, null);
      expect((await state("authenticated")).data).toEqual({ released: SECTIONS });
    });
  });

  it("is a stable security definer with search_path pinned to empty, owned by postgres", async () => {
    const row = (await db.query(
      `select p.prosecdef, p.provolatile, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner) as owner, p.pronargs
       from pg_catalog.pg_proc p where p.oid = 'public.get_public_section_release_state()'::regprocedure`,
    )).rows[0];
    expect(row).toEqual({ prosecdef: true, provolatile: "s", proconfig: ["search_path=\"\""], owner: "postgres", pronargs: 0 });
  });

  it("answers only { released } with the short names of released sections: no held name, no date, no other field", async () => {
    await inCase("shape_case", async () => {
      await hold(KEYS[0], null);
      await hold(KEYS[1], "2999-01-01 09:00 America/New_York");
      await hold(KEYS[2], "2000-01-01 09:00 America/New_York");
      const { data } = await state();
      expect(Object.keys(data)).toEqual(["released"]);
      expect(data.released).toEqual(["sign_in_design_2", "sign_in_design_4"]);
      const text = JSON.stringify(data);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|infinity|2999|2000/);
      expect(text).not.toContain("sign_in_design_3");
      expect(text).not.toContain("unions_map_3d");
      expect(text).not.toContain("features.");
      for (const name of data.released) expect(SECTIONS).toContain(name);
    });
  });

  it("never names a row that is not a boolean under the exact prefix, even with no release time", async () => {
    await inCase("kind_case", async () => {
      await db.query(
        `insert into public.platform_setting_definitions
           (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible, organization_editable)
         values ('features.public_pages.proof_count', 'integer', 'Proof', 'Proof row.', '1', 0, 10, null, 999, 'general', false, false),
                ('features.public_pagesx.proof_flag', 'boolean', 'Proof', 'Proof row.', 'true', null, null, null, 999, 'general', false, false)`,
      );
      expect((await state()).data).toEqual({ released: [] });
    });
  });

  it("names no other switch, released or not", async () => {
    await inCase("other_case", async () => {
      await db.query("update public.platform_setting_definitions set release_at = null where key in ('features.identity_providers.apple', 'features.security.sso')");
      expect((await state()).data).toEqual({ released: [] });
    });
  });

  it("answers a missing section as not named", async () => {
    await inCase("missing_case", async () => {
      await hold(KEYS[0], null);
      await db.query("delete from public.platform_setting_definitions where key = $1", [KEYS[0]]);
      expect((await state()).data).toEqual({ released: [] });
    });
  });

  it("lets the release tool's function release and hold a section, with one audit row each", async () => {
    await inCase("tool_case", async () => {
      // The database owner route of scripts/release-calendar.mjs, which sends
      // no request claims. Every state() read sets them for its role, and they
      // last for the transaction, so they are cleared before each call.
      const ownerSet = async (at, reason) => {
        await db.query("select set_config('request.jwt.claims', '', true)");
        await db.query("select public.set_platform_setting_release($1, $2::timestamptz, $3, 'proof')", [KEYS[1], at, reason]);
      };
      await ownerSet("2000-01-01 09:00 America/New_York", "proof release");
      expect((await state()).data).toEqual({ released: ["sign_in_design_3"] });
      await ownerSet("infinity", "proof hold");
      expect((await state()).data).toEqual({ released: [] });
      const audit = (await db.query(
        "select count(*)::int as n from private.platform_setting_release_changes where setting_key = $1 and actor_name = 'proof'",
        [KEYS[1]],
      )).rows[0].n;
      expect(audit).toBe(2);
    });
  });

  it("refuses the guard when a section is missing or released, and passes when all four are held", async () => {
    await db.query(GUARD);
    await inCase("guard_missing", async () => {
      await db.query("delete from public.platform_setting_definitions where key = $1", [KEYS[2]]);
      await expect(db.query(GUARD)).rejects.toMatchObject({ code: "55000", message: "expected 4 held public-page sections, found 3" });
    });
    await inCase("guard_released", async () => {
      await hold(KEYS[2], null);
      await expect(db.query(GUARD)).rejects.toMatchObject({ code: "55000", message: "expected 4 held public-page sections, found 3" });
    });
  });
});
