// @vitest-environment node
// REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001 (CR-082):
// automatic enrollment (default ON by) that
// assigns the organization's own checklist and nothing else, the configurable
// stalled flag, and audited staff complete / skip / reset inside the caller's
// organization only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Required proof (scripts/run-required-db-proofs.mjs): live whenever the owned
// disposable stack is named, rolled back afterwards.
const runLive = Boolean(process.env.SUPABASE_DB_URL);
const IDS = {
  orgA: "50912100-0000-4000-8000-000000000001",
  orgB: "50912100-0000-4000-8000-000000000002",
  staffA: "50912100-0000-4000-8000-000000000101",
  memberA: "50912100-0000-4000-8000-000000000102",
  joinerA: "50912100-0000-4000-8000-000000000103",
  joinerOff: "50912100-0000-4000-8000-000000000104",
  staffB: "50912100-0000-4000-8000-000000000201",
  memberB: "50912100-0000-4000-8000-000000000202",
  joinerB: "50912100-0000-4000-8000-000000000203",
};
const STEPS = [
  "50912100-0000-4000-8000-000000000501",
  "50912100-0000-4000-8000-000000000502",
  "50912100-0000-4000-8000-000000000503",
  "50912100-0000-4000-8000-000000000504",
];
const KEYS = {
  autoEnroll: "features.guidance_onboarding.auto_enroll_onboarding",
  stalledFlag: "features.guidance_onboarding.stalled_flag",
  stalledDays: "limits.guidance_onboarding.stalled_after_days",
  stalledPercent: "limits.guidance_onboarding.stalled_below_percent",
  overrides: "features.guidance_onboarding.staff_step_overrides",
};
const SESSIONS = Object.fromEntries(Object.entries(IDS)
  .filter(([key]) => !key.startsWith("org"))
  .map(([, userId], index) => [userId, `50912100-0000-4000-8000-0000009000${String(index + 10).padStart(2, "0")}`]));

