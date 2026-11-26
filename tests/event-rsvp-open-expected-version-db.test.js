// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-EVENTS-20261103 (#6944), gate finding r4s1
// on #7029. The edit form saves the fields, then switches RSVP collection in a
// second request. A switch already on its way when an undo landed used to
// commit anyway and put back the value the undo took away. 20261106120000
// gives the switch an expected version with the agenda setter's semantics.
// Against the earlier body the live cases fail: the switch takes no
// p_expected_version, so the stale switch is not refused.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261106120000_event_rsvp_open_expected_version.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);

describe("RSVP switch expected version migration (offline)", () => {
  it("refuses a stale version like the agenda setter, still journals, and leaves one signature", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const source = parseFunctions(sql).find((fn) => fn.name === "public.set_member_event_rsvp_open").source;
    expect(helperFirst(source)).toBe(true);
    expect(code).toContain("create or replace function public.set_member_event_rsvp_open(p_id text, p_open boolean, p_expected_version integer default null)");
    expect(source).toContain("p_expected_version is not null and ev.version is distinct from p_expected_version");
    expect(source).toContain("detail = 'event_changed'");
    expect(source).toContain("private.learning_event_journal('event_edit'");
    expect(source).toContain("not private.mfa_satisfied()");
    // The version check comes after the row lock and before any write.
    expect(source.indexOf("for update")).toBeLessThan(source.indexOf("p_expected_version is not null"));
    expect(source.indexOf("p_expected_version is not null")).toBeLessThan(source.indexOf("update public.member_events"));
    expect(code).toContain("revoke all on function public.set_member_event_rsvp_open(text, boolean, integer) from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.set_member_event_rsvp_open(text, boolean, integer) to authenticated;");
    expect(code).toContain("drop function public.set_member_event_rsvp_open(text, boolean);");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("RSVP switch expected version on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "event-rsvp-open-expected-version-proof" });
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
      return { ok: false, code: error.code, message: error.message, detail: error.detail };
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

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const org = { id: randomUUID(), chapter: `rsvp-version-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98318)", [org.chapter, org.id]);
    world = { org, admin: await person(org, "admin"), steward: await person(org, "steward") };
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], world.admin);
  const eventId = () => `proof-${randomUUID().slice(0, 12)}`;
  const createEvent = (id) => one(
    "select public.create_member_event($1, 'Practice meeting', now() + interval '3 days', 'Hall B', 'A fictional meeting', null, false, false) as r",
    [id], world.steward);
  const update = (id, title, version) => call(
    "select public.update_member_event(p_id => $1, p_title => $2, p_expected_version => $3) as r", [id, title, version], world.steward);
  const toggle = (id, open, version) => call(
    "select public.set_member_event_rsvp_open(p_id => $1, p_open => $2, p_expected_version => $3) as r", [id, open, version], world.steward);
  const state = async (id) => (await c.query("select rsvp_open, version from public.member_events where id = $1", [id])).rows[0];
  const editEntries = async (id) => (await c.query(
    "select id, state from private.learning_action_journal where target_table = 'public.member_events' and target_id = $1 and action_kind = 'event_edit' order by created_at, id", [id])).rows;
  const undo = (entry) => call("select public.undo_my_learning_action($1, 1) as r", [entry], world.steward);

  it("refuses a switch that waited behind an undo, and a fresh read switches and returns its version", async () => {
    const id = eventId();
    await createEvent(id);
    await start();
    // Tab A saves unchanged fields at version 1; its switch is still on the way.
    expect(await update(id, "Practice meeting", 1)).toMatchObject({ ok: true, rows: [{ r: { version: 1 } }] });
    // Tab B closes RSVPs and undoes that, so collection is open again.
    expect(await toggle(id, false, 1)).toMatchObject({ ok: true, rows: [{ r: { updated: true, rsvpOpen: false, version: 2 } }] });
    const [closed] = await editEntries(id);
    expect(closed).toMatchObject({ state: "active" });
    expect(await undo(closed.id)).toMatchObject({ ok: true });
    expect(await state(id)).toEqual({ rsvp_open: true, version: 3 });
    // Tab A's switch arrives with the version its update left.
    expect(await toggle(id, false, 1)).toMatchObject({ ok: false, code: "PT409", detail: "event_changed" });
    expect(await state(id)).toEqual({ rsvp_open: true, version: 3 });
    expect(await editEntries(id)).toHaveLength(1);
    // A fresh read switches.
    expect(await toggle(id, false, 3)).toMatchObject({ ok: true, rows: [{ r: { updated: true, version: 4 } }] });
    // An unchanged switch at the current version reports no change and the same version.
    expect(await toggle(id, false, 4)).toMatchObject({ ok: true, rows: [{ r: { updated: false, version: 4 } }] });
  });

  it("keeps one signature, callable without a version, and closed to anonymous callers", async () => {
    const id = eventId();
    await createEvent(id);
    expect((await c.query("select to_regprocedure('public.set_member_event_rsvp_open(text, boolean)') as old, to_regprocedure('public.set_member_event_rsvp_open(text, boolean, integer)') is not null as new")).rows[0])
      .toEqual({ old: null, new: true });
    expect(await call("select public.set_member_event_rsvp_open($1, false) as r", [id], world.steward)).toMatchObject({ ok: true, rows: [{ r: { updated: true, version: 2 } }] });
    expect(await call("select public.set_member_event_rsvp_open($1, true, 2) as r", [id], null)).toMatchObject({ ok: false, code: "42501" });
  });
});
