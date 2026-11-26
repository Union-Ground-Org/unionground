// @vitest-environment node
//
// BUG-UG-ENGAGEMENT-DELIVERY-SENDS-WEEKS-LATE-MAIL-ON-ACTIVATION-20261117 (#9050)
//
// Runs 20261117133000 on a disposable database inside one rolled-back
// transaction, with fixture outbox rows: a delivery more than 14 days (336
// hours) past its due time ends as suppressed/skipped_stale before any lease,
// a row exactly 336 hours old is still claimed, and a survey email the
// payload refused because the survey closed ends as
// suppressed/skipped_survey_closed instead of retrying.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("engagement delivery stale and closed-survey skip on a disposable database", () => {
  let db;
  const ID = { org: randomUUID(), admin: randomUUID(), openSurvey: randomUUID(), closedSurvey: randomUUID(), pastSurvey: randomUUID() };
  for (const name of ["m1", "m2", "m3", "m4", "m5", "m6"]) ID[name] = randomUUID();
  ID.chapter = `stale-skip-${ID.org.slice(0, 8)}`;
  const ROW = {};
  const q = (sql, values = []) => db.query(sql, values);
  const outboxRow = async (id) => (await q(
    "select state, last_error_code, attempt_count, lease_token, available_at, updated_at from public.engagement_delivery_outbox where id = $1",
    [id],
  )).rows[0];
  const surveyDelivery = async (survey, user) => (await q(
    "select state, last_error_code from public.organization_survey_deliveries where survey_id = $1 and recipient_user_id = $2",
    [survey, user],
  )).rows[0];
  const claim = async (lease = randomUUID()) => ({
    lease,
    rows: (await q("select public.claim_engagement_delivery_batch($1, 100, 300) rows", [lease])).rows[0].rows,
  });
  const fixtureIds = (rows) => rows.map((row) => row.id).filter((id) => Object.values(ROW).includes(id)).sort();
  // name, kind, source, recipient, state, attempts, due (SQL over now()), lease expiry
  const OUTBOX = [
    ["staleQueued", "broadcast", "stale-queued", "m3", "queued", 0, "now() - interval '336 hours' - interval '1 second'", null],
    ["staleFailed", "broadcast", "stale-failed", "m4", "failed", 3, "now() - interval '20 days'", null],
    ["staleExpiredLease", "broadcast", "stale-expired", "m5", "leased", 1, "now() - interval '15 days'", "now() - interval '1 minute'"],
    ["staleExhausted", "broadcast", "stale-exhausted", "m6", "failed", 20, "now() - interval '30 days'", null],
    ["boundary", "broadcast", "boundary", "m3", "queued", 0, "now() - interval '336 hours'", null],
    ["fresh", "broadcast", "fresh", "m4", "queued", 0, "now() - interval '1 hour'", null],
    ["freshUnavailable", "broadcast", "fresh-unavailable", "m5", "queued", 0, "now() - interval '2 hours'", null],
    ["staleSurveyPending", "survey_reminder", "openSurvey", "m1", "queued", 0, "now() - interval '15 days'", null],
    ["staleSurveyEngaged", "survey_reminder", "openSurvey", "m2", "failed", 2, "now() - interval '15 days'", null],
    ["openReminder", "survey_reminder", "openSurvey", "m3", "queued", 0, "now() - interval '3 hours'", null],
    ["closedReminder", "survey_reminder", "closedSurvey", "m1", "queued", 0, "now() - interval '4 hours'", null],
    ["pastReminder", "survey_reminder", "pastSurvey", "m2", "queued", 0, "now() - interval '5 hours'", null],
  ];

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "engagement-delivery-stale-skip-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    // Keep every other claimable row out of these claims.
    await q("update public.engagement_delivery_outbox set available_at = now() + interval '1 day' where state in ('queued','failed','leased')");
    const users = [ID.admin, ID.m1, ID.m2, ID.m3, ID.m4, ID.m5, ID.m6];
    for (const id of users) await q("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await q("insert into public.organizations(id,slug,name,created_by) values ($1,$2,$3,$4)", [ID.org, ID.chapter, `Stale skip proof ${ID.org.slice(0, 8)}`, ID.admin]);
    await q("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,92617)", [ID.chapter, ID.org]);
    const survey = (id, status, closesAt) => q(
      `insert into public.organization_surveys(id,organization_id,title,status,created_by,owner_user_id,chapter_id,closes_at)
       values ($1,$2,'Stale skip check-in',$3,$4,$4,$5,${closesAt})`,
      [id, ID.org, status, ID.admin, ID.chapter],
    );
    await survey(ID.openSurvey, "open", "null");
    await survey(ID.closedSurvey, "closed", "null");
    await survey(ID.pastSurvey, "open", "now() - interval '1 hour'");
    const deliveries = [[ID.openSurvey, ID.m1, "queued"], [ID.openSurvey, ID.m2, "engaged"], [ID.openSurvey, ID.m3, "queued"], [ID.closedSurvey, ID.m1, "queued"], [ID.pastSurvey, ID.m2, "queued"]];
    for (const [surveyId, user, state] of deliveries) {
      await q("insert into public.organization_survey_deliveries(organization_id,survey_id,recipient_user_id,state) values ($1,$2,$3,$4)", [ID.org, surveyId, user, state]);
    }
    for (const [name, kind, source, recipient, state, attempts, due, leaseExpiry] of OUTBOX) {
      ROW[name] = randomUUID();
      const sourceKind = kind === "broadcast" ? "broadcast" : "survey";
      const sourceId = sourceKind === "survey" ? ID[source] : `${source}-${ID.org.slice(0, 8)}`;
      await q(
        `insert into public.engagement_delivery_outbox(id,organization_id,recipient_user_id,delivery_kind,source_kind,source_id,state,attempt_count,available_at,lease_token,lease_expires_at,last_error_code)
         values ($1,$2,$3,$4,$5,$6,$7,$8,${due},$9,${leaseExpiry ?? "null"},$10)`,
        [ROW[name], ID.org, ID[recipient], kind, sourceKind, sourceId, state, attempts,
          state === "leased" ? randomUUID() : null, state === "failed" ? "provider_5xx" : null],
      );
    }
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  for (const zone of ["America/New_York", "UTC"]) {
    it(`ends mail more than 336 hours late before any lease and still claims the rest (session time zone ${zone})`, async () => {
      await q("savepoint claim_zone");
      await q(`set local timezone = '${zone}'`);
      const { rows } = await claim();
      // Exactly 336 hours old is not stale; fresh mail and every open or
      // closed survey email inside the window is leased as before.
      expect(fixtureIds(rows)).toEqual([ROW.boundary, ROW.fresh, ROW.freshUnavailable, ROW.openReminder, ROW.closedReminder, ROW.pastReminder].sort());
      for (const name of ["staleQueued", "staleFailed", "staleExpiredLease", "staleSurveyPending", "staleSurveyEngaged"]) {
        expect(await outboxRow(ROW[name])).toMatchObject({ state: "suppressed", last_error_code: "skipped_stale", lease_token: null });
      }
      // The sweep is not an attempt.
      expect((await outboxRow(ROW.staleQueued)).attempt_count).toBe(0);
      expect((await outboxRow(ROW.staleFailed)).attempt_count).toBe(3);
      // An exhausted row is no longer claimable and is left as it was.
      expect(await outboxRow(ROW.staleExhausted)).toMatchObject({ state: "failed", last_error_code: "provider_5xx", attempt_count: 20 });
      // A pending survey delivery follows its stale email; a member who
      // already took part keeps their engaged state.
      expect(await surveyDelivery(ID.openSurvey, ID.m1)).toEqual({ state: "suppressed", last_error_code: "skipped_stale" });
      expect(await surveyDelivery(ID.openSurvey, ID.m2)).toEqual({ state: "engaged", last_error_code: null });
      await q("rollback to savepoint claim_zone");
    });
  }

  it("is idempotent: a later or overlapping claim changes no suppressed row and leases no stale row", async () => {
    await q("savepoint idempotent");
    const first = await claim();
    const stale = ["staleQueued", "staleFailed", "staleExpiredLease", "staleSurveyPending", "staleSurveyEngaged"];
    const after = {};
    for (const name of stale) after[name] = await outboxRow(ROW[name]);
    const again = await claim();
    expect(fixtureIds(again.rows)).toEqual([]);
    for (const name of stale) expect(await outboxRow(ROW[name])).toEqual(after[name]);
    // Rows the first claim leased keep that lease.
    expect((await outboxRow(ROW.fresh)).lease_token).toBe(first.lease);
    // A stale row whose lease expires later is ended by the next claim,
    // never re-leased.
    await q("update public.engagement_delivery_outbox set state='leased', lease_token=$2, lease_expires_at=now() - interval '1 second', available_at=now() - interval '400 hours', last_error_code=null where id=$1", [ROW.fresh, first.lease]);
    const third = await claim();
    expect(fixtureIds(third.rows)).toEqual([]);
    expect(await outboxRow(ROW.fresh)).toMatchObject({ state: "suppressed", last_error_code: "skipped_stale", lease_token: null });
    await q("rollback to savepoint idempotent");
  });

  it("ends a survey email the payload refused for a closed or past-close survey, and retries every other refusal", async () => {
    await q("savepoint closed");
    const { lease } = await claim();
    const complete = async (name, code = "payload_unavailable") => (await q(
      "select public.complete_engagement_delivery($1,$2,false,$3,300) r",
      [ROW[name], lease, code],
    )).rows[0].r.state;
    for (const name of ["closedReminder", "pastReminder"]) {
      expect((await q("select public.get_engagement_delivery_payload($1,$2) p", [ROW[name], lease])).rows[0].p).toMatchObject({ available: false });
    }
    expect(await complete("closedReminder")).toBe("suppressed");
    expect(await complete("pastReminder")).toBe("suppressed");
    expect(await outboxRow(ROW.closedReminder)).toMatchObject({ last_error_code: "skipped_survey_closed", lease_token: null });
    expect(await surveyDelivery(ID.closedSurvey, ID.m1)).toEqual({ state: "suppressed", last_error_code: "skipped_survey_closed" });
    expect(await surveyDelivery(ID.pastSurvey, ID.m2)).toEqual({ state: "suppressed", last_error_code: "skipped_survey_closed" });
    // The database must agree: an open survey and a broadcast still retry.
    expect(await complete("openReminder")).toBe("failed");
    expect(await outboxRow(ROW.openReminder)).toMatchObject({ last_error_code: "payload_unavailable" });
    expect(await complete("freshUnavailable")).toBe("failed");
    // A provider failure on a closed survey's email is not the payload
    // refusal and keeps its own code.
    await q("savepoint other_code");
    await q("update public.engagement_delivery_outbox set state='leased', lease_token=$2, lease_expires_at=now() + interval '5 minutes' where id=$1", [ROW.closedReminder, lease]);
    expect(await complete("closedReminder", "provider_5xx")).toBe("failed");
    await q("rollback to savepoint other_code");
    // Ended rows are never claimed again.
    const again = await claim();
    expect(fixtureIds(again.rows)).toEqual([]);
    await q("rollback to savepoint closed");
  });
});

