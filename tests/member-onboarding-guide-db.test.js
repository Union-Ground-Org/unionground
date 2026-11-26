// @vitest-environment node
// REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: the onboarding
// guide reads the organization's existing checklist, enforces the five
// guidance_onboarding switches server-side, never reduces a staff account and
// never crosses an organization boundary.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Required proof (scripts/run-required-db-proofs.mjs): live whenever the
// owned disposable stack is named, rolled back afterwards.
const runLive = Boolean(process.env.SUPABASE_DB_URL);
const IDS = {
  orgA: "50912000-0000-4000-8000-000000000001",
  orgB: "50912000-0000-4000-8000-000000000002",
  staffA: "50912000-0000-4000-8000-000000000101",
  memberA: "50912000-0000-4000-8000-000000000102",
  newMemberA: "50912000-0000-4000-8000-000000000103",
  establishedA: "50912000-0000-4000-8000-000000000104",
  longtimeA: "50912000-0000-4000-8000-000000000105",
  laterA: "50912000-0000-4000-8000-000000000106",
  veteranA: "50912000-0000-4000-8000-000000000107",
  staffB: "50912000-0000-4000-8000-000000000201",
  memberB: "50912000-0000-4000-8000-000000000202",
};
const STEPS = [
  "50912000-0000-4000-8000-000000000501",
  "50912000-0000-4000-8000-000000000502",
  "50912000-0000-4000-8000-000000000503",
  "50912000-0000-4000-8000-000000000504",
  "50912000-0000-4000-8000-000000000505",
  "50912000-0000-4000-8000-000000000506",
];
const SWITCHES = [
  "features.guidance_onboarding.feature_drip",
  "features.guidance_onboarding.hud_tooltips",
  "features.guidance_onboarding.spotlight",
  "features.guidance_onboarding.progressive_disclosure",
  "features.guidance_onboarding.badge_achievements",
];
const SESSIONS = Object.fromEntries(Object.entries(IDS)
  .filter(([key]) => !key.startsWith("org"))
  .map(([, userId], index) => [userId, `50912000-0000-4000-8000-0000009000${String(index + 10).padStart(2, "0")}`]));

