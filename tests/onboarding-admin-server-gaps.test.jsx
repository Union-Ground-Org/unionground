// REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104 (#7013): the admin
// onboarding desk on its three server pieces. By-chapter lines come only from
// the server's floored chapterSummary, a skip is sent only with a reason, and
// a stalled member gets one reminder a day unless they turned it off.
// Expected values are typed here, never worked out by the module.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberSupportView } from "../src/views/MemberSupportView.jsx";
import { MEMBER_ONBOARDING_OVERSIGHT_RPCS, normalizeOnboardingOversight } from "../src/features/memberSupport/index.js";
import {
  chapterProgressRows,
  onboardingReminderFailure,
  onboardingReminderState,
  skipReasonProblem,
} from "../src/features/onboardingGuideEngine/adminSide.js";
import { REMINDER_PREFERENCE_KEYS, updateMemberSettings } from "../src/lib/memberApi.js";
import { catalogue } from "../src/lib/i18n.js";

vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const steward = { userId: USER, selectedOrganizationId: ORG, membershipStatus: "active", selectedHat: "steward", organizationRoles: ["steward"], mfaSatisfied: true };
// Tuesday, November 3, 2026, 9:00 PM Eastern.
const NOW = Date.UTC(2026, 10, 4, 2);

function row(n, extra = {}) {
  return {
    planId: `plan-${n}`,
    memberUserId: `member-${n}`,
    memberLabel: `Person ${String(n).padStart(2, "0")}`,
    status: "in_progress",
    completedStepIds: ["step-1"],
    completedSteps: 1,
    percentComplete: 33,
    assignedAt: "2026-09-01T00:00:00Z",
    autoEnrolled: false,
    stalled: false,
    ...extra,
  };
}

const CHAPTERS = {
  floor: 25,
  withheld: false,
  chapters: [
    { chapterId: "north", name: "North campaign", enrolled: 40, notStarted: 10, inProgress: 22, completed: 8, stalled: 5 },
    // Under the floor: a server never sends it, and the desk drops it if one did.
    { chapterId: "tiny", name: "Tiny campaign", enrolled: 3, notStarted: 3, inProgress: 0, completed: 0, stalled: 0 },
  ],
  otherChapters: { enrolled: 30, notStarted: 12, inProgress: 12, completed: 6, stalled: 4 },
  withheldChapters: 2,
};

function payload(members, extra = {}) {
  return {
    state: "ready",
    organizationId: ORG,
    stalledFlagEnabled: true,
    stalledAfterDays: 14,
    stalledBelowPercent: 50,
    staffOverridesEnabled: true,
    autoEnrollEnabled: false,
    totalSteps: 3,
    steps: [1, 2, 3].map((n) => ({ id: `step-${n}`, title: `Step title ${n}`, position: n })),
    members,
    memberCount: members.length,
    chapterSummary: CHAPTERS,
    ...extra,
  };
}

describe("the oversight payload's new fields", () => {
  it("keeps only campaigns at the floor, the pooled line at the floor, known skipped steps and reminder state", () => {
    const normalized = normalizeOnboardingOversight(payload([
      row(1, {
        stalled: true,
        skippedSteps: [
          { stepId: "step-2", reason: "Trained at orientation.", skippedAt: "2026-11-02T15:00:00Z" },
          { stepId: "step-retired", reason: "Old step", skippedAt: "2026-11-02T15:00:00Z" },
          { stepId: "step-3", reason: 42 },
        ],
        reminderSentAt: "2026-11-03T20:00:00Z",
        reminderOptedOut: "yes",
      }),
    ]));
    expect(normalized.chapterSummary).toEqual({
      floor: 25,
      withheld: false,
      chapters: [{ chapterId: "north", name: "North campaign", enrolled: 40, notStarted: 10, inProgress: 22, completed: 8, stalled: 5 }],
      otherChapters: { enrolled: 30, notStarted: 12, inProgress: 12, completed: 6, stalled: 4 },
      withheldChapters: 2,
    });
    expect(normalized.members[0]).toMatchObject({
      skippedSteps: [{ stepId: "step-2", reason: "Trained at orientation.", skippedAt: "2026-11-02T15:00:00Z" }],
      reminderSentAt: "2026-11-03T20:00:00Z",
      reminderOptedOut: false,
    });
    const small = normalizeOnboardingOversight(payload([row(1)], { chapterSummary: { ...CHAPTERS, otherChapters: { enrolled: 24 } } }));
    expect(small.chapterSummary.otherChapters).toBeNull();
    expect(normalizeOnboardingOversight(payload([row(1)], { chapterSummary: undefined })).chapterSummary).toBeNull();
  });

  it("turns the summary into desk rows without counting anything itself", () => {
    expect(chapterProgressRows(normalizeOnboardingOversight(payload([row(1)])).chapterSummary)).toEqual({
      floor: 25,
      withheld: false,
      rows: [{ key: "north", name: "North campaign", enrolled: 40, notStarted: 10, inProgress: 22, completed: 8, stalled: 5, completedPercent: 20 }],
      other: { key: "other", name: null, enrolled: 30, notStarted: 12, inProgress: 12, completed: 6, stalled: 4, completedPercent: 20 },
      pooledChapters: 2,
    });
    expect(chapterProgressRows(null)).toBeNull();
  });
});

