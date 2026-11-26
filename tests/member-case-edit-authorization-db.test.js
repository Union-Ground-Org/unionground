// @vitest-environment node
//
// BUG-UG-MEMBER-CAN-RESOLVE-OWN-CASE-AND-MOVE-ITS-DEADLINE-20261110:
// public.update_my_member_case keeps the member's own status, deadline and
// step edit only on a member-only case. A case with an assigned steward or
// coordinator, or one an organization procedure resolves for, is refused with
// 42501 and no row change when called straight from the API, while the
// coordinator's own path still moves it. The learning-period undo of the
// member's own earlier edit is refused on such a case the same way.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = readdirSync("supabase/migrations").filter((name) => name.endsWith("_member_case_edit_unassigned_only.sql")).sort().at(-1);
const code = stripComments(readFileSync(`supabase/migrations/${FILE}`, "utf8"));

describe("member case edit authorization migration (offline)", () => {
  it("refuses an assigned or procedure case after the ownership check and before any write", () => {
    const refusal = code.indexOf("raise exception 'case is managed by its representative' using errcode = '42501'");
    expect(refusal).toBeGreaterThan(code.indexOf("raise exception 'case unavailable'"));
    expect(refusal).toBeLessThan(code.indexOf("update public.member_cases"));
    for (const clause of ["case_row.steward_user_id is not null", "case_row.coordinator_user_id is not null",
      "pg_catalog.btrim(coalesce(case_row.steward_name, '')) <> ''", "pg_catalog.btrim(coalesce(case_row.coordinator_name, '')) <> ''",
      "private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null"]) {
      expect(code).toContain(clause);
    }
    expect(code).toContain("grant execute on function public.update_my_member_case(uuid, text, date, text) to authenticated;");
    expect(code).toContain("create function private.member_case_managed(case_row public.member_cases)");
    expect(code).toContain("grant execute on function public.get_my_member_case_managed(uuid) to authenticated;");
    expect(code).not.toMatch(/grant execute on function private\.member_case_managed/);
    const undo = code.slice(code.indexOf("create or replace function private.learning_undo_case("));
    expect(undo).toContain("and created.action_kind = 'case_create'");
    expect(undo.indexOf("if p_entry ->> 'action_kind' = 'case_edit' and not private.casework_staff_can_access(case_row.id)"))
      .toBeGreaterThan(undo.indexOf("raise exception 'you can no longer change this case'"));
    expect(code.match(/^begin;$/gm)).toHaveLength(1);
    expect(code.match(/^commit;$/gm)).toHaveLength(1);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member case edit authorization on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "member-case-edit-authorization-proof" });
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

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const org = { id: randomUUID(), chapter: `member-case-edit-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98319)", [org.chapter, org.id]);
    world = { org, admin: await person(org, "admin"), coordinator: await person(org, "coordinator"), member: await person(org, "member") };
  });
  afterEach(async () => { await c.query("rollback"); });

  const openCase = async () => {
    const id = (await one("select public.create_member_case('Overtime past the cap', null, 'Scheduling', '') as r", [], world.member)).caseId;
    await c.query("update public.member_cases set deadline = '2026-11-27', step = 'Investigation' where id = $1", [id]);
    return id;
  };
  const caseRow = async (id) => (await c.query("select status, deadline::text as deadline, step from public.member_cases where id = $1", [id])).rows[0];
  const edits = async (id) => Number((await c.query("select count(*) from private.learning_action_journal where target_table = 'public.member_cases' and target_id = $1 and action_kind = 'case_edit'", [id])).rows[0].count);
  const memberEdit = (id, step = null) => call("select public.update_my_member_case($1, 'resolved', '2026-12-31', $2) as r", [id, step], world.member);
  const unchanged = { status: "active", deadline: "2026-11-27", step: "Investigation" };

  it("keeps the member's edit of status, deadline and step on a member-only case", async () => {
    const id = await openCase();
    expect(await one("select public.update_my_member_case($1, 'resolved', '2026-12-31', 'Step 2') as r", [id], world.member))
      .toMatchObject({ id, status: "resolved", deadline: "2026-12-31", step: "Step 2" });
    expect(await caseRow(id)).toEqual({ status: "resolved", deadline: "2026-12-31", step: "Step 2" });
  });

  it("refuses the member on a case with an assigned steward and coordinator and changes nothing", async () => {
    const id = await openCase();
    await c.query("update public.member_cases set steward_user_id = $2, steward_name = 'Proof steward', coordinator_user_id = $2, coordinator_name = 'Proof coordinator', assigned_at = now() where id = $1", [id, world.coordinator.id]);
    const before = await edits(id);
    expect(await memberEdit(id)).toMatchObject({ ok: false, code: "42501", message: "case is managed by its representative" });
    expect(await memberEdit(id, "Closed")).toMatchObject({ ok: false, code: "42501" });
    // The same values the case already holds are refused too: the edit path is closed, not filtered.
    expect(await call("select public.update_my_member_case($1, 'active', '2026-11-27') as r", [id], world.member)).toMatchObject({ ok: false, code: "42501" });
    expect(await caseRow(id)).toEqual(unchanged);
    expect(await edits(id)).toBe(before);
  });

  it("refuses the member when only a steward account, or only a stamped coordinator name, marks the assignment", async () => {
    const steward = await openCase();
    const managed = (id, user = world.member) => call("select public.get_my_member_case_managed($1) as r", [id], user);
    expect(await managed(steward)).toMatchObject({ ok: true, rows: [{ r: false }] });
    await c.query("update public.member_cases set steward_user_id = $2 where id = $1", [steward, world.coordinator.id]);
    // The case window asks the server, so an account-only assignment is read-only there too.
    expect(await managed(steward)).toMatchObject({ ok: true, rows: [{ r: true }] });
    expect(await managed(steward, world.coordinator)).toMatchObject({ ok: false, code: "42501" });
    expect(await memberEdit(steward)).toMatchObject({ ok: false, code: "42501" });
    expect(await caseRow(steward)).toEqual(unchanged);
    const named = await openCase();
    await c.query("update public.member_cases set coordinator_name = 'Proof coordinator' where id = $1", [named]);
    expect(await memberEdit(named)).toMatchObject({ ok: false, code: "42501" });
    expect(await caseRow(named)).toEqual(unchanged);
  });

  it("refuses the member on an unassigned case an organization procedure resolves for", async () => {
    const id = await openCase();
    await c.query("insert into public.casework_procedures(organization_id, name, created_by) values ($1, 'Proof procedure', $2)", [world.org.id, world.coordinator.id]);
    expect(await memberEdit(id)).toMatchObject({ ok: false, code: "42501", message: "case is managed by its representative" });
    expect(await caseRow(id)).toEqual(unchanged);
  });

  it("still lets the coordinator change status and deadline on the assigned case", async () => {
    const id = await openCase();
    await c.query("update public.member_cases set coordinator_user_id = $2, coordinator_name = 'Proof coordinator', assigned_at = now() where id = $1", [id, world.coordinator.id]);
    expect(await memberEdit(id)).toMatchObject({ ok: false, code: "42501" });
    expect(await one("select public.coordinator_update_case($1, 'resolved', null, '2026-12-15', 'Settled at step 1') as r", [id], world.coordinator))
      .toMatchObject({ id, status: "resolved", deadline: "2026-12-15" });
    expect(await caseRow(id)).toEqual({ status: "resolved", deadline: "2026-12-15", step: "Investigation" });
  });

  it("refuses the member's learning-period undo of their own earlier edit once the case is assigned", async () => {
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    const id = await openCase();
    await one("select public.update_my_member_case($1, 'resolved', '2026-12-31') as r", [id], world.member);
    const [entry] = (await c.query("select id from private.learning_action_journal where target_table = 'public.member_cases' and target_id = $1 and action_kind = 'case_edit' order by created_at desc, id desc limit 1", [id])).rows;
    expect(entry).toBeDefined();
    await c.query("update public.member_cases set coordinator_user_id = $2, coordinator_name = 'Proof coordinator', assigned_at = now() where id = $1", [id, world.coordinator.id]);
    expect(await call("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.member)).toMatchObject({ ok: false, code: "42501" });
    expect(await caseRow(id)).toEqual({ status: "resolved", deadline: "2026-12-31", step: "Investigation" });
  });

  // Undoing your own self-intake undoes its later
  // details edit in the same chain; under a procedure that edit must not be
  // refused, because the whole case goes. A standalone edit undo still is.
  it("lets the member undo their own self-intake with details under a procedure, and still refuses a standalone edit undo", async () => {
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    await c.query("insert into public.casework_procedures(organization_id, name, created_by) values ($1, 'Proof procedure', $2)", [world.org.id, world.coordinator.id]);
    const created = await one("select public.open_member_case(null, 'Van without air conditioning', 'Safety', '', null, 'Route nine ran without air conditioning all week.', null, null, null, false) as r", [], world.member);
    const id = created.caseId;
    const journal = async (caseId) => (await c.query("select id, action_kind from private.learning_action_journal where target_table = 'public.member_cases' and target_id = $1 order by created_at, id", [caseId])).rows;
    expect((await journal(id)).map((row) => row.action_kind)).toEqual(["case_create", "case_edit"]);
    const [creation] = await journal(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [creation.id], world.member)).toMatchObject({ status: "undone" });
    expect((await c.query("select learning_undone_at is not null as undone from public.member_cases where id = $1", [id])).rows[0].undone).toBe(true);

    await c.query("delete from public.casework_procedures where organization_id = $1", [world.org.id]);
    const other = await openCase();
    await one("select public.update_my_member_case($1, 'resolved', '2026-12-31') as r", [other], world.member);
    const edit = (await journal(other)).find((row) => row.action_kind === "case_edit");
    await c.query("insert into public.casework_procedures(organization_id, name, created_by) values ($1, 'Proof procedure', $2)", [world.org.id, world.coordinator.id]);
    expect(await call("select public.undo_my_learning_action($1, 1) as r", [edit.id], world.member)).toMatchObject({ ok: false, code: "42501" });
    expect(await caseRow(other)).toEqual({ status: "resolved", deadline: "2026-12-31", step: "Investigation" });
  });
});
