// @vitest-environment node
//
// REQ-UG-GRIEVANCE-PROCEDURE-STARTER-TEMPLATE-20261001 and
// REQ-UG-NEW-MEMBER-STARTER-ITEMS-20261001 against a disposable database.
// One transaction, a savepoint per case, rolled back at the end.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = Boolean(process.env.SUPABASE_DB_URL);
const names = ["admin", "coordinator", "member", "foreignAdmin", "inviter", "joiner", "joinerEs", "provisioned", "former", "orgA", "orgB", "case"];
const ids = Object.fromEntries(names.map((name) => [name, randomUUID()]));
const sessions = Object.fromEntries(["admin", "coordinator", "member", "foreignAdmin", "inviter"].map((name) => [name, randomUUID()]));
const SWITCH_PROCEDURE = "features.casework.starter_procedure_template";
const SWITCH_ITEMS = "features.guidance_onboarding.new_member_starter_items";
const EXPECTED_STEPS = [
  ["filing", "File the grievance", "calendar_days", 14, "incident", false],
  ["step_1", "Step 1: management response", "calendar_days", 30, "step_entry", false],
  ["step_2_appeal", "Appeal to Step 2", "business_days", 10, "step_entry", false],
  ["step_2", "Step 2: management response", "calendar_days", 30, "step_entry", false],
  ["step_3_appeal", "Appeal to Step 3", "calendar_days", 30, "step_entry", false],
  ["step_3", "Step 3: management response", "calendar_days", 30, "step_entry", false],
  ["arbitration_demand", "Demand arbitration", "calendar_days", 30, "step_entry", false],
  ["arbitration", "Arbitration", "none", 0, "step_entry", true],
];