// Gate round 1 (stage 322, r1s1/r2s1): a member whose survey delivery ended
// as skipped_stale or skipped_survey_closed is remindable again while the
// survey is open, through the staff Remind action.
live("survey reminders after a stale or closed-survey skip on a disposable database", () => {
  let db;
  const W = {};
  const q = (text, values = []) => db.query(text, values);

  // A refusal rolls back to its own savepoint, so the proof transaction
  // stays usable.
  async function asStaff(text, values = []) {
    await q("savepoint staff_call");
    try {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: W.admin.id, session_id: W.admin.session, aal: "aal2" })]);
      await q("set local role authenticated");
      const row = (await q(text, values)).rows[0];
      await q("reset role");
      await q("select set_config('request.jwt.claims', '', true)");
      await q("release savepoint staff_call");
      return row;
    } catch (error) {
      await q("rollback to savepoint staff_call");
      await q("release savepoint staff_call");
      throw error;
    }
  }
  const remind = async (survey) => (await asStaff("select public.queue_organization_survey_reminders($1) r", [survey])).r;

  async function person(label, { roles = [], chapterRoles = [] } = {}) {
    const user = { id: randomUUID(), session: randomUUID() };
    await q("insert into auth.users(id,email) values ($1,$2)", [user.id, `stale-skip-${label}-${user.id}@example.invalid`]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [W.org, user.id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, W.chapter]);
    await q("update public.member_profiles set chapter_id = $2 where id = $1", [user.id, W.chapter]);
    for (const role of roles) await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [W.org, user.id, role]);
    for (const role of chapterRoles) await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, W.chapter]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  const outbox = async (survey, kind) => (await q(
    "select id, state, last_error_code from public.engagement_delivery_outbox where source_id = $1 and recipient_user_id = $2 and delivery_kind = $3",
    [survey, W.member.id, kind],
  )).rows[0];
  const delivery = async (survey) => (await q(
    "select state, last_error_code from public.organization_survey_deliveries where survey_id = $1 and recipient_user_id = $2",
    [survey, W.member.id],
  )).rows[0];
  const claim = async () => {
    const lease = randomUUID();
    const rows = (await q("select public.claim_engagement_delivery_batch($1, 100, 300) rows", [lease])).rows[0].rows;
    return { lease, ids: rows.map((row) => row.id) };
  };
  async function openSurvey() {
    const survey = randomUUID();
    await q("insert into public.organization_surveys(id,organization_id,title,status,created_by,owner_user_id,chapter_id) values ($1,$2,'Stale skip reminder check-in','open',$3,$3,$4)", [survey, W.org, W.admin.id, W.chapter]);
    expect(await asStaff("select public.prepare_organization_survey_distribution($1) r", [survey])).toBeTruthy();
    return survey;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "engagement-delivery-stale-skip-reminders-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    await q("update public.engagement_delivery_outbox set available_at = now() + interval '1 day' where state in ('queued','failed','leased')");
    const bootstrap = randomUUID();
    await q("insert into auth.users(id,email) values ($1,$2)", [bootstrap, `stale-skip-bootstrap-${bootstrap}@example.invalid`]);
    W.org = randomUUID();
    await q("insert into public.organizations(id,slug,name,created_by) values ($1,$2,$2,$3)", [W.org, `stale-skip-r-${W.org.slice(0, 8)}`, bootstrap]);
    W.chapter = `stale-skip-r-${W.org.slice(0, 8)}`;
    await q("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,92618)", [W.chapter, W.org]);
    W.admin = await person("admin", { roles: ["admin"], chapterRoles: ["admin"] });
    W.member = await person("member");
    await q("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values (true,$1,true) on conflict do nothing", [W.org]);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  it("reminds a member whose invitation was skipped as stale", async () => {
    await q("savepoint stale_invitation");
    const survey = await openSurvey();
    const invitation = await outbox(survey, "survey_invitation");
    expect(invitation).toMatchObject({ state: "queued" });
    await q("update public.engagement_delivery_outbox set available_at = now() - interval '400 hours' where id = $1", [invitation.id]);
    expect((await claim()).ids).not.toContain(invitation.id);
    expect(await outbox(survey, "survey_invitation")).toMatchObject({ state: "suppressed", last_error_code: "skipped_stale" });
    expect(await delivery(survey)).toEqual({ state: "suppressed", last_error_code: "skipped_stale" });

    expect(await remind(survey)).toMatchObject({ surveyId: survey, queued: expect.any(Number) });
    const reminder = await outbox(survey, "survey_reminder");
    expect(reminder).toMatchObject({ state: "queued" });
    const { lease, ids } = await claim();
    expect(ids).toContain(reminder.id);
    expect((await q("select public.get_engagement_delivery_payload($1,$2) p", [reminder.id, lease])).rows[0].p).toMatchObject({ available: true });
    // The stale invitation itself stays ended.
    expect(await outbox(survey, "survey_invitation")).toMatchObject({ state: "suppressed", last_error_code: "skipped_stale" });
    await q("rollback to savepoint stale_invitation");
  });

  it("reminds again after the survey closed, its emails were skipped, and it reopened", async () => {
    await q("savepoint reopen");
    const survey = await openSurvey();
    expect(await remind(survey)).toMatchObject({ surveyId: survey, queued: expect.any(Number) });
    const first = await claim();
    const invitation = await outbox(survey, "survey_invitation");
    const reminder = await outbox(survey, "survey_reminder");
    expect(first.ids).toEqual(expect.arrayContaining([invitation.id, reminder.id]));
    await q("update public.organization_surveys set closes_at = now() - interval '1 hour' where id = $1", [survey]);
    for (const row of [invitation, reminder]) {
      expect((await q("select public.complete_engagement_delivery($1,$2,false,'payload_unavailable',300) r", [row.id, first.lease])).rows[0].r.state).toBe("suppressed");
    }
    expect(await delivery(survey)).toEqual({ state: "suppressed", last_error_code: "skipped_survey_closed" });
    // While closed, Remind is refused as before.
    await expect(remind(survey)).rejects.toMatchObject({ code: "P0002" });

    await q("update public.organization_surveys set closes_at = null where id = $1", [survey]);
    expect(await remind(survey)).toMatchObject({ surveyId: survey, queued: expect.any(Number) });
    expect(await outbox(survey, "survey_reminder")).toMatchObject({ id: reminder.id, state: "queued" });
    const { lease, ids } = await claim();
    expect(ids).toContain(reminder.id);
    expect((await q("select public.get_engagement_delivery_payload($1,$2) p", [reminder.id, lease])).rows[0].p).toMatchObject({ available: true });
    await q("rollback to savepoint reopen");
  });

  it("still leaves out a member whose delivery was suppressed for any other reason", async () => {
    await q("savepoint other_reason");
    const survey = await openSurvey();
    await q("update public.organization_survey_deliveries set state = 'suppressed', last_error_code = 'recipient_access_revoked' where survey_id = $1 and recipient_user_id = $2", [survey, W.member.id]);
    expect(await remind(survey)).toMatchObject({ surveyId: survey });
    expect(await outbox(survey, "survey_reminder")).toBeUndefined();
    await q("rollback to savepoint other_reason");
  });
});

