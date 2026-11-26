// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103 (#6942), part 2 of 2:
// a person's own case workflow actions during the learning period (step
// moves, deadlines and extensions, checklists, reminders, intake drafts,
// scores, macros, intake conversion and imports) are journalled from the case
// history rows they wrote and undone without losing that history: a step
// goes back by a reverse transition, anything else is put back as it was;
// someone else's later change refuses the undo; no client inserts a reminder
// or checklist. Retaliation reports and pattern notes are #6943's, recorded
// and kept (20261104120000); this slice leaves their writers alone.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261104123000_learning_period_case_workflow.sql";
const code = stripComments(readFileSync(`supabase/migrations/${FILE}`, "utf8"));

describe("learning period case workflow migration (offline)", () => {
  it("registers a reversing kind per covered table, one parent per writer, and takes away the direct client inserts", () => {
    for (const table of ["step_transitions", "deadlines", "deadline_extensions", "checklists", "checklist_items", "reminders",
      "intake_drafts", "strength_analyses"]) {
      expect(code).toContain(`('casework_${table}_change', 'cases', 'reverse', 'public.casework_${table}', false, 'private.learning_undo_casework'`);
    }
    for (const [writer, kind] of [["casework_advance_step", "casework_step_advance"], ["casework_create_deadline", "casework_deadline_create"],
      ["casework_set_deadline_status", "casework_deadline_status"], ["casework_request_deadline_extension", "casework_extension_request"],
      ["casework_decide_deadline_extension", "casework_extension_decide"], ["casework_set_checklist_item", "casework_checklist_item"],
      ["casework_set_reminder_status", "casework_reminder_status"], ["casework_save_intake_draft", "casework_draft_save"],
      ["casework_score_case", "casework_case_score"],
      ["commit_member_operations_import", "case_operations_import"], ["create_my_case_reminder", "casework_reminder_create"]]) {
      const start = code.search(new RegExp(`create (or replace )?function public\\.${writer}\\(`, "i"));
      expect(start, writer).toBeGreaterThan(-1);
      const body = code.slice(start, code.indexOf("$function$;", start));
      expect(body, writer).toContain(`private.learning_casework_journal('${kind}'`);
      // The graph lock comes first, before any declaration runs.
      const head = body.slice(body.indexOf("$function$"), body.indexOf("$function$") + 120);
      expect(head, writer).toMatch(/perform private\.lock_case_graph\(array\[(\(select )?auth\.uid\(\)\)?\]/);
    }
    expect(code).toContain("revoke insert on public.casework_reminders from authenticated;");
    expect(code).toContain("revoke insert on public.casework_checklists from authenticated;");
    expect(readFileSync("src/lib/caseworkApi.js", "utf8")).not.toMatch(/from\("casework_(reminders|checklists)"\)\.insert/);
    // The retaliation family is #6943's: no kind, journal call or re-emitted writer here.
    expect(code).not.toMatch(/casework_retaliation|retaliation_pattern/);
  });

  it("hands every earlier slice's handler to the dispatcher it found installed, copying none", () => {
    expect(code).toContain("alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_case_workflow;");
    const start = code.indexOf("create function private.learning_dispatch(");
    const body = code.slice(start, code.indexOf("$function$;", start));
    expect(body.match(/when '[a-z_.]+' then return/g)).toEqual([
      "when 'private.learning_undo_casework' then return", "when 'private.learning_undo_casework_macro' then return"]);
    expect(body).toContain("else return private.learning_dispatch_before_case_workflow(p_handler, p_mode, p_entry);");
  });

  it("never deletes a step transition to undo it", () => {
    const start = code.indexOf("create function private.learning_undo_casework(");
    const body = code.slice(start, code.indexOf("$function$;", start));
    expect(body).not.toMatch(/delete\s+from\s+public\.casework_step_transitions\b/i);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period case workflow on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-case-workflow-proof" });
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
  const row = async (text, values = []) => (await c.query(text, values)).rows[0];

  async function person(org, role) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, org.chapter, `Proof ${role}`]);
    if (role !== "member") {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org.id, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, org.chapter]);
      await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, org.chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const org = { id: randomUUID(), chapter: `learning-flow-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98319)", [org.chapter, org.id]);
    world = { org, admin: await person(org, "admin"), coordinator: await person(org, "coordinator"),
      other: await person(org, "coordinator"), member: await person(org, "member") };
    world.case = randomUUID();
    await c.query(`insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status,coordinator_user_id,created_at)
      values ($1,$2,$3,$4,'FLOW-1','Workflow proof','Grievance','intake','active',$5,'2026-09-18 14:00+00')`,
    [world.case, world.member.id, org.id, org.chapter, world.coordinator.id]);
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], world.admin);
  // The action's journal entries, parent first.
  const action = async (kind) => {
    const parent = await row("select id from private.learning_action_journal where action_kind = $1 order by created_at desc, id desc limit 1", [kind]);
    expect(parent, kind).toBeTruthy();
    const children = (await c.query("select id, action_kind, target_table, state from private.learning_action_journal where parent_entry_id = $1 order by created_at, id", [parent.id])).rows;
    return { parent: parent.id, children, kinds: children.map((entry) => entry.action_kind) };
  };
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const undone = async (user, entry) => expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry], user)).toMatchObject({ status: "undone" });
  const count = async (table, where = "case_id = $1", values = [world.case]) => (await row(`select count(*)::int as n from public.${table} where ${where}`, values)).n;
  const steps = [
    { key: "intake", label: "Intake", deadline_rule: { kind: "none", count: 0, from: "step_entry" } },
    { key: "review", label: "Review", deadline_rule: { kind: "calendar_days", count: 5, from: "step_entry" } },
    { key: "finish", label: "Finish", deadline_rule: { kind: "none", count: 0, from: "step_entry" }, terminal: true },
  ];

  it("undoes a procedure step move with its deadline and checklist, by a reverse transition that keeps the move in history", async () => {
    await one("select public.casework_save_procedure(null, null, null, 'Proof procedure', $1, null) as r", [JSON.stringify(steps)], world.admin);
    await one("select public.casework_create_checklist_template($1, 'Grievance', 'review', 'Evidence', '[{\"label\":\"Collect evidence\",\"required\":true}]') as r", [world.org.chapter], world.admin);
    await start();
    await one("select (public.casework_advance_step($1, 'intake', 'review', 'Filed', $2)).id as r", [world.case, randomUUID()], world.coordinator);
    const moved = await action("casework_step_advance");
    expect(moved.kinds).toEqual(expect.arrayContaining(["casework_step_transitions_change", "casework_deadlines_change",
      "case_edit", "casework_checklists_change", "casework_checklist_items_change"]));
    expect(await count("casework_deadlines")).toBe(1);
    expect(await undo(world.member, moved.parent)).toMatchObject({ ok: false, code: "P0002" });
    await undone(world.coordinator, moved.parent);
    expect((await row("select step from public.member_cases where id = $1", [world.case])).step).toBe("intake");
    expect(await count("casework_deadlines")).toBe(0);
    expect(await count("casework_checklists")).toBe(0);
    expect((await c.query("select from_step, to_step, outcome from public.casework_step_transitions where case_id = $1 order by outcome", [world.case])).rows)
      .toEqual([{ from_step: "intake", to_step: "review", outcome: "Filed" }, { from_step: "review", to_step: "intake", outcome: "Undone during the learning period" }]);
    // The case can move again afterwards.
    expect(await call("select (public.casework_advance_step($1, 'intake', 'review', 'Filed again', $2)).id as r", [world.case, randomUUID()], world.coordinator)).toMatchObject({ ok: true });
  });

  it("undoes a free-text step move and refuses once someone else moved the case on", async () => {
    await start();
    await one("select (public.casework_advance_step($1, 'intake', 'Step 1', 'Filed', $2)).id as r", [world.case, randomUUID()], world.coordinator);
    const first = await action("casework_step_advance");
    await one("select (public.casework_advance_step($1, 'Step 1', 'Step 2', 'Heard', $2)).id as r", [world.case, randomUUID()], world.other);
    expect(await undo(world.coordinator, first.parent)).toMatchObject({ ok: false, code: "PT409" });
    const second = await action("casework_step_advance");
    await undone(world.other, second.parent);
    await undone(world.coordinator, first.parent);
    expect((await row("select step from public.member_cases where id = $1", [world.case])).step).toBe("intake");
  });

  it("undoes a new deadline and its status change, and refuses once someone else changed it", async () => {
    await start();
    const deadline = await one("select (public.casework_create_deadline($1, 'filing', 'File response', now() + interval '3 days')).id as r", [world.case], world.coordinator);
    const created = await action("casework_deadline_create");
    expect(created.kinds).toEqual(["casework_deadlines_change"]);
    await one("select (public.casework_set_deadline_status($1, 'met')).id as r", [deadline], world.coordinator);
    const status = await action("casework_deadline_status");
    await undone(world.coordinator, status.parent);
    expect((await row("select status from public.casework_deadlines where id = $1", [deadline])).status).toBe("active");
    await undone(world.coordinator, created.parent);
    expect(await count("casework_deadlines")).toBe(0);
    // Undoing a creation takes the person's own later change with it.
    const both = await one("select (public.casework_create_deadline($1, 'filing', 'Both', now() + interval '3 days')).id as r", [world.case], world.coordinator);
    const bothCreated = await action("casework_deadline_create");
    await one("select (public.casework_set_deadline_status($1, 'met')).id as r", [both], world.coordinator);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [bothCreated.parent], world.coordinator)).toMatchObject({ status: "undone" });
    expect(await count("casework_deadlines", "id = $1", [both])).toBe(0);
    // History keeps every version of the removed deadline.
    expect((await row("select count(*)::int as n from private.casework_record_versions where record_table = 'casework_deadlines' and record_id = $1", [deadline])).n).toBeGreaterThanOrEqual(4);

    const kept = await one("select (public.casework_create_deadline($1, 'filing', 'Kept', now() + interval '3 days')).id as r", [world.case], world.coordinator);
    const keptAction = await action("casework_deadline_create");
    await one("select (public.casework_set_deadline_status($1, 'met')).id as r", [kept], world.other);
    expect(await undo(world.coordinator, keptAction.parent)).toMatchObject({ ok: false, code: "PT409" });
  });

  it("undoes an extension decision to undecided with the due date it moved, then the request itself", async () => {
    await start();
    const deadline = await one("select (public.casework_create_deadline($1, 'filing', 'File response', '2026-12-01 15:00+00')).id as r", [world.case], world.coordinator);
    const extension = await one("select (public.casework_request_deadline_extension($1, '2026-12-08 15:00+00', 'Need records', $2)).id as r", [deadline, randomUUID()], world.coordinator);
    const requested = await action("casework_extension_request");
    expect(requested.kinds).toEqual(["casework_deadline_extensions_change"]);
    await one("select (public.casework_decide_deadline_extension($1, 'approved')).id as r", [extension], world.other);
    const decided = await action("casework_extension_decide");
    expect(decided.kinds).toEqual(expect.arrayContaining(["casework_deadline_extensions_change", "casework_deadlines_change"]));
    expect(await undo(world.coordinator, requested.parent)).toMatchObject({ ok: false, code: "PT409" });
    await undone(world.other, decided.parent);
    expect(await row("select e.status, d.due_at = '2026-12-01 15:00+00'::timestamptz as restored from public.casework_deadline_extensions e join public.casework_deadlines d on d.id = e.deadline_id where e.id = $1", [extension]))
      .toEqual({ status: "requested", restored: true });
    await undone(world.coordinator, requested.parent);
    expect(await count("casework_deadline_extensions", "id = $1", [extension])).toBe(0);
  });

  it("undoes a checklist item check-off", async () => {
    await one("select public.casework_save_procedure(null, null, null, 'Proof procedure', $1, null) as r", [JSON.stringify(steps)], world.admin);
    await one("select public.casework_create_checklist_template($1, 'Grievance', 'review', 'Evidence', '[{\"label\":\"Collect evidence\",\"required\":true}]') as r", [world.org.chapter], world.admin);
    await one("select (public.casework_advance_step($1, 'intake', 'review', 'Filed', $2)).id as r", [world.case, randomUUID()], world.coordinator);
    await start();
    const item = (await row("select i.id from public.casework_checklist_items i join public.casework_checklists l on l.id = i.checklist_id where l.case_id = $1", [world.case])).id;
    await one("select (public.casework_set_checklist_item($1, true)).id as r", [item], world.coordinator);
    const checked = await action("casework_checklist_item");
    expect(checked.kinds).toContain("casework_checklist_items_change");
    await undone(world.coordinator, checked.parent);
    expect(await row("select completed_at, completed_by from public.casework_checklist_items where id = $1", [item])).toEqual({ completed_at: null, completed_by: null });
  });

  it("creates a reminder only through the journalled RPC, and undoes it and its status change", async () => {
    await start();
    const direct = await call(`insert into public.casework_reminders(case_id,organization_id,chapter_id,owner_user_id,title,remind_at)
      values ($1,$2,$3,$4,'Direct',now() + interval '1 day')`, [world.case, world.org.id, world.org.chapter, world.member.id], world.member);
    expect(direct).toMatchObject({ ok: false, code: "42501" });
    expect(await call(`insert into public.casework_checklists(case_id,organization_id,chapter_id,step,title,created_by)
      values ($1,$2,$3,'intake','Direct',$4)`, [world.case, world.org.id, world.org.chapter, world.coordinator.id], world.coordinator)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.create_my_case_reminder($1, 'Not mine', now() + interval '1 day') as r", [world.case], await person(world.org, "member"))).toMatchObject({ ok: false });
    const reminder = await one("select (public.create_my_case_reminder($1, '  Call the steward  ', now() + interval '1 day')).id as r", [world.case], world.member);
    expect(await row("select owner_user_id, title, status, recurrence from public.casework_reminders where id = $1", [reminder]))
      .toEqual({ owner_user_id: world.member.id, title: "Call the steward", status: "scheduled", recurrence: "none" });
    const created = await action("casework_reminder_create");
    expect(created.kinds).toEqual(["casework_reminders_change"]);
    await one("select (public.casework_set_reminder_status($1, 'completed', null)).id as r", [reminder], world.member);
    const status = await action("casework_reminder_status");
    await undone(world.member, status.parent);
    expect((await row("select status from public.casework_reminders where id = $1", [reminder])).status).toBe("scheduled");
    await undone(world.member, created.parent);
    expect(await count("casework_reminders")).toBe(0);
  });

  it("undoes a new intake draft and a draft revision", async () => {
    await start();
    const draft = await one("select (public.casework_save_intake_draft(null, $1, $2, null, '{\"facts\":\"first\"}', null)).id as r", [world.org.chapter, world.member.id], world.coordinator);
    const saved = await action("casework_draft_save");
    await one("select (public.casework_save_intake_draft($1, $2, $3, null, '{\"facts\":\"second\"}', 1)).id as r", [draft, world.org.chapter, world.member.id], world.coordinator);
    const revised = await action("casework_draft_save");
    expect(revised.parent).not.toBe(saved.parent);
    await undone(world.coordinator, revised.parent);
    expect(await row("select payload, revision from public.casework_intake_drafts where id = $1", [draft])).toEqual({ payload: { facts: "first" }, revision: 1 });
    await undone(world.coordinator, saved.parent);
    expect(await count("casework_intake_drafts", "id = $1", [draft])).toBe(0);
  });

  it("undoes a case strength score", async () => {
    await start();
    await one("select (public.casework_score_case($1, '{\"facts\":4,\"documentation\":3}', $2)).id as r", [world.case, randomUUID()], world.coordinator);
    const scored = await action("casework_case_score");
    expect(scored.kinds).toEqual(["casework_strength_analyses_change"]);
    await undone(world.coordinator, scored.parent);
    expect(await count("casework_strength_analyses")).toBe(0);
  });

  it("undoes a macro save: a new macro is retired, an edit is put back", async () => {
    await start();
    const actions = JSON.stringify([{ kind: "add_note", body: "Called the member" }]);
    const made = await call("select public.casework_save_macro(null, $1, 'Call log', $2, true) as r", [world.org.chapter, actions], world.admin);
    expect(made, JSON.stringify(made)).toMatchObject({ ok: true });
    const macro = made.rows[0].r.id;
    const created = await row("select id from private.learning_action_journal where action_kind = 'casework_macro_save' and target_id = $1", [macro]);
    await one("select public.casework_save_macro($1, $2, 'Call log renamed', $3, true) as r", [macro, world.org.chapter, actions], world.admin);
    const edited = await row("select id from private.learning_action_journal where action_kind = 'casework_macro_save' and target_id = $1 order by created_at desc, id desc limit 1", [macro]);
    await undone(world.admin, edited.id);
    expect(await row("select name, active from public.casework_macros where id = $1", [macro])).toEqual({ name: "Call log", active: true });
    await undone(world.admin, created.id);
    expect(await row("select name, active from public.casework_macros where id = $1", [macro])).toEqual({ name: "Call log", active: false });
  });

  // #7036 r1s4: a task conversion puts its report back too, unless someone triaged it since.
  it("restores an intake report converted into a task, and refuses once it was triaged since", async () => {
    const steward = await person(world.org, "steward");
    await c.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values ($1,'General',$2)", [world.org.chapter, world.admin.id]);
    const intake = async (title) => {
      const id = randomUUID();
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: world.member.id })]);
      await c.query(`insert into public.member_intake_reports(id,chapter_id,reporter_id,category,title,details,status)
        values ($1,$2,$3,'safety',$4,'Details','new')`, [id, world.org.chapter, world.member.id, title]);
      return id;
    };
    const report = await intake("Broken lift");
    await start();
    const converted = await call("select public.convert_member_intake_report($1, 'task') as r", [report], steward);
    expect(converted, JSON.stringify(converted)).toMatchObject({ ok: true });
    const created = await row("select id from private.learning_action_journal where action_kind = 'task_create' order by created_at desc, id desc limit 1");
    await undone(steward, created.id);
    expect(await row("select status, assigned_to, task_id from public.member_intake_reports where id = $1", [report]))
      .toEqual({ status: "new", assigned_to: null, task_id: null });

    const triaged = await intake("Wet floor");
    expect(await call("select public.convert_member_intake_report($1, 'case') as r", [triaged], steward)).toMatchObject({ ok: true });
    const conversion = await action("case_intake_convert");
    expect(await call("select public.triage_member_intake_report($1, 'in_progress', $2) as r", [triaged, world.coordinator.id], world.coordinator)).toMatchObject({ ok: true });
    expect(await undo(steward, conversion.parent)).toMatchObject({ ok: false, code: "PT409" });
  });

  // #7036 r1g3: a member-profile import writes no case, so it offers no Undo.
  it("journals nothing for a member-profile import", async () => {
    await start();
    const staged = await one("select public.stage_member_operations_import('member', 'members.csv', $1, $2, $3) as r",
      [{ member_id: "member_id", job_title: "job_title" }, JSON.stringify([{ member_id: world.member.id, job_title: "Nurse" }]), randomUUID()], world.admin);
    const batch = staged.batchId ?? staged.batch_id ?? staged.id;
    await one("select public.validate_member_operations_import($1, $2) as r", [batch, randomUUID()], world.admin);
    expect(await one("select public.commit_member_operations_import($1, $2) as r", [batch, randomUUID()], world.admin)).toMatchObject({ state: "committed", importedCount: 1 });
    expect((await row("select count(*)::int as n from private.learning_action_journal where action_kind = 'case_operations_import'")).n).toBe(0);
  });

  // #7036 Codex r4468649924 / r1s1: a row with no case is judged by its writer's role today.
  it("refuses to undo a draft once its writer lost the staff role, though still a member", async () => {
    await start();
    const draft = await one("select (public.casework_save_intake_draft(null, $1, $2, null, '{\"facts\":\"first\"}', null)).id as r", [world.org.chapter, world.member.id], world.coordinator);
    const drafted = await action("casework_draft_save");
    for (const table of ["member_roles", "member_role_chapters", "organization_role_grants"]) {
      await c.query(`delete from public.${table} where user_id = $1`, [world.coordinator.id]);
    }
    expect(await undo(world.coordinator, drafted.parent)).toMatchObject({ ok: false, code: "42501" });
    expect(await count("casework_intake_drafts", "id = $1", [draft])).toBe(1);
  });

  // #7036 r2s3: a draft attached to the writer's own case still needs the drafting role.
  it("refuses to undo a draft attached to the writer's own case once they lost the staff role", async () => {
    const own = randomUUID();
    await c.query(`insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status)
      values ($1,$2,$3,$4,'FLOW-OWN','Own case','Grievance','intake','active')`, [own, world.coordinator.id, world.org.id, world.org.chapter]);
    await start();
    const draft = await one("select (public.casework_save_intake_draft(null, $1, $2, $3, '{\"facts\":\"own\"}', null)).id as r", [world.org.chapter, world.coordinator.id, own], world.coordinator);
    const drafted = await action("casework_draft_save");
    for (const table of ["member_roles", "member_role_chapters", "organization_role_grants"]) {
      await c.query(`delete from public.${table} where user_id = $1`, [world.coordinator.id]);
    }
    expect(await undo(world.coordinator, drafted.parent)).toMatchObject({ ok: false, code: "42501" });
    expect(await count("casework_intake_drafts", "id = $1", [draft])).toBe(1);
  });

  // #7036 r2s2: a reminder is undone under its own rule (owner, current case read), not case write access.
  it("lets an unassigned steward who can read the case undo their own reminder", async () => {
    const steward = await person(world.org, "steward");
    await start();
    const reminder = await one("select (public.create_my_case_reminder($1, 'Check in', now() + interval '1 day')).id as r", [world.case], steward);
    expect(await one("select private.casework_staff_can_access($1) as r", [world.case], steward, true)).toBe(false);
    const created = await action("casework_reminder_create");
    expect(await undo(world.member, created.parent)).toMatchObject({ ok: false, code: "P0002" });
    await undone(steward, created.parent);
    expect(await count("casework_reminders", "id = $1", [reminder])).toBe(0);
  });

  // #7036 r2s1: two moves in a row by the same person undo together, judged on the projected step.
  it("undoes two consecutive procedure moves by the same person", async () => {
    await one("select public.casework_save_procedure(null, null, null, 'Proof procedure', $1, null) as r", [JSON.stringify(steps)], world.admin);
    await start();
    await one("select (public.casework_advance_step($1, 'intake', 'review', 'Filed', $2)).id as r", [world.case, randomUUID()], world.coordinator);
    const first = await action("casework_step_advance");
    await one("select (public.casework_advance_step($1, 'review', 'finish', 'Settled', $2)).id as r", [world.case, randomUUID()], world.coordinator);
    await undone(world.coordinator, first.parent);
    expect((await row("select step from public.member_cases where id = $1", [world.case])).step).toBe("intake");
    expect(await count("casework_deadlines")).toBe(0);
    // #7036 r3g1: each move is reversed from the step the newer undo left,
    // newest first, so the history holds exactly one reverse per forward move.
    expect((await c.query("select from_step, to_step from public.casework_step_transitions where case_id = $1 order by from_step, to_step", [world.case])).rows)
      .toEqual([{ from_step: "finish", to_step: "review" }, { from_step: "intake", to_step: "review" },
        { from_step: "review", to_step: "finish" }, { from_step: "review", to_step: "intake" }]);
    expect((await row("select count(*)::int as n from private.learning_action_journal where action_kind = 'casework_step_advance' and state = 'undone'")).n).toBe(2);
  });

  // #7036 r3s1: a staff-only change is undone only by staff who can still work on the case,
  // even when the person also owns the case.
  it("refuses a case owner's undo of a staff-only change once they lost staff access", async () => {
    const own = randomUUID();
    await c.query(`insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status,coordinator_user_id)
      values ($1,$2,$3,$4,'FLOW-OWNER','Owner case','Grievance','intake','active',$2)`, [own, world.coordinator.id, world.org.id, world.org.chapter]);
    const deadline = await one("select (public.casework_create_deadline($1, 'filing', 'File response', now() + interval '3 days')).id as r", [own], world.coordinator);
    await start();
    await one("select (public.casework_set_deadline_status($1, 'met')).id as r", [deadline], world.coordinator);
    const status = await action("casework_deadline_status");
    for (const table of ["member_roles", "member_role_chapters", "organization_role_grants"]) {
      await c.query(`delete from public.${table} where user_id = $1`, [world.coordinator.id]);
    }
    expect(await call("select (public.casework_set_deadline_status($1, 'active')).id as r", [deadline], world.coordinator)).toMatchObject({ ok: false });
    expect(await undo(world.coordinator, status.parent)).toMatchObject({ ok: false, code: "42501" });
    expect((await row("select status from public.casework_deadlines where id = $1", [deadline])).status).toBe("met");
  });

  // #7036 r4s1 (ledgered P2, by design): a recurring reminder whose schedule the sweep
  // advanced has really changed, so its undo is refused and nothing is sent again.
  it("refuses to undo a recurring reminder once the sweep advanced its schedule", async () => {
    await start();
    const reminder = await one("select (public.create_my_case_reminder($1, 'Weekly check', now() - interval '5 minutes', 'daily')).id as r", [world.case], world.member);
    const created = await action("casework_reminder_create");
    await c.query("select set_config('request.jwt.claims', '', true)");
    expect((await row("select private.casework_fire_due_reminders() as n")).n).toBeGreaterThanOrEqual(1);
    const sent = (await row("select count(*)::int as n from public.member_notifications where user_id = $1", [world.member.id])).n;
    expect(await undo(world.member, created.parent)).toMatchObject({ ok: false, code: "PT409" });
    expect(await count("casework_reminders", "id = $1", [reminder])).toBe(1);
    expect((await row("select count(*)::int as n from public.member_notifications where user_id = $1", [world.member.id])).n).toBe(sent);
  });

  // #7036 r4s2: a deadline whose notice the sweep sent can still be undone, and the notice stamps are kept.
  it("undoes a deadline and its status change after the deadline notice was sent", async () => {
    await start();
    const deadline = await one("select (public.casework_create_deadline($1, 'filing', 'File response', now() + interval '3 days', now() - interval '1 minute')).id as r", [world.case], world.coordinator);
    const created = await action("casework_deadline_create");
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("select private.casework_sweep_deadline_reminders()");
    expect((await row("select reminder_disposition, reminder_sent_at is not null as sent from public.casework_deadlines where id = $1", [deadline])).reminder_disposition).toBe("sent");
    await one("select (public.casework_set_deadline_status($1, 'met')).id as r", [deadline], world.coordinator);
    const status = await action("casework_deadline_status");
    await undone(world.coordinator, status.parent);
    expect(await row("select status, reminder_disposition, reminder_sent_at is not null as sent from public.casework_deadlines where id = $1", [deadline]))
      .toEqual({ status: "active", reminder_disposition: "sent", sent: true });
    await undone(world.coordinator, created.parent);
    expect(await count("casework_deadlines", "id = $1", [deadline])).toBe(0);
  });

  // #7036 r3s2: a reminder the sweep has already sent can still be undone, and the send is not recalled or repeated.
  it("undoes a reminder after the delivery sweep sent it", async () => {
    await start();
    const reminder = await one("select (public.create_my_case_reminder($1, 'Call the steward', now() - interval '5 minutes')).id as r", [world.case], world.member);
    const created = await action("casework_reminder_create");
    await c.query("select set_config('request.jwt.claims', '', true)");
    expect((await row("select private.casework_fire_due_reminders() as n")).n).toBeGreaterThanOrEqual(1);
    expect((await row("select last_fired_at is not null as sent from public.casework_reminders where id = $1", [reminder])).sent).toBe(true);
    const sent = (await row("select count(*)::int as n from public.member_notifications where user_id = $1", [world.member.id])).n;
    await undone(world.member, created.parent);
    expect(await count("casework_reminders", "id = $1", [reminder])).toBe(0);
    expect((await row("select count(*)::int as n from public.member_notifications where user_id = $1", [world.member.id])).n).toBe(sent);
  });

  // #7036 Codex r4468649934: a deadline someone asked to extend is not taken away.
  it("refuses to undo a deadline's creation once an extension was requested on it", async () => {
    await start();
    const deadline = await one("select (public.casework_create_deadline($1, 'filing', 'File response', now() + interval '3 days')).id as r", [world.case], world.coordinator);
    const created = await action("casework_deadline_create");
    const extension = await one("select (public.casework_request_deadline_extension($1, now() + interval '9 days', 'Need records', $2)).id as r", [deadline, randomUUID()], world.member);
    expect(await undo(world.coordinator, created.parent)).toMatchObject({ ok: false, code: "PT409" });
    expect(await count("casework_deadlines", "id = $1", [deadline])).toBe(1);
    expect(await call("select (public.casework_decide_deadline_extension($1, 'approved')).id as r", [extension], world.coordinator)).toMatchObject({ ok: true });
  });

  // #7036 r1s3: a removal has a state ({"absent": true}) to journal and compare,
  // so an action that removes a covered row journals it and its undo puts the row back.
  it("journals a removed row and puts it back on undo", async () => {
    const deadline = await one("select (public.casework_create_deadline($1, 'filing', 'Removed', now() + interval '3 days')).id as r", [world.case], world.coordinator);
    await start();
    // One statement removes the deadline and journals the action, as a writer does.
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: world.coordinator.id, session_id: world.coordinator.session, aal: "aal2" })]);
    await c.query(`do $remove$ begin
      delete from public.casework_deadlines where id = '${deadline}';
      perform private.learning_casework_journal('casework_deadline_status', '${world.case}');
    end $remove$`);
    const removed = await action("casework_deadline_status");
    expect(removed.kinds).toEqual(["casework_deadlines_change"]);
    await undone(world.coordinator, removed.parent);
    expect(await row("select label, status from public.casework_deadlines where id = $1", [deadline])).toEqual({ label: "Removed", status: "active" });
  });

  it("refuses an undo once the person can no longer work on the case", async () => {
    await start();
    await one("select (public.casework_create_deadline($1, 'filing', 'File response', now() + interval '3 days')).id as r", [world.case], world.coordinator);
    const created = await action("casework_deadline_create");
    await c.query("update public.member_cases set coordinator_user_id = null where id = $1", [world.case]);
    await c.query("delete from public.member_roles where user_id = $1", [world.coordinator.id]);
    await c.query("delete from public.member_role_chapters where user_id = $1", [world.coordinator.id]);
    await c.query("delete from public.organization_role_grants where user_id = $1", [world.coordinator.id]);
    expect(await undo(world.coordinator, created.parent)).toMatchObject({ ok: false, code: "42501" });
    expect(await count("casework_deadlines")).toBe(1);
  });

  it("undoes a member intake report converted into a case, and an operations import's cases as one action", async () => {
    const steward = await person(world.org, "steward");
    const report = randomUUID();
    // The report takes its chapter from its reporter's own selection.
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: world.member.id })]);
    await c.query(`insert into public.member_intake_reports(id,chapter_id,reporter_id,category,title,details,status)
      values ($1,$2,$3,'safety','Blocked exit','The back exit is blocked','new')`, [report, world.org.chapter, world.member.id]);
    await start();
    const converted = await call("select public.convert_member_intake_report($1, 'case') as r", [report], steward);
    expect(converted, JSON.stringify(converted)).toMatchObject({ ok: true });
    const conversion = await action("case_intake_convert");
    expect(conversion.kinds).toContain("case_create");
    const caseId = (await row("select case_id from public.member_intake_reports where id = $1", [report])).case_id;
    await undone(steward, conversion.parent);
    expect((await row("select learning_undone_at is not null as undone from public.member_cases where id = $1", [caseId])).undone).toBe(true);
    // The report is back as it stood and free to be converted again (#7036 r1s4).
    expect(await row("select status, assigned_to, case_id, task_id from public.member_intake_reports where id = $1", [report]))
      .toEqual({ status: "new", assigned_to: null, case_id: null, task_id: null });
    const again = await call("select public.convert_member_intake_report($1, 'case') as r", [report], steward);
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    expect((await row("select case_id from public.member_intake_reports where id = $1", [report])).case_id).not.toBe(caseId);

    const mapping = { member_id: "member_id", chapter_id: "chapter_id", reference: "reference", title: "title" };
    const rows = [{ member_id: world.member.id, chapter_id: world.org.chapter, reference: "IMP-1", title: "Imported one" },
      { member_id: world.member.id, chapter_id: world.org.chapter, reference: "IMP-2", title: "Imported two" }];
    const staged = await one("select public.stage_member_operations_import('grievance', 'cases.csv', $1, $2, $3) as r", [mapping, JSON.stringify(rows), randomUUID()], world.admin);
    const batch = staged.batchId ?? staged.batch_id ?? staged.id;
    await one("select public.validate_member_operations_import($1, $2) as r", [batch, randomUUID()], world.admin);
    expect(await one("select public.commit_member_operations_import($1, $2) as r", [batch, randomUUID()], world.admin)).toMatchObject({ state: "committed", importedCount: 2 });
    const imported = await action("case_operations_import");
    expect(imported.kinds).toEqual(["case_create", "case_create"]);
    await undone(world.admin, imported.parent);
    expect(await count("member_cases", "reference = any($1) and learning_undone_at is null", [["IMP-1", "IMP-2"]])).toBe(0);
  });

  it("frees the form a case was opened from when that case's creation is undone (#7000 r1s3)", async () => {
    const steward = await person(world.org, "steward");
    const form = randomUUID();
    await c.query(`insert into public.member_forms(id,user_id,template_key,status,answers,organization_id)
      values ($1,$2,'grievance','approved','{}',$3)`, [form, world.member.id, world.org.id]);
    await start();
    const opened = await call("select public.open_form_as_case($1) as r", [form], steward);
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
    const caseId = (await row("select case_id from public.member_forms where id = $1", [form])).case_id;
    const created = await row("select id from private.learning_action_journal where action_kind = 'case_create' and target_id = $1", [caseId]);
    await undone(steward, created.id);
    expect((await row("select case_id from public.member_forms where id = $1", [form])).case_id).toBeNull();
    expect(await call("select public.open_form_as_case($1) as r", [form], steward)).toMatchObject({ ok: true });
  });

  it("keeps the status change of an outcome kept for its size, so the action is refused whole (#7000 r3s4)", async () => {
    const wide = `A${"\u0001".repeat(3998)}A`;
    await one("select public.coordinator_record_case_outcome($1, 'other', $2) as r", [world.case, wide], world.coordinator);
    await start();
    await one("select public.coordinator_record_case_outcome($1, 'settled', 'Paid back') as r", [world.case], world.coordinator);
    const kept = await row("select id, parent_entry_id from private.learning_action_journal where action_kind = 'case_outcome_kept' order by created_at desc, id desc limit 1");
    const parent = await row("select state, before_image from private.learning_action_journal where id = $1", [kept.parent_entry_id]);
    expect(parent).toEqual({ state: "kept", before_image: null });
    expect(await undo(world.coordinator, kept.parent_entry_id)).toMatchObject({ ok: false, code: "55000" });
  });

  it("still dispatches an earlier slice's handler through the hand-off", async () => {
    expect((await row("select to_regprocedure('private.learning_dispatch_before_case_workflow(text,text,jsonb)') is not null as moved")).moved).toBe(true);
    await start();
    // Part 1's note handler (20261104075000) is reached only through the moved dispatcher.
    const note = await one("select public.add_my_case_update($1, 'Practice note') as r", [world.case], world.member);
    const entry = await row("select id from private.learning_action_journal where action_kind = 'case_note_add' and target_id = $1", [note.id]);
    await undone(world.member, entry.id);
    expect((await row("select learning_undone_at is not null as undone from public.member_case_updates where id = $1", [note.id])).undone).toBe(true);
    // A handler no slice registered still fails closed, from the moved dispatcher.
    await c.query("savepoint unknown_handler");
    await expect(c.query("select private.learning_dispatch('private.learning_undo_nothing', 'state', '{}'::jsonb)"))
      .rejects.toMatchObject({ code: "55000", message: "learning undo handler unavailable: private.learning_undo_nothing" });
    await c.query("rollback to savepoint unknown_handler");
  });

  it("journals nothing outside a learning period", async () => {
    await one("select (public.casework_create_deadline($1, 'filing', 'Real', now() + interval '3 days')).id as r", [world.case], world.coordinator);
    expect((await row("select count(*)::int as n from private.learning_action_journal where action_kind like 'casework_%'")).n).toBe(0);
  });
});
