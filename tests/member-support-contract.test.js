import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_MEMBER_SUPPORT_WORKSPACE,
  MEMBER_SUPPORT_DONOR,
  MEMBER_SUPPORT_RPCS,
  createMemberSupportAdapter,
  canManageMemberSupport,
  canReadMemberSupport,
  normalizeMemberSupportActor,
  normalizeMemberSupportWorkspace,
} from "../src/features/memberSupport/index.js";

const member = {
  userId: "11111111-1111-4111-8111-111111111111",
  selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
  membershipStatus: "active",
  selectedHat: "member",
};

const steward = {
  ...member,
  selectedHat: "steward",
  organizationRoles: ["steward"],
  mfaSatisfied: true,
};
const migration = [
  "20260826151000_mi1_w2_feature_persistence.sql",
  "20260829030000_member_support_programs.sql",
  "20260830160000_member_operations_completion.sql",
].map((name) => readFileSync(`${process.cwd()}/supabase/migrations/${name}`, "utf8")).join("\n");

describe("member support authorization", () => {
  it("requires active organization membership for reads", () => {
    expect(canReadMemberSupport(member)).toBe(true);
    expect(canReadMemberSupport({ ...member, membershipStatus: "invited" })).toBe(false);
    expect(canReadMemberSupport({ ...member, selectedOrganizationId: null })).toBe(false);
  });

  it("requires the explicitly selected authorized staff hat and MFA for management", () => {
    expect(canManageMemberSupport(steward)).toBe(true);
    expect(canManageMemberSupport({ ...steward, selectedHat: "member" })).toBe(false);
    expect(canManageMemberSupport({ ...steward, mfaSatisfied: false })).toBe(false);
    expect(canManageMemberSupport({ ...steward, organizationRoles: ["advisor"] })).toBe(false);
  });

  it("normalizes aliases, removes duplicate roles, and rejects unsupported hats", () => {
    expect(normalizeMemberSupportActor({
      id: member.userId,
      organizationId: member.selectedOrganizationId,
      roles: ["steward", "steward", "unsupported"],
      chapterRoles: ["advisor", "advisor", null, "unsupported"],
      chapterId: "chapter-1",
      membershipStatus: "active",
      mfaSatisfied: 1,
    })).toEqual({
      userId: member.userId,
      selectedOrganizationId: member.selectedOrganizationId,
      chapterId: "chapter-1",
      selectedHat: "member",
      organizationRoles: ["steward"],
      chapterRoles: ["advisor"],
      membershipStatus: "active",
      mfaSatisfied: true,
    });
    expect(canReadMemberSupport()).toBe(false);
    expect(canReadMemberSupport({ ...member, userId: null })).toBe(false);
  });
});

