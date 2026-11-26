// @vitest-environment node
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runLive = process.env.RUN_LOCAL_DB_TESTS === "1";
const IDS = {
  orgA: "50907900-0000-4000-8000-000000000001",
  orgB: "50907900-0000-4000-8000-000000000002",
  staffA: "50907900-0000-4000-8000-000000000101",
  memberA: "50907900-0000-4000-8000-000000000102",
  staffB: "50907900-0000-4000-8000-000000000201",
  memberB: "50907900-0000-4000-8000-000000000202",
  // BUG-UG-MEMBER-SUPPORT-RPCS-REQUIRE-HOME-CHAPTER-FOR-CHAPTERLESS-STAFF-20260921.
  // Organization-only staff: an active organization membership and an admin
  // grant, no chapter membership, no home chapter on the profile.
  chapterlessStaffA: "50907900-0000-4000-8000-000000000301",
  // The same persona in two organizations, which must stay fail-closed.
  chapterlessMultiOrg: "50907900-0000-4000-8000-000000000302",
};

// One authenticated session per fixture user. private.mfa_satisfied() requires
// the session_id claim to resolve to a live auth.sessions row for that user.
const SESSIONS = Object.fromEntries(Object.entries(IDS)
  .filter(([key]) => !key.startsWith("org"))
  .map(([key, userId], index) => [userId, `50907900-0000-4000-8000-0000009000${String(index + 10).padStart(2, "0")}`]));

