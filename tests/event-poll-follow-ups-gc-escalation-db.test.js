// @vitest-environment node
//
// REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001 and
// REQ-UG-GC-ESCALATION-FLAGS-20261001 (CR-027)
//
// Old app (de7df4b57c^): a new event saved a DRAFT broadcast for staff
// (lib/handoffs/event-handoffs.ts), a closed live poll told its voters and
// warned staff of low participation (lib/handoffs/poll-handoffs.ts, threshold
// 10), and an hourly job flagged overdue or 48-hour-critical grievance tasks as
// coordinator badges (0242 gc_flag_escalations). 20261003032000 restores them
// on the existing event-notices and casework-alert-escalation ticks. The live
// half runs both real cron targets with no JWT, as pg_cron does, on a
// disposable database inside one rolled-back transaction.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20261003032000_event_poll_follow_ups_and_gc_escalation_flags.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");

describe("event and poll follow-ups and coordinator escalation flags (static)", () => {
  it("registers every switch and limit with its old default", () => {
    for (const [key, value] of [
      ["features.automation.event_announcement_drafts", "'true'"], ["features.automation.poll_results_notice", "'true'"],
      ["features.automation.poll_low_participation_alert", "'true'"], ["limits.automation.poll_low_participation_threshold", "'10', 1, 1000"],
      ["features.casework.gc_escalation_flags", "'true'"], ["limits.casework.gc_escalation_due_hours", "'48', 1, 336"],
      ["features.casework.gc_escalation_notify", "'true'"],
    ]) {
      const at = migration.indexOf(`('${key}',`);
      expect(at, key).toBeGreaterThan(-1);
      expect(migration.slice(at, migration.indexOf("\n  (", at + 10) > 0 ? migration.indexOf("\n  (", at + 10) : at + 600)).toContain(value);
    }
    expect(migration).toContain("0161_handoff_settings_seed.sql:42");
    expect(migration).toContain("0242_gc_tasks_escalation.sql");
  });

  it("rides the two mirrored jobs, error-isolated, and adds no unmonitored job", () => {
    expect(migration).not.toMatch(/cron\.schedule\(/);
    expect(migration).toContain("perform private.engagement_follow_up_sweep(100);");
    expect(migration).toContain("perform private.casework_flag_escalations(200);");
    expect(migration.match(/when query_canceled then\n {6}raise;\n {4}when others then/g)).toHaveLength(2);
    const guard = migration.slice(migration.indexOf("do $predecessor$"), migration.indexOf("$predecessor$;"));
    expect(guard).toMatch(/\('private\.event_notice_sweep\(\)', '[0-9a-f]{64}'\)/);
    expect(guard).toMatch(/\('private\.casework_escalate_due_alerts\(integer\)', '[0-9a-f]{64}'\)/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("event and poll follow-ups and coordinator escalation flags on a disposable database", () => {
  let db;
  const ID = {
    org: randomUUID(), other: randomUUID(), steward: randomUUID(), coordinator: randomUUID(), member: randomUUID(), admin: randomUUID(),
    chapterLegacy: randomUUID(), unitSteward: randomUUID(), officer: randomUUID(), leader: randomUUID(), otherAdmin: randomUUID(),
    voterA: randomUUID(), voterB: randomUUID(), otherSteward: randomUUID(), caseId: randomUUID(), poll: randomUUID(), option: randomUUID(),
  };
  ID.chapter = `followup-${ID.org.slice(0, 8)}`;
  ID.otherChapter = `followup-${ID.other.slice(0, 8)}`;
  ID.event = `followup-event-${ID.org.slice(0, 8)}`;
  ID.oldEvent = `followup-old-${ID.org.slice(0, 8)}`;
  const D = { overdue: randomUUID(), hearing: randomUUID(), followUp: randomUUID(), appeal: randomUUID(), met: randomUUID() };
  const sessions = new Map();
  const q = (sql, values = []) => db.query(sql, values);
  const cron = async (sql) => { await q("select set_config('request.jwt.claims','',true)"); return q(sql); };
  async function as(userId, statement, values = []) {
    await q("savepoint follow_up_as");
    try {
      await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", session_id: sessions.get(userId), aal: "aal2" })]);
      await q("set local role authenticated");
      const result = await q(statement, values);
      await q("reset role");
      await q("release savepoint follow_up_as");
      return { code: "", rows: result.rows };
    } catch (error) {
      await q("rollback to savepoint follow_up_as");
      await q("reset role").catch(() => {});
      return { code: error.code || "?", message: error.message, rows: [] };
    }
  }
  const setSetting = (key, value) => q(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
    [ID.org, key, JSON.stringify(value)],
  );
  // Only this migration's copy: fixture setup produces unrelated account notices.
  const OWN_TITLES = ["Poll results are ready", "Low turnout on a poll", "A case deadline is overdue", "A case deadline is close"];
  const notices = async (userId, kind) => (await q("select title from public.member_notifications where user_id=$1 and kind=$2 and title = any($3::text[]) order by title", [userId, kind, OWN_TITLES])).rows.map((row) => row.title);
  const flags = async () => (await q("select deadline_id, reason, notified_reason from private.casework_escalation_flags where case_id=$1 order by reason, deadline_id", [ID.caseId])).rows;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "follow-ups-gc-escalation-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    const people = [ID.steward, ID.coordinator, ID.member, ID.voterA, ID.voterB, ID.otherSteward, ID.admin, ID.chapterLegacy, ID.unitSteward, ID.officer, ID.leader, ID.otherAdmin];
    for (const id of people) await q("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    for (const [org, chapter, owner, order] of [[ID.org, ID.chapter, ID.steward, 92621], [ID.other, ID.otherChapter, ID.otherSteward, 92622]]) {
      await q("insert into public.organizations(id,slug,name,created_by) values ($1,$2,$2,$3)", [org, `followup-${org.slice(0, 8)}`, owner]);
      await q("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,$3)", [chapter, org, order]);
    }
    for (const [org, chapter, ids] of [[ID.org, ID.chapter, [ID.steward, ID.coordinator, ID.member, ID.voterA, ID.voterB, ID.admin, ID.chapterLegacy, ID.unitSteward, ID.officer, ID.leader]], [ID.other, ID.otherChapter, [ID.otherSteward, ID.otherAdmin]]]) {
      for (const id of ids) {
        await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, id]);
        await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapter]);
        await q("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
      }
    }
    for (const id of [ID.steward, ID.coordinator, ID.member, ID.otherSteward, ID.admin, ID.chapterLegacy, ID.unitSteward, ID.officer, ID.leader, ID.otherAdmin]) {
      const session = randomUUID();
      sessions.set(id, session);
      await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
      await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    for (const [org, id, role] of [[ID.org, ID.steward, "steward"], [ID.org, ID.coordinator, "coordinator"], [ID.other, ID.otherSteward, "steward"], [ID.org, ID.admin, "admin"], [ID.other, ID.otherAdmin, "admin"]]) {
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, id, role]);
    }
    // One new event and one that predates installation.
    await q("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id) values ($1,'Contract town hall',now()+interval '5 days','Union hall','Bring questions','SG-TOWN1',92621,$2)", [ID.event, ID.chapter]);
    await q("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,created_at) values ($1,'Old picnic',now()+interval '6 days','Park','Old','SG-PICNIC',92622,$2,(select installed_at from private.automation_follow_up_state) - interval '1 hour')", [ID.oldEvent, ID.chapter]);
    // A live poll with two voters, then closed.
    await q("insert into public.organization_live_polls(id,organization_id,chapter_id,title,state,eligibility,results_visibility,created_by,opens_at) values ($1,$2,$3,'Strike vote','open','chapter','after_close',$4,now()-interval '1 hour')", [ID.poll, ID.org, ID.chapter, ID.steward]);
    await q("insert into public.organization_live_poll_options(id,organization_id,poll_id,label,sort_index) values ($1,$2,$3,'Yes',0)", [ID.option, ID.org, ID.poll]);
    for (const voter of [ID.voterA, ID.voterB]) await q("insert into public.organization_live_poll_votes(organization_id,poll_id,option_id,voter_user_id) values ($1,$2,$3,$4)", [ID.org, ID.poll, ID.option, voter]);
    await q("update public.organization_live_polls set state='closed', closed_at=now() where id=$1", [ID.poll]);
    // An active case the coordinator coordinates, with five deadlines.
    await q("insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status,coordinator_user_id) values ($1,$2,$3,$4,'GC-1','Synthetic escalation case','Grievance','intake','active',$5)", [ID.caseId, ID.member, ID.org, ID.chapter, ID.coordinator]);
    for (const [id, kind, due, status] of [
      [D.overdue, "filing", "now() - interval '1 hour'", "active"], [D.hearing, "hearing", "now() + interval '24 hours'", "active"],
      [D.followUp, "follow_up", "now() + interval '24 hours'", "active"], [D.appeal, "appeal", "now() + interval '100 hours'", "active"],
      [D.met, "response", "now() - interval '2 hours'", "met"],
    ]) {
      await q(`insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,status,created_by) values ($1,$2,$3,$4,$5,'Synthetic deadline',${due},$6,$7)`, [id, ID.caseId, ID.org, ID.chapter, kind, status, ID.coordinator]);
    }

    // This broad-reader fixture is an
    // existing legacy grant; exercise its actual migration carry-over.
    await q("insert into public.member_roles(user_id,role,chapter_id,granted_by) values ($1,'steward',$2,$3)",
      [ID.chapterLegacy, ID.chapter, ID.admin]);
    await q("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values ($1,'steward',$2,$3)",
      [ID.chapterLegacy, ID.chapter, ID.admin]);
    await migrateLegacyStewardFixtures(db);
    expect((await q("select legacy_chapter_coverage from private.chapter_role_scopes where user_id=$1 and chapter_id=$2 and role='steward'",
      [ID.chapterLegacy, ID.chapter])).rows).toEqual([{ legacy_chapter_coverage: true }]);
    const unit = (await q("select id from private.chapter_units where chapter_id=$1 and is_default", [ID.chapter])).rows[0].id;
    for (const [id, role, scope] of [[ID.unitSteward, "steward", unit], [ID.officer, "secretary", null], [ID.leader, "vp", null]]) {
      expect(await as(ID.admin, "select public.set_member_access_role($1,$2,$3,true,$4,null)", [id, ID.chapter, role, scope])).toMatchObject({ code: "" });
    }
    await q("select set_config('request.jwt.claims','',true)");
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  it("drafts one announcement for a new event, never for history, and never sends it", async () => {
    await cron("select private.event_notice_sweep()");
    await cron("select private.event_notice_sweep()");
    const rows = (await q("select source_id, state, title, body from private.engagement_follow_ups where kind='announcement_draft' and organization_id=$1", [ID.org])).rows;
    expect(rows).toEqual([expect.objectContaining({ source_id: ID.event, state: "draft", title: "Upcoming: Contract town hall" })]);
    expect(rows[0].body).toContain("Location: Union hall");
    expect((await q("select count(*)::int n from public.member_broadcasts where organization_id=$1", [ID.org])).rows[0].n).toBe(0);
  });

  // BUG-UG-ANNOUNCEMENT-DRAFTS-SERVER-STILL-ADMITS-STEWARDS-WITHOUT-CHAPTER-NOTICES-20261115
  // (#8940): drafts are chapter-wide notices, so only a caller who may send to
  // the whole chapter (chapter leadership or a notices officer) lists or
  // resolves them. Since #7664 no steward may, carry-over mark or not.
  it("shows the draft only to callers who may send chapter-wide, who can dismiss it once", async () => {
    const listed = await as(ID.admin, "select public.list_announcement_drafts() v");
    expect(listed.code).toBe("");
    expect(listed.rows[0].v.drafts).toEqual([expect.objectContaining({ eventId: ID.event, title: "Upcoming: Contract town hall" })]);
    const id = listed.rows[0].v.drafts[0].id;
    for (const refused of [ID.steward, ID.chapterLegacy, ID.unitSteward, ID.otherSteward, ID.member]) {
      const refusal = { code: "42501", message: "chapter steward role required", rows: [] };
      expect(await as(refused, "select public.list_announcement_drafts() v")).toEqual(refusal);
      for (const state of ["dismissed", "published"]) {
        expect(await as(refused, "select public.resolve_announcement_draft($1,$2) v", [id, state])).toEqual(refusal);
      }
    }
    expect((await as(ID.otherAdmin, "select public.list_announcement_drafts() v")).rows[0].v.drafts).toEqual([]);
    const foreign = await as(ID.otherAdmin, "select public.resolve_announcement_draft($1,'dismissed') v", [id]);
    expect(foreign).toEqual(await as(ID.otherAdmin, "select public.resolve_announcement_draft($1,'dismissed') v", [randomUUID()]));
    expect(foreign.code).toBe("22023");
    for (const allowed of [ID.admin, ID.leader, ID.officer]) {
      expect((await as(allowed, "select public.list_announcement_drafts() v")).rows[0].v.drafts).toHaveLength(1);
      for (const state of ["dismissed", "published"]) {
        await q("savepoint dismiss");
        expect((await as(allowed, "select public.resolve_announcement_draft($1,$2) v", [id, state])).rows[0].v).toMatchObject({ state });
        expect(await as(allowed, "select public.resolve_announcement_draft($1,$2) v", [id, state])).toMatchObject({ code: "22023" });
        expect((await as(allowed, "select public.list_announcement_drafts() v")).rows[0].v.drafts).toEqual([]);
        await q("rollback to savepoint dismiss");
      }
    }
  });

  it("drafts nothing while the event switch is off", async () => {
    await q("savepoint drafts_off");
    await q("delete from private.engagement_follow_ups where source_id=$1", [ID.event]);
    await setSetting("features.automation.event_announcement_drafts", false);
    await cron("select private.event_notice_sweep()");
    expect((await q("select count(*)::int n from private.engagement_follow_ups where source_id=$1", [ID.event])).rows[0].n).toBe(0);
    await q("rollback to savepoint drafts_off");
  });

  it("tells voters the results are ready and warns the creator of low turnout, once", async () => {
    // The event sweep above already processed the closed poll.
    expect(await notices(ID.voterA, "votes")).toEqual(["Poll results are ready"]);
    expect(await notices(ID.voterB, "votes")).toEqual(["Poll results are ready"]);
    expect(await notices(ID.steward, "general")).toEqual(["Low turnout on a poll"]);
    expect(await notices(ID.member, "votes")).toEqual([]);
    const rows = (await q("select kind, state, recipients from private.engagement_follow_ups where source_id=$1 order by kind", [ID.poll])).rows;
    expect(rows).toEqual([
      { kind: "poll_low_participation_alert", state: "sent", recipients: 1 },
      { kind: "poll_results_notice", state: "sent", recipients: 2 },
    ]);
  });

  it("respects the threshold, staff-only results and both poll switches", async () => {
    await q("savepoint polls");
    await q("delete from private.engagement_follow_ups where source_id=$1", [ID.poll]);
    await q("delete from public.member_notifications where user_id = any($1::uuid[])", [[ID.voterA, ID.voterB, ID.steward]]);
    await setSetting("limits.automation.poll_low_participation_threshold", 2);
    await q("update public.organization_live_polls set results_visibility='staff_only' where id=$1", [ID.poll]);
    await cron("select private.event_notice_sweep()");
    expect(await notices(ID.voterA, "votes")).toEqual([]);
    expect(await notices(ID.steward, "general")).toEqual([]);
    expect((await q("select kind, state from private.engagement_follow_ups where source_id=$1 order by kind", [ID.poll])).rows)
      .toEqual([{ kind: "poll_low_participation_alert", state: "skipped" }, { kind: "poll_results_notice", state: "skipped" }]);
    await q("rollback to savepoint polls");
  });

  it("flags overdue and critical contractual deadlines, notifying the coordinator once per reason", async () => {
    await cron("select private.casework_escalate_due_alerts(200)");
    await cron("select private.casework_escalate_due_alerts(200)");
    expect(await flags()).toEqual([
      { deadline_id: D.hearing, reason: "critical_deadline", notified_reason: "critical_deadline" },
      { deadline_id: D.overdue, reason: "overdue", notified_reason: "overdue" },
    ]);
    expect(await notices(ID.coordinator, "deadlines")).toEqual(["A case deadline is close", "A case deadline is overdue"]);
    expect(await notices(ID.member, "deadlines")).toEqual([]);
  });

  it("escalates a critical flag to overdue, clears a met deadline, and widens with the window", async () => {
    await q("savepoint escalate");
    await q("update public.casework_deadlines set due_at = now() - interval '5 minutes' where id=$1", [D.hearing]);
    await q("update public.casework_deadlines set status = 'met' where id=$1", [D.overdue]);
    await setSetting("limits.casework.gc_escalation_due_hours", 120);
    await cron("select private.casework_escalate_due_alerts(200)");
    expect(await flags()).toEqual([
      { deadline_id: D.appeal, reason: "critical_deadline", notified_reason: "critical_deadline" },
      { deadline_id: D.hearing, reason: "overdue", notified_reason: "overdue" },
    ]);
    expect(await notices(ID.coordinator, "deadlines")).toEqual([
      "A case deadline is close", "A case deadline is close", "A case deadline is overdue", "A case deadline is overdue",
    ]);
    await q("rollback to savepoint escalate");
  });

  it("clears every flag while switched off and flags silently while notices are off", async () => {
    await q("savepoint switches");
    await setSetting("features.casework.gc_escalation_flags", false);
    await cron("select private.casework_escalate_due_alerts(200)");
    expect(await flags()).toEqual([]);
    await setSetting("features.casework.gc_escalation_flags", true);
    await setSetting("features.casework.gc_escalation_notify", false);
    await q("delete from public.member_notifications where user_id=$1", [ID.coordinator]);
    await cron("select private.casework_escalate_due_alerts(200)");
    expect((await flags()).length).toBe(2);
    expect(await notices(ID.coordinator, "deadlines")).toEqual([]);
    await q("rollback to savepoint switches");
  });

  it("serves coordinator badges to case staff only", async () => {
    const coordinator = await as(ID.coordinator, "select public.casework_get_escalation_flags($1) v", [ID.caseId]);
    expect(coordinator.code, coordinator.message).toBe("");
    expect(coordinator.rows[0].v).toMatchObject({ caseId: ID.caseId, enabled: true, dueHours: 48 });
    expect(coordinator.rows[0].v.flags.map((flag) => flag.reason).sort()).toEqual(["critical_deadline", "overdue"]);
    expect(await as(ID.member, "select public.casework_get_escalation_flags($1) v", [ID.caseId])).toMatchObject({ code: "42501" });
    expect(await as(ID.otherSteward, "select public.casework_get_escalation_flags($1) v", [ID.caseId])).toMatchObject({ code: "42501" });
  });
});
