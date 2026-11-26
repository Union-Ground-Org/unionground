// @vitest-environment node
//
// REQ-UG-RELEASE-CALENDAR-SCREEN-RELEASE-AND-HOLD-CHANGE-BOTH-DATABASES-20261117 (#9077).
//
// Offline half: the platform_setting_release_follow migration's grants and
// bodies. public.get_platform_setting_release_for_follow and
// public.follow_platform_setting_release are the service role's only way to
// read and set a release time (api/release-calendar.js calls them on SAMPLE;
// the service role has no select or update on the definitions table). The
// refusals live once, in private.platform_setting_release_previous, which
// public.set_platform_setting_release now uses too, and the service-key check
// once, in private.platform_setting_release_service_caller.
// Live half (disposable loopback only): the service role reads and follows a
// time with a name and a reason, one audit row; nobody else can; a changed
// row, a switch never held and the other refusals write nothing.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

// Found by name: the controller assigns the stamp when the change is pushed.
const MIGRATIONS = readdirSync("supabase/migrations").filter((name) => name.endsWith("_platform_setting_release_follow.sql"));
if (MIGRATIONS.length !== 1) throw new Error(`expected one platform_setting_release_follow migration, found ${MIGRATIONS.length}`);
const code = stripComments(readFileSync(`supabase/migrations/${MIGRATIONS[0]}`, "utf8")).replace(/\s+/g, " ");
const FOLLOW = "public.follow_platform_setting_release(text, timestamptz, timestamptz, text, text)";
const SET = "public.set_platform_setting_release(text, timestamptz, text, text)";
const PREVIOUS = "private.platform_setting_release_previous(text, timestamptz, text)";
const READ = "public.get_platform_setting_release_for_follow(text)";
const SERVICE = "private.platform_setting_release_service_caller()";

function body(name) {
  const start = code.search(new RegExp(`create (or replace )?function ${name.replace(/\./g, "\\.")}\\(`));
  expect(start, name).toBeGreaterThan(-1);
  const open = code.indexOf("as $function$", start) + "as $function$".length;
  return code.slice(open, code.indexOf("$function$", open));
}

