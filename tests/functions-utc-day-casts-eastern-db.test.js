// @vitest-environment node
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// BUG-UG-FUNCTIONS-CAST-TIMESTAMPS-TO-THE-UTC-DAY-20261115 (#8876):
// one regression per changed group of the record, each failing on Main.
// Functions given an instant are called at 9 PM Eastern, when the UTC day is
// already tomorrow. Functions that read now() cannot be moved in time, so
// inside the rolled-back transaction private.eastern_day() is replaced by one
// that answers a day N days before the Eastern day. That stands for the
// evening, when the Eastern day is behind the UTC day, and N is chosen so the
// week or quarter differs whatever hour the test runs. A function that still
// reads the UTC day ignores the helper and fails.
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const ID = {
  org: "88760000-0000-4000-8000-000000000001",
  member: "88760000-0000-4000-8000-000000000002",
  session: "88760000-0000-4000-8000-000000000003",
};
const CHAPTER = "utc-day-casts-8876";

live("the Eastern calendar in the functions #8876 moved", () => {
  let db;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  async function shiftEasternDay(days) {
    await db.query(`create or replace function private.eastern_day(p_at timestamptz default pg_catalog.now())
      returns date language sql stable set search_path = ''
      as $$ select (p_at at time zone 'America/New_York')::date - ${Number(days)} $$`);
  }
  async function scoped(work) {
    await db.query("savepoint utc_day_casts");
    try { return await work(); } finally { await db.query("rollback to savepoint utc_day_casts"); }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "functions-utc-day-casts-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query("insert into auth.users (id,email) values ($1,'utc-day-casts-member@example.invalid')", [ID.member]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,'utc-day-casts-org','UTC day casts proof org',$2)", [ID.org, ID.member]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,92876)", [CHAPTER, ID.org]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, ID.member]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ID.member, CHAPTER]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ID.member, CHAPTER]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [ID.session, ID.member]);
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values (gen_random_uuid(),$1,'m','totp','verified',now(),now())`,
      [ID.member],
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("casework reminders: a monthly reminder set at 9:30 PM Eastern on April 30 next falls on May 30", async () => {
    // 01:30 UTC on May 1 is 9:30 PM EDT on April 30. On the UTC calendar it
    // recurred on the 1st (May 31 at 9:30 PM Eastern), a day late.
    const { next } = await one(
      "select private.casework_reminder_next_occurrence('2026-05-01T01:30:00Z', 'monthly', '2026-05-10T12:00:00Z') as next",
    );
    expect(next.toISOString()).toBe("2026-05-31T01:30:00.000Z");
  });

  it("automation: a task due on the Eastern day is a due-today candidate", async () => {
    await scoped(async () => {
      // The definition and task are written as fixtures, beneath the
      // case-graph triggers (so the task's number is given here); only the
      // candidate read is under test.
      await db.query("set local session_replication_role = replica");
      const { id: definition } = await one(
        `insert into public.organization_automation_definitions (organization_id, name, trigger_kind, threshold_days, schema_version, updated_by)
         values ($1, 'Due today proof', 'task_due', 0, 2, $2) returning id`,
        [ID.org, ID.member],
      );
      // The candidates are those its author may see: an organization admin.
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [ID.org, ID.member]);
      await db.query("update public.organizations set status = 'active' where id = $1", [ID.org]);
      const { id: task } = await one(
        `insert into public.chapter_tasks (id, chapter_id, task_number, title, created_by, updated_by, workstream, status, priority, due_date)
         values (gen_random_uuid(), $1, 1, 'Due on the Eastern day', $2, $2, 'Organizing', 'to_do', 'medium',
                 (now() at time zone 'America/New_York')::date - 3) returning id`,
        [CHAPTER, ID.member],
      );
      await db.query("set local session_replication_role = origin");
      await shiftEasternDay(3);
      const candidates = (await db.query(
        "select source_kind, source_id from private.automation_v2_candidates($1, false)",
        [definition],
      )).rows;
      expect(candidates).toContainEqual({ source_kind: "task", source_id: task });
    });
  });

  it("chapter connections: the previous quarter is the one before the Eastern day's quarter", async () => {
    await scoped(async () => {
      await shiftEasternDay(120);
      const expected = await one(`select
        pg_catalog.to_char(pg_catalog.date_trunc('quarter', ((now() at time zone 'America/New_York')::date - 120)::timestamp) - interval '3 months', 'YYYY"Q"Q') as key,
        (pg_catalog.date_trunc('quarter', ((now() at time zone 'America/New_York')::date - 120)::timestamp) - interval '3 months') at time zone 'America/New_York' as starts_at,
        pg_catalog.date_trunc('quarter', ((now() at time zone 'America/New_York')::date - 120)::timestamp) at time zone 'America/New_York' as ends_at`);
      const quarter = await one("select period_key, starts_at, ends_at from private.chapter_connection_previous_quarter()");
      expect(quarter.period_key).toBe(expected.key);
      expect(quarter.starts_at.toISOString()).toBe(expected.starts_at.toISOString());
      expect(quarter.ends_at.toISOString()).toBe(expected.ends_at.toISOString());
    });
  });

  it("usage digests: on a Sunday at 9 PM Eastern the last complete week ends the Sunday before", async () => {
    // 02:00 UTC on Monday November 16 is 9 PM EST on Sunday November 15: the
    // Eastern week is still running, so the newest complete week is Nov 2 to 8.
    const rows = (await db.query(
      "select bucket_start::text, bucket_end::text from private.usage_digest_windows('weekly', '2026-11-16T02:00:00Z') order by bucket_start",
    )).rows;
    expect(rows.at(-1)).toEqual({ bucket_start: "2026-11-02", bucket_end: "2026-11-08" });
    expect(rows).toHaveLength(4);
  });

  // Gate round 1 of #9031 (r2s1): a weekly bucket stored before #8876 was
  // counted on UTC bounds. The month Oct 5 to Nov 1, 2026 holds one person
  // whose only check-in, 10 PM EDT on Sunday Oct 18 (02:00 UTC Oct 19), is in
  // Eastern week Oct 12-18 but in the stored UTC week Oct 19-25, and 24 others
  // in the week of Oct 26. Without the stored week the month has 25 people and
  // is publishable. With it, that person is already in a published figure, so
  // the month's remainder is 24 and nothing may be published: on Eastern
  // bounds alone they were counted again and the month went out.
  it("usage digests: a month mixing a stored UTC week withholds what would single out one person", async () => {
    await scoped(async () => {
      await db.query("set local session_replication_role = replica");
      const people = (await db.query(
        "insert into auth.users(id,email) select gen_random_uuid(), 'digest-mix-' || n || '@example.invalid' from generate_series(1,25) n returning id",
      )).rows.map((row) => row.id);
      const checkIn = (userId, at) => db.query(
        `insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at)
         values ($1,$2::uuid,$3,'meeting_check_in','digest-mix|' || $2::uuid::text,$4)`,
        [ID.org, userId, CHAPTER, at],
      );
      await checkIn(people[0], "2026-10-19T02:00:00Z");
      for (const userId of people.slice(1)) await checkIn(userId, "2026-10-28T15:00:00Z");
      await db.query("set local session_replication_role = origin");
      const publishable = async () => (await one(
        "select private.usage_digest_window_publishable($1, '2026-10-05', '2026-11-01', 25, 'meeting_check_in') as ok",
        [ID.org],
      )).ok;
      expect(await publishable()).toBe(true);
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into private.analytics_usage_digests(organization_id, period, window_start, window_end, buckets, has_data)
         values ($1, 'weekly', '2026-10-19', '2026-10-25', '[{"start":"2026-10-19","end":"2026-10-25","suppressed":false}]'::jsonb, true)`,
        [ID.org],
      );
      await db.query("set local session_replication_role = origin");
      expect(await publishable()).toBe(false);
    });
  });

  it("weekly questions: a question is filed under the Eastern week", async () => {
    await scoped(async () => {
      await shiftEasternDay(7);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: ID.member, role: "authenticated", session_id: ID.session, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      // The member-facing submission; the legacy one-field submit_weekly_question
      // body moved too but has no client grant.
      const { result } = await one(
        "select public.submit_weekly_poll_question('What should the chapter take on next?', '[\"Staffing\", \"Safety\"]'::jsonb) as result",
      );
      await db.query("reset role");
      expect(result.created).toBe(true);
      const { week_start: weekStart, expected } = await one(
        `select q.week_start::text,
           pg_catalog.date_trunc('week', ((now() at time zone 'America/New_York')::date - 7)::timestamp)::date::text as expected
         from public.member_weekly_questions q where q.id = $1`,
        [result.id],
      );
      expect(weekStart).toBe(expected);
    });
  });

  it("other: a meeting folder for 9 PM Eastern carries that Eastern date", async () => {
    // 02:00 UTC on November 18 is 9 PM EST on November 17.
    const { name } = await one("select private.drive_meeting_folder_name('Board meeting', '2026-11-18T02:00:00Z', 'event-8876') as name");
    expect(name.startsWith("Meeting 2026-11-17 · Board meeting · ")).toBe(true);
  });
});
