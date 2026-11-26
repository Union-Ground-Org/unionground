// @vitest-environment node
//
// BUG-UG-TASKS-REPORT-ENDS-ON-THE-UTC-DAY-AFTER-7-PM-EASTERN-20261112 (#8563)
//
// public.chapter_task_report counts days on the Eastern day, whatever the
// session time zone. The hosted projects run in UTC, so from 7 PM Eastern the
// UTC day is already tomorrow. A test cannot move now(), so it pins the
// session time zone instead. The zone it picks always sits on a different
// date from Eastern at the moment the test runs: UTC+14 whenever its date is
// already tomorrow (from 5 AM Eastern in standard time, 6 AM in daylight
// time), otherwise UTC-12, which is still yesterday until 7 AM (8 AM) Eastern.
// The database compares the dates itself, so no hour of the year is left
// uncovered (gate stage 190, r1s2/r2s2). A report that read the session day would then name the
// wrong end date and, ahead of Eastern, count a task due today as overdue.
// A completion at 9:30 PM Eastern on October 31 (01:30 UTC on November 1),
// read under UTC, must land in October and in an October window.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const ID = {
  org: "50908563-0000-4000-8000-000000000001",
  staff: "50908563-0000-4000-8000-000000000101",
  session: "50908563-0000-4000-8000-000000000201",
  dueToday: "50908563-0000-4000-8000-000000000301",
  eveningDone: "50908563-0000-4000-8000-000000000302",
  eveningRemoved: "50908563-0000-4000-8000-000000000303",
};
const CHAPTER = "task-report-eastern-day";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter_task_report counts the Eastern day on a disposable database", () => {
  let db;
  let easternToday;
  let offZone;

  async function asStaff(statement, values = [], timeZone = "UTC") {
    await db.query("savepoint task_report_eastern_day");
    try {
      await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: ID.staff,
        role: "authenticated",
        session_id: ID.session,
        aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("rollback to savepoint task_report_eastern_day");
      await db.query("release savepoint task_report_eastern_day");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint task_report_eastern_day");
      await db.query("release savepoint task_report_eastern_day");
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "chapter-task-report-eastern-day-proof",
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
    await db.query("insert into auth.users(id,email) values($1,'task-report-eastern-staff@example.invalid')", [ID.staff]);
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'task-report-eastern-org','Task report Eastern day',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9922)",
      [CHAPTER, ID.org],
    );
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ID.org]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, ID.staff]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ID.staff, CHAPTER]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ID.staff, CHAPTER]);
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [ID.org, ID.staff],
    );
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [ID.session, ID.staff]);
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values(gen_random_uuid(),$1,'task-report-eastern-totp','totp','verified',now(),now())`,
      [ID.staff],
    );
    await db.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [CHAPTER, ID.staff]);
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.chapter_tasks
         (id, chapter_id, task_number, title, status, workstream, start_date, due_date, done_at, created_at, created_by, updated_by, deleted_at)
       values
         ($1,$4,1,'Due today, created now','to_do','General',$6::date,$6::date,null,now(),$5,$5,null),
         ($2,$4,2,'Done on an October evening','done','General','2026-10-01','2026-10-31',
             '2026-10-31 21:30:00 America/New_York','2026-10-01 12:00:00+00',$5,$5,null),
         ($3,$4,3,'Removed on an October evening','to_do','General','2026-10-01','2026-10-31',null,
             '2026-10-01 12:00:00+00',$5,$5,'2026-10-31 21:30:00 America/New_York')`,
      [ID.dueToday, ID.eveningDone, ID.eveningRemoved, CHAPTER, ID.staff, easternToday],
    );
    await db.query("set local session_replication_role = origin");
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("ends the default range on today's Eastern date and keeps a task due today out of overdue, in every session time zone", async () => {
    // The session time zone sits on another date from Eastern right now.
    const { rows: [zone] } = await db.query(
      "select (now() at time zone $1)::date::text as there", [offZone],
    );
    expect(zone.there).not.toBe(easternToday);
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const report = await asStaff("select public.chapter_task_report(null, null) as value", [], timeZone);
      expect(report.code, `${timeZone}: ${report.message}`).toBe("");
      const value = report.rows[0].value;
      expect(value.to, timeZone).toBe(easternToday);
      const dueToday = { total: Number(value.totals.total), open: Number(value.totals.open), overdue: Number(value.totals.overdue) };
      // The task created now and due today counts, open and not overdue.
      expect(dueToday, timeZone).toEqual({ total: 2, open: 1, overdue: 0 });
      expect(value.byPerson.map((row) => Number(row.overdue)).reduce((a, b) => a + b, 0), timeZone).toBe(0);
    }
  });

  it("puts work done or removed on an October evening in October, under the UTC session the hosted projects run", async () => {
    const report = await asStaff(
      "select public.chapter_task_report($1::date, $2::date) as value",
      ["2026-10-01", "2026-10-31"],
    );
    expect(report.code, report.message).toBe("");
    const value = report.rows[0].value;
    expect(value.to).toBe("2026-10-31");
    // 9:30 PM Eastern on October 31 is 01:30 UTC on November 1.
    expect(Number(value.totals.done)).toBe(1);
    expect(Number(value.totals.done_late)).toBe(0);
    expect(value.byMonth).toEqual([{ month: "2026-10", done: 1 }]);
    expect(Number(value.deletedCount)).toBe(1);
  });
});
