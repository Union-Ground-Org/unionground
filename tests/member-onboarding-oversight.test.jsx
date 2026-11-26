// REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001 (CR-082):
// the staff onboarding roster with the stalled flag and audited complete /
// skip / reset, on the web member-support desk.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberSupportView } from "../src/views/MemberSupportView.jsx";
import { catalogue } from "../src/lib/i18n.js";
import {
  EMPTY_ONBOARDING_OVERSIGHT,
  MEMBER_ONBOARDING_OVERSIGHT_RPCS,
  createMemberSupportAdapter,
  normalizeOnboardingOversight,
  openOnboardingSteps,
} from "../src/features/memberSupport/index.js";

vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const member = { userId: USER, selectedOrganizationId: ORG, membershipStatus: "active", selectedHat: "member", mfaSatisfied: true };
const steward = { ...member, selectedHat: "steward", organizationRoles: ["steward"] };

const OVERSIGHT = Object.freeze({
  state: "ready",
  organizationId: ORG,
  stalledFlagEnabled: true,
  stalledAfterDays: 14,
  stalledBelowPercent: 50,
  staffOverridesEnabled: true,
  autoEnrollEnabled: false,
  totalSteps: 2,
  steps: [{ id: "step-1", title: "Welcome", position: 1 }, { id: "step-2", title: "Rights", position: 2 }],
  members: [
    { planId: "plan-2", memberUserId: "member-2", memberLabel: "Alex Member", status: "in_progress", completedStepIds: ["step-1"], completedSteps: 1, percentComplete: 50, assignedAt: "2026-08-01T00:00:00Z", autoEnrolled: false, stalled: false },
    { planId: "plan-3", memberUserId: "member-3", memberLabel: "Jordan Member", status: "not_started", completedStepIds: [], completedSteps: 0, percentComplete: 0, assignedAt: "2026-07-01T00:00:00Z", autoEnrolled: true, stalled: true },
  ],
  memberCount: 2,
});

function workspace() {
  return {
    state: "ready",
    organizationId: ORG,
    staff: true,
    emergencyChecklists: [],
    accommodations: [],
    accommodationSummary: { total: 0, open: 0, approved: 0, denied: 0, withdrawn: 0 },
    hrDirectory: null,
    hrContacts: [],
    onboardingProgram: [
      { id: "step-1", title: "Welcome", description: "", position: 1, active: true },
      { id: "step-2", title: "Rights", description: "", position: 2, active: true },
    ],
    onboardingPlan: null,
    onboardingRoster: [{ id: "plan-2", memberUserId: "member-2", memberLabel: "Alex Member", status: "in_progress", completedStepIds: ["step-1"] }],
    mentorshipPairs: [],
    mentorshipDirectory: [],
  };
}

function clientFor(oversight = OVERSIGHT) {
  return { rpc: vi.fn(async (name) => {
    if (name === "get_member_support_workspace") return { data: workspace(), error: null };
    if (name === MEMBER_ONBOARDING_OVERSIGHT_RPCS.load) return { data: oversight, error: null };
    if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
    return { data: { id: "plan-3", status: "in_progress" }, error: null };
  }) };
}

async function openOversight(client) {
  render(<MemberSupportView actor={steward} client={client} />);
  await screen.findByRole("heading", { name: "Emergency rights checklist" });
  fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
  fireEvent.click(screen.getByText("Manage program and oversight"));
  return screen.findByRole("region", { name: "Worker progress" });
}

afterEach(() => vi.restoreAllMocks());

