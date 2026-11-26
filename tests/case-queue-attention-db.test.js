// @vitest-environment node
// REQ-UG-CASE-QUEUE-SIGNALS-AND-NEXT-ACTION-20261001 and
// REQ-UG-STEWARD-ATTENTION-TREND-20261001 on an owned disposable database.
// Fixture rows are written by the table owner inside one rolled-back
// transaction; every product read runs as `authenticated` with a JWT claim set.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("case queue next actions and steward attention on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "otherOrg", "steward", "stewardSession", "coordinator", "coordinatorSession", "member", "memberSession", "otherSteward"].map((key) => [key, randomUUID()]));
  const prefix = `queue-${ids.org.slice(0, 8)}`;
  const chapter = `${prefix}-a`;
  const foreign = `${prefix}-b`;
  const people = {};
  const cases = {};

  async function as(user, session, sql, params = []) {
    await db.query("savepoint queue_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint queue_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint queue_call");
      await db.query("release savepoint queue_call");
      return { code: error.code, message: error.message };
    }
  }
  const setting = (key, value) => db.query(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [ids.org, key, JSON.stringify(value)],
  );
  const queue = (hat = "steward", user = ids.steward, session = ids.stewardSession) => as(user, session, "select public.get_case_queue_next_actions($1, 25) data", [hat]);
  const attention = (hat = "steward", user = ids.steward, session = ids.stewardSession) => as(user, session, "select public.get_steward_attention_queue($1) data", [hat]);

  async function account(id, { session = null, org = ids.org, chapterId = chapter, roles = [], fullName = null } = {}) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapterId]);
    await db.query("update public.member_profiles set chapter_id=$2, full_name=coalesce($3, full_name) where id=$1", [id, chapterId, fullName]);
    if (session) await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [session, id]);
    if (roles.length) {
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Queue proof','totp','verified',now(),now())", [randomUUID(), id]);
      for (const role of roles) await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, id, role]);
    }
  }
  async function memberCase(key, owner, { steward = ids.steward, deadlineDays = null, restricted = false } = {}) {
    const id = randomUUID();
    await db.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,articles,organization_id,chapter_id,steward_user_id,deadline,status,is_restricted,restriction_reason,restricted_at,restricted_by)
       values ($1,$2,$3,'Narrative stays private','Discipline','',$4,$5,$6,case when $7::integer is null then null else ((now() at time zone 'America/New_York')::date + $7::integer) end,'active',$8,$9,$10,$11)`,
      [id, owner, `${prefix}-${key}`, ids.org, chapter, steward, deadlineDays, restricted, restricted ? "Sensitive proof" : null, restricted ? new Date() : null, restricted ? ids.steward : null],
    );
    cases[key] = id;
    return id;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "case-queue-attention-proof" });
    await db.connect();
    await db.query("begin");
    await releaseCalendarHolds(db);
    await db.query("set local statement_timeout='120s'");
    await db.query("set local lock_timeout='15s'");
    const creator = randomUUID();
    await db.query("insert into auth.users(id,email) values ($1,$2)", [creator, `${creator}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$3,$3,$5),($2,$4,$4,$5)", [ids.org, ids.otherOrg, `${prefix}-org`, `${prefix}-other`, creator]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$3,false,9941),($2,$2,$2,$4,false,9942)", [chapter, foreign, ids.org, ids.otherOrg]);
    await account(ids.steward, { session: ids.stewardSession, roles: ["steward"] });
    await account(ids.coordinator, { session: ids.coordinatorSession, roles: ["coordinator"] });
    await account(ids.member, { session: ids.memberSession });
    await account(ids.otherSteward, { roles: ["steward"] });
    for (const key of ["one", "two", "three", "four", "five"]) {
      people[key] = randomUUID();
      await account(people[key], { fullName: `Proof Member ${key}` });
    }
    // one: due in 2 days, no evidence, never contacted.
    await memberCase("one", people.one, { deadlineDays: 2 });
    // two: due in 30 days, weak strength 25, never contacted.
    await memberCase("two", people.two, { deadlineDays: 30 });
    await db.query("insert into public.casework_strength_analyses(case_id,organization_id,chapter_id,analyzed_by,inputs,score,band,idempotency_key) values ($1,$2,$3,$4,'{}'::jsonb,25,'needs_evidence',$5)", [cases.two, ids.org, chapter, ids.steward, randomUUID()]);
    // three: due in 10 days with confirmed evidence and a contact note 2 days ago.
    await memberCase("three", people.three, { deadlineDays: 10 });
    await db.query("insert into public.member_case_files(case_id,user_id,object_name,filename,mime_type,size_bytes,confirmed_at) values ($1,$2,$3,'proof.pdf','application/pdf',100,now())", [cases.three, people.three, `${people.three}/${randomUUID()}.pdf`]);
    const conversation = (await db.query("insert into public.member_conversations(user_id,title) values ($1,'Case follow-up') returning id", [people.three])).rows[0].id;
    await db.query("insert into public.member_contact_notes(conversation_id,member_user_id,chapter_id,author_id,note,created_at) values ($1,$2,$3,$4,'Called the member',now() - interval '2 days')", [conversation, people.three, chapter, ids.steward]);
    // four: unassigned.
    await memberCase("four", people.four, { steward: null, deadlineDays: 40 });
    // five: another steward's restricted case.
    await memberCase("five", people.five, { steward: ids.otherSteward, deadlineDays: 1, restricted: true });

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 120000);
  beforeEach(async () => { await db.query("savepoint queue_test"); });
  afterEach(async () => { await db.query("rollback to savepoint queue_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("refuses anon, members and hats the caller does not hold", async () => {
    const grants = await db.query("select has_function_privilege('anon','public.get_case_queue_next_actions(text, integer)','execute') q, has_function_privilege('anon','public.get_steward_attention_queue(text)','execute') a");
    expect(grants.rows[0]).toEqual({ q: false, a: false });
    expect((await queue("member", ids.member, ids.memberSession)).code).toBe("42501");
    expect((await queue("steward", ids.member, ids.memberSession)).code).toBe("42501");
    expect((await queue("admin")).code).toBe("42501");
    expect((await attention("steward", ids.member, ids.memberSession)).code).toBe("42501");
  });

  it("ranks the steward's own next actions with the old sort bands", async () => {
    const result = await queue();
    expect(result, result.message).toMatchObject({ code: "", data: { enabled: true } });
    const ids2 = result.data.items.map((item) => item.id);
    // The two never-contacted members tie on score, severity and due date, so
    // the server orders them by item id; their ids are random per run.
    // #9782: case one is due in 2 days with no evidence. Its deadline item is
    // listed once; no second missing-evidence item for the same deadline.
    expect(ids2).toEqual([
      `deadline_risk:${cases.one}`,
      ...[`stale_contact:${people.one}`, `stale_contact:${people.two}`].sort(),
      `weak_strength:${cases.two}`,
    ]);
    expect(result.data.items[0]).toMatchObject({ kind: "deadline_risk", severity: "high", days: 2, memberName: "Proof Member one" });
    expect(result.data.items[3]).toMatchObject({ kind: "weak_strength", severity: "medium", strength: 25 });
    expect(result.data.summary).toMatchObject({ total: 4, urgent: 1, missingOwner: 0, staleContact: 2, missingEvidence: 0, weakStrength: 1 });
    // Another steward's restricted case and the unassigned case never appear.
    expect(JSON.stringify(result.data)).not.toContain(cases.five);
    expect(JSON.stringify(result.data)).not.toContain(cases.four);
    expect(JSON.stringify(result.data)).not.toMatch(/Narrative stays private|Called the member/);
  });

  // BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
  // a dated item names which deadline it is. A missed step deadline before the
  // case's own deadline is the step with its label; a step on the case's own
  // day stays the case deadline. The member reads the same row.
  it("names the step or case deadline behind each dated item, as the member reads it", async () => {
    const stepDue = (days) => `(((now() at time zone 'America/New_York')::date + ${days}) + time '23:59:59') at time zone 'America/New_York'`;
    const insertStep = (caseId, label, days, status) => db.query(
      `insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at,status,created_by) values ($1,$2,$3,'procedure',$4,${stepDue(days)},$5,$6) returning id`,
      [caseId, ids.org, chapter, label, status, ids.steward],
    );
    await insertStep(cases.two, "Step 1", -1, "missed");
    await insertStep(cases.two, "Step 2", 5, "active");
    await insertStep(cases.two, "Step 0", -3, "met");
    await insertStep(cases.one, "Step 1", 2, "active");
    const result = await queue();
    expect(result, result.message).toMatchObject({ code: "", data: { enabled: true } });
    const today = (await db.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d;
    const shift = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    const byId = Object.fromEntries(result.data.items.map((item) => [item.id, item]));
    expect(byId[`deadline_risk:${cases.two}`]).toMatchObject({ dueKind: "step", dueLabel: "Step 1", dueDate: shift(-1), days: -1, severity: "critical" });
    expect(byId[`weak_strength:${cases.two}`]).toMatchObject({ dueKind: "step", dueLabel: "Step 1", dueDate: shift(-1) });
    // A step on the case's own day is not earlier: the case deadline is named.
    expect(byId[`deadline_risk:${cases.one}`]).toMatchObject({ dueKind: "case", dueLabel: null, dueDate: shift(2), days: 2 });
    expect(byId[`missing_evidence:${cases.one}`]).toBeUndefined();
    // The case owner reads the same open step rows through table RLS.
    const ownerSession = randomUUID();
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal1')", [ownerSession, people.two]);
    await db.query("savepoint owner_read");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: people.two, role: "authenticated", session_id: ownerSession, aal: "aal1" })]);
    await db.query("set local role authenticated");
    const rows = (await db.query("select label, (due_at at time zone 'America/New_York')::date::text due_on, status from public.casework_deadlines where case_id = $1 and status in ('active','extended','missed') order by due_at, label, id", [cases.two])).rows;
    await db.query("reset role");
    await db.query("release savepoint owner_read");
    expect(rows[0]).toEqual({ label: "Step 1", due_on: shift(-1), status: "missed" });
  });

  // Two open steps at the identical moment: the server names the lower id, the
  // order the member clients use too (src/lib/caseNextDeadline.js).
  it("breaks an identical due moment by id, not by label", async () => {
    const moment = `(((now() at time zone 'America/New_York')::date - 1) + time '23:59:59') at time zone 'America/New_York'`;
    const low = "00000000-0000-4000-8000-0000000000a1";
    const high = "00000000-0000-4000-8000-0000000000b2";
    for (const [id, label] of [[high, "Step A"], [low, "Step Z"]]) {
      await db.query(`insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,status,created_by) values ($1,$2,$3,$4,'procedure',$5,${moment},'missed',$6)`, [id, cases.two, ids.org, chapter, label, ids.steward]);
    }
    const result = await queue();
    expect(result, result.message).toMatchObject({ code: "" });
    const item = result.data.items.find((entry) => entry.id === `deadline_risk:${cases.two}`);
    expect(item).toMatchObject({ dueKind: "step", dueLabel: "Step Z", days: -1 });
  });

  // BUG-UG-STEWARD-NEXT-ACTIONS-LIST-CLOSED-STEP-CASES-AND-REPEAT-A-CASE-20261124 (#9782):
  // a case due after the deadline lookahead (7 days) and inside the evidence
  // window (14) with no evidence raises its missing-evidence item, and no
  // deadline item; a case inside the lookahead raises the deadline item only.
  it("lists each deadline once: the deadline item inside the lookahead, the evidence item after it", async () => {
    await db.query("update public.member_cases set deadline = (now() at time zone 'America/New_York')::date + 10 where id = $1", [cases.two]);
    const result = await queue();
    expect(result, result.message).toMatchObject({ code: "", data: { enabled: true } });
    const ids = result.data.items.map((item) => item.id);
    expect(result.data.items.find((item) => item.id === `missing_evidence:${cases.two}`)).toMatchObject({ severity: "high", days: 10 });
    expect(ids).not.toContain(`deadline_risk:${cases.two}`);
    expect(ids).toContain(`deadline_risk:${cases.one}`);
    expect(ids).not.toContain(`missing_evidence:${cases.one}`);
  });

  // Sol pre-read of the #9785 successor (P1): private.organization_limit has
  // no fallback, so the lookahead can be null. Then no deadline item is
  // raised, and the evidence item must stay.
  it("keeps the evidence item when the lookahead setting is null", async () => {
    // The registry default cannot be null (platform_setting_definitions_default_valid),
    // but an organization's stored value has no type check, so a JSON null
    // there reads back as a null limit.
    await setting("limits.casework.deadline_lookahead_days", null);
    expect((await db.query("select private.organization_limit($1, 'limits.casework.deadline_lookahead_days') as lookahead", [ids.org])).rows[0].lookahead).toBeNull();
    const result = await queue();
    expect(result, result.message).toMatchObject({ code: "", data: { enabled: true } });
    const ids2 = result.data.items.map((item) => item.id);
    expect(ids2).not.toContain(`deadline_risk:${cases.one}`);
    expect(result.data.items.find((item) => item.id === `missing_evidence:${cases.one}`)).toMatchObject({ days: 2 });
  });

  // BUG-UG-WHAT-TO-DO-NEXT-DEADLINE-ITEM-DROPS-NO-EVIDENCE-20261124
  // (#9901, a review note): the deadline item stands for the missing-evidence
  // item a case inside the lookahead no longer raises, so it says whether the
  // case has evidence, with the same test as that item: due inside the
  // evidence window (14 days) and no confirmed file still held.
  it("says on the deadline item whether a case due soon has no evidence", async () => {
    const item = async () => {
      const result = await queue();
      expect(result, result.message).toMatchObject({ code: "", data: { enabled: true } });
      return result.data.items.find((entry) => entry.id === `deadline_risk:${cases.one}`);
    };
    expect(await item()).toMatchObject({ days: 2, noEvidence: true });
    // A row with no confirmed_at is an upload that has not finished: the
    // two-phase upload mints it invisible and only its confirm step sets
    // confirmed_at (src/lib/memberApi.js, private file uploads). No screen
    // shows it, so it is not evidence and the line still shows.
    const file = (confirmed) => db.query(
      "insert into public.member_case_files(case_id,user_id,object_name,filename,mime_type,size_bytes,confirmed_at) values ($1,$2,$3,'proof.pdf','application/pdf',100,$4) returning id",
      [cases.one, people.one, `${people.one}/${randomUUID()}.pdf`, confirmed ? new Date() : null],
    );
    await file(false);
    expect(await item()).toMatchObject({ noEvidence: true });
    // Outside the evidence window the item does not say it.
    await setting("limits.casework.evidence_deadline_days", 1);
    expect(await item()).toMatchObject({ noEvidence: false });
    await setting("limits.casework.evidence_deadline_days", null);
    expect(await item()).toMatchObject({ noEvidence: false });
    await setting("limits.casework.evidence_deadline_days", 14);
    await file(true);
    expect(await item()).toMatchObject({ noEvidence: false });
    // Nothing else changes: the case still raises no missing-evidence item,
    // and the summary counts are the same.
    const result = await queue();
    expect(result.data.items.map((entry) => entry.id)).not.toContain(`missing_evidence:${cases.one}`);
    expect(result.data.summary).toMatchObject({ total: 4, urgent: 1, missingEvidence: 0 });
  });

  it("follows the configured limits and the queue switch", async () => {
    await setting("limits.casework.weak_strength_threshold", 20);
    await setting("limits.casework.evidence_deadline_days", 1);
    await setting("limits.casework.stale_contact_days", 1);
    const tuned = await queue();
    const kinds = tuned.data.items.map((item) => item.kind);
    expect(kinds).not.toContain("weak_strength");
    expect(kinds).not.toContain("missing_evidence");
    expect(tuned.data.items.filter((item) => item.kind === "stale_contact")).toHaveLength(3);
    await setting("features.casework.next_action_queue", false);
    expect((await queue()).data).toMatchObject({ enabled: false, items: [] });
  });

  it("does not count a steward message from another organization as contact", async () => {
    await db.query("select set_config('request.jwt.claims', '', true)");
    const conversation = (await db.query("insert into public.member_conversations(user_id,title,organization_id) values ($1,'Other tenant contact',$2) returning id", [people.two, ids.otherOrg])).rows[0].id;
    await db.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,'steward','Steward','A message in another tenant')", [conversation, people.two]);
    expect((await queue()).data.items.map((item) => item.id)).toContain(`stale_contact:${people.two}`);
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query("update public.member_conversations set organization_id = $2 where id = $1", [conversation, ids.org]);
    expect((await queue()).data.items.map((item) => item.id)).not.toContain(`stale_contact:${people.two}`);
  });

  it("shows owner gaps to coordinators", async () => {
    const result = await queue("coordinator", ids.coordinator, ids.coordinatorSession);
    expect(result, result.message).toMatchObject({ code: "" });
    expect(result.data.items.map((item) => item.id)).toContain(`missing_owner:${cases.four}`);
    expect(JSON.stringify(result.data)).not.toContain(cases.five);
  });

  it("keeps the attention queue off by default and rolls up members when switched on", async () => {
    expect((await attention()).data).toMatchObject({ enabled: false, members: [], count: 0 });
    await setting("features.attention.guided_portal", true);
    expect((await attention()).data.enabled).toBe(false);
    await setting("features.attention.dashboard", true);
    const result = await attention();
    expect(result, result.message).toMatchObject({ code: "", data: { enabled: true, count: 3, memberSurfaces: false, navigation: false } });
    expect(result.data.members.map((member) => member.memberId)).toEqual([people.one, people.three, people.two]);
    expect(result.data.members[0]).toMatchObject({ reasons: ["deadline_risk", "open_case"], urgency: 90, caseId: cases.one, days: 2, openCases: 1 });
    expect(result.data.breakdown).toEqual({ dueSoon: 1, openWithoutDeadlineRisk: 2 });
    expect(result.data.dominantReason).toBe("open_case");
    await setting("features.attention.member_surfaces", true);
    await setting("features.attention.navigation", true);
    expect((await attention()).data).toMatchObject({ memberSurfaces: true, navigation: true });
  });
});