describe("member support normalization", () => {
  it("fails closed when the snapshot organization differs from the selected organization", () => {
    expect(normalizeMemberSupportWorkspace({ state: "ready", organizationId: "other" }, member))
      .toEqual({ ...EMPTY_MEMBER_SUPPORT_WORKSPACE, state: "unauthorized" });
  });

  it("bounds persisted emergency steps to the canonical scenario", () => {
    const result = normalizeMemberSupportWorkspace({
      state: "ready",
      organizationId: member.selectedOrganizationId,
      emergencyChecklists: [{
        id: "checklist-1",
        memberUserId: member.userId,
        memberLabel: "Morgan Member",
        scenario: "disciplinary_meeting",
        status: "draft",
        completedSteps: [0, 0, 3, 99, -1, "2"],
      }],
    }, member);
    expect(result.emergencyChecklists[0].completedSteps).toEqual([0, 3]);
    expect(result.emergencyChecklists[0]).toMatchObject({
      memberUserId: member.userId,
      memberLabel: "Morgan Member",
    });
    expect(result.staff).toBe(false);
  });

  it("normalizes every persisted workflow and fails invalid rows closed", () => {
    const result = normalizeMemberSupportWorkspace({
      state: "ready",
      organizationId: member.selectedOrganizationId,
      staff: true,
      emergencyChecklists: [
        { id: "invalid-scenario", scenario: "unknown" },
        { id: "minimal-checklist", scenario: "unsafe_work", status: "unknown", completedSteps: null },
      ],
      accommodations: [
        {},
        { id: "accommodation-1", status: "unknown" },
        { id: "accommodation-2", memberUserId: "member-2", memberLabel: "Alex", requestType: "schedule", description: "Shift", status: "approved", staffNote: "Approved", submittedAt: "2026-01-01", resolvedAt: "2026-01-02", updatedAt: "2026-01-02" },
      ],
      accommodationSummary: { total: "2", open: 1, approved: 1, denied: null, withdrawn: 0 },
      hrDirectory: { id: "directory-1", enabled: false },
      hrContacts: [
        {},
        { id: "contact-1", channel: "invalid", disposition: "invalid" },
        { id: "contact-2", memberUserId: "member-2", memberLabel: "Alex", channel: "phone", purpose: "Follow up", disposition: "completed", note: "Reached", occurredAt: "2026-01-01", followUpOn: "2026-01-02", createdAt: "2026-01-01" },
      ],
      onboardingProgram: [
        {},
        { id: "step-1", active: false },
        { id: "step-2", title: "Welcome", description: "Meet the team", position: "2", active: true },
      ],
      onboardingPlan: { id: "plan-1", completedStepIds: ["step-2", "step-2", null] },
      onboardingRoster: [{ id: "roster-1" }],
      mentorshipPairs: [
        {},
        {
          id: "pair-1",
          status: "unknown",
          goals: [{}, { id: "goal-1" }, { id: "goal-2", title: "Prepare", completed: 1 }],
          notes: [{}, { id: "note-1" }, { id: "note-2", authorLabel: "Alex", body: "Ready", createdAt: "2026-01-01" }],
        },
        { id: "pair-2", mentorUserId: "mentor", menteeUserId: "mentee", mentorLabel: "Morgan", menteeLabel: "Alex", status: "completed", startedOn: "2025-01-01", endedOn: "2026-01-01", outcome: "Completed", goals: [], notes: [] },
      ],
      mentorshipDirectory: [{}, { userId: "member-2" }, { userId: "member-3", label: "Taylor", chapterId: "chapter-1" }],
    }, steward);

    expect(result).toMatchObject({
      state: "ready",
      staff: true,
      accommodationSummary: { total: 2, open: 1, approved: 1, denied: 0, withdrawn: 0 },
      hrDirectory: { id: "directory-1", name: "", enabled: false },
      onboardingPlan: {
        id: "plan-1",
        memberUserId: member.userId,
        status: "not_started",
        completedStepIds: ["step-2"],
      },
    });
    expect(result.emergencyChecklists).toHaveLength(1);
    expect(result.emergencyChecklists[0]).toMatchObject({ status: "draft", memberLabel: "Worker", completedSteps: [] });
    expect(result.accommodations).toHaveLength(2);
    expect(result.accommodations[0]).toMatchObject({ status: "submitted", requestType: "other", memberLabel: "Worker" });
    expect(result.hrContacts).toHaveLength(2);
    expect(result.hrContacts[0]).toMatchObject({ channel: "other", disposition: "planned" });
    expect(result.onboardingProgram).toHaveLength(2);
    expect(result.mentorshipPairs).toHaveLength(2);
    expect(result.mentorshipPairs[0]).toMatchObject({ status: "active", mentorLabel: "Mentor", menteeLabel: "Mentee" });
    expect(result.mentorshipPairs[0].goals).toHaveLength(1);
    expect(result.mentorshipPairs[0].notes).toHaveLength(2);
    expect(result.mentorshipDirectory).toEqual([
      { userId: "member-2", label: "Worker", chapterId: null },
      { userId: "member-3", label: "Taylor", chapterId: "chapter-1" },
    ]);
  });

  it("returns the honest empty workspace for absent and explicitly empty snapshots", () => {
    expect(normalizeMemberSupportWorkspace(null, member)).toEqual(EMPTY_MEMBER_SUPPORT_WORKSPACE);
    expect(normalizeMemberSupportWorkspace({ state: "empty" }, member)).toEqual(EMPTY_MEMBER_SUPPORT_WORKSPACE);
    expect(normalizeMemberSupportWorkspace({ state: "ready", organizationId: member.selectedOrganizationId }, { ...member, selectedOrganizationId: null }))
      .toEqual(EMPTY_MEMBER_SUPPORT_WORKSPACE);
  });
});

