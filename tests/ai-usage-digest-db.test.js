// @vitest-environment node
// REQ-UG-AI-USAGE-DIGEST-20261001 on an owned disposable database: the
// 9 AM Eastern generation window, idempotency, bounded continuation batches,
// the privacy floor that cannot be lowered below the live analytics floor,
// staff-only reads, the switch making the behavior inert server-side, and the
// guarded Compass wording write, and the round-1 privacy repair
// (OPS-UG-AI-USAGE-DIGEST-PRIVACY-REVIEW-20261010, owner default Q53 = A):
// no view, section or role figure, and check-ins under their own people floor.
// Fixture rows are written by the table owner inside one rolled-back
// transaction.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261010130000_ai_usage_digest.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const REPAIR = "supabase/migrations/20261010200000_ai_usage_digest_privacy_repair.sql";
const repair = readFileSync(new URL(`../${REPAIR}`, import.meta.url), "utf8");
const BUCKET_KEYS = ["actors", "checkins", "end", "minCohort", "start", "suppressed"];
const SWITCH = "features.analytics.ai_usage_digest";
const WORDING = "features.analytics.ai_usage_digest_wording";
const FLOOR_KEY = "limits.analytics.ai_usage_digest_min_cohort";

describe("usage digest migration (static)", () => {
  it("registers the switch, the wording switch and both limits off and staff-only, citing the old defaults", () => {
    const code = stripComments(migration);
    expect(code).toMatch(/\('features\.analytics\.ai_usage_digest', 'boolean'/);
    expect(code).toMatch(/'false', null, null, null, 300, 'analytics', false\)/);
    expect(code).toMatch(/\('features\.analytics\.ai_usage_digest_wording', 'boolean'/);
    expect(code).toMatch(/\('limits\.analytics\.ai_usage_digest_min_cohort', 'integer'/);
    expect(code).toMatch(/'25', 25, 200, null, 320, 'analytics', false\)/);
    expect(code).toMatch(/\('limits\.analytics\.ai_usage_digest_sections', 'integer'/);
    expect(code).toMatch(/on conflict \(key\) do nothing;/);
    // The old file and line the default comes from stays in the migration.
    expect(migration).toContain("lib/settings/settings-keys.ts:170");
  });

  it("keeps the private cache client-unreachable and grants only the three staff RPCs", () => {
    const code = stripComments(migration);
    for (const table of ["analytics_usage_digests", "analytics_usage_digest_visits"]) {
      expect(code).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
    }
    expect(code).toContain("grant execute on function public.get_analytics_usage_digests(text) to authenticated;");
    expect(code).toContain("grant execute on function public.authorize_analytics_usage_digest_ai(text, uuid) to authenticated;");
    expect(code).toContain("grant execute on function public.save_analytics_usage_digest_ai(text, uuid, text, text[], text, text) to authenticated;");
    expect(code).toContain("revoke all on function private.generate_analytics_usage_digests(timestamptz, integer, boolean) from public, anon, authenticated, service_role;");
    // Nothing in the digest path may read a member identifier out of the
    // engagement rows: only counts leave the aggregation.
    expect(code).not.toMatch(/select\s+e\.user_id\b/);
  });

  it("takes every window from one fixed ISO-week grid and gates a wider window statically", () => {
    const code = stripComments(migration);
    expect(code).toContain("create function private.usage_digest_block_start(p_day date)");
    expect(code).toContain("date '2024-01-01' + (pg_catalog.floor((p_day - date '2024-01-01') / 28.0)::integer * 28)");
    expect(code).toContain("private.usage_digest_block_start((p_now at time zone 'UTC')::date) - (offsets.n * 28)");
    // No window may be anchored on the day the generator runs.
    expect(code).not.toMatch(/\(p_now at time zone 'UTC'\)::date - \(offsets\.n \* 28\)/);
    expect(code).toContain("private.usage_digest_window_publishable(org.id, window_row.bucket_start, window_row.bucket_end, floor_size)");
    // The gate reads the weeks' own counts, never the release history.
    expect(code).not.toContain("published_buckets");
    expect(code).not.toContain("private.analytics_usage_digests d2");
  });

  it("registers one bounded pg_cron job for the generator", () => {
    expect(stripComments(migration)).toContain(
      "perform cron.schedule('analytics-usage-digest', '*/20 13-23 * * *', 'select private.generate_analytics_usage_digests(pg_catalog.now(), 200, false)');",
    );
  });

  it("repairs the digest so nothing reads page views and check-ins have their own people floor", () => {
    const code = stripComments(repair);
    // F2-F4: no view total, section or role row is computed any more.
    expect(code).not.toContain("organization_page_views");
    expect(code).not.toMatch(/'views'|'topSections'|'byHat'|suppressedSections|suppressedHats/);
    expect(code).toContain("drop function private.usage_digest_bucket(uuid, date, date, integer, integer);");
    expect(code).toContain("drop function private.usage_digest_section(text);");
    expect(code).toContain("delete from public.platform_setting_definitions\nwhere key = 'limits.analytics.ai_usage_digest_sections';");
    // F1: a bucket's check-ins need enough distinct people, and a wider
    // window's check-ins follow the same remainder rule as its actors.
    expect(code).toContain("'checkins', case when checkin_people >= floor_size then private.usage_digest_floored(checkins) end");
    expect(code).toContain("floor_size, 'meeting_check_in')");
    // F5: a week a stored bucket already published counts as published.
    expect(code).toContain("where (counted.people >= 25 or counted.stored)");
    expect(code).toContain("array['actors', 'checkins']");
    // Round 2 (Sol 6.1 P0): a rewritten digest gets a new id, so a wording
    // save authorized against the old payload matches no row.
    expect(code).toContain("update private.analytics_usage_digests d\nset id = extensions.gen_random_uuid(),");
    expect(code).toMatch(/ai_status = 'not_requested',\s+ai_summary = null,/);
    expect(code).not.toMatch(/select\s+e\.user_id\b/);
    expect(code).toContain("revoke all on function private.usage_digest_window_publishable(uuid, date, date, integer, text) from public, anon, authenticated, service_role;");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
// 2026-10-05 13:05 UTC = 9:05 AM EDT on a Monday, and 2026-10-05 also opens a
// fixed four-week block (28-day steps from the Monday epoch 2024-01-01). The
// four completed ISO weeks end 2026-10-04 and so does the newest completed
// block, 2026-09-07..2026-10-04.
const MORNING = "2026-10-05T13:05:00Z";
// 3:40 PM ET the same day: a continuation batch.
const AFTERNOON = "2026-10-05T19:40:00Z";
// 8:05 AM ET: before the window opens.
const EARLY = "2026-10-05T12:05:00Z";

live("usage digest on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(
    ["org", "otherOrg", "admin", "adminSession", "member", "memberSession"].map((key) => [key, randomUUID()]),
  );
  const prefix = `usage-${ids.org.slice(0, 8)}`;
  const chapter = `${prefix}-a`;
  const foreign = `${prefix}-b`;

  async function as(user, session, sql, params = []) {
    await db.query("savepoint usage_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint usage_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint usage_call");
      await db.query("reset role").catch(() => {});
      await db.query("release savepoint usage_call");
      return { code: error.code, message: error.message };
    }
  }

  const setting = (key, value, org = ids.org) => db.query(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [org, key, JSON.stringify(value)],
  );
  const generate = (now = MORNING, limit = 200, force = false) => db
    .query("select private.generate_analytics_usage_digests($1::timestamptz, $2, $3) n", [now, limit, force])
    .then((result) => result.rows[0].n);
  const read = (hat = "admin", user = ids.admin, session = ids.adminSession) => as(
    user, session, "select public.get_analytics_usage_digests($1) data", [hat],
  );
  const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
  const stored = (org = ids.org) => db
    .query("select * from private.analytics_usage_digests where organization_id=$1 order by period", [org])
    .then((result) => result.rows);

  async function signedIn(user, session, org, chapterId, roles = []) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, user]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user, chapterId]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapterId]);
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [session, user]);
    await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Usage digest proof','totp','verified',now(),now())", [randomUUID(), user]);
    for (const role of roles) {
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, user, role]);
    }
  }

  // Thirty people use the app inside the latest completed ISO week and inside
  // the latest completed four-week block. Every actor in the block sits in a
  // week that publishes on its own, so the block adds no cohort of its own and
  // only the weekly total may be published.
  async function seedUsage(org, chapterId, people, day, views, checkinPeople = 26) {
    for (let i = 0; i < people; i += 1) {
      const id = randomUUID();
      await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapterId]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapterId]);
      await db.query(
        "insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at) values ($1,$2,$3,'page_view',$4,$5)",
        [org, id, chapterId, `/m/home|${day}T12:0${i % 10}`, `${day}T12:00:00Z`],
      );
      if (i < checkinPeople) {
        await db.query(
          "insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at) values ($1,$2,$3,'meeting_check_in',$4,$5)",
          [org, id, chapterId, `${prefix}-${day}-${i}`, `${day}T12:30:00Z`],
        );
      }
    }
    await db.query(
      "insert into public.organization_page_views(organization_id,path,hat,day,view_count) values ($1,'/m/home','member',$2::date,$3),($1,'/m/cases/open','steward',$2::date,$4) on conflict (organization_id,path,hat,day) do update set view_count = excluded.view_count",
      [org, day, views, 30],
    );
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "ai-usage-digest-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout='180s'");
    await db.query("set local lock_timeout='15s'");
    const creator = randomUUID();
    await db.query("insert into auth.users(id,email) values ($1,$2)", [creator, `${creator}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$3,$3,$5),($2,$4,$4,$5)", [ids.org, ids.otherOrg, `${prefix}-org`, `${prefix}-other`, creator]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$3,false,9931),($2,$2,$2,$4,false,9932)", [chapter, foreign, ids.org, ids.otherOrg]);
    await signedIn(ids.admin, ids.adminSession, ids.org, chapter, ["admin"]);
    await signedIn(ids.member, ids.memberSession, ids.org, chapter);
    // 2026-09-30 sits in the newest completed ISO week (09-28..10-04) and in
    // the newest completed four-week block (09-07..10-04).
    await seedUsage(ids.org, chapter, 30, "2026-09-30", 140);
    // Another organization's day in the same window must never enter the totals.
    await seedUsage(ids.otherOrg, foreign, 30, "2026-09-30", 999);
  }, 300000);
  beforeEach(async () => { await db.query("savepoint usage_test"); });
  afterEach(async () => { await db.query("rollback to savepoint usage_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("registers the switch and limits OFF, staff-only, in the analytics category", async () => {
    const rows = (await db.query(
      "select key, value_kind, default_value, category, member_visible, minimum, maximum from public.platform_setting_definitions where key = any($1::text[]) order by key",
      [[SWITCH, WORDING, FLOOR_KEY, "limits.analytics.ai_usage_digest_sections"]],
    )).rows;
    // The section limit retired with the section list (Q53 = A).
    expect(rows.map((row) => row.key)).toEqual([
      "features.analytics.ai_usage_digest",
      "features.analytics.ai_usage_digest_wording",
      "limits.analytics.ai_usage_digest_min_cohort",
    ]);
    expect(rows[0]).toMatchObject({ value_kind: "boolean", default_value: false, category: "analytics", member_visible: false });
    expect(rows[1]).toMatchObject({ value_kind: "boolean", default_value: false, category: "analytics", member_visible: false });
    expect(rows[2]).toMatchObject({ value_kind: "integer", default_value: 25, minimum: 25, maximum: 200 });
  });

  it("stays off by default and before 9 AM Eastern, and the staff read stays inert", async () => {
    expect(await generate()).toBe(0);
    const refused = await read();
    expect(refused, refused.message).toMatchObject({ code: "" });
    expect(refused.data).toEqual({ enabled: false, digests: [] });
    await setting(SWITCH, true);
    expect(await generate(EARLY)).toBe(0);
    expect(await stored()).toHaveLength(0);
  });

  it("stores one weekly and one monthly aggregate digest, idempotently, with this organization's rows only", async () => {
    await setting(SWITCH, true);
    expect(await generate()).toBe(2);
    expect(await generate()).toBe(0);
    const rows = await stored();
    expect(rows.map((row) => row.period)).toEqual(["monthly", "weekly"]);
    const weekly = rows.find((row) => row.period === "weekly");
    expect(weekly.window_end.toISOString().slice(0, 10)).toBe("2026-10-04");
    expect(weekly.buckets).toHaveLength(4);
    expect(weekly.has_data).toBe(true);
    expect(weekly.ai_status).toBe("not_requested");
    const latest = weekly.buckets[3];
    // 30 actors clear the floor and 26 people checked in once each, so both
    // figures publish, floored to 30 and 25. No view figure exists.
    expect(latest).toEqual({ start: "2026-09-28", end: "2026-10-04", suppressed: false, minCohort: 25, actors: 30, checkins: 25 });
    expect(weekly.deltas.map((delta) => delta.metric)).toEqual(["actors", "checkins"]);
    const monthly = rows.find((row) => row.period === "monthly");
    expect(monthly.buckets).toHaveLength(2);
    expect(monthly.buckets[1]).toMatchObject({ suppressed: true, actors: null, checkins: null });
    // 999 is the other organization's seeded count; match it only as a JSON
    // number so a random UUID that happens to contain "999" cannot fail this.
    expect(JSON.stringify(rows)).not.toMatch(/example\.invalid|[:,[]999[,}\]]/);
  });

  it("withholds the four-week total that would reveal a hidden one-person week by subtraction", async () => {
    await seedUsage(ids.org, chapter, 1, "2026-09-20", 25);
    // Keep exactly the review's 25 older views (seedUsage also adds a role row).
    await db.query("delete from public.organization_page_views where organization_id=$1 and day='2026-09-20' and hat='steward'", [ids.org]);
    await setting(SWITCH, true);
    await setting(WORDING, true);
    await setting("features.ai_assistant.enabled", true);
    await generate();
    const { digests } = (await read()).data;
    const weekly = digests.find((row) => row.period === "weekly");
    const monthly = digests.find((row) => row.period === "monthly");
    expect(weekly.buckets[3]).toMatchObject({ suppressed: false, actors: 30 });
    expect(weekly.buckets[1]).toMatchObject({ suppressed: true, actors: null });
    expect(monthly.buckets[1]).toEqual({ start: "2026-09-07", end: "2026-10-04", suppressed: true, minCohort: 25, actors: null, checkins: null });
    expect(monthly.deltas.every((delta) => delta.current === null && delta.direction === "unknown")).toBe(true);
    expect(monthly).toMatchObject({ hasData: false, ai: { status: "off" } });
    const authorized = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", weekly.id]);
    expect(authorized.code).toBe("");
    expect(authorized.data.buckets[1].actors).toBeNull();
    const withheld = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", monthly.id]);
    expect(withheld.code).toBe("22023");
  });

  it("checks the union of published weeks rather than only pairwise complements", async () => {
    await seedUsage(ids.org, chapter, 30, "2026-09-23", 140);
    await seedUsage(ids.org, chapter, 1, "2026-09-20", 25);
    await setting(SWITCH, true);
    await generate();
    const rows = await stored();
    expect(rows.find((row) => row.period === "weekly").buckets.filter((bucket) => !bucket.suppressed)).toHaveLength(2);
    expect(rows.find((row) => row.period === "monthly").buckets[1]).toMatchObject({ suppressed: true, actors: null });
  });

  it("publishes the wider total when its additional distinct-actor cohort clears the floor", async () => {
    await seedUsage(ids.org, chapter, 13, "2026-09-10", 40);
    await seedUsage(ids.org, chapter, 13, "2026-09-20", 40);
    await setting(SWITCH, true);
    await generate();
    const monthly = (await stored()).find((row) => row.period === "monthly");
    // 26 people checked in outside the 30-person week, so check-ins publish
    // too: 26 + 13 + 13 = 52 floors to 50.
    expect(monthly.buckets[1]).toEqual({ start: "2026-09-07", end: "2026-10-04", suppressed: false, minCohort: 25, actors: 55, checkins: 50 });
  });

  // Round-4, 2026-10-10: the remainder used to drop only the
  // events inside publishable weeks, so people from the published 30-person
  // week who also came back in a quiet week counted toward the floor, and the
  // block total (35) minus the weekly total (30) handed back five newcomers.
  it("does not count people already in a published week toward the wider window's added cohort", async () => {
    const regulars = (await db.query(
      "select distinct user_id from public.organization_engagement_events where organization_id=$1 and event_type='page_view' and occurred_at >= '2026-09-28' and occurred_at < '2026-10-05' order by user_id limit 20",
      [ids.org],
    )).rows.map((row) => row.user_id);
    expect(regulars).toHaveLength(20);
    for (const id of regulars) {
      await db.query(
        "insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at) values ($1,$2,$3,'page_view',$4,'2026-09-10T12:00:00Z')",
        [ids.org, id, chapter, `/m/home|returning-${id}`],
      );
    }
    await seedUsage(ids.org, chapter, 5, "2026-09-17", 40);
    await setting(SWITCH, true);
    await generate();
    const rows = await stored();
    const weekly = rows.find((row) => row.period === "weekly");
    expect(weekly.buckets[3]).toMatchObject({ suppressed: false, actors: 30 });
    expect(weekly.buckets[0]).toMatchObject({ suppressed: true, actors: null });
    expect(rows.find((row) => row.period === "monthly").buckets[1]).toMatchObject({ suppressed: true, actors: null });
  });

  // Round-4 gate: at a floor of 60 no 30-person week was separately
  // publishable, so the block published; lowering the floor to 25 later lets
  // the weekly digests publish those weeks and the stored block total minus
  // them returns the one-person week. Inner weeks are judged at 25 always.
  it("judges inner weeks at the lowest possible floor so a later floor change cannot open a subtraction", async () => {
    await seedUsage(ids.org, chapter, 30, "2026-09-17", 170);
    await seedUsage(ids.org, chapter, 1, "2026-09-08", 25);
    await db.query("delete from public.organization_page_views where organization_id=$1 and day='2026-09-08' and hat='steward'", [ids.org]);
    await setting(SWITCH, true);
    await setting(FLOOR_KEY, 60);
    await generate();
    expect((await stored()).find((row) => row.period === "monthly").buckets[1]).toMatchObject({ suppressed: true, actors: null });
  });

  // Round-4 gate: on the fixed grid a block returns as the older bucket of the
  // next monthly digest, and a recount after account deletion would publish a
  // smaller figure for the same interval; the generator reuses the bucket it
  // first stored instead.
  it("reuses the first stored bucket when an interval returns in a later release", async () => {
    await seedUsage(ids.org, chapter, 13, "2026-09-10", 40);
    await seedUsage(ids.org, chapter, 13, "2026-09-20", 40);
    await setting(SWITCH, true);
    await generate();
    const first = (await stored()).find((row) => row.period === "monthly").buckets[1];
    expect(first).toMatchObject({ start: "2026-09-07", end: "2026-10-04", suppressed: false, actors: 55 });
    // What an account-deletion cascade does to the engagement rows.
    await db.query("delete from public.organization_engagement_events where organization_id=$1 and occurred_at >= '2026-09-10' and occurred_at < '2026-09-11'", [ids.org]);
    await generate("2026-11-02T14:05:00Z");
    const later = (await stored()).filter((row) => row.period === "monthly").find((row) => day(row.window_start) === "2026-09-07");
    expect(later.buckets[0]).toEqual(first);
  });

  it("never offers a window that partially overlaps another window, whatever day a release runs", async () => {
    const windows = async (period, now) => (await db.query(
      "select bucket_start, bucket_end from private.usage_digest_windows($1, $2::timestamptz) order by bucket_start",
      [period, now],
    )).rows.map((row) => [day(row.bucket_start), day(row.bucket_end)]);
    const seen = [];
    // Every day of a four-week block and the first day of the next one.
    for (const date of ["2026-10-05", "2026-10-08", "2026-10-11", "2026-10-19", "2026-11-01", "2026-11-02"]) {
      for (const period of ["weekly", "monthly"]) seen.push(...await windows(period, `${date}T13:05:00Z`));
    }
    for (const [aStart, aEnd] of seen) {
      for (const [bStart, bEnd] of seen) {
        const identical = aStart === bStart && aEnd === bEnd;
        const disjoint = aEnd < bStart || bEnd < aStart;
        const nested = (aStart <= bStart && bEnd <= aEnd) || (bStart <= aStart && aEnd <= bEnd);
        expect(identical || disjoint || nested, `${aStart}..${aEnd} vs ${bStart}..${bEnd}`).toBe(true);
      }
    }
    // Two releases inside one week, and inside one block, ask for the same
    // windows: a second release discloses no new interval to subtract.
    expect(await windows("weekly", "2026-10-05T13:05:00Z")).toEqual(await windows("weekly", "2026-10-09T23:40:00Z"));
    expect(await windows("monthly", "2026-10-05T13:05:00Z")).toEqual(await windows("monthly", "2026-10-26T13:05:00Z"));
    expect(await windows("monthly", "2026-10-05T13:05:00Z")).toEqual([["2026-08-10", "2026-09-06"], ["2026-09-07", "2026-10-04"]]);
    expect(await windows("weekly", "2026-10-05T13:05:00Z")).toEqual([
      ["2026-09-07", "2026-09-13"], ["2026-09-14", "2026-09-20"], ["2026-09-21", "2026-09-27"], ["2026-09-28", "2026-10-04"],
    ]);
  });

  // The round-3 adversarial finding on 2026-10-10: two releases a week apart
  // published 195, 170 and 340 over moving 28-day windows, and 195 + 170 - 340
  // handed back the 25 views one person made in a week both digests had
  // suppressed. The windows no longer move, and a window publishes only when
  // the cohort it adds beyond its separately publishable weeks reaches the
  // floor, so no release pair leaves a remainder under the floor.
  it("lets two successive releases disclose nothing a single release would withhold", async () => {
    await seedUsage(ids.org, chapter, 30, "2026-08-20", 140);
    await seedUsage(ids.org, chapter, 30, "2026-09-02", 140);
    await seedUsage(ids.org, chapter, 1, "2026-08-05", 25);
    await db.query("delete from public.organization_page_views where organization_id=$1 and day='2026-08-05' and hat='steward'", [ids.org]);
    await setting(SWITCH, true);
    await generate("2026-09-28T13:05:00Z");
    await generate("2026-10-05T13:05:00Z");
    const released = (await db.query(
      "select period, window_start, buckets from private.analytics_usage_digests where organization_id=$1 order by window_start, period",
      [ids.org],
    )).rows;
    // Both releases stored their own weekly and monthly digest.
    expect(released).toHaveLength(4);
    const intervals = released.flatMap((row) => row.buckets.map((bucket) => ({
      start: bucket.start, end: bucket.end, suppressed: bucket.suppressed, actors: bucket.actors,
    })));
    for (const a of intervals) {
      for (const b of intervals) {
        const identical = a.start === b.start && a.end === b.end;
        const disjoint = a.end < b.start || b.end < a.start;
        const nested = (a.start <= b.start && b.end <= a.end) || (b.start <= a.start && a.end <= b.end);
        expect(identical || disjoint || nested, `${a.start}..${a.end} vs ${b.start}..${b.end}`).toBe(true);
      }
    }
    // Nothing published anywhere in either release covers the week holding the
    // single person's 25 views, so no arithmetic over the published figures
    // reaches them.
    for (const interval of intervals.filter((row) => !row.suppressed)) {
      expect(interval.start <= "2026-08-05" && "2026-08-05" <= interval.end).toBe(false);
      const weeks = (await db.query(
        `select ($1::date + (n * 7)) as week_start,
           (select count(distinct e.user_id) from public.organization_engagement_events e
            where e.organization_id = $3 and e.event_type = 'page_view'
              and e.occurred_at >= (($1::date + (n * 7))::timestamp at time zone 'UTC')
              and e.occurred_at < (($1::date + (n * 7) + 7)::timestamp at time zone 'UTC'))::int as actors
         from generate_series(0, (($2::date - $1::date + 1) / 7) - 1) n`,
        [interval.start, interval.end, ids.org],
      )).rows;
      // A week equal to the whole window is this window, not a part of it.
      const separate = weeks
        .filter((week) => week.actors >= 25 && !(weeks.length === 1 && day(week.week_start) === interval.start))
        .map((week) => day(week.week_start));
      const remainder = (await db.query(
        `select count(distinct e.user_id)::int as actors from public.organization_engagement_events e
         where e.organization_id = $3 and e.event_type = 'page_view'
           and e.occurred_at >= ($1::date::timestamp at time zone 'UTC')
           and e.occurred_at < (($2::date + 1)::timestamp at time zone 'UTC')
           and not exists (select 1 from unnest($4::date[]) w
             join public.organization_engagement_events p
               on p.occurred_at >= (w::timestamp at time zone 'UTC')
               and p.occurred_at < ((w + 7)::timestamp at time zone 'UTC')
             where p.organization_id = $3 and p.event_type = 'page_view' and p.user_id = e.user_id)`,
        [interval.start, interval.end, ids.org, separate],
      )).rows[0].actors;
      // What this window adds beyond its separately publishable weeks is
      // itself a cohort at the floor.
      expect(remainder, `${interval.start}..${interval.end} remainder`).toBeGreaterThanOrEqual(25);
    }
    // The one-person week stays suppressed when asked for directly.
    const alone = (await db.query("select private.usage_digest_bucket($1,'2026-08-03','2026-08-09',25) data", [ids.org])).rows[0].data;
    expect(alone).toMatchObject({ suppressed: true, actors: null, checkins: null });
  });

  // Round-3 P3-2: a digest generated while the wording switch was off stored
  // not_requested, and the read used to wait for the next generation window --
  // on the fixed grid up to four weeks for a monthly digest.
  it("offers wording for a digest generated before the wording switch was turned on", async () => {
    await setting(SWITCH, true);
    await generate();
    expect((await stored()).every((row) => row.ai_status === "not_requested")).toBe(true);
    await setting(WORDING, true);
    await setting("features.ai_assistant.enabled", true);
    const weekly = (await read()).data.digests.find((row) => row.period === "weekly");
    expect(weekly).toMatchObject({ hasData: true, ai: { status: "available", summary: null } });
    const authorized = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", weekly.id]);
    expect(authorized, authorized.message).toMatchObject({ code: "" });
    const saved = await as(
      ids.admin, ids.adminSession,
      "select public.save_analytics_usage_digest_ai($1,$2,$3,$4,$5,$6) data",
      ["admin", weekly.id, "Thirty people opened the member pages in the latest completed week.", ["Home stayed the busiest page"], null, "proof-model"],
    );
    expect(saved, saved.message).toMatchObject({ code: "" });
    expect(saved.data.ai.status).toBe("enriched");
    // Turning the switch back off hides the wording again.
    await setting(WORDING, false);
    expect((await read()).data.digests.find((row) => row.period === "weekly").ai.status).toBe("off");
  });

  it("does not offer wording for an under-floor digest, including a stale available cache row", async () => {
    await setting(SWITCH, true);
    await setting(WORDING, true);
    await setting("features.ai_assistant.enabled", true);
    await setting(FLOOR_KEY, 60);
    await generate();
    expect((await stored()).every((row) => !row.has_data && row.ai_status === "not_requested")).toBe(true);
    const digest = (await read()).data.digests[0];
    expect(digest).toMatchObject({ hasData: false, ai: { status: "off" } });
    await db.query("update private.analytics_usage_digests set ai_status='available' where id=$1", [digest.id]);
    expect((await read()).data.digests[0].ai.status).toBe("off");
    const authorized = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", digest.id]);
    expect(authorized.code).toBe("22023");
  });

  // Review round 1 (OPS-UG-AI-USAGE-DIGEST-PRIVACY-REVIEW-20261010), one
  // case per finding. Each fails on the digest as merged at 71ffc5036.

  // F1: one person checking into five meetings read as "checkins: 5", and
  // G1: eight people checking in read as 5, because only page-view people
  // were counted against the floor.
  it("withholds check-ins until enough distinct people checked in (F1, G1)", async () => {
    await seedUsage(ids.org, chapter, 30, "2026-09-16", 140, 8);
    await seedUsage(ids.org, chapter, 30, "2026-09-23", 140, 0);
    for (let n = 0; n < 5; n += 1) {
      await db.query(
        "insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at) values ($1,$2,$3,'meeting_check_in',$4,'2026-09-23T15:00:00Z')",
        [ids.org, ids.member, chapter, `${prefix}-alone-${n}`],
      );
    }
    await setting(SWITCH, true);
    await generate();
    const weekly = (await stored()).find((row) => row.period === "weekly");
    expect(weekly.buckets[1]).toMatchObject({ start: "2026-09-14", suppressed: false, actors: 30, checkins: null });
    expect(weekly.buckets[2]).toMatchObject({ start: "2026-09-21", suppressed: false, actors: 30, checkins: null });
    expect(weekly.buckets[3]).toMatchObject({ start: "2026-09-28", suppressed: false, actors: 30, checkins: 25 });
    expect(weekly.deltas.find((delta) => delta.metric === "checkins")).toMatchObject({ current: 25, previous: null, direction: "unknown" });
  });

  // F1 across windows: the block's 32 check-in people clear the floor on
  // their own, but 26 of them are the published week's, so the block total
  // minus the weekly one would return six people's check-ins.
  it("withholds a wider window's check-ins when the people it adds are under the floor (F1)", async () => {
    await seedUsage(ids.org, chapter, 13, "2026-09-10", 40, 3);
    await seedUsage(ids.org, chapter, 13, "2026-09-20", 40, 3);
    await setting(SWITCH, true);
    await generate();
    const monthly = (await stored()).find((row) => row.period === "monthly");
    expect(monthly.buckets[1]).toEqual({ start: "2026-09-07", end: "2026-10-04", suppressed: false, minCohort: 25, actors: 55, checkins: null });
  });

  // F2: section totals were gated per section over the whole window, so the
  // block's case-section total minus the weekly one returned the quiet weeks'
  // case views, including one member's 25.
  it("publishes no section breakdown a monthly total could be differenced from (F2)", async () => {
    await seedUsage(ids.org, chapter, 13, "2026-09-10", 40);
    await seedUsage(ids.org, chapter, 13, "2026-09-20", 40);
    await db.query("insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at) select organization_id,user_id,chapter_id,event_type,'/m/cases/open|' || occurred_at::text,occurred_at from public.organization_engagement_events where organization_id=$1 and event_type='page_view'", [ids.org]);
    await db.query("insert into public.organization_page_views(organization_id,path,hat,day,view_count) values ($1,'/m/cases/open','member','2026-09-16',25)", [ids.org]);
    await db.query("insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at) values ($1,$2,$3,'page_view','/m/cases/open|lone','2026-09-16T14:00:00Z')", [ids.org, ids.member, chapter]);
    await setting(SWITCH, true);
    await generate();
    const monthly = (await stored()).find((row) => row.period === "monthly");
    expect(monthly.buckets[1]).toMatchObject({ suppressed: false, actors: 55 });
    for (const bucket of monthly.buckets) expect(Object.keys(bucket).sort()).toEqual(BUCKET_KEYS);
    expect(JSON.stringify(monthly)).not.toMatch(/\/m\/|views|topSections|byHat/);
  });

  // F3: the weekly view total minus the live analytics reader's published
  // day, path and hat cells returned the views of the cells it withheld.
  it("publishes no view total to difference against the live reader's daily cells (F3)", async () => {
    await setting(SWITCH, true);
    await setting(WORDING, true);
    await setting("features.ai_assistant.enabled", true);
    await generate();
    const { data } = await read();
    for (const digest of data.digests) {
      for (const bucket of digest.buckets) expect(Object.keys(bucket).sort()).toEqual(BUCKET_KEYS);
      expect(digest.deltas.map((delta) => delta.metric)).toEqual(["actors", "checkins"]);
    }
    const weekly = data.digests.find((row) => row.period === "weekly");
    expect(weekly.buckets[3]).toMatchObject({ actors: 30, checkins: 25 });
    const authorized = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", weekly.id]);
    expect(authorized, authorized.message).toMatchObject({ code: "" });
    expect(JSON.stringify(authorized.data)).not.toMatch(/views|topSections|byHat|suppressedSections|suppressedHats/);
  });

  // F4 and G2: page views can be pruned at 30 days, so a first generation on
  // 2026-10-26 summed the surviving view rows of the 2026-09-07 block next to
  // a complete actor count and published the partial total.
  it("publishes no view total after page views were pruned (F4, G2)", async () => {
    await seedUsage(ids.org, chapter, 13, "2026-09-10", 40);
    await seedUsage(ids.org, chapter, 13, "2026-09-20", 40);
    await db.query("delete from public.organization_page_views where organization_id=$1 and day < '2026-09-26'", [ids.org]);
    await setting(SWITCH, true);
    await generate("2026-10-26T13:05:00Z");
    const monthly = (await stored()).find((row) => row.period === "monthly");
    expect(monthly.buckets[1]).toEqual({ start: "2026-09-07", end: "2026-10-04", suppressed: false, minCohort: 25, actors: 55, checkins: 50 });
    expect(monthly.buckets[0]).toMatchObject({ start: "2026-08-10", suppressed: true });
  });

  // F5: six of a published 30-person week's accounts are deleted, which
  // removes their engagement rows; judged by today's 24, the week no longer
  // counted as published, and the block's remainder (24 + one newcomer)
  // reached 25, though the stored weekly figure subtracts to the newcomer.
  it("treats a week a stored bucket published as published after account deletion (F5)", async () => {
    await seedUsage(ids.org, chapter, 30, "2026-09-16", 140);
    await setting(SWITCH, true);
    await generate("2026-09-21T13:05:00Z");
    const earlier = (await stored()).find((row) => row.period === "weekly");
    expect(earlier.buckets[3]).toMatchObject({ start: "2026-09-14", end: "2026-09-20", suppressed: false, actors: 30 });
    await db.query(
      "delete from public.organization_engagement_events where organization_id=$1 and user_id in (select distinct user_id from public.organization_engagement_events where organization_id=$1 and event_type='page_view' and occurred_at >= '2026-09-14' and occurred_at < '2026-09-21' order by user_id limit 6)",
      [ids.org],
    );
    await seedUsage(ids.org, chapter, 1, "2026-09-10", 25);
    await generate(MORNING);
    const latest = (await db.query(
      "select period, buckets from private.analytics_usage_digests where organization_id=$1 and ((period='weekly' and window_start='2026-09-07') or (period='monthly' and window_start='2026-08-10')) order by period",
      [ids.org],
    )).rows;
    expect(latest.find((row) => row.period === "weekly").buckets[1]).toMatchObject({ start: "2026-09-14", actors: 30 });
    expect(latest.find((row) => row.period === "monthly").buckets[1]).toMatchObject({ start: "2026-09-07", suppressed: true, actors: null, checkins: null });
  });

  it("withholds a single member's 25-view injected section and fails closed without actor events", async () => {
    await db.query("insert into public.organization_page_views(organization_id,path,hat,day,view_count) values ($1,'/m/Injected.Person','member','2026-09-30',25)", [ids.org]);
    await db.query("insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at) select $1,$2,$3,'page_view','/m/Injected.Person|' || n,'2026-09-30T14:00:00Z' from generate_series(1,25) n", [ids.org, ids.member, chapter]);
    await setting(SWITCH, true);
    await generate();
    const latest = (await stored()).find((row) => row.period === "weekly").buckets[3];
    expect(latest.suppressed).toBe(false);
    expect(Object.keys(latest).sort()).toEqual(BUCKET_KEYS);
    expect(JSON.stringify(latest)).not.toContain("Injected.Person");
    await db.query("delete from public.organization_engagement_events where organization_id=$1 and event_type='page_view'", [ids.org]);
    const empty = (await db.query("select private.usage_digest_bucket($1,'2026-09-28','2026-10-04',25) data", [ids.org])).rows[0].data;
    expect(empty).toMatchObject({ suppressed: true, actors: null, checkins: null });
  });

  it("honors a higher analytics floor at generation and after cached wording exists", async () => {
    await setting(SWITCH, true);
    await setting(WORDING, true);
    await setting("features.ai_assistant.enabled", true);
    await generate();
    const digest = (await read()).data.digests[0];
    await db.query("update private.analytics_usage_digests set ai_status='enriched',ai_summary='{}',ai_model='proof',enriched_at=now() where id=$1", [digest.id]);
    await setting("limits.analytics.anonymity_floor", 60);
    const fresh = (await read()).data;
    expect(fresh.minCohort).toBe(60);
    expect(fresh.digests[0]).toMatchObject({ hasData: false, deltas: [], ai: { status: "off", summary: null, model: null } });
    expect(fresh.digests[0].buckets.every((row) => row.suppressed && row.minCohort === 60 && row.actors === null)).toBe(true);
    const monthly = fresh.digests[1];
    const authorized = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", monthly.id]);
    expect(authorized.code).toBe("22023");
    const saved = await as(ids.admin, ids.adminSession, "select public.save_analytics_usage_digest_ai($1,$2,$3,$4::text[],$5,$6) data", ["admin", monthly.id, "A stale digest must not receive new wording.", [], null, "proof"]);
    expect(saved.code).toBe("22023");
    await db.query("delete from private.analytics_usage_digests where organization_id=$1", [ids.org]);
    await db.query("delete from private.analytics_usage_digest_visits where organization_id=$1", [ids.org]);
    expect(await generate()).toBe(2);
    expect((await stored())[0].buckets.every((row) => row.minCohort === 60 && row.suppressed)).toBe(true);
  });

  it("refuses organization-wide digests to a chapter-only steward", async () => {
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [ids.member, chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [ids.member, chapter]);
    await setting(SWITCH, true);
    await generate();
    expect((await read("steward", ids.member, ids.memberSession)).code).toBe("42501");
  });

  it("continues the batch when one organization's digest insert fails", async () => {
    await setting(SWITCH, true);
    await setting(SWITCH, true, ids.otherOrg);
    await db.query(`create function pg_temp.reject_usage_digest() returns trigger language plpgsql as $body$ begin if new.organization_id = '${ids.org}'::uuid then raise exception 'fixture rejection'; end if; return new; end; $body$`);
    await db.query("create trigger usage_digest_fixture before insert on private.analytics_usage_digests for each row execute function pg_temp.reject_usage_digest()");
    expect(await generate()).toBe(2);
    expect(await stored()).toHaveLength(0);
    expect(await stored(ids.otherOrg)).toHaveLength(2);
    expect(await generate(AFTERNOON)).toBe(0);
  });

  it("suppresses a period whose cohort is under the floor and never lets the floor fall below 25", async () => {
    await setting(SWITCH, true);
    await setting(FLOOR_KEY, 60);
    expect(await generate()).toBe(2);
    const weekly = (await stored()).find((row) => row.period === "weekly");
    expect(weekly.buckets[3]).toEqual({ start: "2026-09-28", end: "2026-10-04", suppressed: true, minCohort: 60, actors: null, checkins: null });
    expect(weekly.has_data).toBe(false);
    // Owner-level SQL bypasses the settings RPC's definition validation.
    // Even with that invalid stored value, the generator cannot go below 25.
    await setting(FLOOR_KEY, 5);
    await db.query("delete from private.analytics_usage_digests where organization_id=$1", [ids.org]);
    await db.query("delete from private.analytics_usage_digest_visits where organization_id=$1", [ids.org]);
    await db.query("delete from public.organization_engagement_events where organization_id=$1 and event_type='page_view' and user_id not in (select user_id from public.organization_engagement_events where organization_id=$1 and event_type='page_view' order by user_id limit 20)", [ids.org]);
    expect(await generate()).toBe(2);
    const clamped = (await stored()).find((row) => row.period === "weekly").buckets[3];
    expect(clamped).toMatchObject({ suppressed: true, minCohort: 25, actors: null, checkins: null });
  });

  it("visits each eligible organization in bounded continuation batches", async () => {
    await setting(SWITCH, true);
    await setting(SWITCH, true, ids.otherOrg);
    expect(await generate(MORNING, 1)).toBe(2);
    const first = await db.query("select distinct organization_id from private.analytics_usage_digest_visits");
    expect(first.rows).toHaveLength(1);
    expect(await generate(AFTERNOON, 1)).toBe(2);
    const second = await db.query("select distinct organization_id from private.analytics_usage_digest_visits");
    expect(second.rows).toHaveLength(2);
    expect(await generate(AFTERNOON, 5)).toBe(0);
  });

  it("opens the read to the staff hats the caller holds and refuses members", async () => {
    await setting(SWITCH, true);
    await generate();
    const staff = await read("admin");
    expect(staff, staff.message).toMatchObject({ code: "" });
    expect(staff.data.enabled).toBe(true);
    expect(staff.data.minCohort).toBe(25);
    expect(staff.data.digests.map((digest) => digest.period)).toEqual(["weekly", "monthly"]);
    expect(staff.data.digests[0].ai).toMatchObject({ status: "off" });
    const asMember = await read("member", ids.member, ids.memberSession);
    expect(asMember.code).toBe("42501");
    const unheld = await read("vp");
    expect(unheld.code).toBe("42501");
  });

  it("offers Compass wording only with both switches on, and stores it once", async () => {
    await setting(SWITCH, true);
    await setting(WORDING, true);
    await setting("features.ai_assistant.enabled", true);
    await generate();
    const staff = await read("admin");
    const digest = staff.data.digests[0];
    expect(digest.ai.status).toBe("available");
    const authorized = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", digest.id]);
    expect(authorized, authorized.message).toMatchObject({ code: "" });
    expect(authorized.data.organizationId).toBe(ids.org);
    expect(Object.keys(authorized.data).sort()).toEqual(["buckets", "deltas", "digestId", "organizationId", "period", "windowEnd", "windowStart"]);
    expect(JSON.stringify(authorized.data)).not.toMatch(/example\.invalid/);
    const saved = await as(
      ids.admin, ids.adminSession,
      "select public.save_analytics_usage_digest_ai($1,$2,$3,$4::text[],$5,$6) data",
      ["admin", digest.id, "App use held steady across the last four weeks, with most activity on the home screen.", ["Home stayed the busiest section"], null, "union-ground/compass-mesh:v1"],
    );
    expect(saved, saved.message).toMatchObject({ code: "" });
    expect(saved.data.ai).toMatchObject({ status: "enriched", model: "union-ground/compass-mesh:v1" });
    // Once only.
    const again = await as(
      ids.admin, ids.adminSession,
      "select public.save_analytics_usage_digest_ai($1,$2,$3,$4::text[],$5,$6) data",
      ["admin", digest.id, "App use held steady across the last four weeks, with most activity on the home screen.", [], null, "union-ground/compass-mesh:v1"],
    );
    expect(again.code).toBe("22023");
    // Short wording is refused.
    const monthly = staff.data.digests[1];
    const short = await as(
      ids.admin, ids.adminSession,
      "select public.save_analytics_usage_digest_ai($1,$2,$3,$4::text[],$5,$6) data",
      ["admin", monthly.id, "too short", [], null, "union-ground/compass-mesh:v1"],
    );
    expect(short.code).toBe("22023");
  });

  it("refuses the wording path while either switch is off", async () => {
    await setting(SWITCH, true);
    await setting(WORDING, true);
    await setting("features.ai_assistant.enabled", true);
    await generate();
    const digest = (await read("admin")).data.digests[0];
    await setting("features.ai_assistant.enabled", false);
    const withoutAi = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", digest.id]);
    expect(withoutAi.code).toBe("42501");
    await setting("features.ai_assistant.enabled", true);
    await setting(WORDING, false);
    const withoutWording = await as(ids.admin, ids.adminSession, "select public.authorize_analytics_usage_digest_ai($1,$2) data", ["admin", digest.id]);
    expect(withoutWording.code).toBe("42501");
    // Turning the digest switch off makes the stored rows unreadable, not just hidden.
    await setting(SWITCH, false);
    const off = await read("admin");
    expect(off.data).toEqual({ enabled: false, digests: [] });
    await setting(WORDING, true);
    const saveOff = await as(ids.admin, ids.adminSession, "select public.save_analytics_usage_digest_ai($1,$2,$3,$4::text[],$5,$6) data", ["admin", digest.id, "This wording must be refused with the digest switch off.", [], null, "proof"]);
    expect(saveOff.code).toBe("42501");
  });

  it("keeps the private cache unreachable from a signed-in client", async () => {
    const direct = await as(ids.admin, ids.adminSession, "select count(*) data from private.analytics_usage_digests");
    expect(direct.code).toBe("42501");
    const visits = await as(ids.admin, ids.adminSession, "select count(*) data from private.analytics_usage_digest_visits");
    expect(visits.code).toBe("42501");
  });

  it("mirrors a failed usage digest cron run and lists the job for the organization admin", async () => {
    const runId = 7_000_000_000 + Number.parseInt(randomUUID().slice(0, 8), 16);
    await db.query("insert into cron.job_run_details(jobid,runid,job_pid,database,username,command,status,return_message,start_time,end_time) select jobid,$1,1,current_database(),current_user,'select 1','failed','fixture',clock_timestamp(),clock_timestamp() from cron.job where jobname='analytics-usage-digest'", [runId]);
    await db.query("select private.sync_organization_job_runs_from_cron_history()");
    const mirrored = await db.query("select status from public.organization_job_runs where job_name='analytics-usage-digest' and run_id=$1", [`cron:${runId}`]);
    expect(mirrored.rows).toEqual([{ status: "failed" }]);
    const health = await as(ids.admin, ids.adminSession, "select public.list_organization_job_health() data");
    expect(health.code).toBe("");
    expect(health.data).toEqual(expect.arrayContaining([expect.objectContaining({ jobName: "analytics-usage-digest", lastStatus: "failed" })]));
  });
});