// Gate final (stage 332, r3s1/r4s1): the scheduled half. The survey
// operations sweep marks a delivery that ended as skipped_stale or
// skipped_survey_closed reminder-due and queues its automatic reminder while
// the survey is open; any other suppression stays excluded.
live("scheduled survey reminders after a stale or closed-survey skip on a disposable database", () => {
  let db;
  const W = {};
  const q = (text, values = []) => db.query(text, values);

  async function user(label) {
    const id = randomUUID();
    await q("insert into auth.users(id,email) values ($1,$2)", [id, `stale-sweep-${label}-${id}@example.invalid`]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [W.org, id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, W.chapter]);
    await q("update public.member_profiles set chapter_id = $2 where id = $1", [id, W.chapter]);
    return id;
  }
  const delivery = async (member) => (await q(
    "select state, last_error_code, escalation_state from public.organization_survey_deliveries where survey_id = $1 and recipient_user_id = $2",
    [W.survey, member],
  )).rows[0];
  const reminder = async (member) => (await q(
    "select state from public.engagement_delivery_outbox where source_id = $1 and recipient_user_id = $2 and delivery_kind = 'survey_reminder'",
    [String(W.survey), member],
  )).rows[0];
  const invitation = (member, state, due, lease = null) => q(
    `insert into public.engagement_delivery_outbox(organization_id,recipient_user_id,delivery_kind,source_kind,source_id,state,attempt_count,available_at,lease_token,lease_expires_at)
     values ($1,$2,'survey_invitation','survey',$3,$4,$5,${due},$6,${lease ? "now() + interval '5 minutes'" : "null"})`,
    [W.org, member, String(W.survey), state, lease ? 1 : 0, lease],
  );

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "engagement-delivery-stale-skip-sweep-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    await q("update public.engagement_delivery_outbox set available_at = now() + interval '1 day' where state in ('queued','failed','leased')");
    await q("update public.organization_surveys set operations_swept_at = now() + interval '1 day'");
    const bootstrap = randomUUID();
    await q("insert into auth.users(id,email) values ($1,$2)", [bootstrap, `stale-sweep-bootstrap-${bootstrap}@example.invalid`]);
    W.org = randomUUID();
    W.chapter = `stale-sweep-${W.org.slice(0, 8)}`;
    await q("insert into public.organizations(id,slug,name,created_by) values ($1,$2,$2,$3)", [W.org, W.chapter, bootstrap]);
    await q("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,92619)", [W.chapter, W.org]);
    W.owner = await user("owner");
    W.stale = await user("stale");
    W.reopened = await user("reopened");
    W.optedOut = await user("opted-out");
    W.survey = randomUUID();
    await q(
      `insert into public.organization_surveys(id,organization_id,title,status,cadence,owner_user_id,privacy_min_responses,created_by,created_at,operations_state)
       values ($1,$2,'Stale skip sweep check-in','open','one_off',$3,3,$3,now() - interval '3 days','distributing')`,
      [W.survey, W.org, W.owner],
    );
    for (const member of [W.stale, W.reopened, W.optedOut]) {
      await q("insert into public.organization_survey_deliveries(organization_id,survey_id,recipient_user_id,state,created_at) values ($1,$2,$3,'queued',now() - interval '2 days')", [W.org, W.survey, member]);
    }
    await q("update public.organization_survey_deliveries set state = 'suppressed', last_error_code = 'recipient_opted_out' where survey_id = $1 and recipient_user_id = $2", [W.survey, W.optedOut]);

    // Stale: the invitation is more than 336 hours late and the claim ends it.
    await invitation(W.stale, "queued", "now() - interval '400 hours'");
    await q("select public.claim_engagement_delivery_batch($1, 100, 300)", [randomUUID()]);
    // Closed, then reopened: the leased invitation is refused while closed.
    const lease = randomUUID();
    await invitation(W.reopened, "leased", "now() - interval '1 hour'", lease);
    await q("update public.organization_surveys set closes_at = now() - interval '1 hour' where id = $1", [W.survey]);
    const id = (await q("select id from public.engagement_delivery_outbox where source_id = $1 and recipient_user_id = $2", [String(W.survey), W.reopened])).rows[0].id;
    await q("select public.complete_engagement_delivery($1,$2,false,'payload_unavailable',300)", [id, lease]);
    await q("update public.organization_surveys set closes_at = null where id = $1", [W.survey]);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  it("marks both skipped deliveries reminder-due and queues their automatic reminder, never an opted-out one", async () => {
    expect(await delivery(W.stale)).toEqual({ state: "suppressed", last_error_code: "skipped_stale", escalation_state: "none" });
    expect(await delivery(W.reopened)).toEqual({ state: "suppressed", last_error_code: "skipped_survey_closed", escalation_state: "none" });
    const result = (await q("select private.run_survey_operations_sweep(100) r")).rows[0].r;
    expect(result.remindersDue).toBeGreaterThanOrEqual(2);
    expect(result.remindersQueued).toBeGreaterThanOrEqual(2);
    for (const member of [W.stale, W.reopened]) {
      expect(await delivery(member)).toMatchObject({ escalation_state: "reminder_due" });
      expect(await reminder(member)).toEqual({ state: "queued" });
    }
    expect(await delivery(W.optedOut)).toMatchObject({ state: "suppressed", escalation_state: "none" });
    expect(await reminder(W.optedOut)).toBeUndefined();
    // One automatic reminder per member: a second sweep queues nothing more.
    await q("update public.organization_surveys set operations_swept_at = null where id = $1", [W.survey]);
    await q("select private.run_survey_operations_sweep(100)");
    expect((await q("select count(*)::int c from public.engagement_delivery_outbox where source_id = $1 and delivery_kind = 'survey_reminder'", [String(W.survey)])).rows[0].c).toBe(2);
  });
});
