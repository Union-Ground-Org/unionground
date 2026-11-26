// @vitest-environment node
//
// SEC-UG-APPOINTMENT-STEWARD-NOTICE-CHURN-20260920
//
// Every member-side book, cancel and reschedule wrote a new steward-facing
// notice, and each insert drew on the steward's shared per-recipient weekly
// nudge budget (5 emails). 20260925130100 coalesces them per (steward, acting
// member) for a rolling week: the first action inserts the notice (one
// delivery at most), later actions rewrite that notice in place with the
// newest copy and mark it unread, which fires no delivery.
// (2026-09-24) dropped the separate-metering clause; the shared budget is
// unchanged.
//
// The offline half pins the migration text and the db-contract entries. The
// live half (disposable loopback only) drives the real appointment RPCs.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("appointment_steward_notice_coalescing"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("appointment steward notice coalescing migration", () => {
  it("sorts after the appointment authorization consolidation, inside one bounded transaction", () => {
    const name = findMigrationName("appointment_steward_notice_coalescing");
    expect(name).toBe("20260925130100_appointment_steward_notice_coalescing.sql");
    expect(name > "20260925030000_appointment_authorization_consolidation.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/\breferences\b/i);
    expect(sql).not.toMatch(/function\s+private\.(notify_member|enqueue_notification_deliveries)\s*\(/);
  });

  it("coalesces only member-side steward notices and never inserts a second row for a window", () => {
    const body = squash(fnBody(sql, "private.notify_appointment_steward"));
    expect(body).toContain("or actor = p_user_id");
    expect(body).toContain("'appointment.booked.steward', 'appointment.cancelled.steward', 'appointment.rescheduled.steward'");
    expect(body).toContain("coalesce_window constant interval := interval '7 days'");
    expect(body).toContain("set title = rendered_title, body = rendered_body, read_at = null, created_at = pg_catalog.now()");
    expect(body.indexOf("update public.member_notifications n")).toBeLessThan(body.lastIndexOf("perform private.notify_member(p_user_id, p_key, p_args, p_kind)"));
    expect(body).not.toMatch(/insert into public\.member_notifications/);
  });

  it("rewrites exactly the three member-side steward calls", () => {
    for (const call of [
      "perform private.notify_member(chosen, ''appointment.booked.steward'',",
      "perform private.notify_member(appt.steward_id, ''appointment.cancelled.steward'',",
      "perform private.notify_member(appt.steward_id, ''appointment.rescheduled.steward'',",
    ]) expect(sql).toContain(call);
    expect(sql).toContain("'steward appointment notice call not found exactly once: %'");
  });

  it("pins the coalescing helper and the rewritten writers in the database contract", () => {
    const helper = contract.functions.find((row) => row.sig === "private.notify_appointment_steward(p_user_id uuid, p_key text, p_args jsonb, p_kind text)");
    expect(helper).toMatchObject({ secdef: true, exec: "" });
    for (const sig of ["public.cancel_appointment(p_id uuid)", "public.reschedule_appointment(p_id uuid, p_starts_at timestamp with time zone)"]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry.bodyContains).toContain("private.notify_appointment_steward(appt.steward_id,");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("repeated member-side appointment actions do not drain the steward's shared budget", () => {
  let client;
  const id = Object.fromEntries([
    "steward", "memberOne", "memberTwo", "stewardSession", "memberOneSession", "memberTwoSession", "org",
  ].map((key) => [key, randomUUID()]));
  const chapter = `asnc-${id.org}`;
  let slots;
  let memberTwoAppointment;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };
  const as = {
    memberOne: () => act(id.memberOne, id.memberOneSession),
    memberTwo: () => act(id.memberTwo, id.memberTwoSession),
    steward: () => act(id.steward, id.stewardSession),
  };
  const book = async (startsAt) => (await client.query(
    "select public.book_appointment('office_hours', 30, $1::timestamptz, 'Union office', $2, 'general') as out",
    [startsAt, id.steward],
  )).rows[0].out;
  const stewardNotices = async () => {
    await client.query("reset role");
    return (await client.query(`
      select n.id, n.title, n.read_at, n.kind,
        (select count(*)::int from public.member_notification_deliveries d
          where d.notification_id = n.id and d.channel = 'email' and d.status <> 'skipped') as emails
      from public.member_notifications n
      where n.user_id = $1
      order by n.title
    `, [id.steward])).rows;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "appointment-steward-notice-coalescing-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.steward, id.stewardSession, "Notice steward"],
      [id.memberOne, id.memberOneSession, "Member One"],
      [id.memberTwo, id.memberTwoSession, "Member Two"],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic notice factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `asnc-${id.org}`, id.steward]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9961)", [chapter, id.org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , name] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3, language='en' where id=$1", [user, chapter, name]);
    }
    await client.query("insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$1)", [id.steward, chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$1)", [id.steward, chapter]);
    await client.query(`
      insert into public.member_appointment_schedules
        (steward_id, timezone, min_notice_minutes, buffer_before_minutes, buffer_after_minutes, max_per_day, accepting)
      values ($1, 'America/New_York', 0, 0, 0, 24, true)
    `, [id.steward]);
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await client.query("insert into public.member_appointment_windows(steward_id, weekday, start_minute, end_minute) values($1,$2,0,1440)", [id.steward, weekday]);
    }
    // Outbound email is off by default; the budget only exists when it is on.
    await client.query("update private.notification_controls set outbound_enabled = true where id");
    slots = (await client.query(
      "select slot_start from private.appointment_slots_for($1, 30, current_date + 3, current_date + 5) order by slot_start limit 12",
      [id.steward],
    )).rows.map((row) => row.slot_start);
    expect(slots.length).toBe(12);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("collapses eight book-and-withdraw cycles from one member into one steward notice and one email", async () => {
    for (let cycle = 0; cycle < 8; cycle += 1) {
      await as.memberOne();
      const booked = await book(slots[cycle % 2]);
      await client.query("select public.cancel_appointment($1)", [booked.id]);
    }
    const notices = (await stewardNotices()).filter((row) => row.kind === "appointments");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "appointments", emails: 1 });
  });

  it("shows the latest action, so a withdrawal is never collapsed into the request it withdraws", async () => {
    const appointmentNotice = async () => (await stewardNotices()).find((row) => row.kind === "appointments");
    let notice = await appointmentNotice();
    expect(notice.title).toBe("Member One cancelled an appointment");
    expect(notice.read_at).toBeNull();

    await client.query("update public.member_notifications set read_at = now() where id = $1", [notice.id]);
    await as.memberOne();
    await book(slots[2]);
    notice = await appointmentNotice();
    expect(notice.title).toBe("Member One booked time with you");
    expect(notice.read_at).toBeNull();
  });

  it("records every action in the event ledger and leaves the member's own notices unchanged", async () => {
    await client.query("reset role");
    const events = (await client.query(`
      select e.action, count(*)::int as n
      from public.member_appointment_events e
      join public.member_appointments a on a.id = e.appointment_id
      where a.user_id = $1
      group by e.action order by e.action
    `, [id.memberOne])).rows;
    expect(events).toEqual([{ action: "booked", n: 9 }, { action: "cancelled", n: 8 }]);
    const own = (await client.query(
      "select count(*)::int as n from public.member_notifications where user_id = $1 and title = 'Appointment confirmed'",
      [id.memberOne],
    )).rows[0].n;
    expect(own).toBe(9);
  });

  it("still delivers an unrelated notification to the same steward", async () => {
    await client.query(
      "insert into public.member_notifications(user_id, title, body, kind) values($1, 'Chapter meeting Thursday', 'Agenda posted.', 'events')",
      [id.steward],
    );
    const events = (await stewardNotices()).filter((row) => row.kind === "events");
    expect(events).toEqual([expect.objectContaining({ title: "Chapter meeting Thursday", emails: 1 })]);
  });

  it("leaves a second member acting with the same steward unaffected", async () => {
    await as.memberTwo();
    memberTwoAppointment = (await book(slots[5])).id;
    const notices = (await stewardNotices()).filter((row) => row.kind === "appointments");
    expect(notices.map((row) => [row.title, row.emails])).toEqual([
      ["Member One booked time with you", 1],
      ["Member Two booked time with you", 1],
    ]);
  });

  it("bounds repeated reschedules of one appointment the same way", async () => {
    let current = memberTwoAppointment;
    for (let round = 0; round < 6; round += 1) {
      await as.memberTwo();
      current = (await client.query(
        "select public.reschedule_appointment($1, $2::timestamptz) as out",
        [current, slots[6 + round]],
      )).rows[0].out.id;
    }
    const notices = (await stewardNotices()).filter((row) => row.kind === "appointments");
    expect(notices.map((row) => [row.title, row.emails])).toEqual([
      ["Member One booked time with you", 1],
      ["Member Two rescheduled an appointment", 1],
    ]);
    const rescheduled = (await client.query(`
      select count(*)::int as n from public.member_appointment_events e
      join public.member_appointments a on a.id = e.appointment_id
      where a.user_id = $1 and e.action = 'rescheduled'
    `, [id.memberTwo])).rows[0].n;
    expect(rescheduled).toBe(6);
  });

  it("does not coalesce a steward-initiated cancellation notice to the member", async () => {
    const before = (await client.query(
      "select count(*)::int as n from public.member_notifications where user_id = $1 and title = 'An appointment was cancelled'",
      [id.memberTwo],
    )).rows[0].n;
    const current = (await client.query(
      "select id from public.member_appointments where user_id = $1 and status = 'confirmed'",
      [id.memberTwo],
    )).rows[0].id;
    await as.steward();
    await client.query("select public.cancel_appointment($1)", [current]);
    await client.query("reset role");
    const after = (await client.query(
      "select count(*)::int as n from public.member_notifications where user_id = $1 and title = 'An appointment was cancelled'",
      [id.memberTwo],
    )).rows[0].n;
    expect(after).toBe(before + 1);
  });
});
