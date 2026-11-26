// REQ-UG-LOVABLE-ADMIN-ONBOARDING-BATCH-D-GAP-20261103: the
// organization side of member onboarding (Batch D port order item 3):
// Onboarding setup, Member progress and Preview as member, on the existing
// save_organization_onboarding_step and get_member_onboarding_oversight RPCs.
// Expected values are typed here, never worked out by the module.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberSupportView } from "../src/views/MemberSupportView.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { catalogue } from "../src/lib/i18n.js";
import { onboardingAdminCatalogue } from "../src/lib/i18n/onboardingAdmin.js";
import { MEMBER_ONBOARDING_OVERSIGHT_RPCS, normalizeOnboardingOversight } from "../src/features/memberSupport/index.js";
import {
  ONBOARDING_PROGRESS_FLOOR,
  applyStepMove,
  filterProgressMembers,
  guideSwitchFields,
  memberPreview,
  nextStepPosition,
  onboardingProgressSummary,
  previewStages,
  programInOrder,
  programSummary,
  progressFilterCounts,
  stepMove,
} from "../src/features/onboardingGuideEngine/adminSide.js";

vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));

// Monday, October 19, 2026, 9:00 AM Eastern.
const NOW = Date.UTC(2026, 9, 19, 13);
const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const steward = { userId: USER, selectedOrganizationId: ORG, membershipStatus: "active", selectedHat: "steward", organizationRoles: ["steward"], mfaSatisfied: true };
const step = (n, extra = {}) => ({ id: `step-${n}`, title: `Step title ${n}`, description: `About step ${n}`, position: n, active: true, ...extra });
const SIX = [1, 2, 3, 4, 5, 6].map((n) => step(n));
const SWITCHES_ON = {
  "features.guidance_onboarding.feature_drip": true,
  "features.guidance_onboarding.hud_tooltips": true,
  "features.guidance_onboarding.spotlight": true,
  "features.guidance_onboarding.progressive_disclosure": true,
  "features.guidance_onboarding.badge_achievements": true,
};
const SWITCHES_OFF = Object.fromEntries(Object.keys(SWITCHES_ON).map((key) => [key, false]));

function row(n, status, done, extra = {}) {
  return {
    planId: `plan-${n}`,
    memberUserId: `member-${n}`,
    memberLabel: `Person ${String(n).padStart(2, "0")}`,
    status,
    completedStepIds: done,
    completedSteps: done.length,
    percentComplete: Math.floor((done.length * 100) / 3),
    assignedAt: "2026-09-01T00:00:00Z",
    autoEnrolled: false,
    stalled: false,
    ...extra,
  };
}

// Twelve plans over three active steps: 2 not started, 7 in progress, 3 done.
const TWELVE = [
  row(1, "not_started", []),
  row(2, "not_started", [], { stalled: true }),
  row(3, "in_progress", ["step-1"]),
  row(4, "in_progress", ["step-1"]),
  row(5, "in_progress", ["step-1"], { stalled: true }),
  row(6, "in_progress", ["step-1"]),
  row(7, "in_progress", ["step-1", "step-2"]),
  row(8, "in_progress", ["step-1", "step-2"]),
  row(9, "in_progress", ["step-1", "step-2"]),
  row(10, "completed", ["step-1", "step-2", "step-3"]),
  row(11, "completed", ["step-1", "step-2", "step-3"]),
  row(12, "completed", ["step-1", "step-2", "step-3"]),
];

function oversightPayload(members = TWELVE, extra = {}) {
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
    ...extra,
  };
}

