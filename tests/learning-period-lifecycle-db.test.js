// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-END-TO-END-20261103 (#6948), slice 9 of 9
// of #6805. Each earlier slice proves its own domain; this one runs a whole
// learning period on local fictional fixtures and proves the pieces agree:
// an administrator starts the period, people practise in every domain, one
// undo is refused and one fails and is recovered, the clock ends undo, the
// end job reminds, closes and reruns harmlessly, a second organization ends
// early, and afterwards kept records are ordinary records except that items
// created during the period keep the Practice marker (ruling 8), held
// own-message removals are redacted, automations sent nothing, what was sent
// stays sent (ruling 4), the audit trail only grew (ruling 5), and a member
// who joins after the end gets no period (ruling 9). The history and Undo
// screens read the same payloads through their shared model.
//
// The steps run in order inside one transaction that rolls back at the end,
// so each `it` is one stage of the same period and builds on the one before.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { learningPeriodT } from "../src/lib/i18n/learningPeriod.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";
import {
  bannerState, entryStatus, kindText, normalizeHistory, normalizePeriod, practiceBadge, undoRefusalReason,
} from "../src/features/learningPeriod/model.js";

// The record tables that may only ever grow: the ledger, the audit events,
// every domain audit table the slices write and the case and record versions.
const AUDIT_TABLES = [
  "public.organization_audit_ledger",
  "public.organization_audit_events",
  "private.casework_record_versions",
  "public.casework_audit_events",
  "public.coordinator_case_audit",
  "public.member_case_assignment_audit",
  "public.chapter_task_activity",
  "public.chapter_record_versions",
  "public.member_admin_audit",
  "public.member_invitation_audit",
  "public.organization_configuration_audit",
];

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period lifecycle end to end on a disposable database", () => {
  let c;
  // Everything the stages share: people, the records they made and the
  // journal entries those records produced.
  const w = {};
  const made = {};

  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-lifecycle-proof" });
    await c.connect();
    await c.query("begin");
    await releaseLearningPeriodHold(c);
  });
  afterAll(async () => {
    await c?.query("rollback").catch(() => {});
    await c?.end();
  });

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
  const row = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0];
  };
  // Owner SQL with no request claims, the way the scheduler and fixtures run.
  const q = async (text, values = []) => {
    await c.query("select set_config('request.jwt.claims', '', true)");
    return (await c.query(text, values)).rows;
  };
  const asService = async (text, values = []) => {
    await c.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    return (await c.query(text, values)).rows;
  };

  async function organization(label) {
    const org = { id: randomUUID(), chapter: `learning-e2e-${label}-${randomUUID().slice(0, 8)}` };
    await q("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await q("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98320)", [org.chapter, org.id]);
    await q("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [org.chapter]);
    return org;
  }
  async function person(org, role, name) {
    const user = { id: randomUUID(), session: randomUUID(), name };
    await q("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await q("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, org.chapter, name]);
    if (role !== "member") {
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org.id, user.id, role]);
      await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, org.chapter]);
    }
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    // Retain this historical broad fixture grant.
    if (role === "steward") await migrateLegacyStewardFixtures(c);
    return user;
  }

  const en = (key, vars) => learningPeriodT("en", key, vars);
  const es = (key, vars) => learningPeriodT("es", key, vars);
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const entries = async (table, target) => q("select id, action_kind, state, version, actor_user_id, before_image from private.learning_action_journal where target_table = $1 and target_id = $2 order by created_at, id", [table, target]);
  const entry = async (table, target, kind) => (await entries(table, target)).find((e) => e.action_kind === kind);
  const flags = async (table, ids) => Object.fromEntries((await q("select target_id, flag from private.learning_practice_flags($1, $2)", [table, ids])).map((r) => [r.target_id, r.flag]));
  const period = async (org) => (await q("select * from private.organization_learning_periods where organization_id = $1", [org.id]))[0];
  const journalStates = async (org) => Object.fromEntries((await q("select state, count(*)::int as n from private.learning_action_journal where organization_id = $1 group by state", [org.id])).map((r) => [r.state, r.n]));
  // Moves a period's whole window so that it ends at clock + offset: the
  // fixture moves the clock by rewriting the row, past the period guard.
  async function endIn(org, offset) {
    await q("alter table private.organization_learning_periods disable trigger b10_learning_period_guard");
    await q(`update private.organization_learning_periods p
      set starts_at = t.at - pg_catalog.make_interval(hours => p.length_days * 24), ends_at = t.at
      from (select pg_catalog.clock_timestamp() + $2::interval as at) t where p.organization_id = $1`, [org.id, offset]);
    await q("alter table private.organization_learning_periods enable trigger b10_learning_period_guard");
  }
  const endJob = async () => (await asService("select public.run_learning_period_end_job() as r"))[0].r;

  // Audit snapshots: one temporary table per stage and audited table holding a
  // digest of every row, so "only grew" means no earlier row was changed or
  // removed and the count never fell.
  async function snapshot(stage) {
    for (const [index, table] of AUDIT_TABLES.entries()) {
      await q(`create temporary table lifecycle_${stage}_${index} on commit drop as select md5(t::text) as h from ${table} t`);
    }
  }
  async function grewSince(stage) {
    const report = {};
    for (const [index, table] of AUDIT_TABLES.entries()) {
      const [{ missing, before, after }] = await q(`select
        (select count(*)::int from (select h from lifecycle_${stage}_${index} except all select md5(t::text) from ${table} t) gone) as missing,
        (select count(*)::int from lifecycle_${stage}_${index}) as before,
        (select count(*)::int from ${table}) as after`);
      report[table] = { missing, grew: after - before };
    }
    for (const [table, { missing, grew }] of Object.entries(report)) {
      expect(missing, `${table} lost or changed a row since ${stage}`).toBe(0);
      expect(grew, `${table} shrank since ${stage}`).toBeGreaterThanOrEqual(0);
    }
    return report;
  }
  // Every notice delivered to the organization's people, as sent.
  const deliveries = async (org) => q("select n.id, md5(n::text) as h from public.member_notifications n where n.user_id in (select user_id from public.organization_memberships where organization_id = $1) order by n.id", [org.id]);

  it("sets up two fictional organizations and the records that exist before the period", async () => {
    w.a = await organization("a");
    w.b = await organization("b");
    w.admin = await person(w.a, "admin", "Proof administrator");
    w.coordinator = await person(w.a, "coordinator", "Proof coordinator");
    w.grantee = await person(w.a, "coordinator", "Proof grantee");
    w.steward = await person(w.a, "steward", "Proof steward");
    w.otherSteward = await person(w.a, "steward", "Proof other steward");
    w.member = await person(w.a, "member", "Proof member");
    w.otherMember = await person(w.a, "member", "Proof other member");
    w.adminB = await person(w.b, "admin", "Proof administrator B");
    w.stewardB = await person(w.b, "steward", "Proof steward B");
    // Made before the period: nothing about them is journalled.
    made.oldTask = (await row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Existing task" })], w.steward)).id;
    made.editedTask = (await row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Existing task to edit" })], w.steward)).id;
    made.oldEvent = `lifecycle-${randomUUID().slice(0, 12)}`;
    await one("select public.create_member_event($1, 'Existing meeting', now() + interval '3 days', 'Hall B', 'A fictional meeting', null, false, false) as r", [made.oldEvent], w.steward);
    await one("select public.rsvp_to_event($1, 'going') as r", [made.oldEvent], w.member);
    made.restrictedCase = randomUUID();
    await q(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status,coordinator_user_id,coordinator_name,assigned_at,is_restricted,restriction_reason,restricted_at,restricted_by)
      values ($1,$2,$3,$3,'other',$4,$5,'active',$6,'Proof coordinator',now(),true,'Witness statements are sensitive',now(),$6)`,
    [made.restrictedCase, w.member.id, `LP-E2E-${made.restrictedCase.slice(0, 8)}`, w.a.id, w.a.chapter, w.coordinator.id]);
    made.conversation = (await q("insert into public.member_conversations(user_id, title, steward_user_id, organization_id) values ($1, 'Proof conversation', $2, $3) returning id", [w.member.id, w.steward.id, w.a.id]))[0].id;
    made.automation = (await q(`insert into public.organization_automation_definitions
      (organization_id, name, trigger_kind, cadence, status, version, review_status, review_version, created_by, updated_by)
      values ($1, 'Practice overdue tasks', 'overdue_task', 'daily', 'paused', 1, 'approved', 1, $2, $2) returning id`, [w.a.id, w.admin.id]))[0].id;
    await q("insert into public.organization_automation_settings(organization_id, enabled) values ($1, true) on conflict (organization_id) do update set enabled = true", [w.a.id]);
    made.settingKey = (await q("select key from public.platform_setting_definitions where organization_editable and value_kind = 'boolean' and not private.learning_setting_excluded(key) order by key limit 1"))[0].key;
    expect(await q("select count(*)::int as n from private.learning_action_journal where organization_id = any($1::uuid[])", [[w.a.id, w.b.id]])).toEqual([{ n: 0 }]);
    await snapshot("before");
  }, 60000);

  it("lets only the administrator start the one organization-level period", async () => {
    for (const user of [w.member, w.steward, w.coordinator]) {
      expect(await call("select public.start_organization_learning_period() as r", [], user), user.name).toMatchObject({ ok: false, code: "42501" });
    }
    const started = await one("select public.start_organization_learning_period() as r", [], w.admin);
    expect(started).toMatchObject({ organizationId: w.a.id, used: true, running: true, lengthDays: 14, endedEarlyAt: null, closedAt: null });
    made.periodA = started.periodId;
    // Every member sees the same period; the banner says it runs.
    const seen = await one("select public.get_organization_learning_period() as r", [], w.member);
    expect(seen).toMatchObject({ periodId: started.periodId, running: true, isAdmin: false });
    expect(bannerState(normalizePeriod(seen))).toMatchObject({ phase: "running", isAdmin: false, when: started.endsAt });
    expect(bannerState(normalizePeriod(started))).toMatchObject({ phase: "running", isAdmin: true });
    made.periodB = (await one("select public.start_organization_learning_period(7) as r", [], w.adminB)).periodId;
  });

  it("journals practice in every domain, each by its own slice", async () => {
    // Tasks: one kept, one undone, one existing task edited and kept.
    made.task = (await row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Practice task" })], w.steward)).id;
    made.undoneTask = (await row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Practice task to undo" })], w.steward)).id;
    await row("select * from public.update_chapter_task_fields($1, $2::jsonb, null)", [made.editedTask, JSON.stringify({ priority: "high" })], w.steward);
    // Cases: the member's own case and note, a case to undo, and a case a coordinator then works on.
    made.case = (await one("select public.create_member_case('Practice shift swap', null, 'Scheduling', '') as r", [], w.member)).caseId;
    made.note = (await one("select public.add_my_case_update($1, 'Practice note') as r", [made.case], w.member)).id;
    made.undoneCase = (await one("select public.create_member_case('Practice case to undo', null, 'Scheduling', '') as r", [], w.member)).caseId;
    made.workedCase = (await one("select public.create_member_case('Practice case a coordinator works', null, 'Pay', '') as r", [], w.member)).caseId;
    // Case access: a coordinator lets a colleague into a restricted case.
    expect(await one("select count(*)::int as n from public.member_cases where id = $1", [made.restrictedCase], w.grantee)).toBe(0);
    await one("select public.casework_grant_access($1, $2, 'Preparing the step 2 meeting') as r", [made.restrictedCase, w.grantee.id], w.coordinator);
    // Events: a new meeting kept, one undone, and the existing meeting deleted (kept).
    made.event = `lifecycle-${randomUUID().slice(0, 12)}`;
    made.undoneEvent = `lifecycle-${randomUUID().slice(0, 12)}`;
    await one("select public.create_member_event($1, 'Practice meeting', now() + interval '4 days', 'Hall C', 'A fictional meeting', null, false, false) as r", [made.event], w.steward);
    await one("select public.create_member_event($1, 'Practice meeting to undo', now() + interval '5 days', 'Hall D', 'A fictional meeting', null, false, false) as r", [made.undoneEvent], w.steward);
    expect(await one("select public.delete_member_event($1) as r", [made.oldEvent], w.steward)).toMatchObject({ deleted: true });
    // Messages: one sent, one removed and kept removed, one removed and put back, one scheduled.
    const send = async (body) => {
      await one("select public.send_member_message($1, $2) as r", [made.conversation, body], w.member);
      return (await q("select id from public.member_messages where conversation_id = $1 and body = $2", [made.conversation, body]))[0].id;
    };
    made.sent = await send("Practice message that stays sent");
    made.removed = await send("Practice message removed for good marker-e2e1");
    made.restored = await send("Practice message removed then put back");
    for (const id of [made.removed, made.restored]) {
      expect(await one("select public.redact_member_message($1) as r", [id], w.member)).toMatchObject({ held: true, redacted: false });
    }
    made.scheduled = (await one("select public.schedule_member_message($1, 'Practice scheduled message', now() + interval '20 days') as r", [made.conversation], w.member)).id;
    // Automations: switched on during the period, it only previews.
    expect(await call("select public.set_organization_automation_definition_status($1, 'active', 1) as r", [made.automation], w.admin)).toMatchObject({ ok: true });
    made.effectsBefore = (await q("select count(*)::int as n from public.organization_automation_effects where organization_id = $1", [w.a.id]))[0].n;
    expect((await q("select private.run_due_organization_automations(50) as r"))[0].r.previewed).toBeGreaterThanOrEqual(1);
    // Invitations: one sent and left alone, one sent then revoked (kept).
    const invite = async (hash) => {
      await one("select public.create_member_invitation($1, 'Practice Invitee', $2, null, 'en', $3) as r", [`invitee-${randomUUID().slice(0, 8)}@example.invalid`, w.a.chapter, hash], w.admin);
      return (await q("select id from public.member_invitations where token_hash = $1", [hash]))[0].id;
    };
    made.inviteHash = "e".repeat(63) + "1";
    made.invitation = await invite(made.inviteHash);
    made.revokedInvitation = await invite("e".repeat(63) + "2");
    await one("select public.revoke_member_invitation($1) as r", [made.revokedInvitation], w.admin);
    // Exports: requested during the period, it is sent for good.
    await one("select public.request_filtered_organization_export(array['members'], 'csv', null, null, $1) as r", [randomUUID()], w.admin);
    made.exportRun = (await q("select id::text as id from public.organization_data_export_runs where organization_id = $1 and requested_by = $2", [w.a.id, w.admin.id]))[0].id;
    // Roles and settings: a role grant kept, one setting change kept, one profile change undone.
    // This organization journal domain uses a supported coordinator grant.
    await one("select public.set_member_organization_role($1, 'coordinator', true) as r", [w.otherMember.id], w.admin);
    await one("select public.update_organization_setting($1, 'false'::jsonb) as r", [made.settingKey], w.admin);
    await one("select public.update_my_member_profile($1, '{\"language\": \"es\"}'::jsonb) as r", [w.member.id], w.member);
    // Organization B: a steward's task in a period that will be ended early.
    made.taskB = (await row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Practice task B" })], w.stewardB)).id;

    // One entry per action, each in the domain that wrote it.
    const kinds = [
      ["public.chapter_tasks", made.task, "task_create", "active"],
      ["public.chapter_tasks", made.editedTask, "task_edit", "active"],
      ["public.member_cases", made.case, "case_create", "active"],
      ["public.member_case_updates", made.note, "case_note_add", "active"],
      ["public.casework_access_grants", `${made.restrictedCase}:${w.grantee.id}`, "case_access_grant", "active"],
      ["public.member_events", made.event, "event_create", "active"],
      ["public.member_events", made.oldEvent, "event_delete", "active"],
      ["public.member_messages", made.sent, "conversation_start", "kept"],
      ["public.member_messages", made.removed, "message_send", "kept"],
      ["public.member_messages", made.removed, "message_remove_own", "active"],
      ["public.member_scheduled_messages", made.scheduled, "scheduled_message_create", "active"],
      ["public.organization_automation_definitions", made.automation, "automation_activate", "active"],
      ["public.member_invitations", made.invitation, "invitation_send", "kept"],
      ["public.member_invitations", made.revokedInvitation, "invitation_revoke", "active"],
      ["public.organization_data_export_runs", made.exportRun, "organization_export_request", "kept"],
      ["public.organization_role_grants", `${w.a.id}:${w.otherMember.id}:coordinator`, "organization_role_grant", "active"],
      ["public.organization_setting_values", `${w.a.id}:${made.settingKey}`, "organization_setting_change", "active"],
      ["public.member_profiles", w.member.id, "own_settings_update", "active"],
      ["public.chapter_tasks", made.taskB, "task_create", "active"],
    ];
    for (const [table, target, kind, state] of kinds) {
      expect(await entry(table, target, kind), `${kind} on ${table}`).toMatchObject({ state });
    }
    // Nothing a sent action journals holds its content.
    expect((await q("select count(*)::int as n from private.learning_action_journal j where j.organization_id = $1 and j::text like '%marker-e2e1%'", [w.a.id]))[0].n).toBe(0);
    // While the period runs, other members see the Practice marker on what they can already read.
    expect(await flags("public.chapter_tasks", [made.task, made.editedTask, made.oldTask])).toEqual({ [made.task]: "practice", [made.editedTask]: "practice_edit" });
    expect(practiceBadge("practice_edit", { running: true })).toMatchObject({ labelKey: "learningPeriod.badge.edit" });
  }, 60000);

  it("undoes your own actions, keeps the audit trail, and puts held removals back", async () => {
    await snapshot("practice");
    const undone = async (user, table, target, kind) => {
      const e = await entry(table, target, kind);
      expect(await one("select public.undo_my_learning_action($1, 1) as r", [e.id], user), `${kind}`).toMatchObject({ status: "undone" });
      return e.id;
    };
    made.undoneEntries = [
      await undone(w.steward, "public.chapter_tasks", made.undoneTask, "task_create"),
      await undone(w.member, "public.member_cases", made.undoneCase, "case_create"),
      await undone(w.steward, "public.member_events", made.undoneEvent, "event_create"),
      await undone(w.member, "public.member_messages", made.restored, "message_remove_own"),
      await undone(w.member, "public.member_profiles", w.member.id, "own_settings_update"),
    ];
    // Undo hides; it never erases.
    expect((await q("select deleted_at is not null as hidden from public.chapter_tasks where id = $1", [made.undoneTask]))[0]).toEqual({ hidden: true });
    expect((await q("select learning_undone_at is not null as hidden from public.member_cases where id = $1", [made.undoneCase]))[0]).toEqual({ hidden: true });
    expect(await one("select count(*)::int as n from public.member_cases where id = $1", [made.undoneCase], w.member)).toBe(0);
    expect((await q("select count(*)::int as n from private.casework_record_versions where record_table = 'member_cases' and record_id = $1", [made.undoneCase]))[0].n).toBeGreaterThan(1);
    expect((await q("select event_row ->> 'title' as title from private.learning_held_member_events where event_id = $1", [made.undoneEvent]))).toEqual([{ title: "Practice meeting to undo" }]);
    expect((await q("select body, learning_removal_held_at from public.member_messages where id = $1", [made.restored]))[0]).toEqual({ body: "Practice message removed then put back", learning_removal_held_at: null });
    expect((await q("select language from public.member_profiles where id = $1", [w.member.id]))[0].language).toBe("en");
    // One ledger row per undone entry, and nothing earlier changed.
    const ledger = (await q("select metadata ->> 'entryId' as id from public.organization_audit_ledger where organization_id = $1 and event_type = 'learning_action_undone'", [w.a.id])).map((r) => r.id);
    expect(ledger.sort()).toEqual([...made.undoneEntries].sort());
    const report = await grewSince("practice");
    expect(report["public.organization_audit_ledger"].grew).toBeGreaterThanOrEqual(made.undoneEntries.length);
    // An undone creation carries no marker.
    expect(await flags("public.chapter_tasks", [made.undoneTask])).toEqual({});
  }, 60000);

  it("refuses an undo someone else's work depends on, and recovers a failed undo once the conflict is gone", async () => {
    // Refused: a coordinator logged a contact on the member's practice case.
    await one("select public.coordinator_log_case_contact($1, 'phone', 'outbound', 'Called the member', now()) as r", [made.workedCase], w.coordinator);
    const worked = await entry("public.member_cases", made.workedCase, "case_create");
    const refused = await undo(w.member, worked.id);
    expect(refused).toMatchObject({ ok: false, code: "PT409" });
    made.refusedReason = undoRefusalReason(refused);
    expect(made.refusedReason).not.toBe("learningPeriod.reason.failed");
    expect((await q("select learning_undone_at from public.member_cases where id = $1", [made.workedCase]))[0].learning_undone_at).toBeNull();
    expect((await entry("public.member_cases", made.workedCase, "case_create")).state).toBe("active");

    // Failed, then recovered: another steward changed the task, so the undo
    // rolls back whole and the entry stays active; once that change is
    // undone too, the same undo succeeds.
    const ledgerBefore = (await q("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1", [w.a.id]))[0].n;
    made.contested = (await row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Contested task" })], w.otherSteward)).id;
    await row("select * from public.update_chapter_task_fields($1, $2::jsonb, null)", [made.contested, JSON.stringify({ priority: "high" })], w.steward);
    await row("select * from public.update_chapter_task_fields($1, $2::jsonb, null)", [made.contested, JSON.stringify({ blocked: true })], w.otherSteward);
    const mine = (await entries("public.chapter_tasks", made.contested)).find((e) => e.action_kind === "task_edit" && e.actor_user_id === w.steward.id);
    const theirs = (await entries("public.chapter_tasks", made.contested)).find((e) => e.action_kind === "task_edit" && e.actor_user_id === w.otherSteward.id);
    const state = async () => (await q("select priority, blocked, deleted_at from public.chapter_tasks where id = $1", [made.contested]))[0];
    const before = await state();
    const failed = await undo(w.steward, mine.id);
    expect(failed).toMatchObject({ ok: false, code: "PT409" });
    expect(undoRefusalReason(failed)).not.toBe("learningPeriod.reason.failed");
    expect(await state()).toEqual(before);
    expect((await entries("public.chapter_tasks", made.contested)).find((e) => e.id === mine.id)).toMatchObject({ state: "active", version: 1 });
    // A stale expected version is a conflict that changes nothing either.
    expect(await undo(w.steward, mine.id, 2)).toMatchObject({ ok: false, code: "PT409" });
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [theirs.id], w.otherSteward)).toMatchObject({ status: "undone" });
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [mine.id], w.steward)).toMatchObject({ status: "undone", undoneCount: 1 });
    expect(await state()).toMatchObject({ priority: "medium", blocked: false, deleted_at: null });
    // Two successful undos, two ledger rows: the failures added none.
    expect((await q("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1", [w.a.id]))[0].n).toBe(ledgerBefore + 2);
  }, 60000);

  it("shows each person their own history with Undo only where the server offers it", async () => {
    const history = await one("select public.list_my_learning_history(50) as r", [], w.member);
    const normalized = normalizeHistory(history);
    expect(normalized.running).toBe(true);
    const byTarget = (target, kind) => normalized.entries.find((e) => e.targetId === target && e.actionKind === kind);
    expect(entryStatus(byTarget(made.sent, "conversation_start"), { running: true }).status).toBe("sent");
    expect(entryStatus(byTarget(made.removed, "message_send"), { running: true }).status).toBe("sent");
    expect(entryStatus(byTarget(made.removed, "message_remove_own"), { running: true }).status).toBe("available");
    expect(entryStatus(byTarget(made.restored, "message_remove_own"), { running: true }).status).toBe("undone");
    expect(entryStatus(byTarget(made.case, "case_create"), { running: true }).status).toBe("available");
    // The refusal the server gave earlier wins over the offer until the history is read again.
    const worked = byTarget(made.workedCase, "case_create");
    expect(entryStatus(worked, { running: true, refusals: new Map([[worked.id, made.refusedReason]]) })).toEqual({ status: "refused", reasonKey: made.refusedReason });
    // Only the member's own entries: nobody else's practice history.
    const ownIds = new Set((await q("select id::text from private.learning_action_journal where actor_user_id = $1", [w.member.id])).map((r) => r.id));
    expect(normalized.entries.every((e) => ownIds.has(e.id))).toBe(true);
    // Every line this period produced reads as words in English and Spanish,
    // never a raw key. (Most kinds outside tasks read by their domain today.)
    for (const user of [w.admin, w.coordinator, w.steward, w.member]) {
      const lines = normalizeHistory(await one("select public.list_my_learning_history(50) as r", [], user)).entries;
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        for (const [lang, t] of [["en", en], ["es", es]]) expect(kindText(line, t), `${line.actionKind} (${lang})`).not.toMatch(/learningPeriod\./);
      }
    }
  }, 60000);

  it("reminds each person with practice actions three days and one day before the end, once each", async () => {
    const active = Object.fromEntries((await q("select actor_user_id as id, count(*)::int as n from private.learning_action_journal where organization_id = $1 and state = 'active' group by actor_user_id", [w.a.id])).map((r) => [r.id, r.n]));
    const reminders = async () => q("select user_id, body from public.member_notifications where organization_id = $1 and title = 'Your learning period ends soon' order by body", [w.a.id]);
    await endIn(w.a, "48 hours");
    expect((await endJob()).reminded).toBeGreaterThanOrEqual(1);
    const three = await reminders();
    expect(three.map((r) => r.user_id).sort()).toEqual(Object.keys(active).sort());
    for (const notice of three) expect(notice.body).toBe(`In 3 days your ${active[notice.user_id]} practice actions will be kept as real records. Review or undo them before then.`);
    expect((await period(w.a)).reminded_three_days_at).not.toBeNull();
    await endIn(w.a, "12 hours");
    await endJob();
    const both = await reminders();
    expect(both).toHaveLength(2 * Object.keys(active).length);
    // A rerun in the same window sends nothing more.
    await endJob();
    expect(await reminders()).toHaveLength(both.length);
    expect((await period(w.a)).closed_at).toBeNull();
  }, 60000);

  it("ends undo by the wall clock before any job runs", async () => {
    await snapshot("expiry");
    made.deliveries = await deliveries(w.a);
    // The period now ends in a second and a half; this transaction's now()
    // stays before the end, the clock does not.
    await endIn(w.a, "1.5 seconds");
    await q("select pg_sleep(2)");
    expect((await q("select now() < ends_at as before from private.organization_learning_periods where organization_id = $1", [w.a.id]))[0].before).toBe(true);
    const removal = await entry("public.member_messages", made.removed, "message_remove_own");
    const late = await undo(w.member, removal.id);
    expect(late).toMatchObject({ ok: false, code: "55000" });
    expect(undoRefusalReason(late)).toBe("learningPeriod.reason.ended");
    // Nothing done after the end is practice.
    const after = (await row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Task after the end" })], w.steward)).id;
    expect(await entries("public.chapter_tasks", after)).toEqual([]);
    // The screens read the ended period the same way, before the job closes it.
    const seen = await one("select public.get_organization_learning_period() as r", [], w.member);
    expect(seen).toMatchObject({ running: false, closedAt: null });
    expect(bannerState(normalizePeriod(seen))).toMatchObject({ phase: "ended" });
    const history = normalizeHistory(await one("select public.list_my_learning_history(50) as r", [], w.member));
    expect(history.running).toBe(false);
    const line = history.entries.find((e) => e.id === removal.id);
    expect(line).toMatchObject({ state: "active", undoable: false });
    expect(entryStatus(line, { running: history.running })).toEqual({ status: "refused", reasonKey: "learningPeriod.reason.ended" });
    // Still held, still unread by anyone, until the close finishes it.
    expect((await q("select learning_removal_held_at is not null as held from public.member_messages where id = $1", [made.removed]))[0].held).toBe(true);
    await grewSince("expiry");
  }, 60000);

  it("closes the ended period from the end job, and a rerun changes nothing", async () => {
    await snapshot("close");
    const members = (await q("select count(*)::int as n from public.organization_memberships where organization_id = $1 and status = 'active'", [w.a.id]))[0].n;
    expect((await endJob()).finished).toBeGreaterThanOrEqual(1);
    const closed = await period(w.a);
    expect(closed.closed_at).not.toBeNull();
    expect(closed.ended_notice_at).not.toBeNull();
    expect(closed.ended_early_at).toBeNull();
    const ended = await q("select user_id from public.member_notifications where organization_id = $1 and title = 'The learning period has ended'", [w.a.id]);
    expect(ended).toHaveLength(members);
    expect(new Set(ended.map((r) => r.user_id)).size).toBe(members);
    // One ledger row with counts only.
    const [closing] = await q("select actor_user_id, metadata from public.organization_audit_ledger where organization_id = $1 and event_type = 'learning_period_closed'", [w.a.id]);
    expect(closing.actor_user_id).toBeNull();
    expect(Object.keys(closing.metadata).sort()).toEqual(expect.arrayContaining(["periodId", "keptCount", "undoneCount"]));
    expect(Object.values(closing.metadata).every((value) => typeof value === "number" || value === made.periodA)).toBe(true);
    // Every active entry is kept, undone ones stay undone, and no before-image is left.
    const states = await journalStates(w.a);
    expect(states.active).toBeUndefined();
    expect(states.undone).toBe(made.undoneEntries.length + 2);
    expect(closing.metadata).toMatchObject({ keptCount: states.kept - (await q("select count(*)::int as n from private.learning_action_journal j join private.learning_action_kinds k using (action_kind) where j.organization_id = $1 and k.disposition = 'permanent'", [w.a.id]))[0].n, undoneCount: states.undone });
    expect((await q("select count(*)::int as n from private.learning_action_journal where organization_id = $1 and before_image is not null", [w.a.id]))[0].n).toBe(0);
    await grewSince("close");

    await snapshot("rerun");
    const deliveriesAfterClose = await deliveries(w.a);
    const journalAfterClose = await q("select id, state, version, kept_at, undone_at from private.learning_action_journal where organization_id = $1 order by id", [w.a.id]);
    for (let run = 0; run < 2; run += 1) {
      await endJob();
      expect((await q("select private.close_learning_period($1) as r", [made.periodA]))[0].r).toMatchObject({ closed: true, changed: false });
    }
    expect(await deliveries(w.a)).toEqual(deliveriesAfterClose);
    expect(await q("select id, state, version, kept_at, undone_at from private.learning_action_journal where organization_id = $1 order by id", [w.a.id])).toEqual(journalAfterClose);
    const rerun = await grewSince("rerun");
    for (const [table, { grew }] of Object.entries(rerun)) expect(grew, `${table} grew on a rerun`).toBe(0);
  }, 90000);

  it("ends a second organization's period early with the same close, one way", async () => {
    for (const user of [w.stewardB, w.admin]) {
      expect(await call("select public.end_organization_learning_period_early() as r", [], user), user.name).toMatchObject({ ok: false });
    }
    const members = (await q("select count(*)::int as n from public.organization_memberships where organization_id = $1 and status = 'active'", [w.b.id]))[0].n;
    const ended = await one("select public.end_organization_learning_period_early() as r", [], w.adminB);
    expect(ended).toMatchObject({ periodId: made.periodB, running: false, used: true });
    expect(ended.endedEarlyAt).not.toBeNull();
    expect(ended.closedAt).not.toBeNull();
    expect(await journalStates(w.b)).toEqual({ kept: 1 });
    expect(await flags("public.chapter_tasks", [made.taskB])).toEqual({ [made.taskB]: "practice" });
    expect(await q("select user_id from public.member_notifications where organization_id = $1 and title = 'The learning period has ended'", [w.b.id])).toHaveLength(members);
    const taskEntry = await entry("public.chapter_tasks", made.taskB, "task_create");
    expect(await undo(w.stewardB, taskEntry.id)).toMatchObject({ ok: false, code: "55000" });
    // The end job later finds nothing to do for it, and there is no second period.
    await endJob();
    expect((await q("select private.close_learning_period($1) as r", [made.periodB]))[0].r).toMatchObject({ closed: true, changed: false });
    expect(await call("select public.end_organization_learning_period_early() as r", [], w.adminB)).toMatchObject({ ok: false, code: "55000" });
    expect(await call("select public.start_organization_learning_period() as r", [], w.adminB)).toMatchObject({ ok: false, code: "55000" });
  }, 60000);

  it("keeps practice as ordinary records, with the Practice marker only on what was created during the period", async () => {
    // Created during the period: the marker stays (ruling 8).
    expect(await flags("public.chapter_tasks", [made.task, made.editedTask, made.undoneTask, made.oldTask])).toEqual({ [made.task]: "practice" });
    expect(await flags("public.member_cases", [made.case, made.workedCase, made.undoneCase, made.restrictedCase])).toEqual({ [made.case]: "practice", [made.workedCase]: "practice" });
    expect(await flags("public.member_events", [made.event, made.undoneEvent, made.oldEvent])).toEqual({ [made.event]: "practice" });
    expect(await flags("public.member_messages", [made.sent])).toEqual({ [made.sent]: "practice" });
    expect(await flags("public.member_invitations", [made.invitation])).toEqual({ [made.invitation]: "practice" });
    expect(await flags("public.organization_data_export_runs", [made.exportRun])).toEqual({ [made.exportRun]: "practice" });
    // Only changed during it: the change marker is gone.
    expect(await flags("public.casework_access_grants", [`${made.restrictedCase}:${w.grantee.id}`])).toEqual({});
    expect(await flags("public.organization_role_grants", [`${w.a.id}:${w.otherMember.id}:steward`])).toEqual({});
    expect(await flags("public.organization_setting_values", [`${w.a.id}:${made.settingKey}`])).toEqual({});
    expect(practiceBadge("practice", { running: false })).toMatchObject({ labelKey: "learningPeriod.badge.practice" });
    expect(practiceBadge("practice_edit", { running: false })).toBeNull();

    // Kept by default: each is a real record its readers see as before.
    expect(await one("select count(*)::int as n from public.chapter_tasks where id = $1 and deleted_at is null", [made.task], w.otherSteward)).toBe(1);
    expect((await q("select priority from public.chapter_tasks where id = $1", [made.editedTask]))[0].priority).toBe("high");
    for (const user of [w.member, w.coordinator]) {
      expect(await one("select count(*)::int as n from public.member_cases where id = $1", [made.case], user), user.name).toBe(1);
    }
    expect((await q("select learning_undone_at from public.member_case_updates where id = $1", [made.note]))[0].learning_undone_at).toBeNull();
    expect(await one("select count(*)::int as n from public.member_cases where id = $1", [made.restrictedCase], w.grantee)).toBe(1);
    expect(await one("select count(*)::int as n from public.member_events where id = $1", [made.event], w.member)).toBe(1);
    // This fixture grants coordinator, not a new unscoped steward.
    expect((await q("select count(*)::int as n from public.organization_role_grants where organization_id = $1 and user_id = $2 and role = 'coordinator'", [w.a.id, w.otherMember.id]))[0].n).toBe(1);
    expect((await q("select value from public.organization_setting_values where organization_id = $1 and setting_key = $2", [w.a.id, made.settingKey]))[0].value).toBe(false);
    expect((await q("select status from public.member_scheduled_messages where id = $1", [made.scheduled]))[0].status).toBe("pending");
    // A kept event delete is completed as today's hard delete, RSVPs with it.
    expect((await q(`select (select count(*)::int from public.member_events where id = $1) as live,
      (select count(*)::int from public.member_event_rsvps where event_id = $1) as rsvps,
      (select count(*)::int from private.learning_held_member_events where event_id = $1) as held`, [made.oldEvent]))[0]).toEqual({ live: 0, rsvps: 0, held: 0 });
    // A kept revoke is final: its link is gone for good.
    expect((await q("select status, token_hash from public.member_invitations where id = $1", [made.revokedInvitation]))[0]).toEqual({ status: "revoked", token_hash: null });
    // An undone creation stays hidden and is not revived by the close.
    expect((await q("select deleted_at is not null as hidden from public.chapter_tasks where id = $1", [made.undoneTask]))[0].hidden).toBe(true);
    expect((await q("select learning_undone_at is not null as hidden from public.member_cases where id = $1", [made.undoneCase]))[0].hidden).toBe(true);
    expect(await q("select id from public.member_events where id = $1", [made.undoneEvent])).toEqual([]);
  }, 60000);

  it("redacts the held removal, keeps what was sent, and sent nothing from the automation", async () => {
    // The removal the member kept is redacted by the close, through the
    // ordinary redaction: no copy of its text is left anywhere.
    expect((await q("select body, redaction_reason, redacted_by, learning_removal_held_at, body_sha256 is not null as digest from public.member_messages where id = $1", [made.removed]))[0])
      .toEqual({ body: "", redaction_reason: "sender_removed", redacted_by: w.member.id, learning_removal_held_at: null, digest: true });
    const copies = (await q(`select
      (select count(*)::int from public.member_messages m where m.body like '%marker-e2e1%') as rows,
      (select count(*)::int from private.learning_action_journal j where j::text like '%marker-e2e1%') as journal,
      (select count(*)::int from public.organization_audit_ledger l where l::text like '%marker-e2e1%') as ledger`))[0];
    expect(copies).toEqual({ rows: 0, journal: 0, ledger: 0 });
    // Already sent is permanent: the sent message, the restored one and every
    // notice delivered during the period are as they were.
    for (const id of [made.sent, made.restored]) {
      expect(await one("select count(*)::int as n from public.member_messages where id = $1", [id], w.steward), id).toBe(1);
    }
    const now = new Map((await deliveries(w.a)).map((r) => [r.id, r.h]));
    for (const { id, h } of made.deliveries) expect(now.get(id), `notice ${id}`).toBe(h);
    expect((await q("select status, token_hash from public.member_invitations where id = $1", [made.invitation]))[0]).toEqual({ status: "pending", token_hash: made.inviteHash });
    expect(await q("select id::text from public.organization_data_export_runs where id::text = $1", [made.exportRun])).toEqual([{ id: made.exportRun }]);
    // Automations were preview-only: runs were previews, and nothing acted.
    expect((await q("select count(*)::int as n from public.organization_automation_effects where organization_id = $1", [w.a.id]))[0].n).toBe(made.effectsBefore);
    const runs = await q("select mode, status, learning_practice from public.organization_automation_runs where definition_id = $1", [made.automation]);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    for (const run of runs) expect(run).toEqual({ mode: "preview", status: "previewed", learning_practice: true });
  }, 60000);

  it("only ever grew the audit trail across the whole period", async () => {
    const report = await grewSince("before");
    for (const table of ["public.organization_audit_ledger", "public.organization_audit_events", "private.casework_record_versions", "public.chapter_task_activity", "public.member_admin_audit", "public.member_invitation_audit", "public.organization_configuration_audit", "public.casework_audit_events"]) {
      expect(report[table].grew, `${table} recorded the period`).toBeGreaterThan(0);
    }
    const events = (await q("select event_type from public.organization_audit_ledger where organization_id = $1 and entity_type = 'learning_period'", [w.a.id])).map((r) => r.event_type).sort();
    expect(events).toEqual(expect.arrayContaining(["learning_period_closed", "learning_period_started"]));
  }, 60000);

  it("gives a member who joins after the end no period of their own, and the history no Undo", async () => {
    const late = await person(w.a, "member", "Proof late joiner");
    const seen = await one("select public.get_organization_learning_period() as r", [], late);
    expect(seen).toMatchObject({ periodId: made.periodA, used: true, running: false });
    expect(await call("select public.start_organization_learning_period() as r", [], late)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.start_organization_learning_period() as r", [], w.admin)).toMatchObject({ ok: false, code: "55000" });
    await one("select public.update_my_member_profile($1, '{\"language\": \"es\"}'::jsonb) as r", [late.id], late);
    expect(await entries("public.member_profiles", late.id)).toEqual([]);
    expect(normalizeHistory(await one("select public.list_my_learning_history(50) as r", [], late))).toEqual({ running: false, entries: [] });
    // Two weeks after the end the banner is gone for everyone.
    const period = normalizePeriod(seen);
    expect(bannerState(period, Date.parse(period.closedAt) + 15 * 24 * 60 * 60 * 1000)).toBeNull();
    // The people who practised read every line as Kept, Undone, Sent or final; nothing offers Undo.
    for (const user of [w.member, w.steward, w.admin, w.coordinator]) {
      const history = normalizeHistory(await one("select public.list_my_learning_history(50) as r", [], user));
      expect(history.running).toBe(false);
      expect(history.entries.length).toBeGreaterThan(0);
      for (const line of history.entries) {
        expect(line.undoable, line.actionKind).toBe(false);
        expect(["kept", "undone", "sent", "final"]).toContain(entryStatus(line, { running: false }).status);
      }
      const removal = await entry("public.member_messages", made.removed, "message_remove_own");
      if (user === w.member) expect(await undo(user, removal.id, 2)).toMatchObject({ ok: false, code: "55000" });
    }
  }, 60000);
});