describe("onboarding oversight payload and adapter", () => {
  it("fails closed and keeps only known steps", () => {
    expect(normalizeOnboardingOversight(null)).toEqual({ ...EMPTY_ONBOARDING_OVERSIGHT });
    const normalized = normalizeOnboardingOversight({
      ...OVERSIGHT,
      members: [{ ...OVERSIGHT.members[0], completedStepIds: ["step-1", "foreign"], status: "weird", percentComplete: 400 }, { planId: 7 }],
    });
    expect(normalized.members).toHaveLength(1);
    expect(normalized.members[0]).toMatchObject({ completedStepIds: ["step-1"], status: "not_started", percentComplete: 100 });
    expect(openOnboardingSteps(normalized, normalized.members[0]).map((step) => step.id)).toEqual(["step-2"]);
  });

  it("is staff-only and sends exactly the audited change", async () => {
    const client = clientFor();
    const adapter = createMemberSupportAdapter(client, { randomUUID: () => "33333333-3333-4333-8333-333333333333" });
    await expect(adapter.loadOnboardingOversight(member)).rejects.toMatchObject({ code: "42501" });
    await expect(adapter.updateMemberOnboarding(member, { planId: "plan-2", action: "reset" })).rejects.toMatchObject({ code: "42501" });
    expect(client.rpc).not.toHaveBeenCalled();
    await expect(adapter.loadOnboardingOversight(steward)).resolves.toMatchObject({ state: "ready", members: [expect.objectContaining({ memberLabel: "Alex Member" }), expect.objectContaining({ stalled: true })] });
    await adapter.updateMemberOnboarding(steward, { planId: "plan-2", action: "skip", stepId: "step-2", reason: "  Done at orientation. " });
    expect(client.rpc).toHaveBeenLastCalledWith("staff_update_member_onboarding_plan", {
      p_plan_id: "plan-2", p_action: "skip", p_step_id: "step-2", p_reason: "Done at orientation.", p_idempotency_key: "33333333-3333-4333-8333-333333333333",
    });
    // A skip with no reason goes out as null, which the server refuses.
    await adapter.updateMemberOnboarding(steward, { planId: "plan-2", action: "skip", stepId: "step-2" });
    expect(client.rpc).toHaveBeenLastCalledWith("staff_update_member_onboarding_plan", expect.objectContaining({ p_action: "skip", p_reason: null }));
    await adapter.updateMemberOnboarding(steward, { planId: "plan-2", action: "reset", stepId: "step-2", reason: "ignored" });
    expect(client.rpc).toHaveBeenLastCalledWith("staff_update_member_onboarding_plan", expect.objectContaining({ p_action: "reset", p_step_id: null, p_reason: null }));
    // REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: one reminder, by plan.
    await adapter.sendOnboardingReminder(steward, "plan-2");
    expect(client.rpc).toHaveBeenLastCalledWith("send_member_onboarding_reminder", { p_plan_id: "plan-2", p_idempotency_key: "33333333-3333-4333-8333-333333333333" });
    await expect(adapter.sendOnboardingReminder(member, "plan-2")).rejects.toMatchObject({ code: "42501" });
    await expect(adapter.sendOnboardingReminder(steward, 42)).rejects.toMatchObject({ code: "22023" });
    await expect(adapter.updateMemberOnboarding(steward, { planId: "plan-2", action: "delete" })).rejects.toMatchObject({ code: "22023" });
  });
});

describe("onboarding oversight settings copy", () => {
  it("names every oversight control in English and Spanish", () => {
    const keys = Object.keys(catalogue.en).filter((key) => /^settings\.def\.(features|limits)\.guidance_onboarding\.(auto_enroll_onboarding|stalled_flag|stalled_after_days|stalled_below_percent|staff_step_overrides)\./.test(key));
    expect(keys).toHaveLength(10);
    for (const key of keys) expect(catalogue.es[key], key).toEqual(expect.any(String));
  });
});

describe("onboarding oversight on the member-support desk", () => {
  it("flags the stalled member and lets staff complete, skip and reset", async () => {
    const client = clientFor();
    const region = await openOversight(client);
    const jordan = within(region).getByText("Jordan Member").closest("article");
    expect(jordan).toHaveClass("member-support-card--attention");
    expect(within(jordan).getByText("Stalled")).toBeInTheDocument();
    expect(within(jordan).getByText("Under 50% complete more than 14 days after onboarding was assigned")).toBeInTheDocument();
    expect(within(jordan).getByText("Enrolled automatically")).toBeInTheDocument();
    const alex = within(region).getByText("Alex Member").closest("article");
    expect(within(alex).queryByText("Stalled")).toBeNull();

    const complete = within(jordan).getByRole("button", { name: "Mark complete" });
    expect(complete).toBeDisabled();
    fireEvent.change(within(jordan).getByLabelText("Step for Jordan Member"), { target: { value: "step-2" } });
    fireEvent.click(complete);
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("staff_update_member_onboarding_plan", expect.objectContaining({ p_plan_id: "plan-3", p_action: "complete", p_step_id: "step-2" })));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Step marked complete."));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    const freshAlex = within(await screen.findByRole("region", { name: "Worker progress" })).getByText("Alex Member").closest("article");
    fireEvent.click(within(freshAlex).getByRole("button", { name: "Reset progress" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("staff_update_member_onboarding_plan", expect.objectContaining({ p_plan_id: "plan-2", p_action: "reset", p_step_id: null })));
    expect(window.confirm).toHaveBeenCalledWith("Reset all onboarding progress for Alex Member? This cannot be undone.");
  });

  it("hides the change controls and says why when the organization turned them off", async () => {
    const region = await openOversight(clientFor({ ...OVERSIGHT, staffOverridesEnabled: false }));
    expect(within(region).getByText("Staff changes to worker onboarding are turned off in Feature switches & limits.")).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Mark complete" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "Reset progress" })).toBeNull();
  });

  it("keeps the plain roster when the oversight read is unavailable", async () => {
    const client = clientFor();
    client.rpc.mockImplementation(async (name) => {
      if (name === "get_member_support_workspace") return { data: workspace(), error: null };
      if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
      return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    });
    render(<MemberSupportView actor={steward} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    fireEvent.click(screen.getByText("Manage program and oversight"));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("get_member_onboarding_oversight", undefined));
    expect(screen.getByText("1 of 2 steps complete")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Worker progress" })).toBeNull();
  });
});