describe("Onboarding setup: order, moves and the step summary", () => {
  it("orders every step, active or not, by position then id", () => {
    const steps = [step(3), step(1, { active: false }), { ...step(2), position: 1, id: "a-first" }];
    expect(programInOrder(steps).map((item) => item.id)).toEqual(["a-first", "step-1", "step-3"]);
    expect(programInOrder(null)).toEqual([]);
  });

  it("puts a new step after the last one, or in a free position when the last is 1000", () => {
    expect(nextStepPosition([])).toBe(1);
    expect(nextStepPosition([step(1), step(7, { active: false })])).toBe(8);
    expect(nextStepPosition([step(1), { ...step(2), position: 1000 }])).toBe(999);
  });

  it("moves a step past its neighbour in three saves through a free position", () => {
    const move = stepMove([step(1), step(2), step(3)], "step-2", "up");
    expect(move).toEqual({
      ok: true,
      writes: [
        { stepId: "step-2", title: "Step title 2", description: "About step 2", position: 1000, active: true },
        { stepId: "step-1", title: "Step title 1", description: "About step 1", position: 2, active: true },
        { stepId: "step-2", title: "Step title 2", description: "About step 2", position: 1, active: true },
      ],
      originals: {
        "step-2": { stepId: "step-2", title: "Step title 2", description: "About step 2", position: 2, active: true },
        "step-1": { stepId: "step-1", title: "Step title 1", description: "About step 1", position: 1, active: true },
      },
    });
    const down = stepMove([step(1), step(2, { active: false }), step(3)], "step-2", "down");
    expect(down.ok && down.writes.map((write) => [write.stepId, write.position, write.active])).toEqual([
      ["step-2", 1000, false], ["step-3", 2, true], ["step-2", 3, false],
    ]);
  });

  // BUG-UG-ONBOARDING-STEP-REORDER-PARTIAL-SAVE-20261104: A, B, C at
  // 1, 2, 3; Move up on B. A fake server keeps the real positions.
  function fakeServer(failAt = null, { failRestore = false } = {}) {
    const positions = { "step-1": 1, "step-2": 2, "step-3": 3 };
    const calls = [];
    const save = vi.fn(async (write) => {
      calls.push([write.stepId, write.position]);
      const isRestore = calls.length > 3 || (failAt !== null && calls.length > failAt);
      if (calls.length === failAt || (failRestore && isRestore)) throw new Error("network");
      if (Object.entries(positions).some(([id, at]) => id !== write.stepId && at === write.position)) throw new Error("onboarding position already in use");
      positions[write.stepId] = write.position;
    });
    const order = () => Object.entries(positions).sort((a, b) => a[1] - b[1]).map(([id]) => id);
    return { save, calls, positions, order };
  }
  const B_UP = () => stepMove([step(1), step(2), step(3)], "step-2", "up");

  it("lands a whole move when every save succeeds", async () => {
    const server = fakeServer();
    await applyStepMove(B_UP(), server.save);
    expect(server.calls).toEqual([["step-2", 1000], ["step-1", 2], ["step-2", 1]]);
    expect(server.order()).toEqual(["step-2", "step-1", "step-3"]);
  });

  it("puts the old order back when the second save fails, and says so", async () => {
    const server = fakeServer(2);
    const failure = await applyStepMove(B_UP(), server.save).catch((error) => error);
    expect(failure).toMatchObject({ code: "ONBOARDING_STEP_MOVE_FAILED", restored: true });
    expect(failure.cause.message).toBe("network");
    expect(server.calls).toEqual([["step-2", 1000], ["step-1", 2], ["step-2", 2]]);
    expect(server.positions).toEqual({ "step-1": 1, "step-2": 2, "step-3": 3 });
  });

  it("puts the old order back when the last save fails, neighbour first so no position collides", async () => {
    const server = fakeServer(3);
    const failure = await applyStepMove(B_UP(), server.save).catch((error) => error);
    expect(failure.restored).toBe(true);
    expect(server.calls.slice(3)).toEqual([["step-1", 1], ["step-2", 2]]);
    expect(server.positions).toEqual({ "step-1": 1, "step-2": 2, "step-3": 3 });
  });

  it("writes nothing back when the first save fails, and reports a restore that failed", async () => {
    const first = fakeServer(1);
    expect(await applyStepMove(B_UP(), first.save).catch((error) => error)).toMatchObject({ restored: true });
    expect(first.calls).toEqual([["step-2", 1000]]);
    const stuck = fakeServer(2, { failRestore: true });
    expect(await applyStepMove(B_UP(), stuck.save).catch((error) => error)).toMatchObject({ code: "ONBOARDING_STEP_MOVE_FAILED", restored: false });
    expect(stuck.positions["step-2"]).toBe(1000);
  });

  it("refuses the ends and an unknown step with a reason", () => {
    expect(stepMove(SIX, "step-1", "up")).toEqual({ ok: false, reason: "first" });
    expect(stepMove(SIX, "step-6", "down")).toEqual({ ok: false, reason: "last" });
    expect(stepMove(SIX, "nope", "up")).toEqual({ ok: false, reason: "missing" });
  });

  it("names the Momentum point only when a step lies between it and the end", () => {
    expect(programSummary([])).toEqual({ active: 0, momentum: null });
    expect(programSummary([step(1), step(2)])).toEqual({ active: 2, momentum: null });
    expect(programSummary([step(1), step(2), step(3)])).toEqual({ active: 3, momentum: 2 });
    expect(programSummary([...SIX, step(7, { active: false })])).toEqual({ active: 6, momentum: 2 });
    expect(programSummary([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => step(n)))).toEqual({ active: 9, momentum: 3 });
  });
});