describe.skipIf(!runLive)("member onboarding guide live database behavior", () => {
  let client;

  async function callAs(userId, sql, values = []) {
    await client.query("savepoint onboarding_guide_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: SESSIONS[userId] }),
      ]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      await client.query("release savepoint onboarding_guide_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint onboarding_guide_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  async function guideFor(userId) {
    const result = await callAs(userId, "select public.get_member_onboarding_guide() result");
    expect(result.code, result.message).toBe("");
    return result.rows[0].result;
  }

  async function setSwitch(organizationId, key, value) {
    await client.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value)
       values ($1, $2, to_jsonb($3::boolean))
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [organizationId, key, value],
    );
  }

  async function setCompleted(userId, stepIds, status) {
    await client.query(
      `update public.member_onboarding_plans
       set completed_step_ids = $2::uuid[], status = $3,
           started_at = case when $3 = 'not_started' then null else now() end,
           completed_at = case when $3 = 'completed' then now() else null end
       where organization_id = $1 and member_user_id = $4`,
      [IDS.orgA, stepIds, status, userId],
    );
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false, application_name: "onboarding-guide-test" });
    await client.connect();
    await client.query("begin");
    await client.query(
      `insert into auth.users (id, email) values
       ($1, 'guide-staff-a@example.test'), ($2, 'guide-member-a@example.test'), ($3, 'guide-new-a@example.test'),
       ($4, 'guide-staff-b@example.test'), ($5, 'guide-member-b@example.test')`,
      [IDS.staffA, IDS.memberA, IDS.newMemberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
       ($1, 'guide-org-a', 'Guide Org A', $3), ($2, 'guide-org-b', 'Guide Org B', $4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
    await client.query("set local session_replication_role = replica");
    await client.query("insert into public.chapters (id,name,slug,order_index,organization_id) values ('tamarack-member-onboarding-guide-a','Tamarack member-onboarding-guide A','tamarack-member-onboarding-guide-a',901,$1)", [IDS.orgA]);
    await client.query("insert into public.chapters (id,name,slug,order_index,organization_id) values ('tamarack-member-onboarding-guide-b','Tamarack member-onboarding-guide B','tamarack-member-onboarding-guide-b',901,$1)", [IDS.orgB]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name) values ('tamarack-member-onboarding-guide-a','General'), ('tamarack-member-onboarding-guide-b','General') on conflict(chapter_id,name) do nothing");
    await client.query("set local session_replication_role = origin");
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id, full_name = fixture.full_name
       from (values ($1::uuid, 'tamarack-member-onboarding-guide-a'::text, 'Alex Staff'::text), ($2::uuid, 'tamarack-member-onboarding-guide-a'::text, 'Morgan Member'::text),
                    ($3::uuid, 'tamarack-member-onboarding-guide-a'::text, 'Nico New'::text), ($4::uuid, 'tamarack-member-onboarding-guide-b'::text, 'Blair Staff'::text),
                    ($5::uuid, 'tamarack-member-onboarding-guide-b'::text, 'Taylor Member'::text)) fixture(id, chapter_id, full_name)
       where member_profiles.id = fixture.id`,
      [IDS.staffA, IDS.memberA, IDS.newMemberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1, 'tamarack-member-onboarding-guide-a', 'active', true, now()), ($2, 'tamarack-member-onboarding-guide-a', 'active', true, now()), ($3, 'tamarack-member-onboarding-guide-a', 'active', true, now()),
              ($4, 'tamarack-member-onboarding-guide-b', 'active', true, now()), ($5, 'tamarack-member-onboarding-guide-b', 'active', true, now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [IDS.staffA, IDS.memberA, IDS.newMemberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id)
       values ($1,$3),($1,$4),($1,$5),($2,$6),($2,$7)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.memberA, IDS.newMemberA, IDS.staffB, IDS.memberB],
    );
    // BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106: members
    // who were here before the program below was switched on, by their
    // organization membership (Erin) or their member-since year only (Lee,
    // Val); and Kit, who joined five days ago, after the early step the
    // cutoff test writes ten days back.
    await client.query(
      `insert into auth.users (id, email) values ($1, 'guide-established-a@example.test'), ($2, 'guide-longtime-a@example.test'),
              ($3, 'guide-later-a@example.test'), ($4, 'guide-veteran-a@example.test')`,
      [IDS.establishedA, IDS.longtimeA, IDS.laterA, IDS.veteranA],
    );
    await client.query(
      `update public.member_profiles set chapter_id = 'tamarack-member-onboarding-guide-a', full_name = fixture.full_name, member_since = fixture.member_since
       from (values ($1::uuid, 'Erin Established'::text, null::integer), ($2::uuid, 'Lee Longtime'::text, 2020),
                    ($3::uuid, 'Kit Later'::text, null::integer), ($4::uuid, 'Val Veteran'::text, 2015)) fixture(id, full_name, member_since)
       where member_profiles.id = fixture.id`,
      [IDS.establishedA, IDS.longtimeA, IDS.laterA, IDS.veteranA],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       select member_id, 'tamarack-member-onboarding-guide-a', 'active', true, now() from unnest($1::uuid[]) member_id
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [[IDS.establishedA, IDS.longtimeA, IDS.laterA, IDS.veteranA]],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id, created_at)
       values ($1, $2, now() - interval '3 years'), ($1, $3, now()), ($1, $4, now() - interval '5 days'), ($1, $5, now())`,
      [IDS.orgA, IDS.establishedA, IDS.longtimeA, IDS.laterA, IDS.veteranA],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
       values ($1,$3,'admin',$3),($1,$3,'steward',$3),($2,$4,'admin',$4),($2,$4,'steward',$4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'guide-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'guide-b-totp', 'totp', 'verified', now(), now())`,
      [IDS.staffA, IDS.staffB],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
       select (value ->> 'sessionId')::uuid, (value ->> 'userId')::uuid, now(), now(), 'aal2'
       from pg_catalog.jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(Object.entries(SESSIONS).map(([userId, sessionId]) => ({ userId, sessionId })))],
    );
    // Organization A runs a six-step program; organization B has none.
    await client.query(
      `insert into public.organization_onboarding_steps (id, organization_id, title, position, active)
       select step_id, $1, 'Step ' || ordinality, ordinality::integer * 10, true
       from unnest($2::uuid[]) with ordinality step_id`,
      [IDS.orgA, STEPS],
    );
    await client.query(
      `insert into public.member_onboarding_plans (id, organization_id, member_user_id)
       values (gen_random_uuid(), $1, $2)`,
      [IDS.orgA, IDS.memberA],
    );
    // The untouched plan automatic enrollment gives a new app membership
    // (assigned_by null, not started) is not the long-time member's choice.
    await client.query(
      `insert into public.member_onboarding_plans (id, organization_id, member_user_id, assigned_by)
       select gen_random_uuid(), $1, member_id, null from unnest($2::uuid[]) member_id`,
      [IDS.orgA, [IDS.longtimeA, IDS.laterA, IDS.veteranA]],
    );
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("defines five member-visible guidance switches that start on", async () => {
    const { rows } = await client.query(
      `select key, value_kind, default_value, category, member_visible
       from public.platform_setting_definitions where key = any($1::text[]) order by sort_order`,
      [SWITCHES],
    );
    expect(rows.map((row) => row.key)).toEqual(SWITCHES);
    for (const row of rows) {
      expect(row).toMatchObject({ value_kind: "boolean", default_value: true, category: "guidance_onboarding", member_visible: true });
    }
  });

  it("guides a member by default with no switch set", async () => {
    const guide = await guideFor(IDS.memberA);
    expect(guide).toMatchObject({
      state: "ready",
      applies: true,
      memberOnly: true,
      programConfigured: true,
      enrolled: true,
      onboardingComplete: false,
      progressiveDisclosureActive: true,
      showHud: true,
      featureDrip: true,
      spotlight: "member-support",
      badge: "new_member",
    });
  });

  it("stays inactive while every switch is turned off but still reports onboarding progress", async () => {
    for (const key of SWITCHES) await setSwitch(IDS.orgA, key, false);
    const guide = await guideFor(IDS.memberA);
    expect(guide).toMatchObject({
      state: "ready",
      applies: false,
      memberOnly: true,
      programConfigured: true,
      enrolled: true,
      onboardingComplete: false,
      progressiveDisclosureActive: false,
      showHud: false,
      spotlight: null,
      badge: null,
    });
  });

  it("guides a member through New Member, Momentum and Ready to Roll once switched on", async () => {
    for (const key of SWITCHES) await setSwitch(IDS.orgA, key, true);
    let guide = await guideFor(IDS.memberA);
    expect(guide).toMatchObject({
      applies: true,
      stage: "welcome",
      badge: "new_member",
      spotlight: "member-support",
      showHud: true,
      featureDrip: true,
      progressiveDisclosureActive: true,
      onboardingComplete: false,
      totalSteps: 6,
      completedSteps: 0,
      nextStep: { id: STEPS[0], title: "Step 1" },
    });

    await setCompleted(IDS.memberA, STEPS.slice(0, 2), "in_progress");
    guide = await guideFor(IDS.memberA);
    expect(guide).toMatchObject({ stage: "activate", badge: "momentum", completedSteps: 2, nextStep: { id: STEPS[2] } });

    await setCompleted(IDS.memberA, STEPS, "completed");
    guide = await guideFor(IDS.memberA);
    expect(guide).toMatchObject({
      stage: "complete",
      badge: "ready_to_roll",
      spotlight: "events",
      onboardingComplete: true,
      progressiveDisclosureActive: false,
      nextStep: null,
    });
  });

  it("keeps a finished member finished when an admin later adds a step", async () => {
    await client.query(
      `insert into public.organization_onboarding_steps (id, organization_id, title, position, active)
       values (gen_random_uuid(), $1, 'Added later', 900, true)`,
      [IDS.orgA],
    );
    const guide = await guideFor(IDS.memberA);
    expect(guide).toMatchObject({ onboardingComplete: true, progressiveDisclosureActive: false, totalSteps: 7 });
  });

  it("treats a member with no plan yet as at the start of the program", async () => {
    const guide = await guideFor(IDS.newMemberA);
    expect(guide).toMatchObject({ applies: true, enrolled: false, establishedMember: false, completedSteps: 0, progressiveDisclosureActive: true, badge: "new_member" });
  });

  it("does not badge a member who joined before the program was switched on as a new member", async () => {
    for (const [userId, enrolled] of [[IDS.establishedA, false], [IDS.longtimeA, true]]) {
      const guide = await guideFor(userId);
      expect(guide).toMatchObject({
        state: "ready",
        applies: false,
        memberOnly: true,
        programConfigured: true,
        enrolled,
        establishedMember: true,
        progressiveDisclosureActive: false,
        showHud: false,
        featureDrip: false,
        spotlight: null,
        badge: null,
      });
    }
  });

  it("guides an established member who chooses the guide", async () => {
    const started = await callAs(IDS.establishedA, "select public.start_member_onboarding_plan(null, gen_random_uuid()) result");
    expect(started.code, started.message).toBe("");
    const guide = await guideFor(IDS.establishedA);
    expect(guide).toMatchObject({ applies: true, enrolled: true, establishedMember: false, progressiveDisclosureActive: true, showHud: true, badge: "new_member" });
  });

  it("enforces each switch independently on the server", async () => {
    await setSwitch(IDS.orgA, "features.guidance_onboarding.progressive_disclosure", false);
    await setSwitch(IDS.orgA, "features.guidance_onboarding.spotlight", false);
    await setSwitch(IDS.orgA, "features.guidance_onboarding.badge_achievements", false);
    let guide = await guideFor(IDS.newMemberA);
    expect(guide).toMatchObject({ applies: true, progressiveDisclosureActive: false, spotlight: null, badge: null, showHud: true });
    await setSwitch(IDS.orgA, "features.guidance_onboarding.hud_tooltips", false);
    guide = await guideFor(IDS.newMemberA);
    expect(guide).toMatchObject({ applies: true, showHud: false, featureDrip: true });
    await setSwitch(IDS.orgA, "features.guidance_onboarding.feature_drip", false);
    guide = await guideFor(IDS.newMemberA);
    expect(guide).toMatchObject({ applies: false, featureDrip: false, onboardingComplete: false });
    for (const key of SWITCHES) await setSwitch(IDS.orgA, key, true);
  });

  it("never reduces a staff account", async () => {
    const guide = await guideFor(IDS.staffA);
    expect(guide).toMatchObject({ applies: false, memberOnly: false, progressiveDisclosureActive: false, showHud: false });
  });

  it("stays scoped to the caller's own organization", async () => {
    const guide = await guideFor(IDS.memberB);
    expect(guide).toMatchObject({
      organizationId: IDS.orgB,
      programConfigured: false,
      onboardingComplete: true,
      applies: false,
      totalSteps: 0,
    });
  });

  it("offers no Home onboarding reminder to an established member, and still reminds a member who is not", async () => {
    await setSwitch(IDS.orgA, "features.home.onboarding_nudge", true);
    const nudgesFor = async (userId) => {
      const result = await callAs(userId, "select public.get_member_home_nudges() result");
      expect(result.code, result.message).toBe("");
      return result.rows[0].result;
    };
    // Lee: member since 2020, an untouched automatic plan, guide quiet.
    expect(await guideFor(IDS.longtimeA)).toMatchObject({ applies: false, establishedMember: true, enrolled: true });
    expect(await nudgesFor(IDS.longtimeA)).toMatchObject({ onboarding: null, guidedFirstRun: false });
    // With every guide switch off the guide is quiet for everyone: the
    // reminder still reaches Nico's unfinished plan and still skips Lee.
    for (const key of SWITCHES) await setSwitch(IDS.orgA, key, false);
    await client.query(
      `insert into public.member_onboarding_plans (id, organization_id, member_user_id, assigned_by) values (gen_random_uuid(), $1, $2, null)`,
      [IDS.orgA, IDS.newMemberA],
    );
    expect(await nudgesFor(IDS.newMemberA)).toMatchObject({ onboarding: { completed: 0, total: 7 }, guidedFirstRun: false });
    expect(await nudgesFor(IDS.longtimeA)).toMatchObject({ onboarding: null });
    for (const key of SWITCHES) await setSwitch(IDS.orgA, key, true);
  });

  it("keeps the guide for a member who joined after the program started when its oldest step is turned off", async () => {
    const early = "50912000-0000-4000-8000-000000000500";
    await client.query(
      `insert into public.organization_onboarding_steps (id, organization_id, title, position, active, created_at)
       values ($1, $2, 'First step, written ten days ago', 5, true, now() - interval '10 days')`,
      [early, IDS.orgA],
    );
    expect(await guideFor(IDS.laterA)).toMatchObject({ applies: true, establishedMember: false, badge: "new_member" });
    await client.query("update public.organization_onboarding_steps set active = false where id = $1", [early]);
    expect(await guideFor(IDS.laterA)).toMatchObject({ applies: true, establishedMember: false, badge: "new_member", progressiveDisclosureActive: true });
  });

  it("guides an established member whose existing automatic plan they, or staff, explicitly start", async () => {
    expect(await guideFor(IDS.longtimeA)).toMatchObject({ applies: false, establishedMember: true });
    const own = await callAs(IDS.longtimeA, "select public.start_member_onboarding_plan(null, gen_random_uuid()) result");
    expect(own.code, own.message).toBe("");
    expect(await guideFor(IDS.longtimeA)).toMatchObject({ applies: true, establishedMember: false, enrolled: true, badge: "new_member" });

    expect(await guideFor(IDS.veteranA)).toMatchObject({ applies: false, establishedMember: true });
    const staff = await callAs(IDS.staffA, "select public.start_member_onboarding_plan($1, gen_random_uuid()) result", [IDS.veteranA]);
    expect(staff.code, staff.message).toBe("");
    expect(await guideFor(IDS.veteranA)).toMatchObject({ applies: true, establishedMember: false, enrolled: true });
  });

  it("is not executable by anonymous callers", async () => {
    const { rows } = await client.query(
      "select has_function_privilege('anon', 'public.get_member_onboarding_guide()', 'EXECUTE') anon_exec, has_function_privilege('authenticated', 'public.get_member_onboarding_guide()', 'EXECUTE') auth_exec",
    );
    expect(rows[0]).toEqual({ anon_exec: false, auth_exec: true });
  });
});
