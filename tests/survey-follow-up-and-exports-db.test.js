// @vitest-environment node
//
// REQ-UG-SURVEY-ESCALATION-AND-FOLLOWUP-TASKS-20261001 (CR-006/CR-007)
// REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001 (CR-010 + CR-112)
//
// On a disposable database: the derived survey attention matches the old
// coverage-escalation and low-response rules; the hourly sweep turns it into
// response_review / closeout / low_response / coverage_escalation tasks
// without reopening completed ones, marks reminders due and escalated, and
// queues reminders by default unless scheduled
// sending is switched off; the dated report and export apply the privacy floor
// inside the window; filtered exports accept xlsx behind their switch.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261002102000_survey_follow_up_and_exports.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const KEY = {
  automation: "features.engagement_voice.survey_follow_up_automation",
  reminders: "features.engagement_voice.survey_scheduled_reminders",
  exports: "features.engagement_voice.survey_report_exports",
  xlsx: "features.analytics.filtered_export_xlsx",
};

describe("survey follow-up and exports (static)", () => {
  it("registers the switches and limits with their defaults (scheduled reminders ON) and gates every writer", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    for (const [key, value] of [
      [KEY.automation, "'true'"], [KEY.reminders, "'true'"], [KEY.exports, "'true'"], [KEY.xlsx, "'true'"],
      ["limits.engagement_voice.survey_low_response_threshold", "'3'"],
      ["limits.engagement_voice.survey_coverage_uncovered_grace_days", "'2'"],
      ["limits.engagement_voice.survey_coverage_open_stale_days", "'3'"],
      ["limits.engagement_voice.survey_coverage_progress_stale_days", "'7'"],
      ["limits.engagement_voice.survey_first_reminder_days", "'1'"],
      ["limits.engagement_voice.survey_reminder_interval_days", "'3'"],
    ]) {
      expect(migration, key).toMatch(new RegExp(`\\('${key.replaceAll(".", "\\.")}', '(boolean|integer)', '[^']+',\\s+'(?:[^']|'')+',\\s+${value},`));
    }
    for (const name of [
      "private.open_survey_follow_up_task", "private.run_survey_operations_sweep",
      "public.export_organization_survey_window", "public.request_filtered_organization_export",
    ]) {
      const fn = parseFunctions(migration, MIGRATION).find((entry) => entry.name === name);
      expect(fn, name).toBeTruthy();
      expect(helperFirst(fn.source), name).toBe(true);
    }
    expect(stripComments(migration)).toContain("'survey-operations-sweep',\n      '41 * * * *',\n      $job$select private.run_survey_operations_sweep(100);$job$");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("survey follow-up and exports on a disposable database", () => {
  let db;
  let ids;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "survey-follow-up-exports-proof" });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  async function user(label, sessions) {
    const id = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${label}-${id}@example.invalid`]);
    await db.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids.org, id]);
    await db.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [id, ids.chapter]);
    await db.query("update public.member_profiles set chapter_id = $1 where id = $2", [ids.chapter, id]);
    const session = randomUUID();
    await db.query("insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [session, id]);
    await db.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), id]);
    sessions[id] = session;
    return id;
  }

  beforeEach(async () => {
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    ids = { org: randomUUID(), chapter: `survey-follow-up-${randomUUID()}`, sessions: {}, members: [] };
    const bootstrap = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [bootstrap, `bootstrap-${bootstrap}@example.invalid`]);
    await db.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, 'Survey follow-up proof org', $3)", [ids.org, ids.chapter, bootstrap]);
    await db.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, $1, $1, true, 1, $2)", [ids.chapter, ids.org]);
    ids.admin = await user("admin", ids.sessions);
    await db.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [ids.org, ids.admin]);
    await db.query("insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'admin', $2, $1)", [ids.admin, ids.chapter]);
    await db.query("insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'admin', $2, $1)", [ids.admin, ids.chapter]);
    ids.owner = await user("owner", ids.sessions);
    await db.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $3)", [ids.org, ids.owner, ids.admin]);
    for (let index = 0; index < 5; index += 1) ids.members.push(await user(`member${index}`, ids.sessions));
    ids.survey = randomUUID();
    await db.query(
      `insert into public.organization_surveys (id, organization_id, title, status, cadence, owner_user_id, privacy_min_responses, created_by, created_at, operations_state)
       values ($1, $2, 'Workplace check-in', 'open', 'one_off', $3, 3, $3, now() - interval '3 days', 'distributing')`,
      [ids.survey, ids.org, ids.owner],
    );
    ids.question = randomUUID();
    await db.query(
      "insert into public.organization_survey_questions (id, organization_id, survey_id, sort_index, question_type, label, options) values ($1, $2, $3, 0, 'radio', 'Biggest issue?', '[\"Pay\",\"Safety\"]'::jsonb)",
      [ids.question, ids.org, ids.survey],
    );
    ids.distribution = (await db.query(
      `insert into public.organization_survey_tasks (organization_id, survey_id, reason, status, assigned_to, created_by)
       values ($1, $2, 'distribution', 'in_progress', $3, $3) returning id`,
      [ids.org, ids.survey, ids.owner],
    )).rows[0].id;
    for (const member of ids.members) {
      await db.query(
        `insert into public.organization_survey_deliveries (organization_id, survey_id, recipient_user_id, state, sent_at, created_at)
         values ($1, $2, $3, 'sent', now() - interval '2 days', now() - interval '2 days')`,
        [ids.org, ids.survey, member],
      );
    }
  });
  afterEach(async () => { await db.query("rollback"); });

  async function as(userId, sql, values = []) {
    await db.query("savepoint caller");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: ids.sessions[userId] })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint caller");
      return { code: "", rows: result.rows };
    } catch (error) {
      await db.query("rollback to savepoint caller");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message };
    }
  }

  const setting = (key, value) => db.query(
    "insert into public.organization_setting_values (organization_id, setting_key, value, updated_by) values ($1, $2, $3::jsonb, $4) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [ids.org, key, JSON.stringify(value), ids.admin],
  );
  const state = async () => (await db.query("select private.survey_operations_state($1) s", [ids.survey])).rows[0].s;
  const sweep = async () => (await db.query("select private.run_survey_operations_sweep(100) r")).rows[0].r;
  const tasks = async () => (await db.query("select reason, status from public.organization_survey_tasks where survey_id = $1 order by reason", [ids.survey])).rows;
  async function respond(count, submittedAt = "now()", from = 0) {
    for (const member of ids.members.slice(from, count)) {
      const session = (await db.query(
        `insert into public.organization_survey_sessions (organization_id, survey_id, respondent_user_id, status, submitted_at)
         values ($1, $2, $3, 'submitted', ${submittedAt}) returning id`,
        [ids.org, ids.survey, member],
      )).rows[0].id;
      await db.query("insert into public.organization_survey_answers (organization_id, session_id, question_id, value) values ($1, $2, $3, '\"Pay\"'::jsonb)", [ids.org, session, ids.question]);
    }
  }

  it("derives the old low-response and reminder signals for a quiet survey", async () => {
    const current = await state();
    expect(current).toMatchObject({ reviewReady: false, closeoutDue: false, escalation: null });
    expect(current.lowResponse).toEqual({ state: "no_responses", threshold: 3, due: true });
    expect(current.reminder).toMatchObject({ due: true, cadenceDays: 1, scheduledSending: true });
  });

  it("the sweep opens a low-response task, marks reminders due, sends nothing when scheduled sending is turned off, and is idempotent", async () => {
    await setting(KEY.reminders, false);
    expect(await sweep()).toEqual({ tasksCreated: 1, remindersDue: 5, escalated: 0, remindersQueued: 0 });
    expect(await tasks()).toEqual([{ reason: "distribution", status: "in_progress" }, { reason: "low_response", status: "open" }]);
    expect((await db.query("select count(*)::int c from public.engagement_delivery_outbox where source_id = $1", [String(ids.survey)])).rows[0].c).toBe(0);
    expect(await sweep()).toEqual({ tasksCreated: 0, remindersDue: 0, escalated: 0, remindersQueued: 0 });
    const audit = (await db.query("select metadata from public.organization_audit_events where organization_id = $1 and event_type = 'survey_task_updated'", [ids.org])).rows;
    expect(audit).toEqual([{ metadata: expect.objectContaining({ reason: "low_response", reasonCode: "scheduled", surveyId: ids.survey }) }]);
  });

  it("queues each due reminder once by default, with no setting written", async () => {
    expect(await sweep()).toMatchObject({ remindersDue: 5, remindersQueued: 5 });
    expect((await db.query("select count(*)::int c from public.engagement_delivery_outbox where source_id = $1 and delivery_kind = 'survey_reminder'", [String(ids.survey)])).rows[0].c).toBe(5);
    expect(await sweep()).toMatchObject({ remindersQueued: 0 });
    const audit = (await db.query("select metadata from public.organization_audit_events where organization_id = $1 and event_type = 'survey_reminders_queued'", [ids.org])).rows;
    expect(audit).toEqual([{ metadata: expect.objectContaining({ count: 5, reasonCode: "scheduled" }) }]);
  });

  it("escalates a due reminder still unanswered after the progress window", async () => {
    await sweep();
    await db.query("update public.organization_survey_deliveries set updated_at = now() - interval '8 days' where survey_id = $1 and recipient_user_id = $2", [ids.survey, ids.members[0]]);
    expect(await sweep()).toMatchObject({ escalated: 1 });
    expect((await db.query("select escalation_state from public.organization_survey_deliveries where survey_id = $1 and recipient_user_id = $2", [ids.survey, ids.members[0]])).rows[0].escalation_state).toBe("escalated");
  });

  it("follows the old coverage escalation rules and never reopens a task staff completed", async () => {
    await db.query("update public.organization_survey_tasks set updated_at = now() - interval '8 days' where id = $1", [ids.distribution]);
    expect((await state()).escalation).toMatchObject({ level: "monitor", reason: "coverage_stalled", recommendedAction: "open_task" });
    await sweep();
    expect((await tasks()).map((task) => task.reason)).not.toContain("coverage_escalation");
    await db.query("update public.organization_surveys set owner_user_id = null where id = $1", [ids.survey]);
    expect((await state()).escalation).toMatchObject({ level: "elevated", reason: "coverage_unassigned", thresholdDays: 2 });
    await sweep();
    expect(await tasks()).toEqual(expect.arrayContaining([{ reason: "coverage_escalation", status: "open" }]));
    await db.query("update public.organization_survey_tasks set status = 'done' where survey_id = $1 and reason in ('coverage_escalation', 'low_response')", [ids.survey]);
    await sweep();
    expect((await tasks()).filter((task) => ["coverage_escalation", "low_response"].includes(task.reason))).toEqual([
      { reason: "coverage_escalation", status: "done" }, { reason: "low_response", status: "done" },
    ]);
  });

  it("opens response review at the held floor of 25, not the survey floor of 3, and closeout once the survey closes", async () => {
    // REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: review
    // readiness follows the review lane and the reports, which stay withheld
    // below 25 whatever the survey's own floor.
    for (let index = 5; index < 25; index += 1) ids.members.push(await user(`member${index}`, ids.sessions));
    await respond(3);
    const early = await state();
    expect(early).toMatchObject({ reviewReady: false, escalation: null, lowResponse: { state: "below_threshold" } });
    await sweep();
    expect((await tasks()).map((task) => task.reason)).not.toContain("response_review");
    await respond(24, "now()", 3);
    expect(await state()).toMatchObject({ reviewReady: false, escalation: null });
    await sweep();
    expect((await tasks()).map((task) => task.reason)).not.toContain("response_review");
    await respond(25, "now()", 24);
    const ready = await state();
    expect(ready).toMatchObject({ reviewReady: true, lowResponse: null });
    expect(ready.escalation).toMatchObject({ reason: "review_handoff_overdue", level: "monitor" });
    await sweep();
    expect((await tasks()).map((task) => task.reason)).toContain("response_review");
    await db.query("update public.organization_surveys set status = 'closed' where id = $1", [ids.survey]);
    await sweep();
    expect((await tasks()).map((task) => task.reason)).toContain("closeout");
  });

  it("does nothing for an organization that turned automation off", async () => {
    await setting(KEY.automation, false);
    expect(await sweep()).toEqual({ tasksCreated: 0, remindersDue: 0, escalated: 0, remindersQueued: 0 });
    expect(await tasks()).toEqual([{ reason: "distribution", status: "in_progress" }]);
  });

  it("shows the attention to staff only", async () => {
    const staff = await as(ids.owner, "select public.get_survey_operations_attention() a");
    expect(staff.code).toBe("");
    expect(staff.rows[0].a).toMatchObject({ automation: true, scheduledReminders: true, exports: true });
    expect(staff.rows[0].a.surveys).toEqual([expect.objectContaining({ surveyId: ids.survey, lowResponse: expect.objectContaining({ state: "no_responses" }) })]);
    expect(staff.rows[0].a.surveys[0]).not.toHaveProperty("ownerUserId");
    expect((await as(ids.members[0], "select public.get_survey_operations_attention() a")).code).toBe("42501");
  });

  it("applies the privacy floor inside the report window and refuses a narrow export", async () => {
    // The survey floor is 3, but reports and exports never go below 25
    // (REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104): 2 older
    // and 23 recent responses make 25 in all and 23 in the narrow window.
    for (let index = 5; index < 25; index += 1) ids.members.push(await user(`member${index}`, ids.sessions));
    await respond(2, "now() - interval '10 days'");
    await db.query("savepoint more");
    for (const member of ids.members.slice(2, 25)) {
      const session = (await db.query(
        "insert into public.organization_survey_sessions (organization_id, survey_id, respondent_user_id, status, submitted_at) values ($1, $2, $3, 'submitted', now()) returning id",
        [ids.org, ids.survey, member],
      )).rows[0].id;
      await db.query("insert into public.organization_survey_answers (organization_id, session_id, question_id, value) values ($1, $2, $3, '\"Safety\"'::jsonb)", [ids.org, session, ids.question]);
    }
    await db.query("release savepoint more");
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const narrow = await as(ids.owner, "select public.get_organization_survey_report_window($1, $2, null) r", [ids.survey, recent]);
    expect(narrow.rows[0].r).toMatchObject({ available: false, responseCount: 23, privacyMinResponses: 25, questions: [] });
    expect((await as(ids.owner, "select public.export_organization_survey_window($1, $2, null, 'csv') r", [ids.survey, recent])).code).toBe("22023");
    const full = await as(ids.owner, "select public.export_organization_survey_window($1, null, null, 'xlsx') r", [ids.survey]);
    expect(full.code).toBe("");
    expect(full.rows[0].r).toMatchObject({ available: true, responseCount: 25, privacyMinResponses: 25, format: "xlsx" });
    expect(full.rows[0].r.responses).toHaveLength(25);
    expect(full.rows[0].r.questions[0].distribution).toEqual([{ value: "Pay", count: 2 }, { value: "Safety", count: 23 }]);
    const audit = (await db.query("select metadata from public.organization_audit_events where organization_id = $1 and event_type = 'organization_export_completed'", [ids.org])).rows;
    expect(audit).toEqual([{ metadata: expect.objectContaining({ exportType: "survey", exportFormat: "xlsx", rowCount: 25 }) }]);
    expect((await as(ids.members[0], "select public.export_organization_survey_window($1, null, null, 'csv') r", [ids.survey])).code).toBe("42501");
    await setting(KEY.exports, false);
    expect((await as(ids.owner, "select public.get_organization_survey_report_window($1, null, null) r", [ids.survey])).code).toBe("55000");
  });

  it("filtered organization exports accept xlsx behind their switch", async () => {
    const workbook = await as(ids.admin, "select public.request_filtered_organization_export(array['members'], 'xlsx', null, null, null) r");
    expect(workbook.code, workbook.message).toBe("");
    expect(workbook.rows[0].r).toMatchObject({ format: "xlsx" });
    expect((await db.query("select format from public.organization_data_export_runs where organization_id = $1", [ids.org])).rows).toEqual([{ format: "xlsx" }]);
    await setting(KEY.xlsx, false);
    expect((await as(ids.admin, "select public.request_filtered_organization_export(array['members'], 'xlsx', null, null, null) r")).code).toBe("22023");
    expect((await as(ids.admin, "select public.request_filtered_organization_export(array['members'], 'csv', null, null, null) r")).code).toBe("");
  });

  it("installs the hourly sweep", async () => {
    const job = (await db.query("select schedule, command, active from cron.job where jobname = 'survey-operations-sweep'")).rows;
    expect(job).toEqual([{ schedule: "42 * * * *", command: "select private.run_survey_operations_sweep(100);", active: true }]);
  });
});
