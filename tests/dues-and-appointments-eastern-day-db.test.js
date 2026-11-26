// @vitest-environment node
//
// BUG-UG-FUNCTIONS-AND-DATE-DEFAULTS-READ-THE-UTC-DAY-20261112, part C:
// dues and appointments read the Eastern day, whatever the session time zone.
// The hosted projects run in UTC, so from 7 PM Eastern the UTC day is already
// tomorrow. A test cannot move now(), so it pins the session time zone
// instead, as the  proof does: the zone it picks always sits on a
// different date from Eastern at the moment the test runs (UTC+14 when its
// date is already tomorrow, otherwise UTC-12, which is still yesterday). A
// reader of the session day then calls dues due today overdue (UTC+14) or
// leaves yesterday's dues out of overdue (UTC-12), and refuses a blackout that
// ends today (UTC+14) or saves one that ended yesterday (UTC-12).
//
// Part D adds the evening writes (the pre-push read of): a treasurer's
// credit and a Stripe settlement are dated, and the receipt numbered, on the
// Eastern day, and a retry in another session zone is idempotent; a reminder,
// the treasurer's or the cron planner's (with its own default day), is filed
// in the Eastern month; and the booking window's one day of slack never
// offers a past instant, while two days back is refused.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const ID = {
  org: "50908568-0000-4000-8000-000000000c01",
  member: "50908568-0000-4000-8000-000000000c11",
  steward: "50908568-0000-4000-8000-000000000c12",
  admin: "50908568-0000-4000-8000-000000000c13",
  memberSession: "50908568-0000-4000-8000-000000000c21",
  stewardSession: "50908568-0000-4000-8000-000000000c22",
  adminSession: "50908568-0000-4000-8000-000000000c23",
  dueToday: "50908568-0000-4000-8000-000000000c31",
  dueYesterday: "50908568-0000-4000-8000-000000000c32",
};
const CHAPTER = "dues-appointments-eastern-day";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("dues and appointments read the Eastern day on a disposable database", () => {
  let db;
  let easternToday;
  let offZone;

  // Runs one statement as the user in a session pinned to timeZone, and rolls
  // it back.
  async function asUser(user, session, statement, values = [], timeZone = "UTC") {
    await db.query("savepoint dues_appointments_eastern_day");
    try {
      await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: user, role: "authenticated", session_id: session, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      return { code: error.code || "?", rows: [], message: error.message || "" };
    } finally {
      await db.query("rollback to savepoint dues_appointments_eastern_day");
      await db.query("release savepoint dues_appointments_eastern_day");
      await db.query("reset role");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-appointments-eastern-day-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    const { rows: [clock] } = await db.query(
      `select (now() at time zone 'America/New_York')::date::text as today,
              case when (now() at time zone 'Etc/GMT-14')::date <> (now() at time zone 'America/New_York')::date
                   then 'Etc/GMT-14' else 'Etc/GMT+12' end as off_zone`,
    );
    easternToday = clock.today;
    offZone = clock.off_zone;
    for (const [user, session, email] of [
      [ID.member, ID.memberSession, "dues-appointments-member@example.invalid"],
      [ID.steward, ID.stewardSession, "dues-appointments-steward@example.invalid"],
      [ID.admin, ID.adminSession, "dues-appointments-admin@example.invalid"],
    ]) {
      await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, email]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await db.query(
        "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Eastern day factor','totp','verified',now(),now())",
        [randomUUID(), user],
      );
    }
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'dues-appointments-eastern-org','Dues and appointments Eastern day',$2)",
      [ID.org, ID.steward],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9925)",
      [CHAPTER, ID.org],
    );
    for (const user of [ID.member, ID.steward, ID.admin]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, user]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [ID.org, ID.steward],
    );
    // The role grant trigger selects the administrator's dues financial identity.
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",
      [ID.org, ID.admin],
    );
    // The steward takes appointments around the clock, Eastern, with no notice, so the only
    // thing that keeps a past instant out of the slots is the slot engine's own now() filter.
    await db.query("insert into public.member_appointment_schedules(steward_id,timezone,min_notice_minutes) values($1,'America/New_York',0)", [ID.steward]);
    await db.query("insert into public.member_appointment_windows(steward_id,weekday,start_minute,end_minute) select $1,d,0,1440 from generate_series(0,6) d", [ID.steward]);
    const subject = (await db.query(`
      insert into public.dues_member_subjects(organization_id,user_id) values($1,$2)
      on conflict (organization_id,user_id) do update set user_id = excluded.user_id
      returning id
    `, [ID.org, ID.member])).rows[0].id;
    // Dues due today and dues due yesterday, on the Eastern calendar; one
    // obligation per member per batch.
    for (const [index, [obligation, days]] of [[ID.dueToday, 0], [ID.dueYesterday, -1]].entries()) {
      const batch = randomUUID();
      await db.query(`
        insert into public.dues_assessment_batches(id,organization_id,title,scope_kind,amount_cents,due_on,eligibility_fingerprint,idempotency_key,created_by)
        values ($1,$2,'Eastern day dues','organization',7500,$3::date + $4::integer,$5,$6,$7)
      `, [batch, ID.org, easternToday, days, "e".repeat(64), `dues-appointments-eastern-batch-${index}`, ID.steward]);
      await db.query(`
        insert into public.dues_obligations(id,organization_id,batch_id,member_subject_id,issued_cents,due_on)
        values ($1,$2,$3,$4,7500,$5::date + $6::integer)
      `, [obligation, ID.org, batch, subject, easternToday, days]);
    }
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("picks a session time zone that sits on another date from Eastern right now", async () => {
    const { rows: [zone] } = await db.query("select (now() at time zone $1)::date::text as there", [offZone]);
    expect(zone.there).not.toBe(easternToday);
  });

  it("calls only yesterday's dues overdue in the member's workspace, in every session time zone", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const result = await asUser(ID.member, ID.memberSession, "select public.get_my_dues_workspace(null, 25) as value", [], timeZone);
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      const value = result.rows[0].value;
      expect(value.summary.overdueCents, timeZone).toBe(7500);
      const standing = Object.fromEntries(value.obligations.items.map((item) => [item.id, item.standing]));
      expect(standing, timeZone).toEqual({ [ID.dueToday]: "open", [ID.dueYesterday]: "overdue" });
    }
  });

  it("saves a steward's blackout that ends today and refuses one that ended yesterday, in every session time zone", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const today = await asUser(
        ID.steward, ID.stewardSession,
        "select public.add_appointment_blackout($1::date - 2, $1::date) as value", [easternToday], timeZone,
      );
      expect(today.code, `${timeZone}: ${today.message}`).toBe("");
      expect(today.rows[0].value.endDate, timeZone).toBe(easternToday);
      const yesterday = await asUser(
        ID.steward, ID.stewardSession,
        "select public.add_appointment_blackout($1::date - 2, $1::date - 1) as value", [easternToday], timeZone,
      );
      expect({ code: yesterday.code, message: yesterday.message }, timeZone)
        .toEqual({ code: "22023", message: "blackout dates are out of range" });
    }
  });

  // The evening writes. Each case runs in one savepoint and switches session zone between calls,
  // as a first write late in the evening and its retry after the UTC date has turned would.
  async function rolledBack(work) {
    await db.query("savepoint dues_evening_writes");
    try {
      return await work();
    } finally {
      await db.query("rollback to savepoint dues_evening_writes");
      await db.query("release savepoint dues_evening_writes");
      await db.query("reset role");
    }
  }
  async function as(claims, statement, values, timeZone) {
    await db.query("reset role");
    await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.query(claims.role === "service_role" ? "set local role service_role" : "set local role authenticated");
    // On an error the transaction is aborted until rolledBack's rollback to the savepoint, which
    // also undoes the role, so the role is reset only after a success and the error stays the one
    // the function raised.
    const row = (await db.query(statement, values)).rows[0];
    await db.query("reset role");
    return row;
  }
  const admin = { sub: ID.admin, role: "authenticated", session_id: ID.adminSession, aal: "aal2" };
  const member = { sub: ID.member, role: "authenticated", session_id: ID.memberSession, aal: "aal2" };
  const zones = () => [offZone, "UTC", "America/New_York"];

  it("dates a treasurer's credit on the Eastern day and keeps its same-key retry idempotent in every session zone", async () => {
    const result = await rolledBack(async () => {
      const key = `dues-evening-credit-${randomUUID()}`;
      const call = (timeZone) => as(admin,
        "select public.apply_dues_credit_event($1, 'credit_adjustment', 500, 'Evening credit', $2, 'admin') as value", [ID.dueToday, key], timeZone);
      const answers = [];
      for (const timeZone of zones()) answers.push((await call(timeZone)).value);
      const stored = (await db.query(
        "select effective_on::text, count(*) over ()::int as rows from public.dues_ledger_events where organization_id = $1 and idempotency_key = $2",
        [ID.org, key],
      )).rows;
      return { answers, stored };
    });
    expect(result.answers.map((answer) => answer.idempotent)).toEqual([false, true, true]);
    expect(new Set(result.answers.map((answer) => answer.id)).size).toBe(1);
    expect(result.stored).toEqual([{ effective_on: easternToday, rows: 1 }]);
  });

  it("dates a Stripe settlement and numbers its receipt on the Eastern day, and settles a retry once, in every session zone", async () => {
    const result = await rolledBack(async () => {
      const reservation = randomUUID();
      const session = `cs_eastern_day_${reservation.slice(0, 8)}`;
      await db.query(`
        insert into public.dues_checkout_reservations (
          id, organization_id, obligation_id, requested_by, idempotency_key, state, reserved_cents,
          connected_account_id, receipt_description, success_url, cancel_url, request_hash,
          provider_idempotency_key, stripe_idempotency_replay_until, expires_at, stripe_session_id, hosted_checkout_url
        ) values ($1, $2, $3, $4, $5, 'open', 7500, 'acct_eastern_day_proof', 'Dues payment',
          'https://app.example.invalid/m/dues?payment=success', 'https://app.example.invalid/m/dues?payment=cancel',
          $6, $7, now() + interval '24 hours', now() + interval '23 hours', $8, 'https://checkout.stripe.com/c/pay/eastern-day-proof')
      `, [reservation, ID.org, ID.dueYesterday, ID.member, `dues-evening-${reservation}`, "b".repeat(64), `dues:${randomUUID()}`, session]);
      const answers = [];
      for (const timeZone of zones()) {
        await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
        answers.push((await db.query(
          "select private.dues_settle_stripe_checkout($1, $2, null, 'paid', 7500, 'usd', 'acct_eastern_day_proof', $1, $1) as value",
          [reservation, session],
        )).rows[0].value);
      }
      const stored = (await db.query(
        "select effective_on::text, receipt_number, count(*) over ()::int as rows from public.dues_ledger_events where organization_id = $1 and external_reference = $2",
        [ID.org, `stripe-session:${session}`],
      )).rows;
      return { answers, stored };
    });
    expect(result.answers.map((answer) => answer.idempotent)).toEqual([false, true, true]);
    expect(new Set(result.answers.map((answer) => answer.receiptNumber)).size).toBe(1);
    expect(result.stored).toHaveLength(1);
    expect(result.stored[0]).toMatchObject({ effective_on: easternToday, rows: 1 });
    expect(result.stored[0].receipt_number).toMatch(new RegExp(`^UG-${easternToday.slice(0, 4)}-\\d{8}$`, "u"));
    expect(result.answers[0].receiptNumber).toBe(result.stored[0].receipt_number);
  });

  it("files a treasurer's reminder and the cron planner's in the Eastern month, and keeps the same-key retry idempotent, in every session zone", async () => {
    const easternMonth = `${easternToday.slice(0, 7)}-01`;
    const queued = await rolledBack(async () => {
      const key = `dues-evening-reminder-${randomUUID()}`;
      const answers = [];
      for (const timeZone of zones()) {
        answers.push((await as(admin, "select public.queue_dues_reminder($1, 'in_app', $2, 'admin') as value", [ID.dueYesterday, key], timeZone)).value);
      }
      const stored = (await db.query(
        "select policy_window::text from public.dues_reminder_attempts where organization_id = $1 and obligation_id = $2",
        [ID.org, ID.dueYesterday],
      )).rows;
      return { answers, stored };
    });
    expect(queued.answers.map((answer) => answer.id)).toEqual(Array(3).fill(queued.answers[0].id));
    expect(queued.answers.map((answer) => answer.alreadyQueued ?? false)).toEqual([false, false, false]);
    expect(queued.stored).toEqual([{ policy_window: easternMonth }]);
    for (const timeZone of zones()) {
      const planned = await rolledBack(async () => {
        // No p_today: the planner's own default is the Eastern day, whatever the session zone.
        await as({ role: "service_role" }, "select public.plan_dues_reminder_attempts(500) as value", [], timeZone);
        return (await db.query(
          "select policy_window::text from public.dues_reminder_attempts where organization_id = $1 and obligation_id = $2",
          [ID.org, ID.dueYesterday],
        )).rows;
      });
      expect(planned, timeZone).toEqual([{ policy_window: easternMonth }]);
    }
  });

  it("offers slots from yesterday's Eastern date for a device behind Eastern, never a past instant, and refuses two days back, in every session zone", async () => {
    for (const timeZone of zones()) {
      const offered = await rolledBack(async () => ({
        now: (await db.query("select now() as now")).rows[0].now,
        slack: await as(member, "select public.get_appointment_slots('office_hours', 20, $1::date - 1, $1::date + 1) as value", [easternToday], timeZone),
      }));
      const starts = offered.slack.value.slots.map((slot) => new Date(slot.startsAt));
      expect(starts.length, timeZone).toBeGreaterThan(0);
      expect(starts.filter((start) => start < offered.now), timeZone).toEqual([]);
      const refused = await asUser(
        ID.member, ID.memberSession,
        "select public.get_appointment_slots('office_hours', 20, $1::date - 2, $1::date) as value", [easternToday], timeZone,
      );
      expect({ code: refused.code, message: refused.message }, timeZone)
        .toEqual({ code: "22023", message: "date span must start today or later and cover at most 31 days" });
    }
  });
});