describe("Worker progress: totals from the oversight rows, behind the floor", () => {
  it("keeps the floor at 10 plans", () => {
    expect(ONBOARDING_PROGRESS_FLOOR).toBe(10);
  });

  it("counts statuses, stalled rows and each step's completions", () => {
    const summary = onboardingProgressSummary(normalizeOnboardingOversight(oversightPayload()));
    expect(summary.withheld).toBe(false);
    expect(summary.partial).toBe(false);
    expect(summary.tiles).toEqual({ enrolled: 12, notStarted: 2, inProgress: 7, completed: 3, stalled: 2 });
    expect(summary.steps).toEqual([
      { id: "step-1", title: "Step title 1", done: 10, percent: 83 },
      { id: "step-2", title: "Step title 2", done: 6, percent: 50 },
      { id: "step-3", title: "Step title 3", done: 3, percent: 25 },
    ]);
    // Titles, not active-only numbers, which could name a different step in Onboarding setup.
    expect(summary.biggestDrop).toEqual({ from: "Step title 1", to: "Step title 2", people: 4 });
  });

  it("withholds every total below the floor", () => {
    const summary = onboardingProgressSummary(normalizeOnboardingOversight(oversightPayload(TWELVE.slice(0, 9))));
    expect(summary).toEqual({ withheld: true, floor: 10, counted: 9, enrolled: 9, partial: false, tiles: null, steps: [], biggestDrop: null });
  });

  it("shows no totals for a roster cut at the server's limit", () => {
    const summary = onboardingProgressSummary(normalizeOnboardingOversight(oversightPayload(TWELVE, { memberCount: 640 })));
    expect(summary).toEqual({ withheld: false, floor: 10, counted: 12, enrolled: 640, partial: true, tiles: null, steps: [], biggestDrop: null });
  });

  it("leaves Stalled out when the flag is off", () => {
    const summary = onboardingProgressSummary(normalizeOnboardingOversight(oversightPayload(TWELVE, { stalledFlagEnabled: false })));
    expect(summary.tiles.stalled).toBeNull();
  });

  it("filters the roster by chip and by name", () => {
    expect(progressFilterCounts(TWELVE)).toEqual({ all: 12, stalled: 2, not_started: 2, in_progress: 7, completed: 3 });
    expect(filterProgressMembers(TWELVE, { filter: "stalled" }).map((item) => item.planId)).toEqual(["plan-2", "plan-5"]);
    expect(filterProgressMembers(TWELVE, { filter: "completed", query: "person 11" }).map((item) => item.planId)).toEqual(["plan-11"]);
    expect(filterProgressMembers(TWELVE, { query: "  PERSON 0" })).toHaveLength(9);
    // Accents are ignored both ways, as in the command palette.
    const named = [row(1, "in_progress", [], { memberLabel: "José Álvarez" }), row(2, "in_progress", [], { memberLabel: "Jose Alvarez" })];
    expect(filterProgressMembers(named, { query: "jose alv" })).toHaveLength(2);
    expect(filterProgressMembers(named, { query: "JOSÉ" })).toHaveLength(2);
  });
});

