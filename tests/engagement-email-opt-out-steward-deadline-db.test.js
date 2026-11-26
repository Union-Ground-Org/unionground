// @vitest-environment node
//
// SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001
// BUG-UG-STEWARD-DEADLINE-REMINDERS-20261001
//
// Live proof on a disposable database for
// supabase/migrations/20261002021000_engagement_email_opt_out_and_steward_deadline_reminders.sql:
//   * every engagement producer skips a member who turned the email category
//     off, and the lease-time payload re-checks the choice and is recorded as
//     a terminal suppression (never a retry);
//   * the payload carries a database-signed one-click token, the service-role
//     unsubscribe flips exactly that choice, and every tampered, expired or
//     browser-role attempt is refused;
//   * the assigned steward and coordinator get a case-free deadline warning
//     once per threshold while the member keeps their own notice, quiet hours
//     and topic switches hold, the organization switch and window are
//     enforced per tenant, and a recipient who lost case access gets nothing.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { UNSUBSCRIBE_TOKEN } from "../api/_lib/engagementEmail.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const MIGRATION = "20261002021000_engagement_email_opt_out_and_steward_deadline_reminders.sql";
const migration = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const STAFF_COPY = {
  days: "Assigned case deadline approaching",
  tomorrow: "Assigned case deadline tomorrow",
  today: "Assigned case deadline today",
};
const MEMBER_DAYS_TITLE = "Case deadline approaching";

describe("engagement opt-out and steward deadline migration (static)", () => {
  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/engagement-email-opt-out-steward-deadline-db.test.js");
  });

  it("pins the new service-role RPC and the private tables in the database contract", () => {
    expect(contract.functions).toContainEqual(expect.objectContaining({
      sig: "public.apply_engagement_email_unsubscribe(p_token text)", secdef: true, exec: "service_role",
    }));
    for (const table of ["private.engagement_email_unsubscribe_key", "private.staff_deadline_notice_marks"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(contract.tableGrants).toContainEqual({ table, role, privileges: "" });
      }
    }
  });

  it("adds the two organization settings without overwriting a registry row", () => {
    expect(migration).toContain("('features.notifications.steward_deadline_reminders', 'boolean'");
    expect(migration).toContain("('limits.notifications.steward_deadline_reminder_days', 'integer'");
    expect(migration).toMatch(/'3', 1, 30, 210\)\s*\non conflict \(key\) do nothing;/);
  });

  it("keeps every staff notice free of case detail in both languages", () => {
    const rows = [...migration.matchAll(/\('deadline\.staff\.[a-z]+', '(en|es)', '([^']+)', '([^']+)'\)/g)];
    expect(rows).toHaveLength(6);
    for (const [, , title, body] of rows) {
      expect(`${title} ${body}`).not.toMatch(/\{(?!days\})/);
    }
  });

  it("re-emits every gated writer behind the case-graph gate first", () => {
    for (const name of [
      "private.queue_member_broadcast_delivery()",
      "public.prepare_organization_survey_distribution(",
      "public.queue_organization_survey_reminders(p_survey_id uuid)",
      "public.queue_due_welcome_messages(p_idempotency_key uuid)",
      "public.complete_engagement_delivery(",
      "private.case_deadline_notice_sweep()",
      "public.apply_engagement_email_unsubscribe(p_token text)",
      "private.staff_deadline_notice_sweep()",
    ]) {
      const start = migration.indexOf(`function ${name}`);
      expect(start, name).toBeGreaterThan(-1);
      const body = migration.slice(migration.indexOf("$function$", start) + "$function$".length);
      expect(body.replace(/^\s*declare[\s\S]*?\bbegin\b/, "begin").trimStart(), name)
        .toMatch(/^begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/);
    }
  });
});