describe("member support adapter", () => {
  it("declares the complete five-workflow RPC surface and donor rejection boundary", () => {
    expect(Object.keys(MEMBER_SUPPORT_RPCS)).toEqual(expect.arrayContaining([
      "snapshot", "saveEmergencyChecklist", "alertEmergencySteward",
      "resolveEmergencyChecklist",
      "createAccommodation", "transitionAccommodation", "recordHrContact",
      "startOnboarding", "completeOnboardingStep", "createMentorshipPair",
      "transitionMentorshipPair", "addMentorshipNote", "saveMentorshipGoal",
    ]));
    expect(MEMBER_SUPPORT_DONOR.rejected).toContain("fictional production tenants, users, programs, or onboarding assignments");
  });

  it("does not call the database before organization onboarding", async () => {
    const client = { rpc: vi.fn() };
    await expect(createMemberSupportAdapter(client).load({ ...member, selectedOrganizationId: null }))
      .resolves.toEqual(EMPTY_MEMBER_SUPPORT_WORKSPACE);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("derives scope server-side and never sends organization or actor ids to the snapshot RPC", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: {
      state: "ready",
      organizationId: member.selectedOrganizationId,
    }, error: null }) };
    const result = await createMemberSupportAdapter(client).load(member);
    expect(result.state).toBe("ready");
    expect(client.rpc).toHaveBeenCalledWith("get_member_support_workspace", undefined);
  });

  it("rejects staff transitions from a member hat before making an RPC", async () => {
    const client = { rpc: vi.fn() };
    await expect(createMemberSupportAdapter(client).transitionAccommodation(member, {
      requestId: "33333333-3333-4333-8333-333333333333",
      status: "approved",
    })).rejects.toMatchObject({ code: "42501" });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("uses an injected secure UUID source for every native mutation", async () => {
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    ];
    const client = { rpc: vi.fn().mockResolvedValue({ data: { saved: true }, error: null }) };
    const adapter = createMemberSupportAdapter(client, { randomUUID: vi.fn(() => ids.shift()) });
    await adapter.saveEmergencyChecklist(member, { scenario: "unsafe_work" });
    await adapter.resolveEmergencyChecklist(member, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(client.rpc.mock.calls.map(([, args]) => args.p_idempotency_key)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    ]);
  });

  it("maps snapshot failures to bounded workspace states", async () => {
    const cases = [
      [{ code: "PGRST202" }, "unavailable"],
      [{ code: "42883" }, "unavailable"],
      [new Error("could not find the function"), "unavailable"],
      [{ code: "42501", message: "MFA required" }, "mfa_required"],
      [{ code: "42501", message: "denied" }, "unauthorized"],
      [{ code: "22023", message: "bad input" }, "invalid_input"],
      [new Error("network failure"), "error"],
    ];
    for (const [error, state] of cases) {
      const client = { rpc: vi.fn().mockResolvedValue({ data: null, error }) };
      await expect(createMemberSupportAdapter(client).load(member)).resolves.toMatchObject({ state });
    }
    await expect(createMemberSupportAdapter(null).load(member)).resolves.toMatchObject({ state: "unavailable" });
  });

  it("maps every mutation to its RPC contract with secure defaults", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { saved: true }, error: null }) };
    const adapter = createMemberSupportAdapter(client, { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });

    await adapter.saveEmergencyChecklist(member, { scenario: "unsafe_work" });
    await adapter.alertEmergencySteward(member, { scenario: "disciplinary_meeting", completedSteps: [0], notes: "Help" });
    await adapter.resolveEmergencyChecklist(member, "checklist-1");
    await adapter.createAccommodation(member, { requestType: "schedule", description: "Earlier shift" });
    await adapter.transitionAccommodation(member, { requestId: "request-1", status: "withdrawn" });
    await adapter.transitionAccommodation(steward, { requestId: "request-2", status: "approved", staffNote: "Approved" });
    await adapter.recordHrContact(member, { channel: "email", purpose: "Question", disposition: "planned" });
    await adapter.recordHrContact(steward, { memberUserId: "member-2", channel: "phone", purpose: "Follow up", disposition: "completed", note: "Reached", occurredAt: "2026-01-01T12:00:00.000Z", followUpOn: "2026-01-02" });
    await adapter.saveHrDirectory(steward, { enabled: false });
    await adapter.saveOnboardingStep(steward, { title: "Welcome", active: false });
    await adapter.startOnboarding(member);
    await adapter.startOnboarding(steward, "member-2");
    await adapter.completeOnboardingStep(member, "step-1");
    await adapter.createMentorshipPair(steward, { mentorUserId: "mentor", menteeUserId: "mentee" });
    await adapter.transitionMentorshipPair(steward, { pairId: "pair-1", status: "completed" });
    await adapter.addMentorshipNote(member, { pairId: "pair-1", body: "Ready" });
    await adapter.saveMentorshipGoal(member, { pairId: "pair-1", title: "Prepare" });
    await adapter.saveMentorshipGoal(member, { pairId: "pair-1", goalId: "goal-1", title: "Prepare", completed: true });

    const calls = Object.fromEntries(client.rpc.mock.calls.map(([name, args]) => [name, args]));
    expect(calls.save_member_emergency_checklist).toMatchObject({ p_completed_steps: [], p_notes: "" });
    expect(calls.record_member_hr_contact).toMatchObject({ p_member_user_id: "member-2", p_note: "Reached", p_follow_up_on: "2026-01-02" });
    expect(calls.save_organization_hr_directory).toMatchObject({ p_name: "", p_enabled: false });
    expect(calls.save_organization_onboarding_step).toMatchObject({ p_step_id: null, p_position: 0, p_active: false });
    expect(calls.create_member_mentorship_pair).toMatchObject({ p_started_on: null });
    expect(calls.transition_member_mentorship_pair).toMatchObject({ p_outcome: "" });
    expect(calls.save_member_mentorship_goal).toMatchObject({ p_goal_id: "goal-1", p_completed: true });
    expect(client.rpc.mock.calls.every(([, args]) => args.p_idempotency_key === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(true);
  });

  it("fails unauthorized mutations and propagates database mutation errors", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: new Error("write failed") }) };
    const adapter = createMemberSupportAdapter(client, { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await expect(adapter.saveEmergencyChecklist({ ...member, membershipStatus: "invited" }, { scenario: "unsafe_work" }))
      .rejects.toMatchObject({ code: "42501" });
    await expect(adapter.saveHrDirectory(member, {})).rejects.toMatchObject({ code: "42501" });
    await expect(adapter.startOnboarding(member, "member-2")).rejects.toMatchObject({ code: "42501" });
    await expect(adapter.createAccommodation(member, { requestType: "schedule", description: "Shift" }))
      .rejects.toThrow("write failed");
  });
});