describe("release follow migration (offline)", () => {
  it("is one atomic migration; the follow function is the service role's alone and the helper nobody's", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    for (const signature of [FOLLOW, READ]) {
      expect(code).toContain(`revoke all on function ${signature} from public, anon, authenticated, service_role;`);
      expect(code).toContain(`grant execute on function ${signature} to service_role;`);
    }
    // The only grants: the two service-role functions and the set function's existing one.
    expect([...code.matchAll(/grant execute on function ([a-z_.]+)\([^)]*\) to ([a-z_, ]+);/g)].map((match) => `${match[1]} ${match[2]}`).sort())
      .toEqual(["public.follow_platform_setting_release service_role", "public.get_platform_setting_release_for_follow service_role", "public.set_platform_setting_release authenticated"]);
    for (const signature of [PREVIOUS, SERVICE]) {
      expect(code).toContain(`revoke all on function ${signature} from public, anon, authenticated, service_role;`);
    }
    // The set function keeps exactly its grant.
    expect(code).toContain(`revoke all on function ${SET} from public, anon, authenticated, service_role;`);
    expect(code).toContain(`grant execute on function ${SET} to authenticated;`);
    // No table and no other existing function changes.
    expect(code).not.toMatch(/\b(create|alter|drop) table\b/);
    expect([...code.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((match) => match[1])).toEqual(["public.set_platform_setting_release"]);
    expect(code).not.toMatch(/platform_setting_release_caller\(text\) (from|to)|function private\.platform_setting_release_caller\(/);
  });

  it("keeps one copy of the refusals, used by both writers after their own caller check", () => {
    const previous = body("private.platform_setting_release_previous");
    expect(previous).toContain("raise exception 'reason required' using errcode = '22023';");
    expect(previous).toContain("raise exception 'release time required' using errcode = '22023';");
    expect(previous).toContain("for update;");
    expect(previous).toContain("raise exception 'switch % was never held; its first hold is a reviewed migration', p_key using errcode = '55000';");
    expect(previous).not.toMatch(/update |insert into|delete from/);

    const set = body("public.set_platform_setting_release");
    expect(set.slice(set.indexOf(" begin ")).trimStart()).toMatch(/^begin caller := private\.platform_setting_release_caller\(p_actor\); previous := private\.platform_setting_release_previous\(p_key, p_release_at, p_reason\);/);
    const follow = body("public.follow_platform_setting_release");
    const read = body("public.get_platform_setting_release_for_follow");
    // The service-key check comes first in both, from its one copy.
    for (const [name, text] of [["follow", follow], ["read", read]]) {
      expect(text.trimStart(), name).toMatch(/^(declare previous timestamptz; )?begin perform private\.platform_setting_release_service_caller\(\);/);
      expect(text, name).not.toContain("service role required");
    }
    expect(read).not.toMatch(/update |insert into|delete from/);
    const service = body("private.platform_setting_release_service_caller");
    expect(service).toContain("if pg_catalog.current_setting('role') is distinct from 'service_role'");
    expect(service).toContain("or (claims::jsonb ->> 'role') is distinct from 'service_role'");
    expect(service).toContain("or (select auth.uid()) is not null then raise exception 'service role required' using errcode = '42501';");
    for (const [name, text] of [["set", set], ["follow", follow]]) {
      // The refusal text lives only in the helper.
      expect(text, name).not.toContain("was never held");
      expect(text, name).not.toContain("'reason required'");
      const updates = [...text.matchAll(/update ([a-z_.]+) set ([a-z_]+) =/g)].map((match) => `${match[1]}.${match[2]}`);
      expect(updates, name).toEqual(["public.platform_setting_definitions.release_at"]);
      expect([...text.matchAll(/insert into ([a-z_.]+)/g)].map((match) => match[1]), name).toEqual(["private.platform_setting_release_changes"]);
      expect(text, name).not.toMatch(/organization_setting_values|delete from/);
    }
    // Compare-and-set: the row changes only while it holds the time the caller read.
    expect(follow.indexOf("if previous is distinct from p_expected then raise exception 'the release time changed since it was read' using errcode = 'PT409';"))
      .toBeLessThan(follow.indexOf("update public.platform_setting_definitions"));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const SWITCH = "features.engagement_voice.bargaining_survey_template";
const NEVER_HELD = "features.passkey_enrollment";
const INTEGER = "limits.casework.deadline_red_days";
const ACTOR = "Production operator 00000000-0000-4000-8000-000000000001, release calendar screen";

live("release follow on a disposable database", () => {
  let c;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "release-calendar-follow-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  const q = async (text, values = []) => (await c.query(text, values)).rows;
  async function call(text, values = [], as = null) {
    await c.query("savepoint call");
    try {
      const claims = as?.id ? { role: "authenticated", sub: as.id, session_id: as.session, aal: "aal2" } : as?.claims ?? null;
      if (claims) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      if (as?.role || as?.id) await c.query(`set local role ${as.role ?? "authenticated"}`);
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }
  const service = { role: "service_role", claims: { role: "service_role" } };
  async function operator() {
    const user = { id: randomUUID(), session: randomUUID() };
    await q("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    await q("insert into private.compass_platform_operators(user_id, granted_note) values ($1, 'release follow proof operator')", [user.id]);
    return user;
  }
  const hold = (key, time) => q("update public.platform_setting_definitions set release_at = $2 where key = $1", [key, time]);
  const releaseAt = async (key) => (await q("select release_at::text t from public.platform_setting_definitions where key = $1", [key]))[0].t;
  const audit = (key) => q(`select action, previous_release_at::text previous, new_release_at::text next, reason,
      actor_user_id::text actor, actor_name, session_role from private.platform_setting_release_changes where setting_key = $1 order by id`, [key]);
  const follow = "select public.follow_platform_setting_release($1, $2::timestamptz, $3::timestamptz, $4, $5) r";
  const read = "select public.get_platform_setting_release_for_follow($1) r";

  it("lets the service role, and only it, read one switch's release time and the clock", async () => {
    await c.query("begin");
    try {
      await hold(SWITCH, "infinity");
      expect(await call(read, [SWITCH], service)).toMatchObject({ ok: true, rows: [{ r: { key: SWITCH, releaseAt: "infinity" } }] });
      expect((await call(read, [SWITCH], service)).rows[0].r.now).toEqual(expect.any(String));
      for (const key of [NEVER_HELD, INTEGER, "features.release_follow_proof.none"]) {
        expect(await call(read, [key], service), key).toMatchObject({ ok: true, rows: [{ r: { key, releaseAt: null } }] });
      }
      const person = await operator();
      expect(await call(read, [SWITCH], person)).toMatchObject({ ok: false, code: "42501" });
      expect(await call(read, [SWITCH], { role: "anon", claims: { role: "anon" } })).toMatchObject({ ok: false, code: "42501" });
      expect(await call(read, [SWITCH])).toMatchObject({ ok: false, code: "42501", message: "service role required" });
      expect(await call(read, [SWITCH], { role: "service_role", claims: { role: "service_role", sub: person.id } }))
        .toMatchObject({ ok: false, code: "42501", message: "service role required" });
    } finally {
      await c.query("rollback");
    }
  });

  it("lets the service role give SAMPLE Production's time, named and audited, and changes nothing the second time", async () => {
    await c.query("begin");
    try {
      await hold(SWITCH, "infinity");
      const now = (await q("select now()::text t"))[0].t;
      expect(await call(follow, [SWITCH, now, "infinity", "Release day", ACTOR], service))
        .toMatchObject({ ok: true, rows: [{ r: { key: SWITCH, previousReleaseAt: "infinity", held: false, updated: true } }] });
      expect(await releaseAt(SWITCH)).toBe(now);
      expect(await call(follow, [SWITCH, now, "infinity", "Release day", ACTOR], service))
        .toMatchObject({ ok: true, rows: [{ r: { updated: false } }] });
      expect(await call(follow, [SWITCH, "infinity", now, "Held again", ACTOR], service)).toMatchObject({ ok: true, rows: [{ r: { held: true, updated: true } }] });
      expect(await audit(SWITCH)).toEqual([
        { action: "set", previous: "infinity", next: now, reason: "Release day", actor: null, actor_name: ACTOR, session_role: "service_role" },
        { action: "set", previous: now, next: "infinity", reason: "Held again", actor: null, actor_name: ACTOR, session_role: "service_role" },
      ]);
    } finally {
      await c.query("rollback");
    }
  });

  it("writes nothing when the row no longer holds the time the caller read", async () => {
    await c.query("begin");
    try {
      await hold(SWITCH, "2099-01-04 09:00 America/New_York");
      const before = await releaseAt(SWITCH);
      expect(await call(follow, [SWITCH, "infinity", "2099-01-11 09:00 America/New_York", "proof", ACTOR], service))
        .toMatchObject({ ok: false, code: "PT409", message: "the release time changed since it was read" });
      expect(await releaseAt(SWITCH)).toBe(before);
      expect(await audit(SWITCH)).toEqual([]);
    } finally {
      await c.query("rollback");
    }
  });

  it("refuses everyone but the service role, and the service role without a name or the time it read", async () => {
    await c.query("begin");
    try {
      await hold(SWITCH, "infinity");
      const person = await operator();
      const args = [SWITCH, "2099-01-04 09:00 America/New_York", "infinity", "proof", ACTOR];
      // Not granted: a stepped-up operator, anon and authenticated with no account.
      expect(await call(follow, args, person)).toMatchObject({ ok: false, code: "42501" });
      expect(await call(follow, args, { role: "anon", claims: { role: "anon" } })).toMatchObject({ ok: false, code: "42501" });
      expect(await call(follow, args, { role: "authenticated", claims: { role: "authenticated" } })).toMatchObject({ ok: false, code: "42501" });
      // The database owner session is not the service role; it has the command line.
      expect(await call(follow, args)).toMatchObject({ ok: false, code: "42501", message: "service role required" });
      // The service role carrying a person's account, or no claims, is refused.
      expect(await call(follow, args, { role: "service_role", claims: { role: "service_role", sub: person.id } }))
        .toMatchObject({ ok: false, code: "42501", message: "service role required" });
      expect(await call(follow, args, { role: "service_role" })).toMatchObject({ ok: false, code: "42501", message: "service role required" });

      for (const actor of [null, "  ", "a\nb", "x".repeat(121)]) {
        expect(await call(follow, [SWITCH, "infinity", "infinity", "proof", actor], service), String(actor)).toMatchObject({ ok: false, code: "22023" });
      }
      expect(await call(follow, [SWITCH, "2099-01-04 09:00 America/New_York", null, "proof", ACTOR], service)).toMatchObject({ ok: false, code: "22023" });
      expect(await releaseAt(SWITCH)).toBe("infinity");
      expect(await audit(SWITCH)).toEqual([]);
    } finally {
      await c.query("rollback");
    }
  });

  it("refuses what the set function refuses, with the same codes", async () => {
    await c.query("begin");
    try {
      await hold(SWITCH, "infinity");
      const time = "2099-01-04 09:00 America/New_York";
      expect(await call(follow, [NEVER_HELD, time, "infinity", "proof", ACTOR], service)).toMatchObject({ ok: false, code: "55000" });
      expect(await releaseAt(NEVER_HELD)).toBe(null);
      expect(await call(follow, [INTEGER, time, "infinity", "proof", ACTOR], service)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(follow, ["features.release_follow_proof.none", time, "infinity", "proof", ACTOR], service)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(follow, [SWITCH, null, "infinity", "proof", ACTOR], service)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(follow, [SWITCH, "-infinity", "infinity", "proof", ACTOR], service)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(follow, [SWITCH, time, "infinity", " ", ACTOR], service)).toMatchObject({ ok: false, code: "22023", message: "reason required" });
      expect(await call(follow, [SWITCH, time, "infinity", "x".repeat(501), ACTOR], service)).toMatchObject({ ok: false, code: "22023" });
      expect(await audit(SWITCH)).toEqual([]);
    } finally {
      await c.query("rollback");
    }
  });

  it("is executable by the service role only; the service role still has no direct read or write of the table", async () => {
    const [grants] = await q(`select
        has_function_privilege('service_role', $1, 'EXECUTE') service,
        has_function_privilege('authenticated', $1, 'EXECUTE') authenticated,
        has_function_privilege('anon', $1, 'EXECUTE') anon,
        has_function_privilege('authenticated', $2, 'EXECUTE') helper_authenticated,
        has_function_privilege('service_role', $2, 'EXECUTE') helper_service,
        has_function_privilege('authenticated', $3, 'EXECUTE') set_authenticated,
        has_function_privilege('service_role', $3, 'EXECUTE') set_service,
        has_function_privilege('service_role', $4, 'EXECUTE') read_service,
        has_function_privilege('authenticated', $4, 'EXECUTE') read_authenticated,
        has_function_privilege('service_role', $5, 'EXECUTE') check_service,
        has_table_privilege('service_role', 'public.platform_setting_definitions', 'SELECT, UPDATE') service_table,
        has_table_privilege('authenticated', 'public.platform_setting_definitions', 'SELECT, UPDATE') authenticated_table`,
    [FOLLOW, PREVIOUS, SET, READ, SERVICE]);
    const expected = {
      service: true, authenticated: false, anon: false,
      helper_authenticated: false, helper_service: false,
      set_authenticated: true, set_service: false,
      read_service: true, read_authenticated: false, check_service: false,
      service_table: false, authenticated_table: false,
    };
    for (const [name, value] of Object.entries(expected)) expect(grants[name], name).toBe(value);
  });
});
