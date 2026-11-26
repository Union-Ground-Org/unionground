// @vitest-environment node
// #7085: an undo rechecks the authority of the operation whose state it restores.
// Run unchanged on Main first: each lost-authority path must fail this proof.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { localMigrations, repoOnlyOrderingFailures } from "../scripts/verify-migration-history.mjs";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

describe("learning undo forward-authority migration order", () => {
  const version = "20261105181500";
  // Later deliveries must not change this repair's landing baseline.
  const atLanding = (migrations) => new Map([...migrations]
    .filter(([candidate]) => candidate <= version));

  it("sorts after 20261105040000", () => {
    const migrations = localMigrations();
    expect(migrations.get(version)?.file).toBe("20261105181500_learning_period_undo_forward_authority.sql");
    expect(version > "20261105040000").toBe(true);
    expect(repoOnlyOrderingFailures(atLanding(migrations), [version])).toEqual([]);
  });

  it("preserves its landing order when a later migration is present", () => {
    const migrations = localMigrations();
    migrations.set("20261105182000", { file: "20261105182000_later_migration.sql" });
    expect(repoOnlyOrderingFailures(migrations, [version]))
      .toEqual([expect.stringMatching(/^ORDERING: 20261105181500/)]);
    expect(repoOnlyOrderingFailures(atLanding(migrations), [version])).toEqual([]);
  });

  it("still rejects backdating the repair below 20261105040000", () => {
    const migrations = localMigrations();
    const backdatedVersion = "20261105035900";
    const repair = migrations.get(version);
    migrations.delete(version);
    migrations.set(backdatedVersion, {
      ...repair,
      file: `${backdatedVersion}_learning_period_undo_forward_authority.sql`,
    });
    expect(repoOnlyOrderingFailures(atLanding(migrations), [backdatedVersion]))
      .toEqual([expect.stringMatching(/^ORDERING: 20261105035900.*20261105040000/)]);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("learning undo current forward authority on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-undo-authority-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });
  afterEach(async () => { await c.query("rollback"); });

  async function call(text, values, user) {
    await c.query("savepoint rpc");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" })]);
      await c.query("set local role authenticated");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("release savepoint rpc");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint rpc");
      await c.query("release savepoint rpc");
      return { ok: false, code: error.code, message: error.message };
    }
  }
  const one = async (text, values, user) => {
    const result = await call(text, values, user);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return Object.values(result.rows[0])[0];
  };
  const row = async (text, values = []) => (await c.query(text, values)).rows[0];
  async function role(user, name, enabled = true) {
    await c.query("select set_config('request.jwt.claims', '', true)");
    if (enabled) {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2) on conflict do nothing", [world.org.id, user.id, name]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, name, world.org.chapter]);
      await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, name, world.org.chapter]);
    } else {
      await c.query("delete from public.member_role_chapters where user_id=$1 and role=$2", [user.id, name]);
      await c.query("delete from public.member_roles where user_id=$1 and role=$2", [user.id, name]);
      await c.query("delete from public.organization_role_grants where user_id=$1 and role=$2", [user.id, name]);
    }
  }
  async function person(roles = []) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [world.org.id, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, world.org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2,full_name='Authority proof' where id=$1", [user.id, world.org.chapter]);
    for (const name of roles) await role(user, name);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    // Retain this historical broad fixture grant.
    if (roles.includes("steward")) await migrateLegacyStewardFixtures(c);
    return user;
  }
  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    world = { org: { id: randomUUID(), chapter: `undo-auth-${randomUUID().slice(0, 8)}` } };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org.id, world.org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98319)", [world.org.chapter, world.org.id]);
    world.admin = await person(["admin"]);
    world.member = await person();
    world.actor = await person(["steward", "advisor"]);
    await c.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values ($1,'General',$2)", [world.org.chapter, world.admin.id]);
  });
  const start = () => one("select public.start_organization_learning_period() as r", [], world.admin);
  const entry = (kind, target) => row("select id, state, version from private.learning_action_journal where action_kind=$1 and ($2::text is null or target_id=$2) order by created_at desc,id desc limit 1", [kind, target ?? null]);
  const undo = (id) => call("select public.undo_my_learning_action($1,1) as r", [id], world.actor);
  const allowed = async (id) => expect(await one("select public.undo_my_learning_action($1,1) as r", [id], world.actor)).toMatchObject({ status: "undone" });
  // Compare complete retained journal and audit rows, not just their counts.
  const evidence = async () => (await row(`select jsonb_build_object(
    'journal', (select jsonb_agg(to_jsonb(j) order by id) from private.learning_action_journal j where organization_id=$1),
    'ledger', (select jsonb_agg(to_jsonb(a) order by id) from public.organization_audit_ledger a where organization_id=$1),
    'versions', (select jsonb_agg(to_jsonb(v) order by id) from private.casework_record_versions v where organization_id=$1),
    'assignments', (select jsonb_agg(to_jsonb(a) order by a.id) from public.member_case_assignment_audit a join public.member_cases c on c.id=a.case_id where c.organization_id=$1)
    ) as r`, [world.org.id])).r;
  const refused = async (id) => {
    const before = await evidence();
    expect(await undo(id)).toMatchObject({ ok: false, code: "42501" });
    expect(await evidence()).toEqual(before);
  };
  async function intake(target) {
    const report = randomUUID();
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: world.member.id, role: "authenticated" })]);
    await c.query(`insert into public.member_intake_reports(id,chapter_id,reporter_id,category,title,details,status)
      values ($1,$2,$3,'safety','Blocked exit','Fictional proof','new')`, [report, world.org.chapter, world.member.id]);
    const converted = await one("select public.convert_member_intake_report($1,$2) as r", [report, target], world.actor);
    const journal = await entry(target === "task" ? "task_create" : "case_create", converted.targetId);
    return { report, target: converted.targetId, entry: journal.id };
  }
  for (const target of ["task", "case"]) {
    it.each(["advisor", "admin", "vp"])(`refuses ${target} intake restoration after steward loss with only %s authority`, async (retained) => {
      if (retained !== "advisor") { await role(world.actor, "advisor", false); await role(world.actor, retained); }
      await start();
      const made = await intake(target);
      await role(world.actor, "steward", false);
      expect(await call("select public.convert_member_intake_report($1,$2) as r", [made.report, target], world.actor)).toMatchObject({ ok: false, code: "42501" });
      const before = await row("select to_jsonb(r) as r from public.member_intake_reports r where id=$1", [made.report]);
      await refused(made.entry);
      expect(await row("select to_jsonb(r) as r from public.member_intake_reports r where id=$1", [made.report])).toEqual(before);
      const table = target === "task" ? "chapter_tasks" : "member_cases";
      const field = target === "task" ? "deleted_at" : "learning_undone_at";
      expect((await row(`select ${field} is null as live from public.${table} where id=$1`, [made.target])).live).toBe(true);
    });
    it.each(["steward", "coordinator"])(`allows ${target} intake restoration with current %s authority and retains the audit trail`, async (current) => {
      await start();
      const made = await intake(target);
      if (current === "coordinator") { await role(world.actor, "coordinator"); await role(world.actor, "steward", false); }
      const before = await evidence();
      await allowed(made.entry);
      expect(await row("select status,assigned_to,case_id,task_id from public.member_intake_reports where id=$1", [made.report]))
        .toEqual({ status: "new", assigned_to: null, case_id: null, task_id: null });
      const after = await evidence();
      expect(after.journal.find((j) => j.id === made.entry)).toMatchObject({ state: "undone", version: 2 });
      expect(after.ledger).toEqual(expect.arrayContaining(before.ledger));
      expect(after.ledger.length).toBeGreaterThan(before.ledger.length);
      if (before.versions) expect(after.versions).toEqual(expect.arrayContaining(before.versions));
    });
  }
  async function newCase() {
    await c.query("select set_config('request.jwt.claims','',true)");
    const id = randomUUID();
    await c.query(`insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status,created_at)
      values ($1,$2,$3,$4,'AUTH-1','Fictional case','Grievance','intake','active','2026-09-18 14:00+00')`, [id, world.member.id, world.org.id, world.org.chapter]);
    return id;
  }
  it("refuses an outcome undo after coordinator loss even with advisor case access, then allows it when coordinator authority returns", async () => {
    await role(world.actor, "coordinator");
    const id = await newCase();
    await start();
    await one("select public.coordinator_record_case_outcome($1,'settled','Fictional settlement') as r", [id], world.actor);
    const journal = await entry("case_outcome", id);
    await role(world.actor, "coordinator", false);
    await refused(journal.id);
    expect((await row("select outcome from public.member_case_outcomes where case_id=$1", [id])).outcome).toBe("settled");
    await role(world.actor, "coordinator");
    await allowed(journal.id);
    expect(await row("select outcome from public.member_case_outcomes where case_id=$1", [id])).toBeUndefined();
  });
  it("refuses a claim undo after steward loss, then allows an authorized release with another audit row", async () => {
    const id = await newCase();
    await start();
    await one("select public.claim_member_case($1) as r", [id], world.actor);
    const journal = await entry("case_claim", id);
    await role(world.actor, "steward", false);
    await refused(journal.id);
    expect((await row("select steward_user_id from public.member_cases where id=$1", [id])).steward_user_id).toBe(world.actor.id);
    await role(world.actor, "steward");
    const before = await evidence();
    await allowed(journal.id);
    expect((await row("select steward_user_id from public.member_cases where id=$1", [id])).steward_user_id).toBeNull();
    const after = await evidence();
    expect(after.assignments).toEqual(expect.arrayContaining(before.assignments));
    expect(after.assignments.length).toBe(before.assignments.length + 1);
  });
  it("refuses a claim-and-coordinator-assignment chain after steward loss despite retained coordinator authority", async () => {
    await role(world.actor, "coordinator");
    const id = await newCase();
    await start();
    await one("select public.claim_member_case($1) as r", [id], world.actor);
    const claim = await entry("case_claim", id);
    await one("select public.assign_member_case($1,'00000000-0000-0000-0000-000000000000',$2) as r", [id, world.actor.id], world.actor);
    await role(world.actor, "steward", false);
    await refused(claim.id);
    expect(await row("select steward_user_id,coordinator_user_id from public.member_cases where id=$1", [id]))
      .toEqual({ steward_user_id: world.actor.id, coordinator_user_id: world.actor.id });
    await role(world.actor, "steward");
    await allowed(claim.id);
    expect(await row("select steward_user_id,coordinator_user_id from public.member_cases where id=$1", [id]))
      .toEqual({ steward_user_id: null, coordinator_user_id: null });
  });
  it.each(["steward", "coordinator"])("rechecks a restored %s against the projected assignment rather than a matching live assignee", async (hat) => {
    await role(world.actor, "coordinator");
    const first = await person([hat]);
    const second = await person([hat]);
    const id = await newCase();
    const assign = async (user) => one("select public.assign_member_case($1,$2,$3) as r",
      [id, hat === "steward" ? user : "00000000-0000-0000-0000-000000000000",
        hat === "coordinator" ? user : "00000000-0000-0000-0000-000000000000"], world.actor);
    await assign(first.id);
    await start();
    await assign(second.id);
    const older = await entry("case_assign", id);
    await assign(first.id);
    await role(first, hat, false);
    await refused(older.id);
    expect((await row(`select ${hat}_user_id as assignee from public.member_cases where id=$1`, [id])).assignee).toBe(first.id);
    await role(first, hat);
    await allowed(older.id);
    expect((await row(`select ${hat}_user_id as assignee from public.member_cases where id=$1`, [id])).assignee).toBe(first.id);
  });
  it("refuses another member's case-creation undo after intake-role loss and allows it after restoration", async () => {
    await start();
    const made = await one("select public.open_member_case($1,'Fictional intake','Safety','',null,null,null,null,null,true) as r", [world.member.id], world.actor);
    const journal = await entry("case_create", made.caseId);
    await role(world.actor, "steward", false);
    await refused(journal.id);
    await role(world.actor, "steward");
    await allowed(journal.id);
  });
  it("refuses to free an approved form after steward loss even with admin intake authority, then allows its steward", async () => {
    await role(world.actor, "admin");
    const form = randomUUID();
    await c.query("insert into public.member_forms(id,user_id,template_key,status,answers,organization_id) values ($1,$2,'grievance','approved','{}',$3)", [form, world.member.id, world.org.id]);
    await start();
    const id = await one("select public.open_form_as_case($1) as r", [form], world.actor);
    const journal = await entry("case_create", id);
    await role(world.actor, "steward", false);
    await refused(journal.id);
    expect((await row("select case_id from public.member_forms where id=$1", [form])).case_id).toBe(id);
    await role(world.actor, "steward");
    await allowed(journal.id);
    expect((await row("select case_id from public.member_forms where id=$1", [form])).case_id).toBeNull();
  });
  it("refuses a bulk import undo after admin loss even with steward intake authority, then allows the current admin", async () => {
    await role(world.actor, "admin");
    const mapping = { member_id: "member_id", chapter_id: "chapter_id", reference: "reference", title: "title" };
    const records = [1, 2].map((n) => ({ member_id: world.member.id, chapter_id: world.org.chapter, reference: `IMPORT-${n}`, title: `Fictional import ${n}` }));
    await start();
    const staged = await one("select public.stage_member_operations_import('grievance','cases.csv',$1,$2,$3) as r", [mapping, JSON.stringify(records), randomUUID()], world.actor);
    const batch = staged.batchId ?? staged.batch_id ?? staged.id;
    await one("select public.validate_member_operations_import($1,$2) as r", [batch, randomUUID()], world.actor);
    await one("select public.commit_member_operations_import($1,$2) as r", [batch, randomUUID()], world.actor);
    const journal = await entry("case_operations_import");
    await role(world.actor, "admin", false);
    await refused(journal.id);
    expect((await row("select count(*)::int as n from public.member_cases where reference in ('IMPORT-1','IMPORT-2') and learning_undone_at is null")).n).toBe(2);
    await role(world.actor, "admin");
    await allowed(journal.id);
    expect((await row("select count(*)::int as n from public.member_cases where reference in ('IMPORT-1','IMPORT-2') and learning_undone_at is null")).n).toBe(0);
  });
  it("continues to undo an ordinary advisor task and a member's own case without intake staff authority", async () => {
    await role(world.actor, "steward", false);
    await start();
    const task = await one("select public.create_chapter_task($1) as r", [{ title: "Fictional ordinary task", workstream: "General" }], world.actor);
    await allowed((await entry("task_create", task.id)).id);
    const made = await one("select public.create_member_case('Own case',null,'Safety','') as r", [], world.member);
    const journal = await entry("case_create", made.caseId);
    expect(await one("select public.undo_my_learning_action($1,1) as r", [journal.id], world.member)).toMatchObject({ status: "undone" });
  });
  it("refuses to reschedule a channel-staff reminder after staff-role loss, then allows current staff and keeps own cancellation available", async () => {
    const space = randomUUID();
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: world.admin.id, role: "authenticated" })]);
    await c.query("insert into public.chapter_spaces(id,name,visibility) values ($1,'Fictional reminder space','chapter')", [space]);
    await start();
    const reminder = await one("select public.create_channel_here_reminder($1,now()+interval '1 day','Staff reminder') as r", [space], world.actor);
    await one("select public.act_on_connected_workflow_reminder($1,'cancel') as r", [reminder.id], world.actor);
    const cancelled = await entry("message_reminder_change", reminder.id);
    await role(world.actor, "steward", false);
    await role(world.actor, "advisor", false);
    expect(await call("select public.create_channel_here_reminder($1,now()+interval '2 days','No longer staff') as r", [space], world.actor)).toMatchObject({ ok: false, code: "42501" });
    await refused(cancelled.id);
    expect((await row("select status from public.member_message_reminders where id=$1", [reminder.id])).status).toBe("cancelled");
    await role(world.actor, "steward");
    await allowed(cancelled.id);
    expect((await row("select status from public.member_message_reminders where id=$1", [reminder.id])).status).toBe("scheduled");
    // Cancelling one's own scheduled work is still allowed after role loss.
    await role(world.actor, "steward", false);
    await allowed((await entry("message_reminder_set", reminder.id)).id);
  });
  it.each(["cancel", "complete"])("allows cancellation of an older reminder set through a later %s after staff loss, while refusing standalone rescheduling", async (action) => {
    const space = randomUUID();
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: world.admin.id, role: "authenticated" })]);
    await c.query("insert into public.chapter_spaces(id,name,visibility) values ($1,'Fictional chain reminder','chapter')", [space]);
    await start();
    const reminder = await one("select public.create_channel_here_reminder($1,now()+interval '1 day','Staff chain reminder') as r", [space], world.actor);
    const original = await entry("message_reminder_set", reminder.id);
    await one("select public.act_on_connected_workflow_reminder($1,$2,now()+interval '2 days') as r", [reminder.id, action], world.actor);
    const changed = await entry("message_reminder_change", reminder.id);
    await role(world.actor, "steward", false);
    await role(world.actor, "advisor", false);
    await refused(changed.id);
    expect((await row("select status from public.member_message_reminders where id=$1", [reminder.id])).status)
      .toBe(action === "complete" ? "completed" : "cancelled");
    expect(await one("select public.undo_my_learning_action($1,1) as r", [original.id], world.actor))
      .toMatchObject({ status: "undone", undoneCount: 2 });
    expect((await row("select status from public.member_message_reminders where id=$1", [reminder.id])).status).toBe("cancelled");
    expect((await row("select count(*)::int n from private.learning_action_journal where id=any($1::uuid[]) and state='undone'", [[original.id, changed.id]])).n).toBe(2);
  });

  // Doubled gate r1g1: retain the explicit same-chapter join independently
  // of the profile-read helper; both paths already refused on the reviewed head.
  it.each(["task", "case"])("refuses %s intake restoration after the caller selects another chapter", async (target) => {
    await start();
    const made = await intake(target);
    const other = `${world.org.chapter}-other`;
    await c.query("select set_config('request.jwt.claims','',true)");
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98320)", [other, world.org.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [world.actor.id, other]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [world.actor.id, other]);
    await refused(made.entry);
    expect((await row("select task_id,case_id from public.member_intake_reports where id=$1", [made.report]))[`${target}_id`]).toBe(made.target);
    await c.query("select set_config('request.jwt.claims','',true)");
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [world.actor.id, world.org.chapter]);
    await allowed(made.entry);
  });

  async function scopedForm({ cosigner, retainedRole }) {
    await role(world.actor, "steward", false);
    if (retainedRole !== "advisor") await role(world.actor, retainedRole);
    // A committee-only steward is no longer
    // a valid grant. Keep the same scope-loss refusal with an explicit unit.
    const unit = randomUUID();
    await c.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Fictional scope unit')", [unit,world.org.id,world.org.chapter]);
    await one("select public.set_chapter_access_member($1,$2,$3,null,true) as r", [world.org.chapter, world.member.id, unit], world.admin);
    await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) as r", [world.actor.id, world.org.chapter, unit], world.admin);
    // The positive co-signer remains in the unit.
    // Scope removal is exercised separately as a 22023 negative control.
    await c.query("select set_config('request.jwt.claims','',true)");
    const form = randomUUID();
    await c.query("insert into public.member_forms(id,user_id,template_key,status,answers,organization_id) values ($1,$2,$3,'submitted','{}',$4)",
      [form, world.member.id, cosigner ? "alliance_grievance" : "grievance", world.org.id]);
    if (cosigner) {
      await c.query(`insert into public.member_form_cosigners(form_id,invited_email,cosigner_user_id,status,invited_by,responded_at,signed_at)
        values ($1,$2,$3,'accepted',$4,now(),now())`, [form, `${world.actor.id}@example.invalid`, world.actor.id, world.member.id]);
    }
    await c.query("update public.member_forms set status='approved' where id=$1", [form]);
    await start();
    const caseId = await one("select public.open_form_as_case($1) as r", [form], world.actor);
    return { unit, form, caseId, journal: await entry("case_create", caseId) };
  }

  // Doubled gate r2s1: linked-case access must not substitute for the scope
  // needed to open the form before that case existed.
  it.each(["coordinator", "advisor"])("refuses form undo after steward grievance-scope loss with retained %s authority", async (retainedRole) => {
    const made = await scopedForm({ cosigner: false, retainedRole });
    // Remove/restore the member's unit scope, preserving the refusal.
    await one("select public.set_chapter_access_member($1,$2,$3,null,false) as r", [world.org.chapter,world.member.id,made.unit],world.admin);
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: world.actor.id, role: "authenticated", session_id: world.actor.session, aal: "aal2" })]);
    expect(await row(`select private.member_form_scope_and_identity_allowed(f) as linked,
      private.member_form_scope_and_identity_allowed(jsonb_populate_record(f,'{"case_id":null}'::jsonb)) as unlinked
      from public.member_forms f where f.id=$1`, [made.form])).toEqual({ linked: retainedRole === "coordinator", unlinked: false });
    await refused(made.journal.id);
    expect((await row("select case_id from public.member_forms where id=$1", [made.form])).case_id).toBe(made.caseId);
    // Remove/restore the member's unit scope, preserving the refusal.
    await one("select public.set_chapter_access_member($1,$2,$3,null,true) as r", [world.org.chapter,world.member.id,made.unit],world.admin);
    await allowed(made.journal.id);
    expect((await row("select case_id from public.member_forms where id=$1", [made.form])).case_id).toBeNull();
  });

  // r1s1/r2g1/r2s2: opening a co-signed alliance form needs its own form
  // authority, without the unrelated ordinary grievance-intake requirement.
  // an owner decision replaces the retired committee-only fixture.
  it("allows an accepted co-signer's form undo through a supported unit assignment", async () => {
    const made = await scopedForm({ cosigner: true, retainedRole: "advisor" });
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: world.actor.id, role: "authenticated", session_id: world.actor.session, aal: "aal2" })]);
    expect((await row("select private.chapter_case_intake_role_allows($1,'steward') as allowed", [world.member.id])).allowed).toBe(true);
    await allowed(made.journal.id);
    expect((await row("select case_id from public.member_forms where id=$1", [made.form])).case_id).toBeNull();
  });

  it("refuses a co-signed form after the member leaves the steward unit (2125 ruling)", async () => {
    const made = await scopedForm({ cosigner: true, retainedRole: "advisor" });
    await allowed(made.journal.id);
    await one("select public.set_chapter_access_member($1,$2,$3,null,false) as r", [world.org.chapter,world.member.id,made.unit],world.admin);
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:world.actor.id,role:"authenticated",session_id:world.actor.session,aal:"aal2"})]);
    expect((await row("select private.chapter_case_intake_role_allows($1,'steward') as allowed", [world.member.id])).allowed).toBe(false);
    expect(await call("select public.open_form_as_case($1) as r",[made.form],world.actor)).toMatchObject({ok:false,code:"22023"});
    expect((await row("select case_id from public.member_forms where id=$1",[made.form])).case_id).toBeNull();
  });

  it("keeps import provenance after parent undo and makes a child retry idempotent after admin loss", async () => {
    await role(world.actor, "admin");
    await start();
    const staged = await one("select public.stage_member_operations_import('grievance','cases.csv',$1,$2,$3) as r",
      [{ member_id: "member_id", chapter_id: "chapter_id", reference: "reference", title: "title" },
        JSON.stringify([{ member_id: world.member.id, chapter_id: world.org.chapter, reference: "IMPORT-RETRY", title: "Fictional import" }]), randomUUID()], world.actor);
    const batch = staged.batchId ?? staged.batch_id ?? staged.id;
    await one("select public.validate_member_operations_import($1,$2) as r", [batch, randomUUID()], world.actor);
    await one("select public.commit_member_operations_import($1,$2) as r", [batch, randomUUID()], world.actor);
    const parent = await entry("case_operations_import");
    const child = await row("select id from private.learning_action_journal where parent_entry_id=$1", [parent.id]);
    await allowed(parent.id);
    expect(await row("select action_kind,state from private.learning_action_journal where id=$1", [parent.id]))
      .toEqual({ action_kind: "case_operations_import", state: "undone" });
    await role(world.actor, "admin", false);
    const before = await evidence();
    expect(await one("select public.undo_my_learning_action($1,2) as r", [child.id], world.actor)).toMatchObject({ status: "already_undone" });
    expect(await evidence()).toEqual(before);
  });
});