describe("member support database contract", () => {
  it("ships all five tenant-scoped data models behind RLS and RPC-only writes", () => {
    for (const table of [
      "member_emergency_checklists", "member_accommodation_requests",
      "organization_hr_directory", "member_hr_contacts",
      "organization_onboarding_steps", "member_onboarding_plans",
      "member_mentorship_pairs", "member_mentorship_notes",
      "member_mentorship_goals", "member_support_events",
    ]) {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`revoke all on public.${table} from public, anon, authenticated`);
    }
    for (const rpc of Object.values(MEMBER_SUPPORT_RPCS)) {
      expect(migration).toContain(`create function public.${rpc}(`);
    }
    expect(migration.match(/private\.mi1_require_selected_organization\(\)/g)?.length).toBeGreaterThanOrEqual(15);
    expect(migration).toContain("private.mi1_w2_selected_organization()");
    expect(migration).toContain("private.mi1_w2_handoff_visible");
  });

  it("keeps onboarding post-provisioning and never invents a production tenant or user", () => {
    expect(migration).not.toMatch(/trigger[\s\S]{0,120}(auth\.users|handle_new_member)/i);
    expect(migration).not.toMatch(/insert\s+into\s+(public\.)?organizations\b/i);
    expect(migration).not.toMatch(/insert\s+into\s+auth\.users\b/i);
    expect(migration).toContain("onboarding program is not configured");
  });

  it("provides a reversible SAMPLE-only three-year seed and parity evidence", () => {
    expect(migration).toContain("create function private.demo_seed_apply_member_support");
    expect(migration).toContain("member support demo seed requires at least 38 seeded users");
    expect(migration).toContain("create function private.demo_seed_remove_member_support");
    expect(migration).toContain("create function private.demo_seed_member_support_status");
    expect(migration).toContain("create trigger demo_seed_sync_member_support_evidence");
    expect(migration).toContain("set coverage = 'seeded'");
    for (const audit of ["CR-079", "CR-080", "CR-081", "CR-082", "CR-083"]) expect(migration).toContain(`('${audit}',`);
    expect(migration).toContain("history_years >= 3");
  });
});

// Adapter contract tests isolate transport; sensitive-content-api.test.js proves the encrypted HTTP boundary.
vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));