describe("Preview as member: client only, from the organization's own steps and switches", () => {
  it("maps the five switches from their setting keys", () => {
    expect(guideSwitchFields({ "features.guidance_onboarding.spotlight": true, "features.guidance_onboarding.badge_achievements": "yes" })).toEqual({
      featureDrip: false, hudTooltips: false, spotlight: true, progressiveDisclosure: false, badgeAchievements: false,
    });
  });

  it("offers In progress only when a step lies past the Momentum point", () => {
    expect(previewStages([])).toEqual(["welcome", "complete"]);
    expect(previewStages([step(1), step(2)])).toEqual(["welcome", "complete"]);
    expect(previewStages([step(1), step(2), step(3)])).toEqual(["welcome", "activate", "complete"]);
  });

  it("shows the worker card for each stage the way the shell would", () => {
    const welcome = memberPreview({ steps: SIX, switches: SWITCHES_ON, stage: "welcome", now: NOW });
    expect(welcome).toMatchObject({ stage: "welcome", total: 6, done: 0, spotlight: "member-support", reason: null });
    expect(welcome.card).toMatchObject({ titleKey: "onboardingGuide.welcomeTitleDrip", badge: "new_member", nextStepTitle: "Step title 1", params: { completed: 0, total: 6 } });
    expect(welcome.steps.map((item) => item.state)).toEqual(["next", "todo", "todo", "todo", "todo", "todo"]);

    const activate = memberPreview({ steps: SIX, switches: SWITCHES_ON, stage: "activate", now: NOW });
    expect(activate.card).toMatchObject({ titleKey: "onboardingGuide.activateTitleDrip", badge: "momentum", nextStepTitle: "Step title 3", params: { completed: 2, total: 6 } });
    expect(activate.steps.map((item) => item.state)).toEqual(["done", "done", "next", "todo", "todo", "todo"]);

    const complete = memberPreview({ steps: SIX, switches: SWITCHES_ON, stage: "complete", now: NOW });
    expect(complete).toMatchObject({ stage: "complete", done: 6, spotlight: "events" });
    expect(complete.card).toMatchObject({ titleKey: "onboardingGuide.completeTitle", badge: "ready_to_roll", dismissable: true });
  });

  it("previews active steps only and says why there is no card", () => {
    const withOff = memberPreview({ steps: [...SIX, step(7, { active: false, title: "Turned off" })], switches: SWITCHES_ON, stage: "welcome", now: NOW });
    expect(withOff.total).toBe(6);
    expect(withOff.steps.map((item) => item.title)).not.toContain("Turned off");
    expect(memberPreview({ steps: [], switches: SWITCHES_ON, stage: "welcome", now: NOW })).toMatchObject({ reason: "noSteps", card: null });
    expect(memberPreview({ steps: SIX, switches: SWITCHES_OFF, stage: "welcome", now: NOW })).toMatchObject({ reason: "switchesOff", card: null });
    expect(memberPreview({ steps: SIX, switches: null, stage: "welcome", now: NOW })).toMatchObject({ reason: "switchesUnknown", card: null });
    const spotlightOnly = { ...SWITCHES_OFF, "features.guidance_onboarding.spotlight": true };
    expect(memberPreview({ steps: SIX, switches: spotlightOnly, stage: "welcome", now: NOW })).toMatchObject({ reason: "noCard", card: null, spotlight: "member-support" });
  });

  it("reads no worker, clock, storage, DOM or network", () => {
    const source = readFileSync(resolve(process.cwd(), "src/features/onboardingGuideEngine/adminSide.js"), "utf8");
    expect(source).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|localStorage|sessionStorage|window\.|document\.|fetch\(|\.rpc\(/);
    // The preview's own code never touches a roster row.
    expect(String(memberPreview)).not.toMatch(/member(?:UserId|Label|s\b)|oversight|planId/);
    const input = { steps: SIX, switches: SWITCHES_ON, stage: "activate", now: NOW };
    const before = JSON.stringify(input);
    expect(memberPreview(input)).toEqual(memberPreview(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("the admin side's copy", () => {
  const { en, es } = onboardingAdminCatalogue;
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it("ships every line in English and Spanish, in both barrels, with the same placeholders", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(en)) {
      expect(key.startsWith("onboardingAdmin."), key).toBe(true);
      expect(placeholders(es[key]), key).toEqual(placeholders(text));
      for (const line of [text, es[key]]) expect(line, key).not.toMatch(/\bhats?\b|\b509\b|Tamarack|555-0142/iu);
      expect(catalogue.en[key], key).toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------
// The three pieces on the member-support desk.
// ---------------------------------------------------------------------------

function workspace(program = [step(1), step(2), step(3)]) {
  return {
    state: "ready",
    organizationId: ORG,
    staff: true,
    emergencyChecklists: [],
    accommodations: [],
    accommodationSummary: { total: 0, open: 0, approved: 0, denied: 0, withdrawn: 0 },
    hrDirectory: null,
    hrContacts: [],
    onboardingProgram: program,
    onboardingPlan: null,
    onboardingRoster: [],
    mentorshipPairs: [],
    mentorshipDirectory: [],
  };
}

function clientFor({ program, oversight = oversightPayload(), failSaves = [] } = {}) {
  let saves = 0;
  return { rpc: vi.fn(async (name) => {
    if (name === "get_member_support_workspace") return { data: workspace(program), error: null };
    if (name === "save_organization_onboarding_step") {
      saves += 1;
      if (failSaves.includes(saves)) return { data: null, error: { message: "network", code: "08006" } };
    }
    if (name === MEMBER_ONBOARDING_OVERSIGHT_RPCS.load) return { data: oversight, error: null };
    if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
    return { data: { id: "step-2", position: 1, active: true }, error: null };
  }) };
}

async function openDesk(client, guideSwitches = SWITCHES_ON) {
  render(<MemberSupportView actor={steward} client={client} guideSwitches={guideSwitches} />);
  await screen.findByRole("heading", { name: "Emergency rights checklist" });
  fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
  fireEvent.click(screen.getByText("Manage program and oversight"));
}

const workspaceReads = (client) => client.rpc.mock.calls.filter(([name]) => name === "get_member_support_workspace").length;
const writes = (client) => client.rpc.mock.calls.filter(([name]) => name !== "get_member_support_workspace" && name !== MEMBER_ONBOARDING_OVERSIGHT_RPCS.load && name !== "list_member_handoffs_v2");

afterEach(() => vi.restoreAllMocks());

describe("Onboarding setup on the desk", () => {
  it("lists the steps in order with the Momentum line and the five switches", async () => {
    await openDesk(clientFor());
    const setup = screen.getByRole("region", { name: "Onboarding setup" });
    expect(within(setup).getByText("3 active steps. The guide's Momentum point comes after 2 of them.")).toBeInTheDocument();
    expect(within(setup).getByRole("button", { name: "Move step Step title 1 up" })).toBeDisabled();
    expect(within(setup).getByRole("button", { name: "Move step Step title 1 up" })).toHaveAccessibleDescription("Already first.");
    expect(within(setup).getByRole("button", { name: "Move step Step title 3 down" })).toHaveAccessibleDescription("Already last.");
    expect(within(setup).getByText("Guided navigation for new workers")).toBeInTheDocument();
    expect(within(setup).getByText("Change these in Feature switches & limits.")).toBeInTheDocument();
    expect(within(setup).getByLabelText("Position")).toHaveValue(4);
  });

  it("moves a step through save_organization_onboarding_step and never another RPC, then reloads", async () => {
    const client = clientFor();
    await openDesk(client);
    const before = workspaceReads(client);
    fireEvent.click(screen.getByRole("button", { name: "Move step Step title 2 up" }));
    await screen.findByText("Step order saved.");
    await waitFor(() => expect(workspaceReads(client)).toBe(before + 1));
    expect(writes(client).map(([name, args]) => [name, args.p_step_id, args.p_position, args.p_title])).toEqual([
      ["save_organization_onboarding_step", "step-2", 1000, "Step title 2"],
      ["save_organization_onboarding_step", "step-1", 2, "Step title 1"],
      ["save_organization_onboarding_step", "step-2", 1, "Step title 2"],
    ]);
  });

  // BUG-UG-ONBOARDING-STEP-REORDER-PARTIAL-SAVE-20261104.
  it("puts the old order back when a later save fails, says so, and reloads the desk", async () => {
    const client = clientFor({ failSaves: [2] });
    await openDesk(client);
    const before = workspaceReads(client);
    fireEvent.click(screen.getByRole("button", { name: "Move step Step title 2 up" }));
    await screen.findByText("The new order didn't save, so the steps are back in their old order. Try again.");
    expect(writes(client).map(([, args]) => [args.p_step_id, args.p_position])).toEqual([
      ["step-2", 1000], ["step-1", 2], ["step-2", 2],
    ]);
    await waitFor(() => expect(workspaceReads(client)).toBe(before + 1));
  });

  it("says plainly when the old order could not be put back, and still reloads", async () => {
    const client = clientFor({ failSaves: [2, 3] });
    await openDesk(client);
    const before = workspaceReads(client);
    fireEvent.click(screen.getByRole("button", { name: "Move step Step title 2 up" }));
    await screen.findByText(/the old order couldn't be put back/);
    await waitFor(() => expect(workspaceReads(client)).toBe(before + 1));
  });

  // Record 8435: a step's controls stay focusable while the desk's commit
  // writes, and a second move is refused while the first runs.
  it("keeps Move up focused while the new order is saved, and starts one move", async () => {
    const client = clientFor();
    await openDesk(client);
    const saves = () => client.rpc.mock.calls.filter(([name]) => name === "save_organization_onboarding_step").length;
    await expectHeldWriteFocus(client.rpc, screen.getByRole("button", { name: "Move step Step title 2 up" }));
    await screen.findByText("Step order saved.");
    expect(saves()).toBe(3);
  });

  it("edits a step's words in place and keeps its position and state", async () => {
    const client = clientFor();
    await openDesk(client);
    fireEvent.click(screen.getByRole("button", { name: "Edit step Step title 3" }));
    const setup = screen.getByRole("region", { name: "Onboarding setup" });
    const titles = within(setup).getAllByLabelText("Step title");
    fireEvent.change(titles[0], { target: { value: "Read the worker guide" } });
    fireEvent.click(within(setup).getByRole("button", { name: "Save step" }));
    await screen.findByText("Onboarding step saved.");
    const [[name, args]] = writes(client);
    expect(name).toBe("save_organization_onboarding_step");
    expect(args).toMatchObject({ p_step_id: "step-3", p_title: "Read the worker guide", p_description: "About step 3", p_position: 3, p_active: true });
  });
});

describe("Preview as worker on the desk", () => {
  it("shows the worker card from the organization's steps, changes stage, and writes nothing", async () => {
    const client = clientFor();
    await openDesk(client);
    const preview = screen.getByRole("region", { name: "Preview as worker" });
    expect(within(preview).getByText(/Preview only\./)).toBeInTheDocument();
    expect(within(preview).getByRole("heading", { name: "Start with one clear next step" })).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: "In progress" }));
    expect(within(preview).getByRole("heading", { name: "Keep the momentum going" })).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: "Open onboarding" }));
    expect(within(preview).getByRole("status")).toHaveTextContent("For a worker, this opens Worker support.");
    fireEvent.click(within(preview).getByRole("button", { name: "Complete" }));
    expect(within(preview).getAllByText("Done")).toHaveLength(3);
    // Never another member's data: no roster name reaches the preview.
    expect(preview.textContent).not.toMatch(/Person \d/);
    expect(writes(client)).toEqual([]);
  });

  it("explains a missing card when every guide switch is off", async () => {
    await openDesk(clientFor(), SWITCHES_OFF);
    const preview = screen.getByRole("region", { name: "Preview as worker" });
    expect(within(preview).getByText(/Every guide switch is off/)).toBeInTheDocument();
    expect(within(preview).queryByRole("heading", { name: "Start with one clear next step" })).toBeNull();
  });
});

describe("Worker progress on the desk", () => {
  it("shows the totals, where people stop, and filters the roster", async () => {
    await openDesk(clientFor());
    const progress = await screen.findByRole("region", { name: "Worker progress" });
    await waitFor(() => expect(within(progress).getByText("How it's going")).toBeInTheDocument());
    expect(within(progress).getByText("Step title 1: 10 of 12 done (83%)")).toBeInTheDocument();
    expect(within(progress).getByText("Biggest drop: from Step title 1 to Step title 2 (4 people)")).toBeInTheDocument();
    const tile = within(progress).getByText("Stalled", { selector: "dt" }).closest("div");
    expect(tile).toHaveTextContent("2");
    fireEvent.click(within(progress).getByRole("button", { name: "Completed · 3" }));
    expect(within(progress).getByText("Person 10")).toBeInTheDocument();
    expect(within(progress).queryByText("Person 03")).toBeNull();
    fireEvent.change(within(progress).getByLabelText("Find a worker"), { target: { value: "person 12" } });
    expect(within(progress).getByText("Person 12")).toBeInTheDocument();
    expect(within(progress).queryByText("Person 10")).toBeNull();
  });

  it("names each worker's next step and holds the totals back below the floor", async () => {
    await openDesk(clientFor({ oversight: oversightPayload(TWELVE.slice(0, 4)) }));
    const progress = await screen.findByRole("region", { name: "Worker progress" });
    await waitFor(() => expect(within(progress).getByText("Totals and step counts show once at least 10 workers have an onboarding plan. Now: 4.")).toBeInTheDocument());
    expect(within(progress).queryByText("How it's going")).toBeNull();
    expect(within(progress).getAllByText("Next step: Step title 2")).toHaveLength(2);
    // The chips are totals too, so they lose their counts below the floor.
    expect(within(progress).getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(within(progress).getByRole("button", { name: "Not started" })).toBeInTheDocument();
    expect(within(progress).queryByRole("button", { name: /·/ })).toBeNull();
  });

  it("shows no totals or chip counts for a roster cut at the server's limit", async () => {
    await openDesk(clientFor({ oversight: oversightPayload(TWELVE, { memberCount: 640 }) }));
    const progress = await screen.findByRole("region", { name: "Worker progress" });
    await waitFor(() => expect(within(progress).getByText("Totals and step counts show only when every plan is listed here.")).toBeInTheDocument());
    expect(within(progress).getByText("Showing 12 of 640 workers.")).toBeInTheDocument();
    expect(within(progress).queryByText("How it's going")).toBeNull();
    expect(within(progress).queryByRole("button", { name: /·/ })).toBeNull();
  });
});