describe.skipIf(!runLive)("member support live database behavior", () => {
  let client;

  async function callAs(userId, sql, values = []) {
    await client.query("savepoint member_support_probe");
    try {
      // private.mfa_satisfied() resolves the caller's auth.sessions row from the
      // session_id claim, so a claim set without one is refused before any
      // member-support authorization runs.
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: SESSIONS[userId] }),
      ]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      await client.query("release savepoint member_support_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint member_support_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: process.env.SUPABASE_DB_URL,
      ssl: false,
      application_name: "member-support-test",
    });
    await client.connect();
    await client.query("begin");
    await client.query(
      `insert into auth.users (id, email) values
       ($1, 'support-staff-a@example.test'), ($2, 'support-member-a@example.test'),
       ($3, 'support-staff-b@example.test'), ($4, 'support-member-b@example.test'),
       ($5, 'support-chapterless-a@example.test'), ($6, 'support-chapterless-multi@example.test')`,
      [IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB, IDS.chapterlessStaffA, IDS.chapterlessMultiOrg],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
       ($1, 'support-org-a', 'Support Org A', $3),
       ($2, 'support-org-b', 'Support Org B', $4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
    await client.query("set local session_replication_role = replica");
    await client.query("update public.chapters set organization_id = $1 where id = 'wor'", [IDS.orgA]);
    await client.query("update public.chapters set organization_id = $1 where id = 'bos'", [IDS.orgB]);
    await client.query("set local session_replication_role = origin");
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id, full_name = fixture.full_name
       from (values ($1::uuid, 'wor'::text, 'Alex Staff'::text), ($2::uuid, 'wor'::text, 'Morgan Member'::text),
                    ($3::uuid, 'bos'::text, 'Blair Staff'::text), ($4::uuid, 'bos'::text, 'Taylor Member'::text)) fixture(id, chapter_id, full_name)
       where member_profiles.id = fixture.id`,
      [IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    // member_profiles.chapter_id defaults to a chapter, so the organization-only
    // persona has to be made genuinely chapterless.
    await client.query(
      `update public.member_profiles set chapter_id = null, full_name = fixture.full_name
       from (values ($1::uuid, 'Rowan Organization'::text), ($2::uuid, 'Sky Twoorg'::text)) fixture(id, full_name)
       where member_profiles.id = fixture.id`,
      [IDS.chapterlessStaffA, IDS.chapterlessMultiOrg],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1, 'wor', 'active', true, now()), ($2, 'wor', 'active', true, now()),
              ($3, 'bos', 'active', true, now()), ($4, 'bos', 'active', true, now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id)
       values ($1,$3),($1,$4),($2,$5),($2,$6),($1,$7),($1,$8),($2,$8)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB,
       IDS.chapterlessStaffA, IDS.chapterlessMultiOrg],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
       values ($1,$3,'admin',$3),($1,$3,'steward',$3),
              ($2,$4,'admin',$4),($2,$4,'steward',$4),
              ($1,$5,'admin',$3),($1,$6,'admin',$3),($2,$6,'admin',$4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB, IDS.chapterlessStaffA, IDS.chapterlessMultiOrg],
    );
    await client.query(
      `insert into auth.mfa_factors
       (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'support-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'support-b-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $3, 'support-chapterless-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $4, 'support-chapterless-multi-totp', 'totp', 'verified', now(), now())`,
      [IDS.staffA, IDS.staffB, IDS.chapterlessStaffA, IDS.chapterlessMultiOrg],
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

  it("saves emergency-rights progress and creates an urgent steward request", async () => {
    const saved = await callAs(
      IDS.memberA,
      "select public.save_member_emergency_checklist('disciplinary_meeting', array[0,1], 'Bring notes.', $1) result",
      [crypto.randomUUID()],
    );
    expect(saved, saved.message).toMatchObject({ code: "" });
    expect(saved.rows[0].result).toMatchObject({ status: "draft" });

    const alerted = await callAs(
      IDS.memberA,
      "select public.alert_member_emergency_steward('disciplinary_meeting', array[0,1,2], 'Meeting begins soon.', $1) result",
      [crypto.randomUUID()],
    );
    expect(alerted.rows[0].result).toMatchObject({ status: "alerted" });
    const workspace = await callAs(IDS.memberA, "select public.get_member_support_workspace() result");
    expect(workspace.rows[0].result.emergencyChecklists).toEqual([
      expect.objectContaining({ scenario: "disciplinary_meeting", status: "alerted", completedSteps: [0, 1, 2] }),
    ]);
    const staffWorkspace = await callAs(IDS.staffA, "select public.get_member_support_workspace() result");
    expect(staffWorkspace.rows[0].result.emergencyChecklists).toEqual([
      expect.objectContaining({
        memberUserId: IDS.memberA,
        memberLabel: "Morgan Member",
        scenario: "disciplinary_meeting",
        status: "alerted",
      }),
    ]);
    const draft = await callAs(
      IDS.memberA,
      "select public.save_member_emergency_checklist('unsafe_work', array[0], 'Draft member-only note.', $1) result",
      [crypto.randomUUID()],
    );
    expect(draft.code).toBe("");
    const staffDraftRead = await callAs(
      IDS.staffA,
      "select id from public.member_emergency_checklists where id = $1",
      [draft.rows[0].result.id],
    );
    expect(staffDraftRead.rows).toHaveLength(0);
    const foreignResolve = await callAs(
      IDS.staffB,
      "select public.resolve_member_emergency_checklist($1,$2)",
      [alerted.rows[0].result.id, crypto.randomUUID()],
    );
    expect(foreignResolve.code).toBe("22023");
    const resolved = await callAs(
      IDS.staffA,
      "select public.resolve_member_emergency_checklist($1,$2) result",
      [alerted.rows[0].result.id, crypto.randomUUID()],
    );
    expect(resolved.rows[0].result).toMatchObject({ id: alerted.rows[0].result.id, status: "resolved" });
    const afterResolve = await callAs(IDS.memberA, "select public.get_member_support_workspace() result");
    expect(afterResolve.rows[0].result.emergencyChecklists).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alerted.rows[0].result.id, status: "resolved" }),
    ]));
  });

  // SEC-UG-EMERGENCY-STEWARD-ALERT-BOUNDS-20260921. A key that already
  // names an ordinary steward request would make the alert's request insert
  // conflict silently, leaving the checklist alerted with no steward notified.
  it("refuses an emergency alert keyed by an existing steward request", async () => {
    // The ordinary request flow (requestSteward) returns the minted id.
    const request = await callAs(
      IDS.memberB,
      "insert into public.member_steward_requests (user_id, lesson_id) values ($1, null) returning id",
      [IDS.memberB],
    );
    expect(request, request.message).toMatchObject({ code: "" });
    const requestId = request.rows[0].id;

    const reused = await callAs(
      IDS.memberB,
      "select public.alert_member_emergency_steward('pre_discipline_response', array[0], 'Reused key.', $1) result",
      [requestId],
    );
    expect(reused.code).toBe("22023");
    const untouched = await client.query(
      "select count(*)::integer n from public.member_emergency_checklists where member_user_id = $1 and scenario = 'pre_discipline_response'",
      [IDS.memberB],
    );
    expect(untouched.rows[0].n).toBe(0);

    const alertKey = crypto.randomUUID();
    const alerted = await callAs(
      IDS.memberB,
      "select public.alert_member_emergency_steward('pre_discipline_response', array[0], 'Fresh key.', $1) result",
      [alertKey],
    );
    expect(alerted, alerted.message).toMatchObject({ code: "" });
    expect(alerted.rows[0].result).toMatchObject({ status: "alerted" });
    const minted = await client.query(
      "select count(*)::integer n from public.member_steward_requests where id = $1 and user_id = $2",
      [alertKey, IDS.memberB],
    );
    expect(minted.rows[0].n).toBe(1);
  });

  // BUG-UG-MEMBER-SUPPORT-RPCS-REQUIRE-HOME-CHAPTER-FOR-CHAPTERLESS-STAFF-20260921.
  // Before 20260924200000 every member-support RPC resolved the organization
  // through private.mi1_require_selected_organization(), which reads only the
  // organization behind a SELECTED CHAPTER. The organization-only staff persona
  // therefore got 42501 from get_member_support_workspace while
  // get_member_operations_workspace answered for the very same session.
  it("opens member support for chapterless single-organization staff and keeps two organizations closed", async () => {
    const operations = await callAs(IDS.chapterlessStaffA, "select public.get_member_operations_workspace() result");
    expect(operations, operations.message).toMatchObject({ code: "" });
    expect(operations.rows[0].result).toMatchObject({ state: "ready", organizationId: IDS.orgA });

    const support = await callAs(IDS.chapterlessStaffA, "select public.get_member_support_workspace() result");
    expect(support, support.message).toMatchObject({ code: "" });
    expect(support.rows[0].result).toMatchObject({ state: "ready", organizationId: IDS.orgA, staff: true });

    // A staff write in the same scope must work too, not just the read.
    const directory = await callAs(
      IDS.chapterlessStaffA,
      "select public.save_organization_hr_directory('Org Only','HR partner','People','org-only@example.test','555-0199','Weekdays','',true,$1) result",
      [crypto.randomUUID()],
    );
    expect(directory, directory.message).toMatchObject({ code: "" });
    expect(directory.rows[0].result).toMatchObject({ id: IDS.orgA, enabled: true });

    // The web member snapshot reads the selected membership row; without an
    // organization-level row Member Support paints "Organization setup is still
    // empty" for an organization that exists.
    const memberships = await callAs(IDS.chapterlessStaffA, "select public.get_my_chapter_memberships() result");
    expect(memberships.rows[0].result).toEqual([
      expect.objectContaining({
        chapterId: null,
        organizationId: IDS.orgA,
        selected: true,
        organizationRoles: ["admin"],
        chapterRoles: [],
      }),
    ]);

    // A handoff writes chapter_id, so it still refuses — honestly.
    const handoff = await callAs(
      IDS.chapterlessStaffA,
      "select public.initiate_member_handoff($1,$2,'',$3)",
      [IDS.memberA, IDS.staffA, crypto.randomUUID()],
    );
    expect(handoff.code).toBe("42501");
    expect(handoff.message).toContain("Select a chapter before transferring responsibility");

    // Two active organizations and no chapter stay fail-closed.
    const ambiguous = await callAs(IDS.chapterlessMultiOrg, "select public.get_member_support_workspace()");
    expect(ambiguous.code).toBe("42501");
    expect(ambiguous.message).toContain("active organization membership required");
    const ambiguousMemberships = await callAs(IDS.chapterlessMultiOrg, "select public.get_my_chapter_memberships() result");
    expect(ambiguousMemberships.rows[0].result).toEqual([]);

    // A chapter-holding member keeps exactly the rows it had.
    const chaptered = await callAs(IDS.memberA, "select public.get_my_chapter_memberships() result");
    expect(chaptered.rows[0].result).toEqual([expect.objectContaining({ chapterId: "wor", selected: true })]);
  });

  it("keeps accommodation transitions within the selected organization", async () => {
    const requestId = crypto.randomUUID();
    const created = await callAs(
      IDS.memberA,
      "select public.create_member_accommodation_request('schedule','Temporary schedule adjustment',$1) result",
      [requestId],
    );
    expect(created.rows[0].result).toMatchObject({ id: requestId, status: "submitted" });
    const foreign = await callAs(
      IDS.staffB,
      "select public.transition_member_accommodation_request($1,'approved','Cross-tenant attempt',$2)",
      [requestId, crypto.randomUUID()],
    );
    expect(foreign.code).toBe("22023");
    const approved = await callAs(
      IDS.staffA,
      "select public.transition_member_accommodation_request($1,'approved','Approved locally',$2) result",
      [requestId, crypto.randomUUID()],
    );
    expect(approved.rows[0].result).toMatchObject({ id: requestId, status: "approved" });
  });

  it("configures an HR directory and keeps member contact history private", async () => {
    const configured = await callAs(
      IDS.staffA,
      "select public.save_organization_hr_directory('People Support','HR partner','People','people@example.test','555-0100','Weekdays','',true,$1) result",
      [crypto.randomUUID()],
    );
    expect(configured.rows[0].result).toMatchObject({ id: IDS.orgA, enabled: true });
    const contactId = crypto.randomUUID();
    expect((await callAs(
      IDS.memberA,
      "select public.record_member_hr_contact(null,'email','Schedule question','reached','Sent documents',now(),null,$1)",
      [contactId],
    )).code).toBe("");
    const foreignRead = await callAs(IDS.memberB, "select id from public.member_hr_contacts where id = $1", [contactId]);
    expect(foreignRead.rows).toHaveLength(0);
  });

  it("enforces ordered post-provisioning onboarding without creating default plans", async () => {
    const empty = await client.query(
      "select count(*)::integer count from public.member_onboarding_plans where member_user_id = $1",
      [IDS.memberA],
    );
    expect(empty.rows[0].count).toBe(0);
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    expect((await callAs(IDS.staffA, "select public.save_organization_onboarding_step(null,'Welcome','Review the welcome guide',10,true,$1)", [firstId])).code).toBe("");
    expect((await callAs(IDS.staffA, "select public.save_organization_onboarding_step(null,'Meet your steward','Schedule an introduction',20,true,$1)", [secondId])).code).toBe("");
    const duplicatePosition = await callAs(
      IDS.staffA,
      "select public.save_organization_onboarding_step(null,'Duplicate position','Must be rejected',10,true,$1)",
      [crypto.randomUUID()],
    );
    expect(duplicatePosition).toMatchObject({ code: "22023" });
    expect(duplicatePosition.message).toContain("onboarding position already in use");
    expect((await callAs(IDS.memberA, "select public.start_member_onboarding_plan(null,$1)", [crypto.randomUUID()])).code).toBe("");
    const outOfOrder = await callAs(IDS.memberA, "select public.complete_member_onboarding_step($1,$2)", [secondId, crypto.randomUUID()]);
    expect(outOfOrder.code).toBe("22023");
    expect((await callAs(IDS.memberA, "select public.complete_member_onboarding_step($1,$2)", [firstId, crypto.randomUUID()])).code).toBe("");
    const completed = await callAs(IDS.memberA, "select public.complete_member_onboarding_step($1,$2) result", [secondId, crypto.randomUUID()]);
    expect(completed.rows[0].result).toMatchObject({ status: "completed" });
  });

  it("authorizes mentorship notes and goals only for pair participants and local staff", async () => {
    const pairId = crypto.randomUUID();
    const pair = await callAs(
      IDS.staffA,
      "select public.create_member_mentorship_pair($1,$2,current_date,$3) result",
      [IDS.staffA, IDS.memberA, pairId],
    );
    expect(pair.rows[0].result).toMatchObject({ id: pairId, status: "active" });
    expect((await callAs(IDS.memberA, "select public.add_member_mentorship_note($1,'Discussed the first month.',$2)", [pairId, crypto.randomUUID()])).code).toBe("");
    const goal = await callAs(IDS.staffA, "select public.save_member_mentorship_goal($1,null,'Complete orientation',false,$2) result", [pairId, crypto.randomUUID()]);
    expect(goal.rows[0].result).toMatchObject({ completed: false });
    const foreign = await callAs(IDS.staffB, "select public.add_member_mentorship_note($1,'Cross-tenant note',$2)", [pairId, crypto.randomUUID()]);
    expect(foreign.code).toBe("42501");
    const workspace = await callAs(IDS.memberA, "select public.get_member_support_workspace() result");
    expect(workspace.rows[0].result.mentorshipPairs).toEqual([
      expect.objectContaining({ id: pairId, mentorLabel: "Alex Staff", menteeLabel: "Morgan Member" }),
    ]);
  });
});
