// @vitest-environment node
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: the staff
// feature guides' server read and writers on a live database. The read
// answers only for a staff role the caller holds in the selected organization,
// at organization or chapter scope, with two-step sign-in; completion keeps
// the first real action and ignores a repeat; each writer refuses a role the
// caller does not hold and an unknown step; progress never crosses an
// organization or a person; the Feature guides switch turns them off. The
// chapter lead's units step (REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109)
// reads the selected chapter's units and stewards for its admin or vp only,
// and finishes from them, never from a click.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAFF_GUIDE_ROLES, STAFF_GUIDE_STEP_IDS, roleSwitchStepId } from "../src/features/onboardingGuideEngine/staffGuides.js";

// Required proof (scripts/run-required-db-proofs.mjs): live whenever the
// owned disposable stack is named, rolled back afterwards.
const runLive = Boolean(process.env.SUPABASE_DB_URL);
const IDS = {
  orgA: "50914000-0000-4000-8000-000000000001",
  orgB: "50914000-0000-4000-8000-000000000002",
  stewardA: "50914000-0000-4000-8000-000000000101",
  chapterStewardA: "50914000-0000-4000-8000-000000000102",
  memberA: "50914000-0000-4000-8000-000000000103",
  multiA: "50914000-0000-4000-8000-000000000104",
  adminA: "50914000-0000-4000-8000-000000000105",
  leadA: "50914000-0000-4000-8000-000000000106",
  adminB: "50914000-0000-4000-8000-000000000201",
};
const CHAPTER_A = "tamarack-staff-guide-a";
const CHAPTER_B = "tamarack-staff-guide-b";
const SESSIONS = Object.fromEntries(Object.entries(IDS)
  .filter(([key]) => !key.startsWith("org"))
  .map(([, userId], index) => [userId, `50914000-0000-4000-8000-0000009000${String(index + 10).padStart(2, "0")}`]));

