// @vitest-environment node
//
// BUG-UG-FUNCTIONS-AND-DATE-DEFAULTS-READ-THE-UTC-DAY-20261112 (#8568), part A:
// a committee's window (starts_on, ends_on) is read on the Eastern day,
// whatever the session time zone. The hosted projects run in UTC, so from
// 7 PM Eastern the UTC day is already tomorrow. A test cannot move now(), so
// it pins the session time zone instead, as the #8563 proof does: the zone it
// picks always sits on a different date from Eastern at the moment the test
// runs (UTC+14 when its date is already tomorrow, otherwise UTC-12, which is
// still yesterday). A committee open for exactly one day, today's Eastern
// date, is then open under every zone only when the reader uses the Eastern
// day: a reader of the session day finds it not yet started (UTC-12) or
// already ended (UTC+14). The new committee default is checked the same way.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const ID = {
  org: "50908568-0000-4000-8000-000000000001",
  staff: "50908568-0000-4000-8000-000000000101",
  member: "50908568-0000-4000-8000-000000000102",
  session: "50908568-0000-4000-8000-000000000201",
  committee: "50908568-0000-4000-8000-000000000301",
};
const CHAPTER = "committee-window-eastern-day";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the committee window reads the Eastern day on a disposable database", () => {
  let db;
  let easternToday;
  let offZone;

  // Runs one statement in a session pinned to timeZone, with the caller's
  // claims set (the readers resolve the caller's organization from them).
  async function inZone(statement, values = [], timeZone = "UTC") {
    await db.query("savepoint committee_window_eastern_day");
    try {
      await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: ID.staff, role: "authenticated", session_id: ID.session, aal: "aal2",
      })]);
      const result = await db.query(statement, values);
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      return { code: error.code || "?", rows: [], message: error.message || "" };
    } finally {
      await db.query("rollback to savepoint committee_window_eastern_day");
      await db.query("release savepoint committee_window_eastern_day");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "committee-window-eastern-day-proof",
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
    for (const [user, email] of [[ID.staff, "committee-window-staff@example.invalid"], [ID.member, "committee-window-member@example.invalid"]]) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [user, email]);
    }
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'committee-window-eastern-org','Committee window Eastern day',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9923)",
      [CHAPTER, ID.org],
    );
    for (const user of [ID.staff, ID.member]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, user]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, CHAPTER]);
    }
    for (const table of ["member_roles", "member_role_chapters"]) {
      await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,'coordinator',$2,$1)`, [ID.staff, CHAPTER]);
    }
    // Open for exactly one day: today's Eastern date.
    await db.query(
      `insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on)
       values($1,$2,'One-day committee','Open on one Eastern day',$3::date,$3::date)`,
      [ID.committee, CHAPTER, easternToday],
    );
    await db.query("insert into private.chapter_committee_members(committee_id,chapter_id,user_id) values($1,$2,$3)", [ID.committee, CHAPTER, ID.member]);
    await db.query(
      "insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,committee_id) values($1,$2,'coordinator',null,$3)",
      [ID.staff, CHAPTER, ID.committee],
    );
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

  it("does not call a role scope on a committee open today expired, in every session time zone", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const result = await inZone(
        "select private.chapter_role_scope_expired($1::uuid, $2, 'coordinator') as expired",
        [ID.staff, CHAPTER], timeZone,
      );
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.rows[0].expired, timeZone).toBe(false);
    }
  });

  it("lets a committee open today reach its member, in every session time zone", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const result = await inZone(
        "select private.chapter_scope_member_allowed($1, null, $2::uuid, $3::uuid) as allowed",
        [CHAPTER, ID.committee, ID.member], timeZone,
      );
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.rows[0].allowed, timeZone).toBe(true);
    }
  });

  it("starts a new committee on today's Eastern date by default, in every session time zone", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const result = await inZone(
        `insert into private.chapter_committees(chapter_id,name,purpose)
         values($1,'Default start','Starts on the default day') returning starts_on::text as starts_on`,
        [CHAPTER], timeZone,
      );
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.rows[0].starts_on, timeZone).toBe(easternToday);
    }
  });
});
