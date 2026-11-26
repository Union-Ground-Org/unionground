// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103 (#6943),
// slice 4 of #6805: a person's own case assignment, explicit access and
// restriction changes during the learning period are journalled and undone
// to their earlier state, and no undo widens access beyond what that person
// could grant at undo time, including after their own role was reduced. A
// reassignment undo is refused once someone else reassigned. The assignment
// audit and the case access audit rows only grow. Retaliation reports and
// pattern notes are recorded and kept.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261104120000_learning_period_case_access_assignment.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const WRITERS = {
  "public.assign_member_case": "case_assign",
  "public.claim_member_case": "case_claim",
  "public.casework_grant_access": "case_access_grant",
  "public.casework_revoke_access": "case_access_revoke",
  "public.casework_set_restriction": "case_restriction",
  "public.casework_submit_retaliation_report": "retaliation_report_submit",
  "public.casework_withdraw_retaliation_report": "retaliation_report_withdraw",
  "public.casework_review_retaliation_pattern": "retaliation_pattern_note",
};
const HANDLERS = ["private.learning_undo_case_assignment", "private.learning_undo_case_access", "private.learning_undo_case_restriction"];

describe("learning period case access and assignment migration (offline)", () => {
  it("journals every writer with the graph lock first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const [name, kind] of Object.entries(WRITERS)) {
      const source = functions.find((fn) => fn.name === name)?.source;
      expect(source, name).toBeDefined();
      expect(helperFirst(source), name).toBe(true);
      expect(source, name).toMatch(new RegExp(`private\\.learning_journal_append\\(\\s*'${kind}'`));
    }
    for (const name of HANDLERS) expect(helperFirst(functions.find((fn) => fn.name === name).source), name).toBe(true);
  });

  it("dispatches its handlers, hands every other one to the installed dispatcher, and never touches an audit row", () => {
    const dispatch = parseFunctions(sql).find((fn) => fn.name === "private.learning_dispatch").source;
    for (const name of HANDLERS) expect(dispatch).toContain(`when '${name}' then return ${name}(p_mode, p_entry);`);
    expect(code).toContain("alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_case_access;");
    expect(dispatch).toContain("else return private.learning_dispatch_before_case_access(p_handler, p_mode, p_entry);");
    expect(code).not.toMatch(/(update|delete from)\s+public\.(organization_audit_ledger|organization_audit_events|member_case_assignment_audit|casework_audit_events)\b/);
    expect(code).not.toMatch(/delete from public\.(member_cases|casework_access_grants|casework_retaliation_reports)\b/);
  });

  it("records retaliation reports and pattern notes as kept, never as practice", () => {
    for (const kind of ["retaliation_report_submit", "retaliation_report_withdraw", "retaliation_pattern_note"]) {
      expect(code).toMatch(new RegExp(`\\('${kind}', 'case_access', 'permanent', '[a-z_.]+', false, null,`));
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period case access and assignment on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-case-access-proof" });
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
      return { ok: false, code: error.code, detail: error.detail, message: error.message };
    }
  }
  const one = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
  };

  async function person(org, roles, name) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, org.chapter, name]);
    for (const role of roles) {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org.id, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, org.chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    // Retain this historical broad fixture grant.
    if (roles.includes("steward")) await migrateLegacyStewardFixtures(c);
    return user;
  }
  const demote = async (user) => {
    await c.query("delete from public.member_roles where user_id = $1", [user.id]);
    await c.query("delete from public.organization_role_grants where user_id = $1", [user.id]);
  };
  async function newCase(fields = {}) {
    const id = randomUUID();
    const f = { steward: null, coordinator: null, restricted: false, restrictedBy: null, ...fields };
    await c.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status,
         steward_user_id,steward_name,coordinator_user_id,coordinator_name,assigned_at,
         is_restricted,restriction_reason,restricted_at,restricted_by)
       values ($1,$2,$3,$3,'other',$4,$5,'active',$6,$7,$8,$9,case when $6::uuid is null and $8::uuid is null then null else now() end,
         $10,case when $10 then 'Witness statements are sensitive' end,case when $10 then now() end,$11)`,
      [id, world.member.id, `LP-ACCESS-${id.slice(0, 8)}`, world.org.id, world.org.chapter,
        f.steward?.id ?? null, f.steward ? "Proof steward" : null, f.coordinator?.id ?? null, f.coordinator ? "Proof coordinator" : null,
        f.restricted, f.restricted ? f.restrictedBy?.id ?? null : null]);
    return id;
  }

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const org = { id: randomUUID(), chapter: `learning-access-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98319)", [org.chapter, org.id]);
    world = { org };
    world.admin = await person(org, ["admin"], "Proof admin");
    world.coordinator = await person(org, ["coordinator"], "Proof coordinator");
    world.otherCoordinator = await person(org, ["coordinator"], "Proof other coordinator");
    world.grantee = await person(org, ["coordinator"], "Proof grantee");
    world.steward = await person(org, ["steward"], "Proof steward");
    world.otherSteward = await person(org, ["steward"], "Proof other steward");
    world.member = await person(org, [], "Proof member");
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], world.admin);
  const entries = async (table, id) => (await c.query("select id, action_kind, state, version, before_image, after_fingerprint from private.learning_action_journal where target_table = $1 and target_id = $2 order by created_at, id", [table, id])).rows;
  const assignmentEntries = (id) => entries("public.member_case_assignment_audit", id);
  const accessEntries = (caseId, grantee = world.grantee) => entries("public.casework_access_grants", `${caseId}:${grantee.id}`);
  // Runs owner SQL with every trigger and foreign key check off, the way an
  // account deletion's detachment or a later cleanup leaves rows.
  const raw = async (text, values = []) => {
    await c.query("set local session_replication_role = replica");
    await c.query(text, values);
    await c.query("set local session_replication_role = origin");
  };
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const assign = (user, caseId, steward, coordinator = "00000000-0000-0000-0000-000000000000") =>
    call("select public.assign_member_case($1, $2, $3)", [caseId, steward, coordinator], user);
  const assignment = async (id) => (await c.query("select steward_user_id, coordinator_user_id from public.member_cases where id = $1", [id])).rows[0];
  const assignmentAudit = async (id) => (await c.query("select id, actor_id, before_assignment, after_assignment, created_at::text from public.member_case_assignment_audit where case_id = $1 order by id", [id])).rows;
  const accessAudit = async (id) => (await c.query("select id, actor_user_id, event_type, entity_id, metadata, created_at::text from public.casework_audit_events where case_id = $1 order by id", [id])).rows;
  const grants = async (id) => (await c.query("select id, grantee_user_id, granted_by, revoked_by, reason, revoked_at is null as active from public.casework_access_grants where case_id = $1 order by revoked_at is null, granted_at, id", [id])).rows;
  const sees = async (user, id) => await one("select count(*)::int as n from public.member_cases where id = $1", [id], user);
  const restriction = async (id) => (await c.query("select is_restricted, restriction_reason, restricted_by from public.member_cases where id = $1", [id])).rows[0];
  const versions = async (id) => (await c.query("select count(*)::int as n from private.casework_record_versions where record_table = 'member_cases' and record_id = $1", [id])).rows[0].n;
  // Every earlier audit row is still there, unchanged, and at least one more follows.
  const grewFrom = (before, after) => {
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
  };

  it("journals nothing while no learning period runs", async () => {
    const id = await newCase();
    expect(await assign(world.coordinator, id, world.steward.id)).toMatchObject({ ok: true });
    expect(await assignmentEntries(id)).toEqual([]);
    expect((await c.query("select count(*)::int as n from private.learning_action_journal where organization_id = $1", [world.org.id])).rows[0].n).toBe(0);
  });

  it("undoes a reassignment to the earlier steward and only adds assignment audit rows", async () => {
    const id = await newCase({ steward: world.steward });
    await start();
    expect(await assign(world.coordinator, id, world.otherSteward.id)).toMatchObject({ ok: true });
    const [entry] = await assignmentEntries(id);
    expect(entry).toMatchObject({ action_kind: "case_assign", state: "active",
      before_image: { steward_user_id: world.steward.id, coordinator_user_id: null } });
    const before = await assignmentAudit(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.coordinator)).toMatchObject({ status: "undone", undoneCount: 1 });
    expect(await assignment(id)).toEqual({ steward_user_id: world.steward.id, coordinator_user_id: null });
    const after = await assignmentAudit(id);
    grewFrom(before, after);
    expect(after.at(-1)).toMatchObject({ actor_id: world.coordinator.id,
      before_assignment: { stewardUserId: world.otherSteward.id }, after_assignment: { stewardUserId: world.steward.id, stewardName: "Proof steward" } });
    // Repeat undo is idempotent and changes nothing.
    expect(await one("select public.undo_my_learning_action($1, 2) as r", [entry.id], world.coordinator)).toMatchObject({ status: "already_undone" });
    expect(await assignmentAudit(id)).toEqual(after);
  });

  it("refuses a reassignment undo once someone else reassigned the case", async () => {
    const id = await newCase();
    await start();
    expect(await assign(world.coordinator, id, world.steward.id)).toMatchObject({ ok: true });
    const [mine] = await assignmentEntries(id);
    expect(await assign(world.otherCoordinator, id, world.otherSteward.id)).toMatchObject({ ok: true });
    const before = await assignmentAudit(id);
    expect(await undo(world.coordinator, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await assignment(id)).toMatchObject({ steward_user_id: world.otherSteward.id });
    expect(await assignmentAudit(id)).toEqual(before);
    expect((await assignmentEntries(id))[0]).toMatchObject({ id: mine.id, state: "active" });
  });

  it("refuses a reassignment undo when the current steward was changed outside the journal", async () => {
    const id = await newCase();
    await start();
    expect(await assign(world.coordinator, id, world.steward.id)).toMatchObject({ ok: true });
    const [mine] = await assignmentEntries(id);
    await c.query("update public.member_cases set steward_user_id = $2, steward_name = 'Proof other steward' where id = $1", [id, world.otherSteward.id]);
    expect(await undo(world.coordinator, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await assignment(id)).toMatchObject({ steward_user_id: world.otherSteward.id });
  });

  it("never puts back a steward who can no longer be assigned, and refuses once the person's own role was reduced", async () => {
    const id = await newCase({ steward: world.steward });
    await start();
    expect(await assign(world.coordinator, id, world.otherSteward.id)).toMatchObject({ ok: true });
    const [entry] = await assignmentEntries(id);
    await demote(world.steward);
    expect(await undo(world.coordinator, entry.id)).toMatchObject({ ok: false, code: "42501" });
    expect(await assignment(id)).toMatchObject({ steward_user_id: world.otherSteward.id });

    const second = await newCase();
    expect(await assign(world.coordinator, second, world.otherSteward.id)).toMatchObject({ ok: true });
    const [own] = await assignmentEntries(second);
    await demote(world.coordinator);
    expect(await undo(world.coordinator, own.id)).toMatchObject({ ok: false, code: "42501" });
    expect(await assignment(second)).toMatchObject({ steward_user_id: world.otherSteward.id });
  });

  it("undoes a steward's claim by releasing the case", async () => {
    const id = await newCase();
    await start();
    expect(await call("select public.claim_member_case($1) as r", [id], world.steward)).toMatchObject({ ok: true });
    const [entry] = await assignmentEntries(id);
    expect(entry).toMatchObject({ action_kind: "case_claim", state: "active" });
    const before = await assignmentAudit(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.steward)).toMatchObject({ status: "undone" });
    expect(await assignment(id)).toEqual({ steward_user_id: null, coordinator_user_id: null });
    grewFrom(before, await assignmentAudit(id));
  });

  it("undoes a grant by taking the access away again; the grant row and its audit rows stay", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    await start();
    expect(await sees(world.grantee, id)).toBe(0);
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    expect(await sees(world.grantee, id)).toBe(1);
    const [grant] = await grants(id);
    const [entry] = await accessEntries(id);
    expect(entry).toMatchObject({ action_kind: "case_access_grant", state: "active", before_image: { active_grant_id: null } });
    expect((await c.query("select flag from private.learning_practice_flags('public.casework_access_grants', array[$1::text])", [`${id}:${world.grantee.id}`])).rows).toEqual([{ flag: "practice_edit" }]);
    const before = await accessAudit(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await sees(world.grantee, id)).toBe(0);
    expect(await grants(id)).toEqual([{ ...grant, active: false, revoked_by: world.coordinator.id }]);
    const after = await accessAudit(id);
    grewFrom(before, after);
    expect(after.at(-1)).toMatchObject({ event_type: "access_revoked", entity_id: grant.id, metadata: { granteeUserId: world.grantee.id } });
  });

  it("undoes a revoke by giving the same grant back, only to someone the person could grant it to now", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    await start();
    const [grant] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [grant.id], world.coordinator)).toMatchObject({ ok: true });
    expect(await sees(world.grantee, id)).toBe(0);
    const [entry] = await accessEntries(id);
    expect(entry).toMatchObject({ action_kind: "case_access_revoke", before_image: { active_grant_id: grant.id } });
    const before = await accessAudit(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await sees(world.grantee, id)).toBe(1);
    expect(await grants(id)).toEqual([{ ...grant, active: true, revoked_by: null }]);
    const after = await accessAudit(id);
    grewFrom(before, after);
    expect(after.slice(-2).map((row) => [row.event_type, row.entity_id])).toEqual([["access_revoked", grant.id], ["access_granted", grant.id]]);
    // The grant row's case history keeps the revoke and the reactivation.
    expect((await c.query("select count(*)::int as n from private.casework_record_versions where record_table = 'casework_access_grants' and record_id = $1", [grant.id])).rows[0].n).toBeGreaterThanOrEqual(3);
  });

  // #7033 final round 2.
  it("undoes an own grant after undoing its revoke, both in the same period (S1)", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    await start();
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    const [grant] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [grant.id], world.coordinator)).toMatchObject({ ok: true });
    const [granted, revoked] = await accessEntries(id);
    expect([granted.action_kind, revoked.action_kind]).toEqual(["case_access_grant", "case_access_revoke"]);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [revoked.id], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await sees(world.grantee, id)).toBe(1);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [granted.id], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await sees(world.grantee, id)).toBe(0);
    expect(await grants(id)).toEqual([{ ...grant, active: false, revoked_by: world.coordinator.id }]);
  });

  it("refuses to undo a restriction once someone working in another organization lifted and reapplied it unjournalled (S2)", async () => {
    const other = { id: randomUUID(), chapter: `learning-access-other-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [other.id, other.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98321)", [other.chapter, other.id]);
    const visitor = await person(world.org, ["steward"], "Proof visiting coordinator");
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [other.id, visitor.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [visitor.id, other.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [visitor.id, other.chapter]);
    const id = await newCase({ coordinator: visitor });
    await start();
    expect(await call("select public.casework_set_restriction($1, true, 'Witness statements are sensitive') as r", [id], world.admin)).toMatchObject({ ok: true });
    const [mine] = await entries("private.learning_case_restriction", id);
    // The visitor's own selected organization runs no period: both changes are real and unjournalled.
    expect(await call("select public.casework_set_restriction($1, false, null) as r", [id], visitor)).toMatchObject({ ok: true });
    expect(await call("select public.casework_set_restriction($1, true, 'Witness statements are sensitive') as r", [id], visitor)).toMatchObject({ ok: true });
    expect(await entries("private.learning_case_restriction", id)).toHaveLength(1);
    expect(await undo(world.admin, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await restriction(id)).toMatchObject({ is_restricted: true, restricted_by: visitor.id });
  });

  it("refuses an assignment undo once someone else reassigned and put it back (S2, assignment facet)", async () => {
    const id = await newCase();
    await start();
    expect(await assign(world.coordinator, id, world.steward.id)).toMatchObject({ ok: true });
    const [mine] = await assignmentEntries(id);
    expect(await assign(world.otherCoordinator, id, world.otherSteward.id)).toMatchObject({ ok: true });
    const [, theirs] = await assignmentEntries(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [theirs.id], world.otherCoordinator)).toMatchObject({ status: "undone" });
    expect(await assignment(id)).toMatchObject({ steward_user_id: world.steward.id });
    expect(await undo(world.coordinator, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await assignment(id)).toMatchObject({ steward_user_id: world.steward.id });
  });

  it("refuses to undo a revoke after the person's own role was reduced, or once the grantee can no longer be granted access", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    await start();
    const [grant] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [grant.id], world.coordinator)).toMatchObject({ ok: true });
    const [entry] = await accessEntries(id);
    const before = await accessAudit(id);

    await demote(world.grantee);
    expect(await undo(world.coordinator, entry.id)).toMatchObject({ ok: false, code: "22023" });
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'coordinator',$2)", [world.org.id, world.grantee.id]);
    await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'coordinator',$2)", [world.grantee.id, world.org.chapter]);

    await demote(world.coordinator);
    expect(await undo(world.coordinator, entry.id)).toMatchObject({ ok: false, code: "42501" });

    expect(await grants(id)).toEqual([{ ...grant, active: false, revoked_by: world.coordinator.id }]);
    expect(await sees(world.grantee, id)).toBe(0);
    expect(await accessAudit(id)).toEqual(before);
    expect((await accessEntries(id))[0]).toMatchObject({ state: "active" });
  });

  it("refuses to undo a revoke once someone else granted the access again", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    await start();
    const [grant] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [grant.id], world.coordinator)).toMatchObject({ ok: true });
    const [entry] = await accessEntries(id);
    expect(await call("select public.casework_grant_access($1, $2, 'The admin needs a second look') as r", [id, world.grantee.id], world.admin)).toMatchObject({ ok: true });
    expect(await undo(world.coordinator, entry.id)).toMatchObject({ ok: false, code: "PT409" });
    expect((await grants(id)).filter((row) => row.active)).toHaveLength(1);
  });

  it("undoes restricting a case, and refuses once the person may no longer set its restriction", async () => {
    const id = await newCase({ coordinator: world.coordinator });
    await start();
    expect(await call("select public.casework_set_restriction($1, true, 'Witness statements are sensitive') as r", [id], world.coordinator)).toMatchObject({ ok: true });
    const [entry] = await entries("private.learning_case_restriction", id);
    expect(entry).toMatchObject({ action_kind: "case_restriction", before_image: { is_restricted: false, restriction_reason: null } });
    const audit = await accessAudit(id);
    const history = await versions(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await restriction(id)).toEqual({ is_restricted: false, restriction_reason: null, restricted_by: null });
    grewFrom(audit, await accessAudit(id));
    expect(await versions(id)).toBeGreaterThan(history);

    const second = await newCase({ coordinator: world.coordinator });
    expect(await call("select public.casework_set_restriction($1, true, 'Witness statements are sensitive') as r", [second], world.coordinator)).toMatchObject({ ok: true });
    const [own] = await entries("private.learning_case_restriction", second);
    await demote(world.coordinator);
    expect(await undo(world.coordinator, own.id)).toMatchObject({ ok: false, code: "42501" });
    expect(await restriction(second)).toMatchObject({ is_restricted: true });
  });

  it("undoes lifting a restriction by restoring the earlier one", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    await start();
    expect(await sees(world.otherCoordinator, id)).toBe(0);
    expect(await call("select public.casework_set_restriction($1, false, null) as r", [id], world.coordinator)).toMatchObject({ ok: true });
    expect(await sees(world.otherCoordinator, id)).toBe(1);
    const [entry] = await entries("private.learning_case_restriction", id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await restriction(id)).toEqual({ is_restricted: true, restriction_reason: "Witness statements are sensitive", restricted_by: world.coordinator.id });
    expect(await sees(world.otherCoordinator, id)).toBe(0);
  });

  // #7033 round 1.
  it("refuses to undo a revoke once someone else granted and revoked the access again through another grant row (r1s1)", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    await start();
    const [first] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [first.id], world.coordinator)).toMatchObject({ ok: true });
    const [mine] = await accessEntries(id);
    expect(await call("select public.casework_grant_access($1, $2, 'The admin needs a second look') as r", [id, world.grantee.id], world.admin)).toMatchObject({ ok: true });
    const second = (await grants(id)).find((row) => row.active);
    expect(await call("select public.casework_revoke_access($1) as r", [second.id], world.admin)).toMatchObject({ ok: true });
    const before = await grants(id);
    expect(await undo(world.coordinator, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await grants(id)).toEqual(before);
    expect(await sees(world.grantee, id)).toBe(0);
  });

  it("refuses to undo a revoke once the same access was granted and revoked by someone no period journals (r1s1, r2s1)", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    await start();
    const [first] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [first.id], world.coordinator)).toMatchObject({ ok: true });
    const [mine] = await accessEntries(id);
    // Exactly what an unjournalled grant and revoke by the administrator leaves:
    // the grant row and its two access audit rows, and no learning entry.
    const second = (await c.query(`insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason, revoked_at, revoked_by)
      values ($1, $2, $3, $4, $5, 'Covering the step 3 hearing', now(), $5) returning id`, [id, world.org.id, world.org.chapter, world.grantee.id, world.admin.id])).rows[0].id;
    for (const event of ["access_granted", "access_revoked"]) {
      await c.query(`insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
        values ($1, $2, $3, $4, $5, 'casework_access_grant', $6, jsonb_build_object('granteeUserId', $7::uuid))`,
        [world.org.id, world.org.chapter, id, world.admin.id, event, second, world.grantee.id]);
    }
    expect(await accessEntries(id)).toHaveLength(1);
    expect(await undo(world.coordinator, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await sees(world.grantee, id)).toBe(0);
  });

  // #7033 full final (r2s1).
  it("undoes an own revoke after separately undoing the grant made after it (r2s1)", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    await start();
    const [first] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [first.id], world.coordinator)).toMatchObject({ ok: true });
    expect(await call("select public.casework_grant_access($1, $2, 'Covering the step 3 hearing') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    const [revoked, granted] = await accessEntries(id);
    expect([revoked.action_kind, granted.action_kind]).toEqual(["case_access_revoke", "case_access_grant"]);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [granted.id], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await sees(world.grantee, id)).toBe(0);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [revoked.id], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await sees(world.grantee, id)).toBe(1);
    expect((await grants(id)).filter((row) => row.active).map((row) => row.id)).toEqual([first.id]);
  });

  it("undoes grant, revoke and grant again one by one, newest first (r2s1)", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    await start();
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    const [first] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [first.id], world.coordinator)).toMatchObject({ ok: true });
    expect(await call("select public.casework_grant_access($1, $2, 'Covering the step 3 hearing') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    const journal = await accessEntries(id);
    expect(journal.map((entry) => entry.action_kind)).toEqual(["case_access_grant", "case_access_revoke", "case_access_grant"]);
    for (const entry of [...journal].reverse()) {
      expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.coordinator)).toMatchObject({ status: "undone" });
    }
    expect(await sees(world.grantee, id)).toBe(0);
    expect((await grants(id)).filter((row) => row.active)).toEqual([]);
  });

  it("refuses to undo a revoke with PT409, not a duplicate grant, when an active grant has lost its granter (r1g2)", async () => {
    const id = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: world.coordinator });
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, world.grantee.id], world.coordinator)).toMatchObject({ ok: true });
    await start();
    const [first] = await grants(id);
    expect(await call("select public.casework_revoke_access($1) as r", [first.id], world.coordinator)).toMatchObject({ ok: true });
    const [mine] = await accessEntries(id);
    await c.query(`insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
      values ($1, $2, $3, $4, $5, 'Granted by an account later deleted')`, [id, world.org.id, world.org.chapter, world.grantee.id, world.admin.id]);
    await raw("update public.casework_access_grants set granted_by = null where case_id = $1 and revoked_at is null", [id]);
    expect(await undo(world.coordinator, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect((await grants(id)).filter((row) => row.active)).toHaveLength(1);
  });

  it("does not journal a change to a case of another organization, so no entry is left that could never be undone (r1s2)", async () => {
    const other = { id: randomUUID(), chapter: `learning-access-other-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [other.id, other.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98320)", [other.chapter, other.id]);
    const otherAdmin = await person(other, ["admin"], "Proof other admin");
    // A steward of this case's chapter who works in the other organization.
    const visitor = await person(world.org, ["steward"], "Proof visiting steward");
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [other.id, visitor.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [visitor.id, other.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [visitor.id, other.chapter]);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: visitor.id, session_id: visitor.session, aal: "aal2" })]);
    expect((await c.query("select private.current_mobile_staff_organization() as r")).rows[0].r).toBe(other.id);
    const id = await newCase({ steward: visitor, restricted: true, restrictedBy: world.coordinator });
    expect(await one("select public.start_organization_learning_period() as r", [], otherAdmin)).toMatchObject({ running: true });
    expect(await call("select public.casework_set_restriction($1, false, null) as r", [id], visitor)).toMatchObject({ ok: true });
    expect(await entries("private.learning_case_restriction", id)).toEqual([]);
    expect(await restriction(id)).toMatchObject({ is_restricted: false });
  });

  it("refuses to undo a claim that would lock the steward out of the case they restricted (r1g1)", async () => {
    const id = await newCase();
    await start();
    expect(await call("select public.claim_member_case($1) as r", [id], world.steward)).toMatchObject({ ok: true });
    expect(await call("select public.casework_set_restriction($1, true, 'Witness statements are sensitive') as r", [id], world.steward)).toMatchObject({ ok: true });
    const [claim] = await assignmentEntries(id);
    const audit = await assignmentAudit(id);
    expect(await undo(world.steward, claim.id)).toMatchObject({ ok: false, code: "22023", detail: "casework_restriction_self_lockout" });
    expect(await assignment(id)).toMatchObject({ steward_user_id: world.steward.id });
    expect(await assignmentAudit(id)).toEqual(audit);
    // Undoing the restriction first, then the claim, works.
    const [restricted] = await entries("private.learning_case_restriction", id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [restricted.id], world.steward)).toMatchObject({ status: "undone" });
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [claim.id], world.steward)).toMatchObject({ status: "undone" });
    expect(await assignment(id)).toMatchObject({ steward_user_id: null });
  });

  it("puts a restriction back under the person restoring it when its earlier author is gone (r1s3)", async () => {
    const author = await person(world.org, ["coordinator"], "Proof departed coordinator");
    const detached = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: author });
    await raw("update public.member_cases set restricted_by = null where id = $1", [detached]);
    const deleted = await newCase({ coordinator: world.coordinator, restricted: true, restrictedBy: author });
    await start();
    for (const id of [detached, deleted]) {
      expect(await call("select public.casework_set_restriction($1, false, null) as r", [id], world.coordinator)).toMatchObject({ ok: true });
    }
    // The author's account goes after the lift, so the second before-image names a deleted user.
    await raw("delete from auth.users where id = $1", [author.id]);
    for (const id of [detached, deleted]) {
      const [entry] = await entries("private.learning_case_restriction", id);
      expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry.id], world.coordinator)).toMatchObject({ status: "undone" });
      expect(await restriction(id)).toEqual({ is_restricted: true, restriction_reason: "Witness statements are sensitive", restricted_by: world.coordinator.id });
    }
  });

  // #7033 round 3 (r3s1).
  it("refuses to undo a self-grant that would lock the coordinator out of the case they then restricted (r3s1)", async () => {
    const id = await newCase();
    const coordinator = world.otherCoordinator;
    await start();
    expect(await call("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [id, coordinator.id], coordinator)).toMatchObject({ ok: true });
    const [granted] = await accessEntries(id, coordinator);
    expect(await call("select public.casework_set_restriction($1, true, 'Witness statements are sensitive') as r", [id], coordinator)).toMatchObject({ ok: true });
    const audit = await accessAudit(id);
    expect(await undo(coordinator, granted.id)).toMatchObject({ ok: false, code: "22023", detail: "casework_restriction_self_lockout" });
    expect(await sees(coordinator, id)).toBe(1);
    expect((await grants(id)).filter((row) => row.active).map((row) => row.grantee_user_id)).toEqual([coordinator.id]);
    expect(await accessAudit(id)).toEqual(audit);
    // Undoing the restriction first, then the grant, works.
    const [restricted] = await entries("private.learning_case_restriction", id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [restricted.id], coordinator)).toMatchObject({ status: "undone" });
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [granted.id], coordinator)).toMatchObject({ status: "undone" });
    expect((await grants(id)).filter((row) => row.active)).toEqual([]);
  });

  it("refuses another person's entry as not found", async () => {
    const id = await newCase();
    await start();
    expect(await assign(world.coordinator, id, world.steward.id)).toMatchObject({ ok: true });
    const [entry] = await assignmentEntries(id);
    expect(await undo(world.otherCoordinator, entry.id)).toMatchObject({ ok: false, code: "P0002" });
    expect(await assignment(id)).toMatchObject({ steward_user_id: world.steward.id });
  });

  it("records a retaliation report and its withdrawal as kept, never as practice and never undoable", async () => {
    const id = await newCase();
    await start();
    // The sealed fields go through the maintenance channel here; the journal
    // still sees the member's own claims.
    const report = randomUUID();
    const sealed = (fields) => JSON.stringify({ ...Object.fromEntries(fields.map((field) => [field, {
      organization: world.org.id, record: report, field, purpose: "casework_retaliation_reports", schema: "1",
      payload: { ciphertext: "fixture" }, wrappedKey: { kid: "fixture" }, keyVersion: "fixture-1", dataVersion: randomUUID() }])) });
    await c.query("savepoint report");
    await c.query("select set_config('app.sensitive_maintenance', 'on', true)");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: world.member.id, session_id: world.member.session, aal: "aal2" })]);
    await c.query("select set_config('app.sensitive_envelopes', $1, true)", [sealed(["management_person", "protected_activity", "adverse_action"])]);
    await c.query("select public.casework_submit_retaliation_report($1, now(), '[encrypted]', '[encrypted]', '[encrypted]', null, $2)", [id, report]);
    await c.query("select set_config('app.sensitive_envelopes', $1, true)", [sealed(["withdrawal_reason"])]);
    await c.query("select public.casework_withdraw_retaliation_report($1, '[encrypted]')", [report]);
    await c.query("select set_config('app.sensitive_maintenance', '', true)");
    await c.query("release savepoint report");
    const journal = await entries("public.casework_retaliation_reports", report);
    expect(journal.map((entry) => [entry.action_kind, entry.state, entry.before_image, entry.after_fingerprint])).toEqual([
      ["retaliation_report_submit", "kept", null, null], ["retaliation_report_withdraw", "kept", null, null]]);
    expect((await c.query("select flag from private.learning_practice_flags('public.casework_retaliation_reports', array[$1::text])", [report])).rows).toEqual([]);
    expect(await undo(world.member, journal[0].id)).toMatchObject({ ok: false, code: "55000" });
    expect((await c.query("select status from public.casework_retaliation_reports where id = $1", [report])).rows[0].status).toBe("withdrawn");
  });
});
