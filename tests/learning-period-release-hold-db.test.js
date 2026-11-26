// @vitest-environment node
//
// REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112 (#8581).
//
// Offline half: what the hold_learning_period_offer migration says. Live
// half (disposable loopback only): while the learning period switch is held no
// organization is offered a period or can start one, a period that is already
// running keeps its read, history, end early and undo, and once the release
// time passes everything behaves as it did before, with no deploy.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { LEARNING_PERIOD_SWITCH } from "./helpers/learningPeriodHold.js";
import { findMigrationName, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const FILE = findMigrationName("_hold_learning_period_offer.sql");
const sql = loadMigrationSql("_hold_learning_period_offer.sql");
const code = stripComments(sql).replace(/\s+/g, " ");
const UNAVAILABLE = "learning period unavailable for this organization";

// Newest definition of a function in the migration chain: its file and body.
function newest(name) {
  let found = null;
  for (const { name: file, sql: text } of migrationFiles()) {
    const fn = parseFunctions(text).find((candidate) => candidate.name === name);
    if (fn) found = { file, source: fn.source };
  }
  return found;
}

describe("learning period release hold migration (offline)", () => {
  it("is one atomic migration that creates the switch already held, platform-only and default on", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("allowed_values, sort_order, category, member_visible, organization_editable, release_at) values ('features.guidance_onboarding.learning_period', 'boolean',");
    expect(code).toContain("'true', null, null, null, 2440, 'guidance_onboarding', false, false, 'infinity');");
    // A key that already existed must fail the migration, never skip the hold.
    expect(code.match(/insert into public\.platform_setting_definitions [^;]*;/i)[0]).not.toMatch(/on conflict/i);
    expect(code).toContain("'unreviewed predecessor: public.get_organization_learning_period()'");
    expect(code).toContain("'unreviewed predecessor: public.start_organization_learning_period(integer)'");
  });

  it("makes this migration the newest read and start, both checking the switch", () => {
    const read = newest("public.get_organization_learning_period");
    expect(read.file).toBe(FILE);
    const readBody = read.source.replace(/\s+/g, " ");
    expect(readBody).toContain(`if private.organization_feature_enabled(org, '${LEARNING_PERIOD_SWITCH}') is not true and private.learning_period_running(org) is null then return null;`);
    expect(readBody).toContain("return private.organization_learning_period_payload(org);");

    const start = newest("public.start_organization_learning_period");
    expect(start.file).toBe(FILE);
    expect(helperFirst(start.source)).toBe(true);
    const startBody = start.source.replace(/\s+/g, " ");
    expect(startBody).toContain(`if not private.organization_is_union(org) or private.organization_feature_enabled(org, '${LEARNING_PERIOD_SWITCH}') is not true then raise exception '${UNAVAILABLE}' using errcode = '42501';`);
    // The rest is the 20261108140100 start: administrator, verified session, shared demo guard, one period.
    for (const pin of ["(select auth.jwt() ->> 'aal') is distinct from 'aal2'", "not private.has_organization_role(org, array['admin'])",
      "hint = 'shared-demo-account'", "p_length_days not in (7, 14)", "on conflict (organization_id) do nothing", "'learning_period_started'"]) {
      expect(startBody, pin).toContain(pin);
    }
  });

  it("leaves end early, the practice history and undo as they were, so a running period keeps them", () => {
    for (const name of ["public.end_organization_learning_period_early", "public.list_my_learning_history", "public.undo_my_learning_action"]) {
      const definition = newest(name);
      expect(definition.file, name).not.toBe(FILE);
      expect(definition.source, name).not.toContain(LEARNING_PERIOD_SWITCH);
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period release hold on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-release-hold-proof" });
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
  const one = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
  };

  async function person(org, role) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, org.chapter, `Proof ${role}`]);
    if (role !== "member") {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org.id, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, org.chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  // The hold exactly as the migration leaves it; each test rolls back.
  beforeEach(async () => {
    await c.query("begin");
    const org = { id: randomUUID(), chapter: `learning-hold-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98317)", [org.chapter, org.id]);
    await c.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [org.chapter]);
    world = { org, admin: await person(org, "admin"), steward: await person(org, "steward"), member: await person(org, "member") };
  });
  afterEach(async () => { await c.query("rollback"); });

  const setRelease = (at) => c.query("update public.platform_setting_definitions set release_at = $2 where key = $1", [LEARNING_PERIOD_SWITCH, at]);
  const read = (user) => one("select public.get_organization_learning_period() as r", [], user);
  const start = (user, days = 14) => call("select public.start_organization_learning_period($1) as r", [days], user);
  const periods = async () => (await c.query("select count(*)::int as n from private.organization_learning_periods where organization_id = $1", [world.org.id])).rows[0].n;

  it("creates the switch held, platform-only and default on, off for every organization and out of the admin list", async () => {
    expect((await c.query(`select value_kind, default_value, member_visible, organization_editable, category, release_at::text as release_at
      from public.platform_setting_definitions where key = $1`, [LEARNING_PERIOD_SWITCH])).rows).toEqual([{
      value_kind: "boolean", default_value: true, member_visible: false, organization_editable: false, category: "guidance_onboarding", release_at: "infinity",
    }]);
    expect((await c.query("select private.organization_feature_enabled($1, $2) as on", [world.org.id, LEARNING_PERIOD_SWITCH])).rows[0].on).toBe(false);
    const settings = (await one("select public.get_admin_organization_configuration() as r", [], world.admin)).settings;
    expect(settings.some((item) => item.key === LEARNING_PERIOD_SWITCH)).toBe(false);
  });

  it("offers nothing and refuses a start while held, to every member and on every length", async () => {
    for (const user of [world.admin, world.steward, world.member]) expect(await read(user)).toBeNull();
    for (const days of [14, 7]) {
      expect(await start(world.admin, days)).toMatchObject({ ok: false, code: "42501", message: UNAVAILABLE });
    }
    // Who may start is checked first, exactly as before.
    expect(await start(world.steward)).toMatchObject({ ok: false, code: "42501", message: "admin role with verified sign-in required" });
    expect(await periods()).toBe(0);
    expect((await c.query("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1 and entity_type = 'learning_period'", [world.org.id])).rows[0].n).toBe(0);
  });

  it("keeps a period that was already running, with its history, undo and end early, until it ends", async () => {
    await setRelease(null);
    expect(await one("select public.start_organization_learning_period() as r", [], world.admin)).toMatchObject({ running: true });
    const task = (await call("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Practice task" })], world.steward)).rows[0];
    await setRelease("infinity");

    for (const user of [world.admin, world.steward, world.member]) {
      expect(await read(user)).toMatchObject({ organizationId: world.org.id, used: true, running: true });
    }
    expect(await read(world.admin)).toMatchObject({ isAdmin: true });
    const history = await one("select public.list_my_learning_history() as r", [], world.steward);
    expect(history.running).toBe(true);
    expect(history.entries).toEqual([expect.objectContaining({ actionKind: "task_create", targetId: task.id, state: "active", undoable: true })]);
    expect(await one("select public.undo_my_learning_action($1, $2) as r", [history.entries[0].id, history.entries[0].version], world.steward))
      .toMatchObject({ status: "undone", undoneCount: 1 });
    expect((await c.query("select deleted_at is not null as deleted from public.chapter_tasks where id = $1", [task.id])).rows[0].deleted).toBe(true);
    // The hold still refuses a start while this period runs.
    expect(await start(world.admin)).toMatchObject({ ok: false, code: "42501", message: UNAVAILABLE });

    expect(await one("select public.end_organization_learning_period_early() as r", [], world.admin)).toMatchObject({ running: false });
    // Ended while held: nothing to show until the release.
    expect(await read(world.admin)).toBeNull();
    await setRelease(null);
    expect(await read(world.admin)).toMatchObject({ used: true, running: false });
  });

  it("behaves as before once the release time passes, with no further change", async () => {
    await c.query("update public.platform_setting_definitions set release_at = now() - interval '1 second' where key = $1", [LEARNING_PERIOD_SWITCH]);
    expect((await c.query("select private.organization_feature_enabled($1, $2) as on", [world.org.id, LEARNING_PERIOD_SWITCH])).rows[0].on).toBe(true);
    expect(await read(world.admin)).toMatchObject({ organizationId: world.org.id, used: false, running: false, isAdmin: true });
    expect(await read(world.member)).toMatchObject({ used: false, isAdmin: false });
    expect(await one("select public.start_organization_learning_period(7) as r", [], world.admin)).toMatchObject({ used: true, running: true, lengthDays: 7 });
    expect(await start(world.admin)).toMatchObject({ ok: false, code: "55000", message: "learning period already used" });
    expect(await periods()).toBe(1);
  });
});