const ID = {
  orgA: "50902001-0000-4000-8000-00000000000a",
  orgB: "50902001-0000-4000-8000-00000000000b",
  adminA: "50902001-0000-4000-8000-000000000101",
  stewardA: "50902001-0000-4000-8000-000000000102",
  coordinatorA: "50902001-0000-4000-8000-000000000103",
  memberIn: "50902001-0000-4000-8000-000000000104",
  memberOut: "50902001-0000-4000-8000-000000000105",
  memberLate: "50902001-0000-4000-8000-000000000106",
  formerSteward: "50902001-0000-4000-8000-000000000107",
  stewardB: "50902001-0000-4000-8000-000000000201",
  memberB: "50902001-0000-4000-8000-000000000202",
  sessionAdminA: "50902001-0000-4000-8000-000000000301",
};
const CHAPTER_A = "urgent-a-proof-a";
const CHAPTER_B = "urgent-a-proof-b";
const CASE_REFERENCE = "URGENT-A-PROOF";
const CASE_TITLE = "Grievance about the night shift";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("engagement email opt-out and steward deadline reminders on a disposable database", () => {
  let db;
  const q = (sql, params) => db.query(sql, params);

  async function as(role, userId, sessionId, work) {
    await q("savepoint act_as");
    try {
      if (userId) {
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
          sub: userId, role, session_id: sessionId, aal: "aal2",
        })]);
      }
      await q(`set local role ${role}`);
      const result = await work();
      await q("reset role");
      await q("select set_config('request.jwt.claims', '', true)");
      await q("release savepoint act_as");
      return result;
    } catch (error) {
      await q("rollback to savepoint act_as");
      await q("reset role");
      throw error;
    }
  }
  const asAdminA = (work) => as("authenticated", ID.adminA, ID.sessionAdminA, work);

  async function outbox(kind, userId) {
    return (await q(
      "select id,state,last_error_code from public.engagement_delivery_outbox where delivery_kind=$1 and recipient_user_id=$2 and organization_id=$3",
      [kind, userId, ID.orgA],
    )).rows;
  }
  async function prefs(userId) {
    return (await q("select notification_prefs from public.member_profiles where id=$1", [userId])).rows[0].notification_prefs;
  }
  async function notices(userId) {
    return (await q(
      "select title,body,kind from public.member_notifications where user_id=$1 order by created_at,id",
      [userId],
    )).rows;
  }
  const staffNotices = async (userId) => (await notices(userId)).filter((row) => row.title.startsWith("Assigned case deadline"));
  const sweep = () => q("select private.case_deadline_notice_sweep()");

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "engagement-opt-out-steward-deadline-proof",
    });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '60s'");
    await q("set local lock_timeout = '15s'");
    // Only this proof's rows are claimable or deadline-due inside the transaction.
    await q("update public.engagement_delivery_outbox set available_at = now() + interval '1 day' where state in ('queued','failed','leased')");
    await q("update public.member_cases set status = 'resolved' where status = 'active' and (deadline is not null or exists (select 1 from public.casework_deadlines d where d.case_id = member_cases.id))");
    await q("update private.notification_controls set outbound_enabled = true where id");
    const users = Object.entries(ID).filter(([key]) => !key.startsWith("org") && !key.startsWith("session"));
    for (const [key, id] of users) {
      await q("insert into auth.users(id,email) values($1,$2)", [id, `urgent-a-${key.toLowerCase()}@example.invalid`]);
    }
    await q("insert into public.organizations(id,slug,name,created_by) values($1,'urgent-a-proof-a','Urgent A proof one',$2),($3,'urgent-a-proof-b','Urgent A proof two',$4)",
      [ID.orgA, ID.adminA, ID.orgB, ID.stewardB]);
    await q("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9931),($3,$3,$3,$4,false,9932)",
      [CHAPTER_A, ID.orgA, CHAPTER_B, ID.orgB]);
    const placement = [
      [ID.orgA, CHAPTER_A, [ID.adminA, ID.stewardA, ID.coordinatorA, ID.memberIn, ID.memberOut, ID.memberLate, ID.formerSteward]],
      [ID.orgB, CHAPTER_B, [ID.stewardB, ID.memberB]],
    ];
    for (const [org, chapter, members] of placement) {
      for (const userId of members) {
        await q("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, userId]);
        await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapter]);
        await q("update public.member_profiles set chapter_id=$2 where id=$1", [userId, chapter]);
      }
    }
    for (const [org, userId, role] of [
      [ID.orgA, ID.adminA, "admin"], [ID.orgA, ID.stewardA, "steward"], [ID.orgA, ID.coordinatorA, "coordinator"],
      [ID.orgB, ID.stewardB, "steward"],
    ]) {
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [org, userId, role]);
    }
    for (const userId of [ID.adminA, ID.stewardA, ID.coordinatorA, ID.stewardB, ID.formerSteward]) {
      await q(`insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
               values(gen_random_uuid(),$1,'urgent-a-totp','totp','verified',now(),now())`, [userId]);
    }
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [ID.sessionAdminA, ID.adminA]);
    await q("update public.member_profiles set notification_prefs = notification_prefs || '{\"announcements\": false, \"surveys\": false}'::jsonb where id=$1", [ID.memberOut]);

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  describe("engagement email", () => {
    let surveyId;
    let leaseToken;
    let claimed;
    let memberInToken;

    it("leaves an opted-out member out of a broadcast and keeps everyone else", async () => {
      await q(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,created_by,locale,organization_id,chapter_id,audience_scope)
               values('urgent-a-proof-broadcast','Chapter','Meeting tonight','Meeting starts at six.',now(),990031,$1,'en',$2,$3,'organization')`,
      [ID.adminA, ID.orgA, CHAPTER_A]);
      expect(await outbox("broadcast", ID.memberOut)).toEqual([]);
      for (const userId of [ID.memberIn, ID.memberLate, ID.stewardA]) expect(await outbox("broadcast", userId)).toHaveLength(1);
    });

    it("records a suppressed survey delivery and no invitation for an opted-out member", async () => {
      surveyId = randomUUID();
      await q(`insert into public.organization_surveys(id,organization_id,title,status,created_by,owner_user_id)
               values($1,$2,'Workload check','open',$3,$3)`, [surveyId, ID.orgA, ID.adminA]);
      const result = await asAdminA(async () => (await q("select public.prepare_organization_survey_distribution($1) r", [surveyId])).rows[0].r);
      expect(result.queued).toBeGreaterThanOrEqual(3);
      expect(await outbox("survey_invitation", ID.memberOut)).toEqual([]);
      expect(await outbox("survey_invitation", ID.memberIn)).toHaveLength(1);
      const deliveries = (await q(
        "select recipient_user_id,state,last_error_code from public.organization_survey_deliveries where survey_id=$1 and recipient_user_id = any($2::uuid[])",
        [surveyId, [ID.memberIn, ID.memberOut]],
      )).rows;
      expect(deliveries).toEqual(expect.arrayContaining([
        { recipient_user_id: ID.memberOut, state: "suppressed", last_error_code: "recipient_opted_out" },
        { recipient_user_id: ID.memberIn, state: "queued", last_error_code: null },
      ]));
    });

    it("skips a member who opted out of surveys after distribution when reminders are queued", async () => {
      await q("update public.member_profiles set notification_prefs = notification_prefs || '{\"surveys\": false}'::jsonb where id=$1", [ID.memberLate]);
      await asAdminA(() => q("select public.queue_organization_survey_reminders($1)", [surveyId]));
      expect(await outbox("survey_reminder", ID.memberIn)).toHaveLength(1);
      expect(await outbox("survey_reminder", ID.memberLate)).toEqual([]);
      expect(await outbox("survey_reminder", ID.memberOut)).toEqual([]);
    });

    it("consumes an opted-out member's welcome step without queueing an email", async () => {
      const campaign = randomUUID();
      await q("insert into public.organization_welcome_campaigns(id,organization_id,name,state,created_by) values($1,$2,'Welcome','active',$3)", [campaign, ID.orgA, ID.adminA]);
      await q(`insert into public.organization_welcome_campaign_steps(organization_id,campaign_id,position,delay_days,locale,subject,body,active)
               values($1,$2,1,0,'en','Welcome to the chapter','Here is how the chapter works.',true)`, [ID.orgA, campaign]);
      for (const userId of [ID.memberIn, ID.memberOut]) {
        await q(`insert into public.member_welcome_enrollments(organization_id,campaign_id,member_user_id,state,next_step_position,next_due_at,enrolled_by)
                 values($1,$2,$3,'active',1,now() - interval '1 minute',$4)`, [ID.orgA, campaign, userId, ID.adminA]);
      }
      const result = await asAdminA(async () => (await q("select public.queue_due_welcome_messages($1) r", [randomUUID()])).rows[0].r);
      expect(result.queuedCount).toBe(1);
      expect(await outbox("welcome", ID.memberIn)).toHaveLength(1);
      expect(await outbox("welcome", ID.memberOut)).toEqual([]);
      const enrollment = (await q("select state from public.member_welcome_enrollments where campaign_id=$1 and member_user_id=$2", [campaign, ID.memberOut])).rows[0];
      expect(enrollment.state).toBe("completed");
    });

    it("re-checks the choice at send time and records an opt-out as terminal, never a retry", async () => {
      await q("update public.member_profiles set notification_prefs = notification_prefs || '{\"announcements\": false}'::jsonb where id=$1", [ID.memberLate]);
      leaseToken = randomUUID();
      claimed = (await q("select public.claim_engagement_delivery_batch($1, 100, 300) rows", [leaseToken])).rows[0].rows;
      const find = (kind, userId) => claimed.find((row) => row.deliveryKind === kind && row.recipientUserId === userId);
      const lateBroadcast = find("broadcast", ID.memberLate);
      const lateSurvey = find("survey_invitation", ID.memberLate);
      expect(lateBroadcast).toBeTruthy();
      expect(lateSurvey).toBeTruthy();
      for (const row of [lateBroadcast, lateSurvey]) {
        const payload = (await q("select public.get_engagement_delivery_payload($1,$2) p", [row.id, leaseToken])).rows[0].p;
        expect(payload).toEqual({ available: false, suppressed: true, reason: "recipient_opted_out" });
        const done = (await q("select public.complete_engagement_delivery($1,$2,false,'recipient_opted_out',300) r", [row.id, leaseToken])).rows[0].r;
        expect(done.state).toBe("suppressed");
      }
      const survey = (await q("select state,last_error_code from public.organization_survey_deliveries where survey_id=$1 and recipient_user_id=$2", [surveyId, ID.memberLate])).rows[0];
      expect(survey).toEqual({ state: "suppressed", last_error_code: "recipient_opted_out" });
      const again = (await q("select public.claim_engagement_delivery_batch($1, 100, 300) rows", [randomUUID()])).rows[0].rows;
      expect(again.some((row) => row.id === lateBroadcast.id || row.id === lateSurvey.id)).toBe(false);
    });

    it("signs a one-click token into the payload and does not believe an opt-out the member never made", async () => {
      const row = claimed.find((entry) => entry.deliveryKind === "broadcast" && entry.recipientUserId === ID.memberIn);
      const payload = (await q("select public.get_engagement_delivery_payload($1,$2) p", [row.id, leaseToken])).rows[0].p;
      expect(payload).toMatchObject({ available: true, category: "announcements", transactional: false, subject: "Meeting tonight" });
      expect(payload.unsubscribeToken).toMatch(UNSUBSCRIBE_TOKEN);
      expect(payload.unsubscribeToken.split(".").slice(0, 2)).toEqual([ID.memberIn, "announcements"]);
      memberInToken = payload.unsubscribeToken;
      const surveyRow = claimed.find((entry) => entry.deliveryKind === "survey_invitation" && entry.recipientUserId === ID.memberIn);
      const surveyPayload = (await q("select public.get_engagement_delivery_payload($1,$2) p", [surveyRow.id, leaseToken])).rows[0].p;
      expect(surveyPayload.category).toBe("surveys");
      expect(surveyPayload.unsubscribeToken.split(".")[1]).toBe("surveys");
      const done = (await q("select public.complete_engagement_delivery($1,$2,false,'recipient_opted_out',300) r", [row.id, leaseToken])).rows[0].r;
      expect(done.state).toBe("failed");
    });

    it("lets only the service role apply the token, and flips exactly that member's category", async () => {
      for (const role of ["anon", "authenticated"]) {
        await expect(as(role, null, null, () => q("select public.apply_engagement_email_unsubscribe($1)", [memberInToken])))
          .rejects.toMatchObject({ code: "42501" });
      }
      const before = await prefs(ID.memberIn);
      const applied = await as("service_role", null, null, async () => (await q("select public.apply_engagement_email_unsubscribe($1) r", [memberInToken])).rows[0].r);
      expect(applied).toEqual({ applied: true, category: "announcements" });
      const after = await prefs(ID.memberIn);
      expect(after.announcements).toBe(false);
      expect(after.surveys).toBe(before.surveys);
      expect({ ...after, announcements: undefined }).toEqual({ ...before, announcements: undefined });
      // Replay is idempotent.
      const replay = await as("service_role", null, null, async () => (await q("select public.apply_engagement_email_unsubscribe($1) r", [memberInToken])).rows[0].r);
      expect(replay).toEqual({ applied: true, category: "announcements" });
      // Every other member is untouched.
      expect((await prefs(ID.memberB)).announcements).toBeUndefined();
    });

    it("refuses a tampered, re-targeted, expired or future token with one answer", async () => {
      const [user, category, issued, signature] = memberInToken.split(".");
      const flip = (text) => text.slice(0, -1) + (text.endsWith("A") ? "B" : "A");
      const sign = async (payload) => (await q("select private.engagement_email_unsubscribe_signature($1) s", [payload])).rows[0].s;
      const now = Math.floor(Date.now() / 1000);
      const expiredPayload = `${ID.memberB}.surveys.${now - 61 * 86400}`;
      const futurePayload = `${ID.memberB}.surveys.${now + 3600}`;
      const freshPayload = `${ID.memberB}.surveys.${now - 59 * 86400}`;
      // A valid signature for a member that does not exist.
      const ghostPayload = `${randomUUID()}.surveys.${issued}`;
      const refused = [
        `${user}.${category}.${issued}.${flip(signature)}`,
        `${user}.surveys.${issued}.${signature}`,
        `${ID.memberB}.${category}.${issued}.${signature}`,
        `${user}.${category}.${Number(issued) - 1}.${signature}`,
        `${expiredPayload}.${await sign(expiredPayload)}`,
        `${futurePayload}.${await sign(futurePayload)}`,
        `${ghostPayload}.${await sign(ghostPayload)}`,
        "not-a-token",
        "",
      ];
      for (const token of refused) {
        const result = await as("service_role", null, null, async () => (await q("select public.apply_engagement_email_unsubscribe($1) r", [token])).rows[0].r);
        expect(result, token).toEqual({ applied: false });
      }
      expect((await prefs(ID.memberB)).surveys).toBeUndefined();
      expect((await prefs(ID.memberIn)).surveys).toBeUndefined();
      // A fresh signature inside the 60-day window is honoured.
      const freshToken = `${freshPayload}.${await sign(freshPayload)}`;
      const fresh = await as("service_role", null, null, async () => (await q("select public.apply_engagement_email_unsubscribe($1) r", [freshToken])).rows[0].r);
      expect(fresh).toEqual({ applied: true, category: "surveys" });
      expect((await prefs(ID.memberB)).surveys).toBe(false);
    });

    it("keeps an unsubscribe through a write that omits the key, and re-enables only on an explicit true", async () => {
      await q("update public.member_profiles set notification_prefs = '{\"deadlines\": true, \"cases\": true}'::jsonb where id=$1", [ID.memberIn]);
      expect(await prefs(ID.memberIn)).toEqual({ deadlines: true, cases: true, announcements: false });
      const row = claimed.find((entry) => entry.deliveryKind === "survey_invitation" && entry.recipientUserId === ID.memberIn);
      expect((await q("select public.get_engagement_delivery_payload($1,$2) p", [row.id, leaseToken])).rows[0].p.available).toBe(true);
      await q("update public.member_profiles set notification_prefs = '{\"deadlines\": true, \"announcements\": true}'::jsonb where id=$1", [ID.memberIn]);
      expect((await prefs(ID.memberIn)).announcements).toBe(true);
    });
  });

  describe("steward deadline reminders", () => {
    let caseThree;

    async function memberCase(owner, deadlineOffset, { steward = null, coordinator = null } = {}) {
      const id = randomUUID();
      await q(`insert into public.member_cases(id,user_id,reference,title,case_type,step,status,deadline,steward_user_id,coordinator_user_id)
               values($1,$2,$3,$4,'other','Step 1','active',(pg_catalog.now() at time zone 'America/New_York')::date + $5::integer,$6,$7)`,
      [id, owner, `${CASE_REFERENCE}-${id.slice(0, 8)}`, CASE_TITLE, deadlineOffset, steward, coordinator]);
      return id;
    }

    beforeAll(async () => {
      // Steward: quiet now and no urgent exception. Coordinator: quiet now, urgent allowed.
      await q(`update public.member_profiles
                  set quiet_hours_timezone = 'America/New_York',
                      quiet_hours_start = ((now() at time zone 'America/New_York') - interval '1 hour')::time,
                      quiet_hours_end = ((now() at time zone 'America/New_York') + interval '1 hour')::time,
                      urgent_notifications_enabled = (id = $2)
                where id = any($1::uuid[])`, [[ID.stewardA, ID.coordinatorA], ID.coordinatorA]);
      await q("update public.member_profiles set notification_prefs = notification_prefs || '{\"deadlines\": false}'::jsonb where id=$1", [ID.stewardB]);
    });

    it("shows both switches to an organization admin through the existing configuration page", async () => {
      const configuration = await asAdminA(async () => (await q("select public.get_admin_organization_configuration() c")).rows[0].c);
      const byKey = Object.fromEntries(configuration.settings.map((item) => [item.key, item]));
      expect(byKey["features.notifications.steward_deadline_reminders"]).toMatchObject({ kind: "boolean", value: true, defaultValue: true, overridden: false });
      expect(byKey["limits.notifications.steward_deadline_reminder_days"]).toMatchObject({ kind: "integer", value: 3, defaultValue: 3, minimum: 1, maximum: 30 });
      await expect(asAdminA(() => q("select public.update_organization_setting('limits.notifications.steward_deadline_reminder_days', '31'::jsonb)")))
        .rejects.toMatchObject({ code: "22023" });
    });

    it("warns the assigned steward and coordinator exactly once per threshold while the member keeps their notice", async () => {
      caseThree = await memberCase(ID.memberIn, 3, { steward: ID.stewardA, coordinator: ID.coordinatorA });
      await memberCase(ID.memberLate, 1, { steward: ID.stewardA });
      await memberCase(ID.memberOut, 10, { steward: ID.stewardA, coordinator: ID.coordinatorA });
      await q(`insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at,created_by)
               values($1,$2,$3,'response','Step 1 response due',((pg_catalog.now() at time zone 'America/New_York')::date + time '23:00') at time zone 'America/New_York',$4)`,
      [caseThree, ID.orgA, CHAPTER_A, ID.coordinatorA]);

      await sweep();
      const steward = (await staffNotices(ID.stewardA)).map((row) => row.title).sort();
      expect(steward).toEqual([STAFF_COPY.days, STAFF_COPY.today, STAFF_COPY.tomorrow].sort());
      const coordinator = (await staffNotices(ID.coordinatorA)).map((row) => row.title).sort();
      expect(coordinator).toEqual([STAFF_COPY.days, STAFF_COPY.today].sort());
      const days = (await staffNotices(ID.coordinatorA)).find((row) => row.title === STAFF_COPY.days);
      expect(days).toEqual({ title: STAFF_COPY.days, kind: "deadlines", body: "A deadline on a case assigned to you is 3 days away. Open Casework for the details." });
      for (const row of [...await staffNotices(ID.stewardA), ...await staffNotices(ID.coordinatorA)]) {
        expect(`${row.title} ${row.body}`).not.toContain(CASE_REFERENCE);
        expect(`${row.title} ${row.body}`).not.toContain("night shift");
        expect(`${row.title} ${row.body}`).not.toContain("Step 1");
      }
      // The member still gets the member notice; staff notices never reach the member.
      expect((await notices(ID.memberIn)).map((row) => row.title)).toContain(MEMBER_DAYS_TITLE);
      expect(await staffNotices(ID.memberIn)).toEqual([]);

      await sweep();
      expect(await staffNotices(ID.stewardA)).toHaveLength(3);
      expect(await staffNotices(ID.coordinatorA)).toHaveLength(2);
    });

    it("announces a moved deadline again and back-fills to the closest threshold", async () => {
      await q("update public.member_cases set deadline = (pg_catalog.now() at time zone 'America/New_York')::date where id=$1", [caseThree]);
      await sweep();
      const titles = (await staffNotices(ID.coordinatorA)).map((row) => row.title);
      expect(titles.filter((title) => title === STAFF_COPY.today)).toHaveLength(2);
      expect(titles).toHaveLength(3);
      await sweep();
      expect(await staffNotices(ID.coordinatorA)).toHaveLength(3);
    });

    it("honours quiet hours under the urgent rule and the recipient's deadline topic", async () => {
      expect((await q("select private.member_focus_blocks($1,'deadlines') b", [ID.stewardA])).rows[0].b).toBe(true);
      expect((await q("select private.member_focus_blocks($1,'deadlines') b", [ID.coordinatorA])).rows[0].b).toBe(false);
      const pending = (await q(
        "select d.id,d.user_id from public.member_notification_deliveries d join public.member_notifications n on n.id=d.notification_id where d.channel='email' and d.status='pending' and n.title like 'Assigned case deadline%' and d.user_id = any($1::uuid[])",
        [[ID.stewardA, ID.coordinatorA]],
      )).rows;
      expect(pending.some((row) => row.user_id === ID.stewardA)).toBe(true);
      expect(pending.some((row) => row.user_id === ID.coordinatorA)).toBe(true);
      const claimedEmail = (await q("select public.claim_notification_deliveries('email', 500) rows")).rows[0].rows;
      const claimedIds = new Set(claimedEmail.map((row) => row.deliveryId));
      for (const row of pending) expect(claimedIds.has(row.id), row.user_id).toBe(row.user_id === ID.coordinatorA);
    });

    it("enforces the organization switch and window per tenant and skips a recipient without case access", async () => {
      const caseB = await memberCase(ID.memberB, 2, { steward: ID.stewardB });
      await memberCase(ID.memberLate, 2, { steward: ID.formerSteward });
      await q("insert into public.organization_setting_values(organization_id,setting_key,value) values($1,'features.notifications.steward_deadline_reminders','false'::jsonb)", [ID.orgB]);
      const stewardABefore = (await staffNotices(ID.stewardA)).length;
      await sweep();
      expect(await staffNotices(ID.stewardB)).toEqual([]);
      expect((await notices(ID.memberB)).map((row) => row.title)).toContain(MEMBER_DAYS_TITLE);
      expect(await staffNotices(ID.formerSteward)).toEqual([]);
      expect((await staffNotices(ID.stewardA)).length).toBe(stewardABefore);

      await q("update public.organization_setting_values set value='true'::jsonb where organization_id=$1 and setting_key='features.notifications.steward_deadline_reminders'", [ID.orgB]);
      await q("insert into public.organization_setting_values(organization_id,setting_key,value) values($1,'limits.notifications.steward_deadline_reminder_days','1'::jsonb)", [ID.orgB]);
      await sweep();
      expect(await staffNotices(ID.stewardB)).toEqual([]);

      await q("update public.organization_setting_values set value='3'::jsonb where organization_id=$1 and setting_key='limits.notifications.steward_deadline_reminder_days'", [ID.orgB]);
      await sweep();
      expect((await staffNotices(ID.stewardB)).map((row) => row.title)).toEqual([STAFF_COPY.days]);
      // In-app notice is kept; the deadlines topic switch stops its email and push.
      const deliveries = (await q(
        "select d.id from public.member_notification_deliveries d join public.member_notifications n on n.id=d.notification_id where d.user_id=$1 and n.title like 'Assigned case deadline%'",
        [ID.stewardB],
      )).rows;
      expect(deliveries).toEqual([]);
      expect((await q("select stage from private.staff_deadline_notice_marks where deadline_id=$1", [caseB])).rows).toEqual([{ stage: 1 }]);
      expect(await staffNotices(ID.formerSteward)).toEqual([]);
    });

    it("keeps the sweep and its ledger out of every client role", async () => {
      const rows = (await q(
        `select p.oid::regprocedure::text signature,p.prosecdef,
           has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
           has_function_privilege('anon',p.oid,'EXECUTE') anon,
           has_function_privilege('service_role',p.oid,'EXECUTE') service
         from pg_catalog.pg_proc p where p.oid = any($1::regprocedure[]) order by 1`,
        [["private.staff_deadline_notice_sweep()", "private.urgent_a_setting_enabled(uuid,text)", "private.urgent_a_setting_integer(uuid,text)", "private.engagement_email_unsubscribe_token(uuid,text)"]],
      )).rows;
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row).toMatchObject({ prosecdef: true, authenticated: false, anon: false, service: false });
      for (const table of ["private.staff_deadline_notice_marks", "private.engagement_email_unsubscribe_key"]) {
        const grants = (await q(
          "select has_table_privilege('authenticated',$1,'select') a, has_table_privilege('service_role',$1,'select') s, has_table_privilege('anon',$1,'select') n",
          [table],
        )).rows[0];
        expect(grants).toEqual({ a: false, s: false, n: false });
      }
    });
  });
});
