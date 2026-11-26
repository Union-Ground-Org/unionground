// @vitest-environment node
//
// REQ-UG-RECOMMENDED-AND-NEAREST-STEWARD-20261001
//
// "Find available steward" only ever said "A steward is covered". The
// recommendation now carries the steward's display name and opted-in contact
// routes (for a chapter the caller belongs to), breaks ties by proximity to the
// caller (work location, then department, then chapter: old
// lib/dashboard/steward-resolver.ts), and recommends the nearest chapter
// steward when nobody is scheduled, all behind
// features.casework.nearest_steward_matching.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migration = readFileSync(
  new URL("../supabase/migrations/20261002144000_recommended_nearest_steward.sql", import.meta.url),
  "utf8",
);

describe("recommended and nearest steward (static)", () => {
  it("registers the switch ON and keeps the account id out of member copy", () => {
    expect(migration).toMatch(/\('features\.casework\.nearest_steward_matching', 'boolean',[\s\S]*?'true', null, null, null, 1600, 'casework', false\)/);
    expect(migration).toContain("steward-resolver.ts");
    expect(migration).toContain("'contactRoute', 'member_message'");
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/recommended-nearest-steward-db.test.js");
  });
});

const ID = {
  org: "50902217-0000-4000-8000-000000000001",
  member: "50902217-0000-4000-8000-000000000101",
  stewardDept: "50902217-0000-4000-8000-000000000102",
  stewardSite: "50902217-0000-4000-8000-000000000103",
  stewardOther: "50902217-0000-4000-8000-000000000104",
  outsider: "50902217-0000-4000-8000-000000000105",
};
const SESSION = {
  [ID.member]: "50902217-0000-4000-8000-000000000201",
  [ID.outsider]: "50902217-0000-4000-8000-000000000202",
};
const CHAPTER = "nearest-steward-proof";
const OTHER_CHAPTER = "nearest-steward-proof-other";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("recommended and nearest steward on a disposable database", () => {
  let db;

  async function recommend(userId, chapter = CHAPTER) {
    await db.query("savepoint as_user");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: SESSION[userId], aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const row = (await db.query("select public.recommend_organization_coverage($1, now()) result", [chapter])).rows[0].result;
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      await db.query("release savepoint as_user");
      return row;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      throw error;
    }
  }
  const setSwitch = (value) => db.query(
    `insert into public.organization_setting_values(organization_id, setting_key, value)
     values ($1, 'features.casework.nearest_steward_matching', $2::jsonb)
     on conflict (organization_id, setting_key) do update set value = excluded.value`,
    [ID.org, JSON.stringify(value)],
  );
  const schedule = (stewardId, updatedAgo, priority = 0) => db.query(
    `insert into public.organization_coordination_records
       (organization_id, chapter_id, kind, title, status, config, created_by, idempotency_key, updated_at)
     values ($1, $2, 'coverage_schedule', 'Coverage', 'active',
       jsonb_build_object('stewardUserId', $3::text, 'dayOfWeek', extract(dow from now() at time zone 'UTC')::integer,
         'startMinute', 0, 'endMinute', 1440, 'timezone', 'UTC', 'priority', $5::integer),
       $3::uuid, gen_random_uuid(), now() - $4::interval)
     returning id`,
    [ID.org, CHAPTER, stewardId, updatedAgo, priority],
  );

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "recommended-nearest-steward-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    const people = [ID.member, ID.stewardDept, ID.stewardSite, ID.stewardOther, ID.outsider];
    for (const id of people) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `nearest-${id.slice(-3)}@example.invalid`]);
    }
    for (const id of [ID.member, ID.outsider]) {
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [SESSION[id], id]);
    }
    await db.query(
      "insert into public.organizations(id, slug, name, created_by) values ($1, 'nearest-steward-proof-org', 'Nearest steward proof', $2)",
      [ID.org, ID.member],
    );
    await db.query(
      "insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $3, false, 9926), ($2, $2, $2, $3, false, 9927)",
      [CHAPTER, OTHER_CHAPTER, ID.org],
    );
    for (const id of people) {
      const chapter = id === ID.outsider ? OTHER_CHAPTER : CHAPTER;
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, chapter]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, chapter]);
    }
    const names = [[ID.stewardDept, "Dana Department"], [ID.stewardSite, "Sam Site"], [ID.stewardOther, "Otto Other"]];
    for (const [id, name] of names) {
      await db.query("update public.member_profiles set full_name = $2 where id = $1", [id, name]);
      await db.query(
        "insert into public.member_roles(user_id, role, chapter_id) values ($1, 'steward', $2) on conflict do nothing",
        [id, CHAPTER],
      );
    }
    const profile = (id, location, department) => db.query(
      `insert into public.organization_member_operational_profiles(organization_id, member_user_id, work_location, department)
       values ($1, $2, $3, $4)`,
      [ID.org, id, location, department],
    );
    await profile(ID.member, "North Clinic", "Records");
    await profile(ID.stewardDept, "South Clinic", "records ");
    await profile(ID.stewardSite, "north clinic", "Billing");
    await profile(ID.stewardOther, "East Office", "Payroll");
    await db.query(
      "insert into public.steward_contact_preferences(steward_user_id, share_email, share_phone, contact_email, contact_phone) values ($1, true, false, 'sam.site@example.invalid', '555-0100')",
      [ID.stewardSite],
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("recommends the nearest chapter steward by work location when nobody is scheduled, with opted-in routes only", async () => {
    const result = await recommend(ID.member);
    expect(result).toMatchObject({
      state: "nearest", source: "nearest", recommendedUserId: ID.stewardSite, matchLevel: "work_location",
      contactRoute: "member_message",
      steward: { name: "Sam Site", contact: { conversation: true, email: "sam.site@example.invalid", phone: null } },
    });
  });

  it("breaks a tie between equally ranked schedules by proximity, and by recency when matching is off", async () => {
    await schedule(ID.stewardOther, "1 minute");
    await schedule(ID.stewardDept, "2 hours");
    const near = await recommend(ID.member);
    expect(near).toMatchObject({ state: "covered", source: "schedule", recommendedUserId: ID.stewardDept, matchLevel: "department" });
    expect(near.steward).toEqual({ name: "Dana Department", contact: { conversation: true, email: null, phone: null } });
    await setSwitch(false);
    const recent = await recommend(ID.member);
    expect(recent).toMatchObject({ state: "covered", recommendedUserId: ID.stewardOther, matchLevel: null });
  });

  it("ignores an override for a person outside the current active steward roster", async () => {
    await db.query("savepoint invalid_coverage");
    try {
      await db.query(`insert into public.organization_coordination_records
        (organization_id, chapter_id, kind, title, status, config, created_by, idempotency_key)
        values ($1,$2,'coverage_override','Stale override','active',
          jsonb_build_object('stewardUserId',$3::text,'startsAt',(now()-interval '1 hour')::text,
            'endsAt',(now()+interval '1 hour')::text,'available',true),$3::uuid,gen_random_uuid())`,
      [ID.org, CHAPTER, ID.outsider]);
      // The current lifecycle may give the organization creator a staff role.
      // A member of the other chapter is actually outside this active roster.
      expect((await db.query("select steward_id from private.member_roster_stewards_for_chapter($1)", [CHAPTER])).rows.map(r => r.steward_id)).not.toContain(ID.outsider);
      expect(await recommend(ID.member)).toMatchObject({ state: "covered", source: "schedule", recommendedUserId: ID.stewardOther });
    } finally {
      await db.query("rollback to savepoint invalid_coverage");
    }
  });

  it("keeps schedule priority above proximity, and an uncovered chapter uncovered while matching is off", async () => {
    await setSwitch(true);
    await schedule(ID.stewardOther, "3 hours", 5);
    expect(await recommend(ID.member)).toMatchObject({ recommendedUserId: ID.stewardOther, matchLevel: "chapter" });
    await db.query("update public.organization_coordination_records set status = 'closed' where organization_id = $1 and kind = 'coverage_schedule'", [ID.org]);
    await setSwitch(false);
    expect(await recommend(ID.member)).toEqual({ state: "uncovered", chapterId: CHAPTER, recommendedUserId: null });
    await setSwitch(true);
  });

  it("withholds the name and routes for a chapter the caller does not belong to", async () => {
    const result = await recommend(ID.outsider, CHAPTER);
    // The outsider has no organization profile, so every steward ties and the id order decides.
    expect(result).toMatchObject({ state: "nearest", recommendedUserId: ID.stewardDept, matchLevel: "chapter" });
    expect(result.steward).toBeNull();
  });
});