describe.skipIf(!runLive)("staff onboarding guide live database behavior", () => {
  let client;

  async function callAs(userId, sql, values = [], { aal = "aal2" } = {}) {
    await client.query("savepoint staff_guide_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal, session_id: SESSIONS[userId] }),
      ]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      await client.query("release savepoint staff_guide_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint staff_guide_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  async function guideFor(userId) {
    const result = await callAs(userId, "select public.get_staff_onboarding_guide() result");
    expect(result.code, result.message).toBe("");
    return result.rows[0].result;
  }

  async function complete(userId, stepId, key) {
    return callAs(userId, "select public.complete_staff_onboarding_step($1, $2) result", [stepId, key]);
  }

  async function markStep(userId, stepId, kind) {
    return callAs(userId, "select public.mark_staff_onboarding_step($1, $2) result", [stepId, kind]);
  }

  const stepOf = (guide, stepId) => guide.steps.find((row) => row.stepId === stepId) ?? null;

  // Fixture rows skip the tables' write triggers; a failure surfaces its own error.
  async function asFixture(sql, values = []) {
    await client.query("savepoint staff_guide_fixture");
    await client.query("set local session_replication_role = replica");
    try {
      await client.query(sql, values);
    } catch (error) {
      await client.query("rollback to savepoint staff_guide_fixture");
      throw error;
    } finally {
      await client.query("set local session_replication_role = origin");
    }
    await client.query("release savepoint staff_guide_fixture");
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false, application_name: "staff-onboarding-guide-test" });
    await client.connect();
    await client.query("begin");
    await client.query(
      `insert into auth.users (id, email) values
       ($1, 'staff-guide-steward-a@example.test'), ($2, 'staff-guide-chapter-steward-a@example.test'),
       ($3, 'staff-guide-member-a@example.test'), ($4, 'staff-guide-multi-a@example.test'),
       ($5, 'staff-guide-admin-b@example.test'), ($6, 'staff-guide-admin-a@example.test'), ($7, 'staff-guide-lead-a@example.test')`,
      [IDS.stewardA, IDS.chapterStewardA, IDS.memberA, IDS.multiA, IDS.adminB, IDS.adminA, IDS.leadA],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
       ($1, 'staff-guide-a', 'Tamarack Valley Staff A', $3), ($2, 'staff-guide-b', 'Tamarack Valley Staff B', $4)`,
      [IDS.orgA, IDS.orgB, IDS.stewardA, IDS.adminB],
    );
    await asFixture(
      `insert into public.chapters (id,name,slug,order_index,organization_id) values
       ($1,'Tamarack staff guide A',$1,903,$3), ($2,'Tamarack staff guide B',$2,903,$4)`,
      [CHAPTER_A, CHAPTER_B, IDS.orgA, IDS.orgB],
    );
    await client.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General'), ($2,'General') on conflict(chapter_id,name) do nothing", [CHAPTER_A, CHAPTER_B]);
    const inA = [IDS.stewardA, IDS.chapterStewardA, IDS.memberA, IDS.multiA, IDS.adminA, IDS.leadA];
    await client.query(
      `update public.member_profiles set chapter_id = case when id = $2 then $4 else $3 end where id = any($1::uuid[]) or id = $2`,
      [inA, IDS.adminB, CHAPTER_A, CHAPTER_B],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       select id, case when id = $2 then $4 else $3 end, 'active', true, now() from pg_catalog.unnest($1::uuid[] || $2::uuid) id
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [inA, IDS.adminB, CHAPTER_A, CHAPTER_B],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id)
       select $1::uuid, id from pg_catalog.unnest($3::uuid[]) id union all select $2::uuid, $4::uuid`,
      [IDS.orgA, IDS.orgB, inA, IDS.adminB],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by, granted_at)
       values ($1,$3,'steward',$3, now() - interval '1 day'), ($1,$4,'steward',$3, now() - interval '1 day'),
              ($1,$4,'advisor',$3, now() - interval '1 day'), ($2,$5,'admin',$5, now() - interval '1 day')`,
      [IDS.orgA, IDS.orgB, IDS.stewardA, IDS.multiA, IDS.adminB],
    );
    // A steward at chapter scope only: the hat is still theirs (decision 2.2).
    await asFixture("insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $3)", [IDS.chapterStewardA, CHAPTER_A, IDS.stewardA]);
    await asFixture(
      "insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $3)",
      [IDS.chapterStewardA, CHAPTER_A, IDS.stewardA],
    );
    // Chapter A's leads: its administrator and its vp, both at chapter scope.
    await asFixture("insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'admin', $3, $1), ($2, 'vp', $3, $1)", [IDS.adminA, IDS.leadA, CHAPTER_A]);
    await asFixture("insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'admin', $3, $1), ($2, 'vp', $3, $1)", [IDS.adminA, IDS.leadA, CHAPTER_A]);
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       select gen_random_uuid(), id, 'staff-guide-totp-' || id::text, 'totp', 'verified', now(), now()
       from pg_catalog.unnest($1::uuid[]) id`,
      [[IDS.stewardA, IDS.chapterStewardA, IDS.multiA, IDS.adminB, IDS.adminA, IDS.leadA]],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
       select (value ->> 'sessionId')::uuid, (value ->> 'userId')::uuid, now(), now(), 'aal2'
       from pg_catalog.jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(Object.entries(SESSIONS).map(([userId, sessionId]) => ({ userId, sessionId })))],
    );
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("accepts exactly the client catalogue's step ids and one role switch per role", async () => {
    const known = [...STAFF_GUIDE_STEP_IDS, ...STAFF_GUIDE_ROLES.map(roleSwitchStepId)];
    const { rows } = await client.query(
      "select step_id, private.staff_onboarding_step_known(step_id) known from pg_catalog.unnest($1::text[]) step_id",
      [[...known, "steward.compass", "member.settings", "steward.casework "]],
    );
    expect(rows.filter((row) => row.known).map((row) => row.step_id).sort()).toEqual([...known].sort());
  });

  it("hides the guide from a member without a staff role and refuses every write and the table", async () => {
    expect(await guideFor(IDS.memberA)).toEqual({ state: "hidden" });
    expect((await complete(IDS.memberA, "steward.casework", "k-member")).code).toBe("42501");
    expect((await markStep(IDS.memberA, "steward.casework", "seen")).code).toBe("42501");
    expect((await callAs(IDS.memberA, "select * from private.staff_onboarding_progress")).code).toBe("42501");
  });

  it("answers for an organization-wide steward and for a chapter-only steward, each with their own scope", async () => {
    expect(await guideFor(IDS.stewardA)).toEqual({ state: "active", organizationId: IDS.orgA, roles: [{ role: "steward", scope: "organization" }], steps: [] });
    expect(await guideFor(IDS.chapterStewardA)).toEqual({ state: "active", organizationId: IDS.orgA, roles: [{ role: "steward", scope: "chapter" }], steps: [] });
    expect((await guideFor(IDS.multiA)).roles).toEqual([{ role: "steward", scope: "organization" }, { role: "advisor", scope: "organization" }]);
  });

  it("hides the guide without two-step sign-in", async () => {
    const result = await callAs(IDS.stewardA, "select public.get_staff_onboarding_guide() result", [], { aal: "aal1" });
    expect(result.code, result.message).toBe("");
    expect(result.rows[0].result).toEqual({ state: "hidden" });
    // Each writer checks two-step sign-in itself (REQ-UG-DEFINER-MFA-AUDIT).
    for (const sql of ["select public.complete_staff_onboarding_step('steward.casework', 'k-aal1')", "select public.mark_staff_onboarding_step('steward.casework', 'seen')"]) {
      expect((await callAs(IDS.stewardA, sql, [], { aal: "aal1" })).code).toBe("42501");
    }
  });

  it("keeps the first completion of a real first action and ignores a repeat", async () => {
    const first = await complete(IDS.stewardA, "steward.casework", "take-1");
    expect(first.code, first.message).toBe("");
    const done = stepOf(first.rows[0].result, "steward.casework");
    expect(done.completedAt).toBeTruthy();
    const again = await complete(IDS.stewardA, "steward.casework", "take-2");
    expect(again.code, again.message).toBe("");
    expect(stepOf(again.rows[0].result, "steward.casework").completedAt).toBe(done.completedAt);
    const { rows } = await client.query("select completion_key from private.staff_onboarding_progress where user_id = $1 and step_id = 'steward.casework'", [IDS.stewardA]);
    expect(rows).toEqual([{ completion_key: "take-1" }]);
    // Another person's progress is their own.
    expect((await guideFor(IDS.chapterStewardA)).steps).toEqual([]);
  });

  it("refuses a role the caller does not hold, an unknown step, a missing key and a completed role switch", async () => {
    expect((await complete(IDS.stewardA, "coordinator.casework", "k")).code).toBe("42501");
    expect((await markStep(IDS.stewardA, "admin.people", "seen")).code).toBe("42501");
    expect((await complete(IDS.stewardA, "steward.compass", "k")).code).toBe("22023");
    expect((await complete(IDS.stewardA, "steward.messages", "")).code).toBe("22023");
    expect((await complete(IDS.stewardA, "steward.messages", null)).code).toBe("22023");
    expect((await complete(IDS.stewardA, roleSwitchStepId("steward"), "k")).code).toBe("22023");
    expect((await markStep(IDS.stewardA, "steward.messages", "done")).code).toBe("22023");
    expect((await markStep(IDS.stewardA, roleSwitchStepId("steward"), "got")).code).toBe("22023");
  });

  it("keeps the first time a card was seen and the latest Got it and reopen", async () => {
    const seen = await markStep(IDS.chapterStewardA, "steward.messages", "seen");
    expect(seen.code, seen.message).toBe("");
    const firstSeen = stepOf(seen.rows[0].result, "steward.messages").seenAt;
    await client.query("update private.staff_onboarding_progress set seen_at = seen_at - interval '1 hour' where user_id = $1", [IDS.chapterStewardA]);
    const earlier = stepOf(await guideFor(IDS.chapterStewardA), "steward.messages").seenAt;
    expect(Date.parse(earlier)).toBeLessThan(Date.parse(firstSeen));
    expect(stepOf((await markStep(IDS.chapterStewardA, "steward.messages", "seen")).rows[0].result, "steward.messages").seenAt).toBe(earlier);
    const got = stepOf((await markStep(IDS.chapterStewardA, "steward.messages", "got")).rows[0].result, "steward.messages");
    expect(got.gotAt).toBeTruthy();
    expect(got.completedAt).toBeNull();
    const reopened = stepOf((await markStep(IDS.chapterStewardA, "steward.messages", "reopen")).rows[0].result, "steward.messages");
    expect(reopened.reopenedAt).toBeTruthy();
    expect((await markStep(IDS.multiA, roleSwitchStepId("advisor"), "seen")).code).toBe("");
  });

  it("writes nothing to the member checklist", async () => {
    const { rows } = await client.query(
      "select count(*)::int n from public.member_onboarding_plans where member_user_id = any($1::uuid[]) and completed_step_ids <> '{}'",
      [[IDS.stewardA, IDS.chapterStewardA, IDS.multiA]],
    );
    expect(rows[0].n).toBe(0);
  });

  it("keeps each organization's guide to itself", async () => {
    const b = await guideFor(IDS.adminB);
    // An organization admin leads its selected chapter: that chapter's facts only.
    expect(b).toEqual({ state: "active", organizationId: IDS.orgB, roles: [{ role: "admin", scope: "organization" }], steps: [],
      chapterUnits: { chapterId: CHAPTER_B, units: 0, stewards: 0, stewardsWithoutUnit: 0 } });
    expect((await complete(IDS.adminB, "steward.casework", "k")).code).toBe("42501");
  });

  it("gives the selected chapter's admin and vp its units and stewards, and no one else", async () => {
    const facts = { chapterId: CHAPTER_A, units: 0, stewards: 1, stewardsWithoutUnit: 1 };
    const admin = await guideFor(IDS.adminA);
    expect(admin.roles).toEqual([{ role: "admin", scope: "chapter" }]);
    expect(admin.chapterUnits).toEqual(facts);
    expect((await guideFor(IDS.leadA)).chapterUnits).toEqual(facts);
    for (const userId of [IDS.stewardA, IDS.chapterStewardA, IDS.multiA]) expect(await guideFor(userId)).not.toHaveProperty("chapterUnits");
    expect(await guideFor(IDS.memberA)).toEqual({ state: "hidden" });
    const aal1 = await callAs(IDS.adminA, "select public.get_staff_onboarding_guide() result", [], { aal: "aal1" });
    expect(aal1.rows[0].result).toEqual({ state: "hidden" });
    // The helper is not callable by an API role.
    expect((await callAs(IDS.adminA, "select private.staff_onboarding_chapter_units($1::uuid, '[]'::jsonb)", [IDS.orgA])).code).toBe("42501");
  });

  it("counts units (not worksites) and stewards with a unit, and finishes only from those facts", async () => {
    await asFixture(
      `insert into private.chapter_units (id, organization_id, chapter_id, name, kind) values
       ('50914000-0000-4000-8000-000000000a01', $1, $2, 'Night shift', 'unit'),
       ('50914000-0000-4000-8000-000000000a02', $1, $2, 'North clinic', 'worksite'),
       ('50914000-0000-4000-8000-000000000b01', $3, $4, 'Other local unit', 'unit')`,
      [IDS.orgA, CHAPTER_A, IDS.orgB, CHAPTER_B],
    );
    expect((await guideFor(IDS.adminA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 1, stewardsWithoutUnit: 1 });
    expect((await guideFor(IDS.adminB)).chapterUnits).toEqual({ chapterId: CHAPTER_B, units: 1, stewards: 0, stewardsWithoutUnit: 0 });
    await asFixture(
      "insert into private.chapter_role_scopes (user_id, chapter_id, role, unit_id) values ($1, $2, 'steward', '50914000-0000-4000-8000-000000000a01')",
      [IDS.chapterStewardA, CHAPTER_A],
    );
    expect((await guideFor(IDS.leadA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 1, stewardsWithoutUnit: 0 });
    // The chapter's default unit (#7663) is never counted, and a steward placed
    // in it is not yet in one of the chapter's own units
    // .
    // This fixture's chapters predate the default-unit trigger, so the
    // default unit is made here, as #7663 makes one for every chapter.
    const defaultUnit = "50914000-0000-4000-8000-000000000a03";
    await asFixture("insert into private.chapter_units (id, organization_id, chapter_id, name, kind, is_default) values ($1, $2, $3, 'Chapter A', 'unit', true)",
      [defaultUnit, IDS.orgA, CHAPTER_A]);
    expect((await guideFor(IDS.adminA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 1, stewardsWithoutUnit: 0 });
    await asFixture("update private.chapter_role_scopes set unit_id = $1 where user_id = $2 and chapter_id = $3 and role = 'steward'",
      [defaultUnit, IDS.chapterStewardA, CHAPTER_A]);
    expect((await guideFor(IDS.adminA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 1, stewardsWithoutUnit: 1 });
    await asFixture("update private.chapter_role_scopes set unit_id = '50914000-0000-4000-8000-000000000a01' where user_id = $1 and chapter_id = $2 and role = 'steward'",
      [IDS.chapterStewardA, CHAPTER_A]);
    expect((await guideFor(IDS.adminA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 1, stewardsWithoutUnit: 0 });
    // An organization steward assigned to this chapter (#7663 keeps these in
    // private.organization_steward_unit_assignments, and chapter access lists
    // them) is one of its stewards: on the default unit it is not set up, in a
    // named unit it is, and a person on both routes counts once.
    await asFixture(
      "insert into private.organization_steward_unit_assignments (organization_id, user_id, role, chapter_id, unit_id) values ($1, $2, 'steward', $3, $4)",
      [IDS.orgA, IDS.stewardA, CHAPTER_A, defaultUnit],
    );
    expect((await guideFor(IDS.adminA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 2, stewardsWithoutUnit: 1 });
    expect((await guideFor(IDS.leadA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 2, stewardsWithoutUnit: 1 });
    await asFixture("update private.organization_steward_unit_assignments set unit_id = '50914000-0000-4000-8000-000000000a01' where user_id = $1 and chapter_id = $2",
      [IDS.stewardA, CHAPTER_A]);
    expect((await guideFor(IDS.adminA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 2, stewardsWithoutUnit: 0 });
    await asFixture(
      "insert into private.organization_steward_unit_assignments (organization_id, user_id, role, chapter_id, unit_id) values ($1, $2, 'steward', $3, $4)",
      [IDS.orgA, IDS.chapterStewardA, CHAPTER_A, "50914000-0000-4000-8000-000000000a01"],
    );
    expect((await guideFor(IDS.adminA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 2, stewardsWithoutUnit: 0 });
    // Another chapter's assignment never counts here.
    await asFixture(
      "insert into private.organization_steward_unit_assignments (organization_id, user_id, role, chapter_id, unit_id) values ($1, $2, 'steward', $3, $4)",
      [IDS.orgB, IDS.adminB, CHAPTER_B, "50914000-0000-4000-8000-000000000b01"],
    );
    expect((await guideFor(IDS.adminA)).chapterUnits).toEqual({ chapterId: CHAPTER_A, units: 1, stewards: 2, stewardsWithoutUnit: 0 });
    // Seen and Got it work; a click never completes it, and only a held role's step is written.
    expect((await markStep(IDS.adminA, "admin.units", "seen")).code).toBe("");
    expect((await markStep(IDS.leadA, "vp.units", "got")).code).toBe("");
    expect((await complete(IDS.adminA, "admin.units", "k-units")).code).toBe("22023");
    expect((await complete(IDS.leadA, "vp.units", "k-units")).code).toBe("22023");
    expect((await markStep(IDS.adminA, "vp.units", "seen")).code).toBe("42501");
    const { rows } = await client.query("select count(*)::int n from private.staff_onboarding_progress where step_id like '%.units' and completed_at is not null");
    expect(rows[0].n).toBe(0);
  });

  it("answers off and refuses writes when the organization turns feature guides off", async () => {
    await client.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value)
       values ($1, 'features.guidance_onboarding.feature_guides', 'false'::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [IDS.orgB],
    );
    expect(await guideFor(IDS.adminB)).toEqual({ state: "off", organizationId: IDS.orgB });
    expect((await complete(IDS.adminB, "admin.people", "k")).code).toBe("55000");
  });
});
