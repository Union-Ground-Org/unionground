// @vitest-environment node
//
// SEC-UG-NATIVE-LEADER-GATES-USE-TEN-WHERE-THE-ORGANIZATION-FLOOR-IS-25-20261115 (#8768):
// the phone's leader screens follow the organization privacy floor the server
// holds (never below 25), not a fixed ten. The native staff scope reports the
// selected organization's privacyFloor and chapterHealthFloor, and the admin
// Pulse form-state count withholds a group below the organization floor.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const FILE = readdirSync("supabase/migrations").filter((name) => name.endsWith("_native_leader_gates_follow_organization_floor.sql")).sort().at(-1);
const raw = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(raw);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const squash = (text) => text.replace(/\s+/g, " ");
// The live definition of a function is the newest migration that (re)defines it.
const latestDefinition = (sig) => {
  const name = sig.replace(/\(.*$/, "").replace(".", "\\.");
  const file = readdirSync("supabase/migrations").filter((entry) => entry.endsWith(".sql")).sort()
    .filter((entry) => new RegExp(`function ${name}\\(`).test(readFileSync(`supabase/migrations/${entry}`, "utf8"))).at(-1);
  return stripComments(readFileSync(`supabase/migrations/${file}`, "utf8"));
};
// The form-state count also
// returns the floor it applied, so the phone can check it against its scope.
const APPLIED = readdirSync("supabase/migrations").filter((name) => name.endsWith("_admin_form_states_report_the_floor_they_applied.sql")).sort().at(-1);
const appliedCode = stripComments(readFileSync(`supabase/migrations/${APPLIED}`, "utf8"));
const formStatesBody = (text) => {
  const start = text.indexOf("create or replace function public.get_admin_chapter_form_states(p_chapter_id text)");
  return text.slice(start, text.indexOf("$function$;", start));
};

describe("native leader gates follow the organization floor (offline)", () => {
  it("redefines the two functions in one transaction behind predecessor pins, with no grant, policy or table change", () => {
    expect(code.match(/^begin;$/gm)).toHaveLength(1);
    expect(code.match(/^commit;$/gm)).toHaveLength(1);
    expect(code).toContain("create or replace function public.get_my_mobile_staff_scope()");
    expect(code).toContain("create or replace function public.get_admin_chapter_form_states(p_chapter_id text)");
    expect(code).toMatch(/md5\(pg_catalog\.pg_get_functiondef\('public\.get_my_mobile_staff_scope\(\)'::pg_catalog\.regprocedure\)\)\s*<> '[0-9a-f]{32}'/);
    expect(code).toMatch(/md5\(pg_catalog\.pg_get_functiondef\('public\.get_admin_chapter_form_states\(text\)'::pg_catalog\.regprocedure\)\)\s*<> '[0-9a-f]{32}'/);
    expect(code).not.toMatch(/\b(create|alter|drop) policy\b|\bgrant\b|\brevoke\b|\balter table\b|\bcreate table\b/i);
    // No fixed ten remains in the form-state floor.
    expect(code).not.toMatch(/people < 10\b/);
  });

  it("is pinned in the database contract", () => {
    for (const sig of ["public.get_my_mobile_staff_scope()", "public.get_admin_chapter_form_states(p_chapter_id text)"]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry, sig).toBeTruthy();
      const live = latestDefinition(sig);
      for (const needle of entry.bodyContains) expect(squash(live), needle).toContain(squash(needle));
      for (const needle of entry.bodyForbids ?? []) expect(squash(live), needle).not.toContain(squash(needle));
    }
  });

  it("returns the applied floor from the form-state count and changes nothing else (ledger 367)", () => {
    expect(appliedCode.match(/^begin;$/gm)).toHaveLength(1);
    expect(appliedCode.match(/^commit;$/gm)).toHaveLength(1);
    expect(appliedCode).toContain("set local search_path = pg_catalog;");
    // Both bodies 20261113135500 left are pinned; only the form-state count is redefined.
    expect(appliedCode).toMatch(/md5\(pg_catalog\.pg_get_functiondef\('public\.get_my_mobile_staff_scope\(\)'::pg_catalog\.regprocedure\)\)\s*<> '[0-9a-f]{32}'/);
    expect(appliedCode).toMatch(/md5\(pg_catalog\.pg_get_functiondef\('public\.get_admin_chapter_form_states\(text\)'::pg_catalog\.regprocedure\)\)\s*<> '[0-9a-f]{32}'/);
    expect(appliedCode.match(/create or replace function/g)).toHaveLength(1);
    expect(appliedCode).not.toMatch(/\b(create|alter|drop) policy\b|\bgrant\b|\brevoke\b|\balter table\b|\bcreate table\b/i);
    // The new body is the 20261113135500 body with privacyFloor added to both results.
    const body = formStatesBody(appliedCode);
    expect(body.match(/'privacyFloor', privacy_floor\)/g)).toHaveLength(2);
    expect(squash(body.replaceAll(", 'privacyFloor', privacy_floor)", ")"))).toBe(squash(formStatesBody(code)));
    expect(APPLIED > FILE).toBe(true);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("native leader gates follow the organization floor on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "native-leader-floor-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function call(text, values = [], user = null) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "anon" })]);
      await c.query(user ? "set local role authenticated" : "set local role anon");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }
  const one = async (text, values, user) => {
    const result = await call(text, values, user);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0].r;
  };
  const formStates = (user) => one("select public.get_admin_chapter_form_states($1) as r", [world.chapter], user);
  const scope = (user) => one("select public.get_my_mobile_staff_scope() as r", [], user);

  async function person(role = null) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [world.org, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, world.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, world.chapter, `Proof ${role || "member"} ${user.id.slice(0, 6)}`]);
    if (role) {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [world.org, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, world.chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }
  async function forms(owners, status, minutesAgo = 60) {
    for (const [index, owner] of owners.entries()) {
      await c.query("insert into public.member_forms(user_id,template_key,status,answers,updated_at,submitted_at) values ($1,'grievance',$2,'{\"what\":\"Private answer\"}'::jsonb,now() - make_interval(mins => $3),now() - make_interval(mins => $3))",
        [owner.id, status, minutesAgo + index]);
    }
  }
  async function raiseFloor(key, value) {
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,$2,$3::jsonb)", [world.org, key, JSON.stringify(value)]);
  }

  beforeEach(async () => {
    await c.query("begin");
    const tag = randomUUID().slice(0, 8);
    world = { org: randomUUID(), chapter: `leader-floor-${tag}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, `leader-floor-${world.org}`]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98330)", [world.chapter, world.org]);
    await c.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values (true,$1,true)", [world.org]);
    world.members = [];
    for (let index = 0; index < 30; index += 1) world.members.push(await person());
    world.admin = await person("admin");
    world.advisor = await person("advisor");
    await c.query("select set_config('request.jwt.claims', '', true)");
  });
  afterEach(async () => { await c.query("rollback"); });

  it("reports the organization floors in the native staff scope, never below 25", async () => {
    for (const user of [world.admin, world.advisor]) {
      expect(await scope(user)).toMatchObject({ organizationId: world.org, staffAuthorized: true, privacyFloor: 25, chapterHealthFloor: 25 });
    }
    await raiseFloor("limits.analytics.anonymity_floor", 30);
    await raiseFloor("limits.analytics.chapter_health_cohort_floor", 40);
    expect(await scope(world.admin)).toMatchObject({ privacyFloor: 30, chapterHealthFloor: 40 });
  });

  it("withholds a form state of 24 different people and shows one of 25", async () => {
    await forms(world.members.slice(0, 24), "submitted");
    expect(await formStates(world.admin)).toEqual({ withheld: true, states: null, privacyFloor: 25 });
    await forms(world.members.slice(24, 25), "submitted", 1);
    expect(await formStates(world.admin)).toEqual({ withheld: false, states: [{ status: "submitted", count: 25 }], privacyFloor: 25 });
  });

  it("follows a raised organization floor", async () => {
    await forms(world.members.slice(0, 25), "submitted");
    expect(await formStates(world.admin)).toEqual({ withheld: false, states: [{ status: "submitted", count: 25 }], privacyFloor: 25 });
    await raiseFloor("limits.analytics.anonymity_floor", 30);
    expect(await formStates(world.admin)).toEqual({ withheld: true, states: null, privacyFloor: 30 });
    await forms(world.members.slice(25, 30), "submitted", 1);
    expect(await formStates(world.admin)).toEqual({ withheld: false, states: [{ status: "submitted", count: 30 }], privacyFloor: 30 });
  });

  // The count says which floor it was checked against, and that is
  // the floor the staff scope reports at the same moment.
  it("returns the floor it applied, the same floor the staff scope reports", async () => {
    await forms(world.members.slice(0, 25), "submitted");
    expect(await formStates(world.admin)).toMatchObject({ withheld: false, privacyFloor: 25 });
    expect((await scope(world.admin)).privacyFloor).toBe(25);
    await raiseFloor("limits.analytics.anonymity_floor", 30);
    expect(await formStates(world.admin)).toEqual({ withheld: true, states: null, privacyFloor: 30 });
    expect((await scope(world.admin)).privacyFloor).toBe(30);
  });

  it("still refuses a caller without admin authority and anonymous callers", async () => {
    await forms(world.members.slice(0, 25), "submitted");
    expect(await call("select public.get_admin_chapter_form_states($1) as r", [world.chapter], world.advisor)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.get_admin_chapter_form_states($1) as r", [world.chapter], null)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.get_my_mobile_staff_scope() as r", [], null)).toMatchObject({ ok: false, code: "42501" });
  });
});