describe.skipIf(!runLive)("member onboarding oversight live database behavior", () => {
  let client;

  async function callAs(userId, sql, values = []) {
    await client.query("savepoint onboarding_oversight_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: SESSIONS[userId] }),
      ]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      await client.query("release savepoint onboarding_oversight_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint onboarding_oversight_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  async function setSetting(organizationId, key, value) {
    await client.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value)
       values ($1, $2, $3::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [organizationId, key, JSON.stringify(value)],
    );
  }

  async function planFor(organizationId, userId) {
    const { rows } = await client.query(
      "select * from public.member_onboarding_plans where organization_id = $1 and member_user_id = $2",
      [organizationId, userId],
    );
    return rows[0] ?? null;
  }

  async function oversight(userId = IDS.staffA) {
    const result = await callAs(userId, "select public.get_member_onboarding_oversight() result");
    expect(result.code, result.message).toBe("");
    return result.rows[0].result;
  }

  // A skip carries a reason (REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104).
  async function staffChange(userId, planId, action, stepId = null) {
    return callAs(
      userId,
      "select public.staff_update_member_onboarding_plan($1, $2, $3, $4, $5) result",
      [planId, action, stepId, crypto.randomUUID(), action === "skip" ? "Covered at orientation." : null],
    );
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false, application_name: "onboarding-oversight-test" });
    await client.connect();
    await client.query("begin");
    await client.query(
      `insert into auth.users (id, email) select id, 'oversight-' || ordinality || '@example.test'
       from unnest($1::uuid[]) with ordinality id`,
      [Object.entries(IDS).filter(([key]) => !key.startsWith("org")).map(([, id]) => id)],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
       ($1, 'oversight-org-a', 'Oversight Org A', $3), ($2, 'oversight-org-b', 'Oversight Org B', $4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
    await client.query("set local session_replication_role = replica");
    await client.query("insert into public.chapters (id,name,slug,order_index,organization_id) values ('tamarack-member-onboarding-oversight-a','Tamarack member-onboarding-oversight A','tamarack-member-onboarding-oversight-a',901,$1)", [IDS.orgA]);
    await client.query("insert into public.chapters (id,name,slug,order_index,organization_id) values ('tamarack-member-onboarding-oversight-b','Tamarack member-onboarding-oversight B','tamarack-member-onboarding-oversight-b',901,$1)", [IDS.orgB]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name) values ('tamarack-member-onboarding-oversight-a','General'), ('tamarack-member-onboarding-oversight-b','General') on conflict(chapter_id,name) do nothing");
    await client.query("set local session_replication_role = origin");
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id, full_name = fixture.full_name
       from (values ($1::uuid, 'tamarack-member-onboarding-oversight-a'::text, 'Alex Staff'::text), ($2::uuid, 'tamarack-member-onboarding-oversight-a'::text, 'Morgan Member'::text),
                    ($3::uuid, 'tamarack-member-onboarding-oversight-b'::text, 'Blair Staff'::text), ($4::uuid, 'tamarack-member-onboarding-oversight-b'::text, 'Taylor Member'::text)) fixture(id, chapter_id, full_name)
       where member_profiles.id = fixture.id`,
      [IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1, 'tamarack-member-onboarding-oversight-a', 'active', true, now()), ($2, 'tamarack-member-onboarding-oversight-a', 'active', true, now()),
              ($3, 'tamarack-member-onboarding-oversight-b', 'active', true, now()), ($4, 'tamarack-member-onboarding-oversight-b', 'active', true, now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'oversight-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'oversight-b-totp', 'totp', 'verified', now(), now())`,
      [IDS.staffA, IDS.staffB],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
       select (value ->> 'sessionId')::uuid, (value ->> 'userId')::uuid, now(), now(), 'aal2'
       from pg_catalog.jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(Object.entries(SESSIONS).map(([userId, sessionId]) => ({ userId, sessionId })))],
    );
    // Existing members join before organization A has an active step, so the
    // default-on automatic enrollment never backfills them.
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id)
       values ($1,$3),($1,$4),($2,$5),($2,$6)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    // Organization A runs a four-step program; organization B has none.
    await client.query(
      `insert into public.organization_onboarding_steps (id, organization_id, title, position, active)
       select step_id, $1, 'Step ' || ordinality, ordinality::integer * 10, true
       from unnest($2::uuid[]) with ordinality step_id`,
      [IDS.orgA, STEPS],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
       values ($1,$3,'admin',$3),($1,$3,'steward',$3),($2,$4,'admin',$4),($2,$4,'steward',$4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("registers the five oversight controls with their defaults (auto-enroll ON by)", async () => {
    const { rows } = await client.query(
      `select key, default_value, category, member_visible, minimum, maximum
       from public.platform_setting_definitions where key = any($1::text[]) order by sort_order`,
      [Object.values(KEYS)],
    );
    expect(Object.fromEntries(rows.map((row) => [row.key, row.default_value]))).toEqual({
      [KEYS.autoEnroll]: true,
      [KEYS.stalledFlag]: true,
      [KEYS.stalledDays]: 14,
      [KEYS.stalledPercent]: 50,
      [KEYS.overrides]: true,
    });
    for (const row of rows) expect(row).toMatchObject({ category: "guidance_onboarding", member_visible: false });
  });

  it("assigns only the organization's checklist by default when a membership becomes active", async () => {
    // No setting is written: enrollment happens on the registry default.
    const counts = async (userId) => (await client.query(
      `select (select count(*) from public.member_cases where user_id = $1)::int cases,
              (select count(*) from public.member_notifications where user_id = $1)::int notifications,
              (select count(*) from public.member_action_log where user_id = $1)::int actions`,
      [userId],
    )).rows[0];
    const before = await counts(IDS.joinerA);
    await client.query("insert into public.organization_memberships (organization_id, user_id) values ($1, $2)", [IDS.orgA, IDS.joinerA]);
    const plan = await planFor(IDS.orgA, IDS.joinerA);
    expect(plan).toMatchObject({ status: "not_started", assigned_by: null, started_at: null, completed_step_ids: [] });
    expect(await counts(IDS.joinerA)).toEqual(before);
    const { rows: events } = await client.query(
      "select actor_user_id, event_type from public.member_support_events where entity_id = $1",
      [plan.id],
    );
    expect(events).toEqual([{ actor_user_id: null, event_type: "auto_enrolled" }]);
    // No backfill: a member who joined earlier still has no plan.
    expect(await planFor(IDS.orgA, IDS.memberA)).toBeNull();
    // An organization without an active step enrolls nobody.
    await client.query("insert into public.organization_memberships (organization_id, user_id) values ($1, $2)", [IDS.orgB, IDS.joinerB]);
    expect(await planFor(IDS.orgB, IDS.joinerB)).toBeNull();
  });

  it("does not enroll anyone while an organization turns automatic enrollment off", async () => {
    await setSetting(IDS.orgA, KEYS.autoEnroll, false);
    await client.query("insert into public.organization_memberships (organization_id, user_id) values ($1, $2)", [IDS.orgA, IDS.joinerOff]);
    expect(await planFor(IDS.orgA, IDS.joinerOff)).toBeNull();
    expect(await planFor(IDS.orgA, IDS.memberA)).toBeNull();
    await setSetting(IDS.orgA, KEYS.autoEnroll, true);
  });

  it("enrolls a revoked member who becomes active again exactly once", async () => {
    await client.query(
      "update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2",
      [IDS.orgA, IDS.joinerOff],
    );
    await client.query(
      "update public.organization_memberships set status = 'active', revoked_at = null where organization_id = $1 and user_id = $2",
      [IDS.orgA, IDS.joinerOff],
    );
    const first = await planFor(IDS.orgA, IDS.joinerOff);
    expect(first).toMatchObject({ status: "not_started" });
    await client.query(
      "update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2",
      [IDS.orgA, IDS.joinerOff],
    );
    await client.query(
      "update public.organization_memberships set status = 'active', revoked_at = null where organization_id = $1 and user_id = $2",
      [IDS.orgA, IDS.joinerOff],
    );
    expect((await planFor(IDS.orgA, IDS.joinerOff)).id).toBe(first.id);
  });

  it("flags stalled members with the organization's own window and threshold", async () => {
    await client.query(
      `insert into public.member_onboarding_plans (id, organization_id, member_user_id, assigned_by, status, completed_step_ids, started_at, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'in_progress', $4::uuid[], now() - interval '20 days', now() - interval '20 days')`,
      [IDS.orgA, IDS.memberA, IDS.staffA, [STEPS[0]]],
    );
    let roster = await oversight();
    expect(roster).toMatchObject({ stalledFlagEnabled: true, stalledAfterDays: 14, stalledBelowPercent: 50, totalSteps: 4, staffOverridesEnabled: true, autoEnrollEnabled: true });
    const member = () => roster.members.find((row) => row.memberUserId === IDS.memberA);
    expect(member()).toMatchObject({ memberLabel: "Morgan Member", completedSteps: 1, percentComplete: 25, stalled: true, autoEnrolled: false });
    expect(roster.members[0].memberUserId).toBe(IDS.memberA);
    expect(roster.members.find((row) => row.memberUserId === IDS.joinerA)).toMatchObject({ stalled: false, autoEnrolled: true });

    await setSetting(IDS.orgA, KEYS.stalledDays, 30);
    roster = await oversight();
    expect(member().stalled).toBe(false);
    await setSetting(IDS.orgA, KEYS.stalledDays, 14);
    await setSetting(IDS.orgA, KEYS.stalledPercent, 20);
    roster = await oversight();
    expect(member().stalled).toBe(false);
    await setSetting(IDS.orgA, KEYS.stalledPercent, 50);
    await setSetting(IDS.orgA, KEYS.stalledFlag, false);
    roster = await oversight();
    expect(member().stalled).toBe(false);
    await setSetting(IDS.orgA, KEYS.stalledFlag, true);
  });

  it("keeps the roster staff-only and inside the caller's organization", async () => {
    expect((await callAs(IDS.memberA, "select public.get_member_onboarding_oversight()")).code).toBe("42501");
    const other = await oversight(IDS.staffB);
    expect(other.organizationId).toBe(IDS.orgB);
    expect(other.members.map((row) => row.memberUserId)).not.toContain(IDS.memberA);
  });

  it("lets staff complete, skip and reset a member's steps with an audit row each", async () => {
    const plan = await planFor(IDS.orgA, IDS.memberA);
    const completed = await staffChange(IDS.staffA, plan.id, "complete", STEPS[1]);
    expect(completed.code, completed.message).toBe("");
    const skipped = await staffChange(IDS.staffA, plan.id, "skip", STEPS[3]);
    expect(skipped.rows[0].result).toMatchObject({ status: "in_progress" });
    expect((await planFor(IDS.orgA, IDS.memberA)).completed_step_ids.sort()).toEqual([STEPS[0], STEPS[1], STEPS[3]].sort());
    const finished = await staffChange(IDS.staffA, plan.id, "skip", STEPS[2]);
    expect(finished.rows[0].result).toMatchObject({ status: "completed" });
    expect(await planFor(IDS.orgA, IDS.memberA)).toMatchObject({ status: "completed" });
    const reset = await staffChange(IDS.staffA, plan.id, "reset");
    expect(reset.rows[0].result).toMatchObject({ status: "not_started", completedStepIds: [] });
    expect(await planFor(IDS.orgA, IDS.memberA)).toMatchObject({ status: "not_started", started_at: null, completed_at: null, completed_step_ids: [] });
    const { rows } = await client.query(
      "select actor_user_id, member_user_id, event_type from public.member_support_events where entity_id = $1 order by occurred_at, event_type",
      [plan.id],
    );
    expect(rows.map((row) => row.event_type).sort()).toEqual(["progress_reset", "step_completed", "step_skipped", "step_skipped"]);
    for (const row of rows) expect(row).toMatchObject({ actor_user_id: IDS.staffA, member_user_id: IDS.memberA });
  });

  it("refuses members, foreign staff, unknown steps and a switched-off organization", async () => {
    const plan = await planFor(IDS.orgA, IDS.memberA);
    expect((await staffChange(IDS.memberA, plan.id, "complete", STEPS[0])).code).toBe("42501");
    expect((await staffChange(IDS.staffB, plan.id, "reset")).code).toBe("22023");
    expect((await staffChange(IDS.staffA, plan.id, "complete", crypto.randomUUID())).code).toBe("22023");
    expect((await staffChange(IDS.staffA, plan.id, "delete")).code).toBe("22023");
    await setSetting(IDS.orgA, KEYS.overrides, false);
    expect((await staffChange(IDS.staffA, plan.id, "reset")).code).toBe("42501");
    await setSetting(IDS.orgA, KEYS.overrides, true);
  });

  it("is not executable by anonymous callers", async () => {
    const { rows } = await client.query(
      `select has_function_privilege('anon', 'public.get_member_onboarding_oversight()', 'EXECUTE') a,
              has_function_privilege('anon', 'public.staff_update_member_onboarding_plan(uuid,text,uuid,uuid,text)', 'EXECUTE') b,
              has_function_privilege('authenticated', 'private.auto_enroll_member_onboarding()', 'EXECUTE') c`,
    );
    expect(rows[0]).toEqual({ a: false, b: false, c: false });
  });
});