describe("reminder and skip rules on the desk side", () => {
  it("offers a reminder only for a stalled worker who has not opted out or had one today", () => {
    expect(onboardingReminderState(row(1), NOW)).toEqual({ state: "notStalled", nextAt: null });
    expect(onboardingReminderState(row(1, { stalled: true }), NOW)).toEqual({ state: "ready", nextAt: null });
    expect(onboardingReminderState(row(1, { stalled: true, reminderOptedOut: true }), NOW)).toEqual({ state: "optedOut", nextAt: null });
    expect(onboardingReminderState(row(1, { stalled: true, reminderSentAt: "2026-11-03T20:00:00Z" }), NOW))
      .toEqual({ state: "sentToday", nextAt: "2026-11-04T20:00:00.000Z" });
    expect(onboardingReminderState(row(1, { stalled: true, reminderSentAt: "2026-11-03T01:00:00Z" }), NOW)).toEqual({ state: "ready", nextAt: null });
  });

  it("names the server's refusals and the skip reason problems", () => {
    expect(onboardingReminderFailure({ code: "54000" })).toBe("rateLimited");
    expect(onboardingReminderFailure({ code: "55000" })).toBe("optedOut");
    expect(onboardingReminderFailure({ code: "42501" })).toBe("forbidden");
    expect(onboardingReminderFailure({ code: "08006" })).toBeNull();
    expect(skipReasonProblem("   ")).toBe("empty");
    expect(skipReasonProblem("x".repeat(501))).toBe("tooLong");
    expect(skipReasonProblem(` ${"x".repeat(500)} `)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// On the member-support desk.
// ---------------------------------------------------------------------------

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
    onboardingProgram: [1, 2, 3].map((n) => ({ id: `step-${n}`, title: `Step title ${n}`, description: "", position: n, active: true })),
    onboardingPlan: null,
    onboardingRoster: [],
    mentorshipPairs: [],
    mentorshipDirectory: [],
  };
}

function clientFor(oversight, { remindError = null } = {}) {
  return { rpc: vi.fn(async (name) => {
    if (name === "get_member_support_workspace") return { data: workspace(), error: null };
    if (name === MEMBER_ONBOARDING_OVERSIGHT_RPCS.load) return { data: oversight, error: null };
    if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
    if (name === MEMBER_ONBOARDING_OVERSIGHT_RPCS.remind && remindError) return { data: null, error: remindError };
    return { data: { id: "plan-1", status: "in_progress", completedStepIds: ["step-1"] }, error: null };
  }) };
}

async function openProgress(client) {
  render(<MemberSupportView actor={steward} client={client} guideSwitches={null} />);
  await screen.findByRole("heading", { name: "Emergency rights checklist" });
  fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
  fireEvent.click(screen.getByText("Manage program and oversight"));
  return screen.findByRole("region", { name: "Worker progress" });
}

const calls = (client, name) => client.rpc.mock.calls.filter(([called]) => called === name);

afterEach(() => vi.restoreAllMocks());

describe("Worker progress on the desk", () => {
  it("shows each campaign at the floor and the pooled line, and nothing for a withheld summary", async () => {
    const progress = await openProgress(clientFor(payload([row(1)])));
    await waitFor(() => expect(within(progress).getByText("By campaign")).toBeInTheDocument());
    expect(within(progress).getByText("North campaign").closest("li")).toHaveTextContent("North campaign 40 with a plan · 8 completed · 22 in progress · 10 not started · 5 stalled");
    expect(within(progress).getByText("Other campaigns and workers without a campaign").closest("li")).toHaveTextContent("30 with a plan · 6 completed · 12 in progress · 12 not started · 4 stalled");
    expect(within(progress).getByText("2 campaigns are counted together in that line, so no group under 25 plans can be singled out.")).toBeInTheDocument();
    expect(within(progress).queryByText("Tiny campaign")).toBeNull();
  });

  it("says when the server withheld every campaign", async () => {
    const progress = await openProgress(clientFor(payload([row(1)], { chapterSummary: { floor: 25, withheld: true, chapters: [], otherChapters: null, withheldChapters: 1 } })));
    await waitFor(() => expect(within(progress).getByText("Campaign counts show for a campaign once at least 25 of its workers have an onboarding plan.")).toBeInTheDocument());
    expect(within(progress).queryByText(/with a plan ·/)).toBeNull();
  });

  it("sends a skip only with a reason and shows stored reasons read-only", async () => {
    const client = clientFor(payload([row(1, { skippedSteps: [{ stepId: "step-1", reason: "Covered at orientation.", skippedAt: "2026-11-02T15:00:00Z" }] })]));
    const progress = await openProgress(client);
    await waitFor(() => expect(within(progress).getByText("Skipped steps")).toBeInTheDocument());
    expect(within(progress).getByText("Step title 1").closest("li")).toHaveTextContent("Step title 1: Covered at orientation.");
    fireEvent.change(within(progress).getByLabelText("Step for Person 01"), { target: { value: "step-2" } });
    fireEvent.click(within(progress).getByRole("button", { name: "Skip step" }));
    const reason = within(progress).getByLabelText("Why skip Step title 2?");
    fireEvent.change(reason, { target: { value: "   " } });
    fireEvent.click(within(progress).getByRole("button", { name: "Skip with this reason" }));
    expect(within(progress).getByText("Write a reason first.")).toBeInTheDocument();
    expect(calls(client, MEMBER_ONBOARDING_OVERSIGHT_RPCS.update)).toHaveLength(0);
    fireEvent.change(reason, { target: { value: " Already a committee worker. " } });
    fireEvent.click(within(progress).getByRole("button", { name: "Skip with this reason" }));
    await waitFor(() => expect(calls(client, MEMBER_ONBOARDING_OVERSIGHT_RPCS.update)).toHaveLength(1));
    expect(calls(client, MEMBER_ONBOARDING_OVERSIGHT_RPCS.update)[0][1]).toMatchObject({ p_plan_id: "plan-1", p_action: "skip", p_step_id: "step-2", p_reason: "Already a committee worker." });
  });

  it("sends one reminder to a stalled worker and explains the refusals", async () => {
    const client = clientFor(payload([
      row(1, { stalled: true }),
      row(2, { stalled: true, reminderOptedOut: true }),
      row(3, { stalled: true, reminderSentAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
      row(4),
    ]));
    const progress = await openProgress(client);
    const send = await within(progress).findByRole("button", { name: "Send Person 01 a reminder" });
    expect(within(progress).getByRole("button", { name: "Send Person 02 a reminder" })).toBeDisabled();
    expect(within(progress).getByRole("button", { name: "Send Person 02 a reminder" })).toHaveAccessibleDescription("This worker turned off onboarding reminders.");
    expect(within(progress).getByRole("button", { name: "Send Person 03 a reminder" })).toBeDisabled();
    expect(within(progress).getByRole("button", { name: "Send Person 03 a reminder" })).toHaveAccessibleDescription(/^A reminder went out in the last day\. The next one can go after /);
    expect(within(progress).queryByRole("button", { name: "Send Person 04 a reminder" })).toBeNull();
    fireEvent.click(send);
    await waitFor(() => expect(calls(client, MEMBER_ONBOARDING_OVERSIGHT_RPCS.remind)).toHaveLength(1));
    expect(calls(client, MEMBER_ONBOARDING_OVERSIGHT_RPCS.remind)[0][1]).toEqual({ p_plan_id: "plan-1", p_idempotency_key: expect.any(String) });
    expect(await screen.findByText("Reminder sent.")).toBeInTheDocument();
  });

  it("says plainly when the server rate-limits a reminder", async () => {
    const client = clientFor(payload([row(1, { stalled: true })]), { remindError: { code: "54000", message: "onboarding reminder limit reached: 1 per worker per day" } });
    const progress = await openProgress(client);
    fireEvent.click(await within(progress).findByRole("button", { name: "Send Person 01 a reminder" }));
    expect(await screen.findByText("This worker already got a reminder in the last day.")).toBeInTheDocument();
  });
});

describe("the worker's onboarding reminder switch", () => {
  it("is written only when the worker sends it", async () => {
    expect(REMINDER_PREFERENCE_KEYS).toEqual(["onboarding"]);
    // Settings saves go through update_my_member_profile (#7026); update
    // records the fields each save sends.
    const update = vi.fn();
    const client = { rpc: vi.fn(async (name, args) => {
      expect(name).toBe("update_my_member_profile");
      expect(args.p_expected_user_id).toBe(USER);
      update(args.p_fields);
      return { data: null, error: null };
    }) };
    await updateMemberSettings(client, USER, { notificationPrefs: { deadlines: false } });
    expect(update.mock.calls[0][0].notification_prefs).not.toHaveProperty("onboarding");
    await updateMemberSettings(client, USER, { notificationPrefs: { onboarding: false } });
    expect(update.mock.calls[1][0].notification_prefs).toMatchObject({ onboarding: false });
  });

  it("has English and Spanish copy", () => {
    for (const key of ["settings.topicOnboarding", "settings.topicOnboardingSub"]) {
      expect(catalogue.en[key], key).toEqual(expect.any(String));
      expect(catalogue.es[key], key).toEqual(expect.any(String));
      expect(catalogue.es[key], key).not.toBe(catalogue.en[key]);
    }
  });
});
