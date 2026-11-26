// @vitest-environment node
//
// BUG-UG-FUNCTIONS-AND-DATE-DEFAULTS-READ-THE-UTC-DAY-20261112 (#8568), part D:
// the other days people see read the Eastern day, whatever the session time
// zone, and the retention cut-off keeps the UTC day its page-view rows are
// bucketed on. The hosted projects run in UTC, so from 7 PM Eastern the UTC
// day is already tomorrow. A test cannot move now(), so it pins the session
// time zone instead, as the #8563 proof does: the zone it picks always sits on
// a different date from the day under test at the moment the test runs (UTC+14
// when its date is already later, otherwise UTC-12, which is still earlier).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const ID = {
  org: "50908568-0000-4000-8000-000000000d01",
  admin: "50908568-0000-4000-8000-000000000d11",
  mentor: "50908568-0000-4000-8000-000000000d12",
  mentee: "50908568-0000-4000-8000-000000000d13",
  adminSession: "50908568-0000-4000-8000-000000000d21",
};
const CHAPTER = "visible-days-eastern-day";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the other visible days read the Eastern day on a disposable database", () => {
  let db;
  let easternToday;
  let offZone;
  let utcToday;
  let offUtcZone;

  // Runs one statement in a session pinned to timeZone, as the user when one
  // is given, and rolls it back.
  async function inZone(statement, values = [], timeZone = "UTC", user = null) {
    await db.query("savepoint visible_days_eastern_day");
    try {
      await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
      if (user) {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
          sub: user, role: "authenticated", session_id: ID.adminSession, aal: "aal2",
        })]);
        await db.query("set local role authenticated");
      }
      const result = await db.query(statement, values);
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      return { code: error.code || "?", rows: [], message: error.message || "" };
    } finally {
      await db.query("rollback to savepoint visible_days_eastern_day");
      await db.query("release savepoint visible_days_eastern_day");
      await db.query("reset role");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "visible-days-eastern-day-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    const { rows: [clock] } = await db.query(
      `select (now() at time zone 'America/New_York')::date::text as today,
              case when (now() at time zone 'Etc/GMT-14')::date <> (now() at time zone 'America/New_York')::date
                   then 'Etc/GMT-14' else 'Etc/GMT+12' end as off_zone,
              (now() at time zone 'UTC')::date::text as utc_today,
              case when (now() at time zone 'Etc/GMT-14')::date <> (now() at time zone 'UTC')::date
                   then 'Etc/GMT-14' else 'Etc/GMT+12' end as off_utc_zone`,
    );
    easternToday = clock.today;
    offZone = clock.off_zone;
    utcToday = clock.utc_today;
    offUtcZone = clock.off_utc_zone;
    for (const [user, email] of [
      [ID.admin, "visible-days-admin@example.invalid"],
      [ID.mentor, "visible-days-mentor@example.invalid"],
      [ID.mentee, "visible-days-mentee@example.invalid"],
    ]) {
      await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, email]);
    }
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ID.adminSession, ID.admin]);
    await db.query(
      "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Visible days factor','totp','verified',now(),now())",
      [randomUUID(), ID.admin],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'visible-days-eastern-org','Visible days Eastern day',$2)",
      [ID.org, ID.admin],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9926)",
      [CHAPTER, ID.org],
    );
    for (const user of [ID.admin, ID.mentor, ID.mentee]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, user]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",
      [ID.org, ID.admin],
    );
    for (const table of ["member_roles", "member_role_chapters"]) {
      await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,'admin',$2,$1)`, [ID.admin, CHAPTER]);
    }
    // Page views on the UTC day 31 and 30 days back: with a 30-day retention
    // only the first is past the cut-off.
    for (const days of [31, 30]) {
      await db.query(
        "insert into public.organization_page_views(organization_id,path,hat,day,view_count) values($1,$2,'member',$3::date - $4::integer,1)",
        [ID.org, `/visible-days-${days}`, utcToday, days],
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("picks session time zones that sit on another date from Eastern and from UTC right now", async () => {
    const { rows: [zone] } = await db.query(
      "select (now() at time zone $1)::date::text as eastern_off, (now() at time zone $2)::date::text as utc_off",
      [offZone, offUtcZone],
    );
    expect(zone.eastern_off).not.toBe(easternToday);
    expect(zone.utc_off).not.toBe(utcToday);
  });

  it("starts a new mentorship on today's Eastern date by default, in every session time zone", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const result = await inZone(
        `insert into public.member_mentorship_pairs(id,organization_id,mentor_user_id,mentee_user_id)
         values($1,$2,$3,$4) returning started_on::text as started_on`,
        [randomUUID(), ID.org, ID.mentor, ID.mentee], timeZone,
      );
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.rows[0].started_on, timeZone).toBe(easternToday);
    }
  });

  it("saves a chapter health snapshot for today's Eastern date and refuses tomorrow's, in every session time zone", async () => {
    const snapshot = "select public.record_chapter_health_snapshot($1, $2::date + $3::integer, 50, 50, 50, 50, 50, 50) as value";
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const today = await inZone(snapshot, [CHAPTER, easternToday, 0], timeZone, ID.admin);
      expect(today.code, `${timeZone}: ${today.message}`).toBe("");
      const tomorrow = await inZone(snapshot, [CHAPTER, easternToday, 1], timeZone, ID.admin);
      expect({ code: tomorrow.code, message: tomorrow.message }, timeZone)
        .toEqual({ code: "22023", message: "invalid health drivers" });
    }
  });

  it("counts page views past the retention cut-off on the UTC day they are bucketed on, in every session time zone", async () => {
    for (const timeZone of ["UTC", offUtcZone, "America/New_York"]) {
      const result = await inZone(
        "select private.retention_eligible_count($1, 'organization_page_views', 30) as eligible",
        [ID.org], timeZone,
      );
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.rows[0].eligible, timeZone).toBe(1);
    }
  });
});