describe.skipIf(!live)("starter templates on disposable PostgreSQL", () => {
  let db;
  const query = async (sql, values = []) => (await db.query(sql, values)).rows;
  // A procedure deadline is the end of an Eastern calendar day (#7198,
  // 20261106170000): count Eastern dates from the clock, never rounded hours.
  // `rounded` is the old whole-day rounding, kept to show why it drifted.
  const easternDeadline = async (dueAt, clock) => (await query(
    `select ($1::timestamptz at time zone 'America/New_York')::date - ($2::timestamptz at time zone 'America/New_York')::date days,
            ($1::timestamptz at time zone 'America/New_York')::time::text at,
            round(extract(epoch from ($1::timestamptz - $2::timestamptz)) / 86400)::int rounded`,
    [dueAt, clock],
  ))[0];
  async function actor(name, aal = "aal2") {
    await query("reset role");
    await query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids[name], role: "authenticated", aal, session_id: sessions[name] })]);
    await query("select set_config('request.jwt.claim.sub', '', true)");
    await query("set local role authenticated");
  }
  async function service() {
    await query("reset role");
    await query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await query("select set_config('request.jwt.claim.sub', '', true)");
  }
  async function fails(sql, values, code) {
    await query("savepoint refusal");
    try { await expect(db.query(sql, values)).rejects.toMatchObject({ code }); }
    finally { await query("rollback to savepoint refusal"); }
  }
  async function setSwitch(org, key, value) {
    await query("reset role");
    await query("insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, $2, $3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value", [org, key, JSON.stringify(value)]);
  }
  async function fireDeferred() {
    await query("set constraints public.new_member_starter_items_on_profile_chapter, public.new_member_starter_items_on_chapter_membership immediate");
    await query("set constraints public.new_member_starter_items_on_profile_chapter, public.new_member_starter_items_on_chapter_membership deferred");
    await query("set constraints public.new_member_starter_items_on_membership immediate");
    await query("set constraints public.new_member_starter_items_on_membership deferred");
  }
  async function starterRows(user) {
    await query("reset role");
    const tasks = await query("select chapter_id, title, description, status, priority, assignee_id, created_by, task_type from public.chapter_tasks where assignee_id = $1 and deleted_at is null", [user]);
    const issued = await query("select organization_id, starter_items_issued_at from public.organization_memberships where user_id = $1", [user]);
    return { tasks, issued };
  }
  async function notifications(user) {
    await query("reset role");
    return query("select title, body, kind from public.member_notifications where user_id = $1 order by created_at, id", [user]);
  }
  // An invitation in the accepting state, as claim_member_invitation leaves it,
  // then the account handle_new_member creates from it.
  async function invitedAccount(user, email, fullName, chapter = "l15-a", language = null) {
    await query("reset role");
    const invitation = randomUUID();
    await query(`insert into public.member_invitations(id, normalized_email, full_name, first_name, initials, chapter_id, token_hash, status, invited_by, expires_at, accepting_at)
      values ($1, $2, $3, $4, 'NM', $5, $6, 'accepting', $7, now() + interval '7 days', now())`,
    [invitation, email, fullName, fullName.split(" ")[0], chapter, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), ids.inviter]);
    await query("insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3)", [user, email, JSON.stringify({ first_name: fullName.split(" ")[0], full_name: fullName, initials: "NM", chapter_id: chapter, union_base_invitation_id: invitation })]);
    // The account welcome is separate from the starter-template notification.
    await query("delete from public.member_notifications where user_id=$1 and kind='general' and title='Welcome to your private organizing workspace'", [user]);
    if (language) await query("update public.member_profiles set language = $2 where id = $1", [user, language]);
    return invitation;
  }
  async function accept(invitation, user) {
    await service();
    await query("update public.member_invitations set status = 'accepted', token_hash = null, accepted_at = clock_timestamp(), auth_user_id = $2 where id = $1", [invitation, user]);
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "l15-starter-templates-proof" });
    await db.connect();
    await query("begin");
    const staff = ["admin", "coordinator", "member", "foreignAdmin", "inviter"];
    for (const name of staff) await query("insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3)", [ids[name], `l15-${name.toLowerCase()}@example.invalid`, JSON.stringify({ full_name: `L15 ${name}` })]);
    await query("insert into public.organizations(id, slug, name, created_by) values ($1, 'l15-proof-a', 'Starter proof A', $3), ($2, 'l15-proof-b', 'Starter proof B', $3)", [ids.orgA, ids.orgB, ids.admin]);
    await query("insert into public.chapters(id, name, slug, region, is_default, order_index, organization_id) values ('l15-a', 'Starter A', 'l15-a', 'proof', false, 9951, $1), ('l15-a2', 'Starter A two', 'l15-a2', 'proof', false, 9952, $1), ('l15-b', 'Starter B', 'l15-b', 'proof', false, 9953, $2)", [ids.orgA, ids.orgB]);
    for (const name of staff) {
      const org = name === "foreignAdmin" ? ids.orgB : ids.orgA;
      const chapter = name === "foreignAdmin" ? "l15-b" : "l15-a";
      await query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [org, ids[name]]);
      await query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [ids[name], chapter]);
      await query("update public.member_profiles set chapter_id = $2, full_name = $3 where id = $1", [ids[name], chapter, `L15 ${name}`]);
      await query("insert into auth.sessions(id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [sessions[name], ids[name]]);
      if (name === "member") continue;
      const role = name === "coordinator" ? "coordinator" : "admin";
      await query("insert into public.organization_role_grants(organization_id, user_id, role) values ($1, $2, $3)", [org, ids[name], role]);
      await query("insert into public.member_roles(user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [ids[name], role, chapter]);
      await query("insert into public.member_role_chapters(user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [ids[name], role, chapter]);
      await query("insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'L15 proof', 'totp', 'verified', now(), now())", [randomUUID(), ids[name]]);
    }
    // The organization's own onboarding steps feed the starter checklist; one
    // is inactive and organization B's must never leak.
    await query(`insert into public.organization_onboarding_steps(id, organization_id, title, position, active) values
      ($1, $4, 'Meet your steward', 2, true), ($2, $4, 'Read the contract summary', 1, true), ($3, $4, 'Retired step', 3, false), ($5, $6, 'Foreign step', 1, true)`,
    [randomUUID(), randomUUID(), randomUUID(), ids.orgA, randomUUID(), ids.orgB]);
    await query("insert into public.member_cases(id, user_id, organization_id, chapter_id, reference, title, case_type, step, created_at) values ($1, $2, $3, 'l15-a', 'L15-1', 'Starter proof', 'Grievance', 'filing', now())", [ids.case, ids.member, ids.orgA]);
    // The setup memberships queue the deferred join check; consume it while
    // the switch is still off so each case sees only its own joins.
    await fireDeferred();
    // Setup notices (second-factor enrollment) are not part of the proof.
    await query("delete from public.member_notifications where user_id = any($1::uuid[])", [staff.map((name) => ids[name])]);
  }, 60000);
  afterAll(async () => { if (db) { await db.query("rollback"); await db.end(); } });
  beforeEach(async () => { await query("savepoint test_case"); });
  afterEach(async () => { await query("rollback to savepoint test_case"); });

  describe("starter grievance procedure", () => {
    it("ships no procedure and previews the old effective deadlines with the caller's rights", async () => {
      await query("reset role");
      expect((await query("select count(*)::int n from public.casework_procedures where organization_id in ($1, $2)", [ids.orgA, ids.orgB]))[0].n).toBe(0);
      await actor("admin");
      const preview = (await query("select public.get_casework_starter_procedure('en') result"))[0].result;
      expect(preview).toMatchObject({ available: true, canLoad: true, name: "Starter grievance procedure", template: "grievance-starter-20261001" });
      expect(preview.steps.map((step) => [step.key, step.label, step.deadline_rule.kind, step.deadline_rule.count, step.deadline_rule.from, step.terminal])).toEqual(EXPECTED_STEPS);
      await actor("coordinator");
      expect((await query("select public.get_casework_starter_procedure('en') result"))[0].result).toMatchObject({ available: true, canLoad: false });
      await actor("member");
      await fails("select public.get_casework_starter_procedure('en')", [], "42501");
      await actor("admin");
      await fails("select public.get_casework_starter_procedure('fr')", [], "22023");
      await query("reset role");
      expect((await query("select count(*)::int n from public.casework_procedures where organization_id = $1", [ids.orgA]))[0].n).toBe(0);
    });

    it("loads only on the admin's explicit call, through the manual save path, and audits it", async () => {
      await actor("admin");
      const procedure = (await query("select public.load_casework_starter_procedure(null, 'en') result"))[0].result;
      expect(procedure).toMatchObject({ organization_id: ids.orgA, chapter_id: null, case_type: null, name: "Starter grievance procedure", version: 1, active: true, created_by: ids.admin });
      expect(procedure.steps.map((step) => [step.key, step.label, step.deadline_rule.kind, step.deadline_rule.count, step.deadline_rule.from, step.terminal])).toEqual(EXPECTED_STEPS);
      expect(procedure.steps.every((step) => step.requires_checklist === false && step.allow_terminal_exit === false)).toBe(true);
      const listed = (await query("select public.casework_list_procedures() result"))[0].result;
      expect(listed.procedures.map((row) => row.id)).toEqual([procedure.id]);
      await query("reset role");
      const audit = await query("select organization_id, case_id, actor_user_id, entity_type, entity_id, metadata from public.casework_audit_events where event_type = 'procedure_starter_loaded'");
      expect(audit).toEqual([{ organization_id: ids.orgA, case_id: null, actor_user_id: ids.admin, entity_type: "procedure", entity_id: procedure.id, metadata: { template: "grievance-starter-20261001", caseType: null, locale: "en", steps: 8 } }]);
      // Once loaded it is ordinary organization data: the admin edits it with
      // the same RPC and optimistic version as any procedure.
      await actor("admin");
      const edited = procedure.steps.map((step) => ({ ...step, deadline_rule: step.key === "step_1" ? { kind: "calendar_days", count: 21, from: "step_entry" } : step.deadline_rule }));
      const saved = (await query("select public.casework_save_procedure($1, null, null, $2, $3, 1) result", [procedure.id, "Our procedure", JSON.stringify(edited)]))[0].result;
      expect(saved.version).toBe(2);
      expect(saved.steps.find((step) => step.key === "step_1").deadline_rule.count).toBe(21);
    });

    it("produces real procedure deadlines when a case advances", async () => {
      await actor("admin");
      await query("select public.load_casework_starter_procedure(null, 'en')");
      const transition = (await query("select (public.casework_advance_step($1, 'filing', 'step_1', 'Filed with management', $2)).*", [ids.case, randomUUID()]))[0];
      expect(transition).toMatchObject({ from_step: "filing", to_step: "step_1" });
      await query("reset role");
      const [{ clock }] = await query("select now()::text clock");
      const [deadline] = await query("select kind, label, due_at from public.casework_deadlines where case_id = $1", [ids.case]);
      expect(deadline).toMatchObject({ kind: "procedure", label: "Step 1: management response" });
      expect(await easternDeadline(deadline.due_at, clock)).toMatchObject({ days: 30, at: "23:59:59" });
    });

    // #7367: rounding (due_at - now()) to whole days read 31 before noon
    // Eastern, because the deadline ends at 11:59:59 PM Eastern. The Eastern
    // calendar comparison gives 30 whatever the hour of the step entry.
    it("compares the starter deadline in Eastern calendar days at any hour of the entry day", async () => {
      const due = "2026-12-07 23:59:59 America/New_York";
      for (const [clock, rounded] of [["2026-11-07 02:00 America/New_York", 31], ["2026-11-07 14:00 America/New_York", 30]]) {
        expect(await easternDeadline(due, clock)).toEqual({ days: 30, at: "23:59:59", rounded });
      }
    });

    it("refuses a scope that already has a procedure and never overwrites it", async () => {
      await actor("admin");
      const own = (await query("select public.casework_save_procedure(null, null, null, 'Our own', $1, null) result", [JSON.stringify([{ key: "intake", label: "Intake", deadline_rule: { kind: "none", count: 0, from: "step_entry" } }])]))[0].result;
      await fails("select public.load_casework_starter_procedure(null, 'en')", [], "23505");
      await fails("select public.load_casework_starter_procedure('  ', 'en')", [], "23505");
      const typed = (await query("select public.load_casework_starter_procedure(' Grievance ', 'es') result"))[0].result;
      expect(typed).toMatchObject({ case_type: "Grievance", name: "Procedimiento de quejas inicial" });
      expect(typed.steps.map((step) => step.label)).toEqual(["Presentar la queja", "Paso 1: respuesta de la gerencia", "Apelación al Paso 2", "Paso 2: respuesta de la gerencia", "Apelación al Paso 3", "Paso 3: respuesta de la gerencia", "Solicitar arbitraje", "Arbitraje"]);
      await fails("select public.load_casework_starter_procedure('Grievance', 'en')", [], "23505");
      await query("reset role");
      const [kept] = await query("select name, version from public.casework_procedures where id = $1", [own.id]);
      expect(kept).toEqual({ name: "Our own", version: 1 });
      expect((await query("select count(*)::int n from public.casework_audit_events where event_type = 'procedure_starter_loaded' and organization_id = $1", [ids.orgA]))[0].n).toBe(1);
    });

    it("is admin-only behind MFA and the organization switch", async () => {
      await actor("coordinator");
      await fails("select public.load_casework_starter_procedure(null, 'en')", [], "42501");
      await actor("member");
      await fails("select public.load_casework_starter_procedure(null, 'en')", [], "42501");
      await actor("admin", "aal1");
      await fails("select public.load_casework_starter_procedure(null, 'en')", [], "42501");
      await query("reset role");
      await query("set local role anon");
      await fails("select public.load_casework_starter_procedure(null, 'en')", [], "42501");
      await setSwitch(ids.orgA, SWITCH_PROCEDURE, false);
      await actor("admin");
      expect((await query("select public.get_casework_starter_procedure('en') result"))[0].result).toMatchObject({ available: false });
      await fails("select public.load_casework_starter_procedure(null, 'en')", [], "55000");
      await fails("select public.load_casework_starter_procedure(null, 'xx')", [], "55000");
      await query("reset role");
      expect((await query("select count(*)::int n from public.casework_procedures where organization_id = $1", [ids.orgA]))[0].n).toBe(0);
    });

    it("stays inside the caller's organization", async () => {
      await actor("foreignAdmin");
      const foreign = (await query("select public.load_casework_starter_procedure(null, 'en') result"))[0].result;
      expect(foreign.organization_id).toBe(ids.orgB);
      await actor("admin");
      expect((await query("select public.casework_list_procedures() result"))[0].result.procedures).toEqual([]);
      const own = (await query("select public.load_casework_starter_procedure(null, 'en') result"))[0].result;
      expect(own.organization_id).toBe(ids.orgA);
      await setSwitch(ids.orgB, SWITCH_PROCEDURE, false);
      await actor("admin");
      expect((await query("select public.get_casework_starter_procedure('en') result"))[0].result.available).toBe(true);
    });
  });

  describe("new member starter items", () => {
    it("waits for an active chapter, then retries on chapter assignment without an empty prompt", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      await query("insert into auth.users(id, email, raw_user_meta_data) values ($1, 'l15-provisioned@example.invalid', $2)", [ids.provisioned, JSON.stringify({ full_name: "Pat Provisioned" })]);
      await query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.admin, role: "authenticated" })]);
      await query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ids.orgA, ids.provisioned]);
      await fireDeferred();
      expect((await starterRows(ids.provisioned)).issued[0].starter_items_issued_at).toBeNull();
      expect(await notifications(ids.admin)).toEqual([]);
      await query("update public.member_profiles set chapter_id = 'l15-a' where id = $1", [ids.provisioned]);
      await fireDeferred();
      expect((await starterRows(ids.provisioned)).issued[0].starter_items_issued_at).toBeNull();
      await query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, 'l15-a', 'active')", [ids.provisioned]);
      await fireDeferred();
      expect((await starterRows(ids.provisioned)).tasks.map((task) => task.chapter_id)).toEqual(["l15-a"]);
      expect((await starterRows(ids.provisioned)).issued[0].starter_items_issued_at).not.toBeNull();
    });
    it("does nothing while the switch is off, which is the default", async () => {
      await query("reset role");
      expect((await query("select default_value, category from public.platform_setting_definitions where key = $1", [SWITCH_ITEMS]))[0]).toEqual({ default_value: false, category: "guidance_onboarding" });
      const invitation = await invitedAccount(ids.joiner, "l15-joiner@example.invalid", "Nadia Joiner");
      await fireDeferred();
      await accept(invitation, ids.joiner);
      await fireDeferred();
      const rows = await starterRows(ids.joiner);
      expect(rows.tasks).toEqual([]);
      expect(rows.issued).toEqual([{ organization_id: ids.orgA, starter_items_issued_at: null }]);
      expect(await notifications(ids.inviter)).toEqual([]);
      expect(await notifications(ids.joiner)).toEqual([]);
    });

    it("issues one Get started task and one mentor prompt to the inviter once the invitation is accepted", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      const invitation = await invitedAccount(ids.joiner, "l15-joiner@example.invalid", "Nadia Joiner");
      // The account exists but the invitation is still accepting: nothing yet.
      await fireDeferred();
      expect((await starterRows(ids.joiner)).tasks).toEqual([]);
      await accept(invitation, ids.joiner);
      const rows = await starterRows(ids.joiner);
      expect(rows.tasks).toEqual([{ chapter_id: "l15-a", title: "Get started", description: "- [ ] Read the contract summary\n- [ ] Meet your steward", status: "to_do", priority: "medium", assignee_id: ids.joiner, created_by: ids.joiner, task_type: "general" }]);
      expect(rows.issued[0].starter_items_issued_at).not.toBeNull();
      expect(await notifications(ids.inviter)).toEqual([{ title: "Pair Nadia Joiner with a mentor", body: "Nadia Joiner joined Starter A. Open Member support, then Mentorship, to pair them with a mentor.", kind: "general" }]);
      // Nothing is invented for the member: no notice, no other task.
      expect(await notifications(ids.joiner)).toEqual([]);
      // The service identity is restored after the task insert.
      expect((await query("select current_setting('request.jwt.claims', true) claims"))[0].claims).toBe(JSON.stringify({ role: "service_role" }));
    });

    it("issues exactly one set per membership across retries, re-joins and a second chapter", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      const invitation = await invitedAccount(ids.joiner, "l15-joiner@example.invalid", "Nadia Joiner");
      await accept(invitation, ids.joiner);
      await query("update public.member_invitations set status = 'accepted' where id = $1", [invitation]);
      await query("update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2", [ids.orgA, ids.joiner]);
      await query("update public.organization_memberships set status = 'active', revoked_at = null where organization_id = $1 and user_id = $2", [ids.orgA, ids.joiner]);
      await query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, 'l15-a2', 'active')", [ids.joiner]);
      await fireDeferred();
      await query("select private.issue_new_member_starter_items($1, $2, $3)", [ids.orgA, ids.joiner, ids.inviter]);
      expect((await starterRows(ids.joiner)).tasks).toHaveLength(1);
      expect(await notifications(ids.inviter)).toHaveLength(1);
    });

    it("localizes the task for a Spanish member and the prompt for a Spanish inviter", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      await query("update public.member_profiles set language = 'es' where id = $1", [ids.inviter]);
      const invitation = await invitedAccount(ids.joinerEs, "l15-joiner-es@example.invalid", "Lucía Nueva", "l15-a", "es");
      await accept(invitation, ids.joinerEs);
      expect((await starterRows(ids.joinerEs)).tasks.map((task) => task.title)).toEqual(["Primeros pasos"]);
      expect(await notifications(ids.inviter)).toEqual([{ title: "Asigna un mentor a Lucía Nueva", body: "Lucía Nueva se unió a Starter A. Abre Apoyo a miembros y luego Mentoría para asignarle un mentor.", kind: "general" }]);
    });

    it("prompts only an adder who is still an active member and keeps an empty checklist when none is configured", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      await query("update public.organization_onboarding_steps set active = false where organization_id = $1", [ids.orgA]);
      await query("update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2", [ids.orgA, ids.inviter]);
      const invitation = await invitedAccount(ids.joiner, "l15-joiner@example.invalid", "Nadia Joiner");
      await accept(invitation, ids.joiner);
      const rows = await starterRows(ids.joiner);
      expect(rows.tasks.map((task) => [task.title, task.description])).toEqual([["Get started", ""]]);
      expect(await notifications(ids.inviter)).toEqual([]);
    });

    it("issues the set when a former member's reactivation invitation is accepted through the service RPC", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      await query("insert into auth.users(id, email, raw_user_meta_data) values ($1, 'l15-former@example.invalid', $2)", [ids.former, JSON.stringify({ full_name: "Fran Former" })]);
      await query("update public.member_profiles set full_name = 'Fran Former' where id = $1", [ids.former]);
      await query("insert into public.organization_memberships(organization_id, user_id, status, revoked_at) values ($1, $2, 'revoked', now())", [ids.orgA, ids.former]);
      const invitation = randomUUID();
      await query(`insert into public.member_invitations(id, kind, normalized_email, full_name, first_name, initials, chapter_id, token_hash, status, invited_by, expires_at, accepting_at)
        values ($1, 'reactivation', 'l15-former@example.invalid', 'Fran Former', 'Fran', 'FF', 'l15-a', $2, 'accepting', $3, now() + interval '7 days', now())`,
      [invitation, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), ids.inviter]);
      await service();
      expect((await query("select public.accept_former_member_invitation($1) result", [invitation]))[0].result).toMatchObject({ accepted: true, reactivated: true, userId: ids.former });
      await fireDeferred();
      const rows = await starterRows(ids.former);
      expect(rows.tasks.map((task) => [task.chapter_id, task.title, task.description])).toEqual([["l15-a", "Get started", "- [ ] Read the contract summary\n- [ ] Meet your steward"]]);
      expect((await notifications(ids.inviter)).map((row) => row.title)).toEqual(["Pair Fran Former with a mentor"]);
    });

    it("covers a membership provisioned without an invitation, prompting the signed-in adder", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      await query("insert into auth.users(id, email, raw_user_meta_data) values ($1, 'l15-provisioned@example.invalid', $2)", [ids.provisioned, JSON.stringify({ full_name: "Pat Provisioned" })]);
      await query("reset role");
      await query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.admin, role: "authenticated" })]);
      await query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ids.orgA, ids.provisioned]);
      await query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, 'l15-a2', 'active')", [ids.provisioned]);
      await query("update public.member_profiles set chapter_id = 'l15-a2' where id = $1", [ids.provisioned]);
      await fireDeferred();
      const rows = await starterRows(ids.provisioned);
      expect(rows.tasks.map((task) => [task.chapter_id, task.title, task.created_by])).toEqual([["l15-a2", "Get started", ids.provisioned]]);
      expect((await notifications(ids.admin)).map((row) => row.title)).toEqual(["Pair Pat Provisioned with a mentor"]);
    });

    it("leaves a person with a live invitation to the invitation path", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      await query("insert into auth.users(id, email, raw_user_meta_data) values ($1, 'l15-provisioned@example.invalid', '{}')", [ids.provisioned]);
      await query(`insert into public.member_invitations(normalized_email, full_name, first_name, initials, chapter_id, token_hash, status, invited_by, expires_at)
        values ('l15-provisioned@example.invalid', 'Pat Provisioned', 'Pat', 'PP', 'l15-a', $1, 'pending', $2, now() + interval '7 days')`, [randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), ids.inviter]);
      await query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ids.orgA, ids.provisioned]);
      await fireDeferred();
      expect((await starterRows(ids.provisioned)).issued).toEqual([{ organization_id: ids.orgA, starter_items_issued_at: null }]);
    });

    it("is tenant-isolated: another organization's switch and steps never apply", async () => {
      await setSwitch(ids.orgB, SWITCH_ITEMS, true);
      const invitation = await invitedAccount(ids.joiner, "l15-joiner@example.invalid", "Nadia Joiner");
      await accept(invitation, ids.joiner);
      expect((await starterRows(ids.joiner)).tasks).toEqual([]);
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      await setSwitch(ids.orgB, SWITCH_ITEMS, false);
      const second = await invitedAccount(ids.joinerEs, "l15-joiner-es@example.invalid", "Lucía Nueva");
      await accept(second, ids.joinerEs);
      const [task] = (await starterRows(ids.joinerEs)).tasks;
      expect(task.chapter_id).toBe("l15-a");
      expect(task.description).not.toContain("Foreign step");
    });

    it("never blocks a join when the items fail, and leaves nothing half-issued", async () => {
      await setSwitch(ids.orgA, SWITCH_ITEMS, true);
      await query("delete from private.notification_copy where key = 'member.mentor_pairing'");
      const invitation = await invitedAccount(ids.joiner, "l15-joiner@example.invalid", "Nadia Joiner");
      await accept(invitation, ids.joiner);
      await query("reset role");
      expect((await query("select status from public.member_invitations where id = $1", [invitation]))[0].status).toBe("accepted");
      const rows = await starterRows(ids.joiner);
      expect(rows.tasks).toEqual([]);
      expect(rows.issued[0].starter_items_issued_at).toBeNull();
    });

    it("keeps the starter functions private and the lifecycle trigger review complete", async () => {
      await query("reset role");
      const grants = await query(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') authenticated, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('service_role', p.oid, 'execute') service
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname in ('issue_new_member_starter_items', 'new_member_starter_items_on_invitation', 'new_member_starter_items_on_membership', 'new_member_starter_items_on_chapter_assignment', 'starter_procedure_template') order by p.proname`);
      expect(grants).toHaveLength(5);
      expect(grants.every((row) => !row.authenticated && !row.anon && !row.service)).toBe(true);
      const publicGrants = await query(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') authenticated, has_function_privilege('anon', p.oid, 'execute') anon
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('get_casework_starter_procedure', 'load_casework_starter_procedure') order by p.proname`);
      expect(publicGrants).toEqual([{ proname: "get_casework_starter_procedure", authenticated: true, anon: false }, { proname: "load_casework_starter_procedure", authenticated: true, anon: false }]);
      expect(await query("select * from private.account_lifecycle_referential_action_trigger_issues()")).toEqual([]);
      // The full lifecycle trigger review takes about 11 s on a migrated stack.
    }, 120_000);
  });
});
