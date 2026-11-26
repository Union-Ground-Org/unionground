// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP1-20261022: the guide
// engine ported from the Batch E prototype, in "The product today" mode.
// Expected values are typed here, never worked out by the engine. The golden
// fixtures G1 to G5 are built by memberServer.js from raw steps, plan and
// switches (the server's formulas), then compared with the engine's payload.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { guideEngineCatalogue } from "../src/lib/i18n/guideEngine.js";
import { GUIDE_COPY_EN } from "../apps/mobile/src/features/guideLayers/guideCopy.ts";
import { INACTIVE_GUIDE, ONBOARDING_CORE_NAV_KEYS, ONBOARDING_GUIDE_REFRESH_EVENT, normalizeOnboardingGuide } from "../src/lib/onboardingGuide.js";
import { createMemberSupportAdapter } from "../src/features/memberSupport/adapter.js";
import { GUIDE_ENGINE_MODE, GUIDE_ENGINE_RULES, plan } from "../src/features/onboardingGuideEngine/engine.js";
import {
  GUIDE_SWITCHES,
  PARITY_FIELDS,
  UNAVAILABLE_GUIDE_PAYLOAD,
  activeStepsInOrder,
  buildMemberGuidePayload,
  computeMemberOnly,
  momentumMark,
  payloadDifferences,
} from "../src/features/onboardingGuideEngine/memberServer.js";
import {
  GUIDE_ENGINE_READS,
  GUIDE_ENGINE_WRITES,
  loadGuideEngineReads,
  performGuideAction,
  renderGuideCopy,
} from "../src/features/onboardingGuideEngine/memberAdapter.js";

const DAY = 86_400_000;
// Monday, October 19, 2026, 9:00 AM Eastern.
const NOW = Date.UTC(2026, 9, 19, 13);
const ORG = "10000000-0000-4000-8000-000000000001";
const TITLES = ["Finish your profile", "Meet your committee contact", "Read the worker guide", "Ask the Guide a question", "Answer an meeting invitation", "Choose your notifications"];
const stepId = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const STEPS = TITLES.map((title, index) => ({ id: stepId(index + 1), title, description: "", position: (index + 1) * 10, active: true }));
const ALL_ON = { featureDrip: true, hudTooltips: true, spotlight: true, progressiveDisclosure: true, badgeAchievements: true };
const ALL_OFF = { featureDrip: false, hudTooltips: false, spotlight: false, progressiveDisclosure: false, badgeAchievements: false };

// organizationConfiguration.switches, keyed the way the member read carries them.
function configSwitches(switches, extra = {}) {
  return { ...Object.fromEntries(GUIDE_SWITCHES.map(({ field, key }) => [key, switches[field] === true])), "features.home.onboarding_nudge": true, ...extra };
}

// get_member_home_nudges' rule for its onboarding half.
function nudgesFor(guide, planRow, { nudgeSwitch = true, snoozeDays = 28 } = {}) {
  const guided = guide.progressiveDisclosureActive === true || (guide.showHud === true && guide.onboardingComplete === false);
  if (guided) return { passkey: false, onboarding: null, guidedFirstRun: true, snoozeDays };
  const open = nudgeSwitch && guide.establishedMember !== true && planRow && planRow.status !== "completed" && guide.totalSteps > 0 && guide.completedSteps < guide.totalSteps;
  return { passkey: false, onboarding: open ? { completed: guide.completedSteps, total: guide.totalSteps } : null, guidedFirstRun: false, snoozeDays };
}

function scenario({ done = [], status, enrolled = true, switches = ALL_ON, memberOnly = true, steps = STEPS, nudgeSwitch = true, snoozeDays = 28, establishedMember = false, ...rest } = {}) {
  const planRow = enrolled ? { id: "plan-1", status: status ?? (done.length ? "in_progress" : "not_started"), completedStepIds: done } : null;
  const guide = buildMemberGuidePayload({ organizationId: ORG, memberOnly, steps, plan: planRow, switches, establishedMember });
  return {
    now: NOW,
    guide,
    workspace: { onboardingProgram: steps.filter((step) => step.active !== false), onboardingPlan: planRow },
    nudges: nudgesFor(guide, planRow, { nudgeSwitch, snoozeDays }),
    nudgesState: "ready",
    switches: configSwitches(switches, { "features.home.onboarding_nudge": nudgeSwitch }),
    ...rest,
  };
}

const why = (view, rule) => view.decisions.find((decision) => decision.rule === rule).why;

// Every { key } an engine view carries, including keys nested in params.
function keysIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => keysIn(item, found));
  else if (value && typeof value === "object") {
    if (typeof value.key === "string") found.add(value.key);
    for (const [name, item] of Object.entries(value)) {
      if (typeof item === "string" && /Key$/.test(name)) found.add(item);
      else keysIn(item, found);
    }
  }
  return found;
}

describe("golden fixtures: the server's formulas, then the engine's payload", () => {
  it("G1: 6 active steps, 2 done, all switches on", () => {
    const input = scenario({ done: [stepId(1), stepId(2)] });
    expect(input.guide).toMatchObject({ state: "ready", applies: true, stage: "activate", badge: "momentum", completedSteps: 2, totalSteps: 6, nextStep: { id: stepId(3), title: "Read the worker guide" } });
    const view = plan(input);
    expect(view.legacy).toEqual(normalizeOnboardingGuide(input.guide));
    expect(view.parity).toEqual({ checked: true, differences: [], unchecked: ["memberOnly"] });
    expect(view.stage).toBe("activate");
    expect(view.badge).toBe("momentum");
  });

  it("G2: a completed plan stays complete when a 7th step is added", () => {
    const seven = [...STEPS, { id: stepId(7), title: "Say hello to your campaign", description: "", position: 70, active: true }];
    const input = scenario({ steps: seven, done: STEPS.map((step) => step.id), status: "completed" });
    expect(input.guide).toMatchObject({ onboardingComplete: true, progressiveDisclosureActive: false, totalSteps: 7, completedSteps: 6, stage: "complete", nextStep: null });
    const view = plan(input);
    expect(view.parity.differences).toEqual([]);
    expect(view.action).toBeNull();
    expect(view.nav.offered).toBe(false);
  });

  it("G3: all five switches off still reports the counts", () => {
    const input = scenario({ switches: ALL_OFF, done: [stepId(1)] });
    expect(input.guide).toMatchObject({ applies: false, totalSteps: 6, completedSteps: 1, showHud: false, spotlight: null, badge: null });
    const view = plan(input);
    expect(view.applies).toBe(false);
    expect(view.card).toBeNull();
    expect(view.ring).toMatchObject({ done: 1, total: 6, percent: 17 });
    expect(why(view, "R2").key).toBe("guideEngine.why.r2.allOff");
  });

  it("G4: card switch off with badges on still shows the card", () => {
    const input = scenario({ switches: { ...ALL_ON, hudTooltips: false } });
    expect(input.guide.showHud).toBe(true);
    const view = plan(input);
    expect(view.card).toMatchObject({ titleKey: "onboardingGuide.welcomeTitleDrip", badgeKey: "onboardingGuide.badgeNewMember", dismissable: false });
    expect(why(view, "R4").key).toBe("guideEngine.why.r4.cardViaBadges");
  });

  it("G5: no active steps means no program and a complete answer", () => {
    const input = scenario({ steps: [] });
    expect(input.guide).toMatchObject({ programConfigured: false, onboardingComplete: true, applies: false, totalSteps: 0, nextStep: null });
    const view = plan(input);
    expect(view.ring).toBeNull();
    expect(view.action).toBeNull();
    expect(why(view, "R2").key).toBe("guideEngine.why.r2.noSteps");
  });

  it("matches the server's other formulas exactly", () => {
    expect([1, 2, 3, 6, 7, 9, 10].map(momentumMark)).toEqual([2, 2, 2, 2, 3, 3, 4]);
    expect(computeMemberOnly({ orgGrants: ["steward"], mfa: true, secondFactor: true })).toBe(false);
    expect(computeMemberOnly({ orgGrants: ["steward"], mfa: true, secondFactor: false })).toBe(true);
    expect(computeMemberOnly({ orgGrants: ["steward"], mfa: true, secondFactor: false, staffMfaRequired: false })).toBe(false);
    expect(computeMemberOnly({ orgGrants: [], mfa: true, secondFactor: true })).toBe(true);
    expect(computeMemberOnly()).toBe(true);
    expect(activeStepsInOrder([{ id: "b", position: 1 }, { id: "a", position: 1 }, { id: "c", position: 0, active: false }, null]).map((step) => step.id)).toEqual(["a", "b"]);
    expect(activeStepsInOrder(null)).toEqual([]);
    // A staff override can leave a non-prefix set: next is the first open step.
    expect(buildMemberGuidePayload({ memberOnly: true, steps: STEPS, plan: { status: "in_progress", completedStepIds: [stepId(1), stepId(3)] }, switches: ALL_ON }).nextStep.id).toBe(stepId(2));
    expect(buildMemberGuidePayload({ memberOnly: true, steps: STEPS, plan: null, switches: undefined })).toMatchObject({ enrolled: false, applies: false, stage: "welcome" });
    expect(UNAVAILABLE_GUIDE_PAYLOAD).toEqual({ state: "unavailable", applies: false, onboardingComplete: null, progressiveDisclosureActive: false });
    expect(PARITY_FIELDS).not.toContain("organizationId");
    expect(payloadDifferences({ stage: "welcome" }, { stage: "activate" })).toContain("stage");
  });
});

describe("the product today: only Start, or Complete on the first open step", () => {
  it("offers Start my onboarding plan before a plan exists, and nothing else", () => {
    const view = plan(scenario({ enrolled: false }));
    expect(view.action).toEqual({ kind: "start_plan", label: { key: "guideEngine.action.startPlan" } });
    expect(view.card.ctaKey).toBe("onboardingGuide.startOnboarding");
    expect(view.steps.map((step) => step.state)).toEqual(["next", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("offers Complete on the first open active step only", () => {
    const view = plan(scenario({ done: [stepId(1)] }));
    expect(view.action).toEqual({ kind: "complete_step", stepId: stepId(2), label: { key: "guideEngine.action.complete", params: { title: "Meet your committee contact" } } });
    expect(view.steps.filter((step) => step.state === "next")).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({ state: "done", reason: { key: "guideEngine.row.done" } });
    expect(view.ring.text).toEqual({ key: "guideEngine.ring.steps", params: { done: 1, total: 6 } });
  });

  it("shows a staff override out of order as done and keeps the first open step next", () => {
    const view = plan(scenario({ done: [stepId(1), stepId(3)] }));
    expect(view.steps.map((step) => step.state)).toEqual(["done", "next", "done", "todo", "todo", "todo"]);
    expect(view.action.stepId).toBe(stepId(2));
    expect(why(view, "R11")).toEqual({ key: "guideEngine.why.r11.staffOutOfOrder", params: { steps: "3" } });
    expect(why(view, "R14").key).toBe("guideEngine.why.r11.staffOutOfOrder");
  });

  it("R14 cannot tell a staff skip from a completion in the worker's data", () => {
    expect(why(plan(scenario({ done: [stepId(1)] })), "R14").key).toBe("guideEngine.why.r14.unknownFromMember");
    expect(why(plan(scenario()), "R14").key).toBe("guideEngine.why.r14.unknownFromMember");
  });

  it("R1 rebuilds memberOnly from the grant facts, and leaves it unchecked without them", () => {
    const staff = { orgGrants: ["steward"], mfa: true, secondFactor: true, staffMfaRequired: true };
    const mismatch = plan({ ...scenario(), who: staff });
    expect(mismatch.parity.unchecked).toEqual([]);
    expect(mismatch.parity.differences).toContain("memberOnly");
    const agreed = plan({ ...scenario({ memberOnly: false }), who: staff });
    expect(agreed.parity).toEqual({ checked: true, differences: [], unchecked: [] });
    const member = plan({ ...scenario(), who: { orgGrants: [], mfa: true } });
    expect(member.parity).toEqual({ checked: true, differences: [], unchecked: [] });
  });

  it("keeps the rule catalogue frozen", () => {
    expect(Object.isFrozen(GUIDE_ENGINE_RULES)).toBe(true);
    expect(() => /** @type {any} */ (GUIDE_ENGINE_RULES).pop()).toThrow(TypeError);
    expect(GUIDE_ENGINE_RULES).toHaveLength(38);
  });

  it("never finishes a step from an action or a screen visit", () => {
    const view = plan(scenario({ done: [stepId(1)], lastAction: "Saved your contact details" }));
    expect(view.steps.filter((step) => step.state === "done")).toHaveLength(1);
    expect(why(view, "R10")).toEqual({ key: "guideEngine.why.r10.today", params: { action: "Saved your contact details" } });
    expect(why(view, "R12").key).toBe("guideEngine.why.r12.never");
    for (const rule of ["R13", "R15", "R18", "R19", "R20", "R22", "R23", "R25", "R26", "R27", "R34", "R36"]) {
      expect(why(view, rule).key, rule).toMatch(/\.today$/);
    }
    // Port step 3: the org-start guide is read only for a staff hat; a member
    // plan without that read shows no org-start guide and says why.
    expect(why(view, "R35").key).toBe("guideEngine.why.r35.notRead");
    expect(view.orgStart).toBeNull();
  });

  it("offers nothing once finished, to a staff hat, or without a ready guide", () => {
    expect(plan(scenario({ done: STEPS.map((step) => step.id), status: "completed" })).action).toBeNull();
    expect(plan(scenario({ hat: "steward" })).action).toBeNull();
    expect(plan({ ...scenario(), guide: UNAVAILABLE_GUIDE_PAYLOAD }).action).toBeNull();
  });

  it("takes the next step from the guide when the workspace was refused", () => {
    const view = plan({ ...scenario({ done: [stepId(1)] }), workspace: null });
    expect(view.steps).toEqual([]);
    expect(view.parity.checked).toBe(false);
    expect(view.next).toMatchObject({ id: stepId(2), title: "Meet your committee contact", state: "next" });
    expect(view.action.stepId).toBe(stepId(2));
  });

  it("refuses the proposed mode and a missing clock", () => {
    expect(GUIDE_ENGINE_MODE).toBe("exists_today");
    expect(() => plan({ ...scenario(), mode: "proposed" })).toThrow(/not ported yet/);
    expect(() => plan({ ...scenario(), now: undefined })).toThrow(/input\.now/);
  });
});

describe("card, navigation, spotlight and badges follow the payload", () => {
  it("m-new: welcome card, New Worker, spotlight on worker support, guided navigation", () => {
    const navLists = [ONBOARDING_CORE_NAV_KEYS.map((key) => ({ key })), [{ key: "events" }, { key: "ballots" }, { key: "pulse" }, { key: "library" }, { key: "dues" }]];
    const view = plan(scenario({ navLists }));
    expect(view.stage).toBe("welcome");
    expect(view.badge).toBe("new_member");
    expect(view.card).toMatchObject({ titleKey: "onboardingGuide.welcomeTitleDrip", bodyKey: "onboardingGuide.welcomeBody", ctaKey: "onboardingGuide.openOnboarding", nextStepTitle: "Finish your profile" });
    expect(view.nav).toMatchObject({ guided: true, offered: true, hiddenCount: 5, spotlight: "member-support" });
    expect(why(view, "R7")).toEqual({ key: "guideEngine.why.r7.guided", params: { core: ONBOARDING_CORE_NAV_KEYS.length, count: 5 } });
    expect(why(view, "R6").key).toBe("guideEngine.why.r6.support");
    expect(why(view, "R5").key).toBe("guideEngine.why.r5.on");
    expect(why(view, "R3")).toEqual({ key: "guideEngine.why.r3.welcome", params: { done: 0, m: 2, total: 6 } });
    expect(view.nudge).toBeNull();
    expect(why(view, "R9").key).toBe("guideEngine.why.r9.guidedFirstRun");
  });

  it("m-complete: Ready to Roll, spotlight on meetings, a dismissable card, full menu", () => {
    const view = plan(scenario({ done: STEPS.map((step) => step.id), status: "completed" }));
    expect(view.card).toMatchObject({ titleKey: "onboardingGuide.completeTitle", bodyKey: "onboardingGuide.completeBodyNavigation", dismissable: true, nextStepTitle: null });
    expect(view.badge).toBe("ready_to_roll");
    expect(view.nav.spotlight).toBe("events");
    expect(why(view, "R3").key).toBe("guideEngine.why.r3.complete");
    expect(why(view, "R4").key).toBe("guideEngine.why.r4.completeWeb");
    expect(why(view, "R7").key).toBe("guideEngine.why.r7.complete");
    expect(why(view, "R8").key).toBe("guideEngine.why.r8.ready");
    expect(why(view, "R6").key).toBe("guideEngine.why.r6.events");
    const putAway = plan(scenario({ done: STEPS.map((step) => step.id), status: "completed", prefs: { completeDismissed: true } }));
    expect(putAway.card).toBeNull();
    expect(why(putAway, "R4").key).toBe("guideEngine.why.r4.putAway");
  });

  it("drip off uses the plain titles; card and badges off show nothing on the web", () => {
    const plain = plan(scenario({ switches: { ...ALL_ON, featureDrip: false }, done: [stepId(1), stepId(2)] }));
    expect(plain.card.titleKey).toBe("onboardingGuide.activateTitle");
    expect(why(plain, "R5").key).toBe("guideEngine.why.r5.off");
    expect(why(plain, "R8").key).toBe("guideEngine.why.r8.momentum");
    expect(why(plain, "R3")).toEqual({ key: "guideEngine.why.r3.activate", params: { done: 2, m: 2 } });
    const cardOff = plan(scenario({ switches: { ...ALL_ON, hudTooltips: false, badgeAchievements: false } }));
    expect(cardOff.card).toBeNull();
    expect(cardOff.entry).toBeNull();
    expect(cardOff.badge).toBeNull();
    expect(why(cardOff, "R4").key).toBe("guideEngine.why.r4.webNoEntry");
    expect(why(cardOff, "R8").key).toBe("guideEngine.why.r8.none");
    const card = plan(scenario());
    expect(why(card, "R4").key).toBe("guideEngine.why.r4.card");
    const spotOff = plan(scenario({ switches: { ...ALL_ON, spotlight: false } }));
    expect(spotOff.nav.spotlight).toBeNull();
    expect(why(spotOff, "R6").key).toBe("guideEngine.why.r6.off");
  });

  it("Show everything keeps the full menu while guided navigation is offered", () => {
    const view = plan(scenario({ prefs: { showAll: true } }));
    expect(view.nav).toMatchObject({ guided: false, offered: true });
    expect(why(view, "R7").key).toBe("guideEngine.why.r7.showEverything");
    expect(why(view, "R16").key).toBe("guideEngine.why.r7.showEverything");
    const off = plan(scenario({ switches: { ...ALL_ON, progressiveDisclosure: false } }));
    expect(off.nav.guided).toBe(false);
    expect(why(off, "R7").key).toBe("guideEngine.why.r7.off");
  });

  it("a staff hat gets no card, spotlight, badge or guided navigation", () => {
    const view = plan(scenario({ hat: "steward" }));
    expect(view.card).toBeNull();
    expect(view.badge).toBeNull();
    expect(view.nav).toMatchObject({ guided: false, spotlight: null });
    expect(why(view, "R7").key).toBe("guideEngine.why.r7.staffHat");
    for (const rule of ["R4", "R6", "R8"]) expect(why(view, rule).key).toBe("guideEngine.why.r2.noStaffToday");
  });

  it("a guide switch off in the worker configuration keeps the shell from using the guide", () => {
    const view = plan({ ...scenario(), switches: configSwitches(ALL_OFF) });
    expect(view.legacy).toEqual({ ...INACTIVE_GUIDE });
    expect(view.card).toBeNull();
    expect(why(view, "R2").key).toBe("guideEngine.why.r2.allOff");
    expect(why(view, "R4").key).toBe("guideEngine.why.r4.off");
    expect(why(view, "R5").key).toBe("guideEngine.why.r5.notInUse");
    expect(why(view, "R6").key).toBe("guideEngine.why.r6.none");
  });

  it("a worker's first 14 days get the guided core navigation without a program", () => {
    const fresh = { memberOnlyAccount: true, accountCreatedAt: new Date(NOW - 3 * DAY).toISOString() };
    const view = plan({ ...scenario({ steps: [] }), who: fresh });
    expect(view.nav.guided).toBe(true);
    const old = plan({ ...scenario({ steps: [] }), who: { ...fresh, accountCreatedAt: new Date(NOW - 20 * DAY).toISOString() } });
    expect(old.nav.guided).toBe(false);
  });

  // BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106 (#7279).
  it("an established worker gets no New Worker badge, card or guided menu; a new worker still does", () => {
    const navLists = [ONBOARDING_CORE_NAV_KEYS.map((key) => ({ key })), [{ key: "events" }, { key: "dues" }]];
    const freshAccount = { memberOnlyAccount: true, accountCreatedAt: new Date(NOW - 3 * DAY).toISOString() };
    const established = plan({ ...scenario({ enrolled: false, establishedMember: true, navLists }), who: freshAccount });
    expect(established.applies).toBe(false);
    expect(established.legacy).toMatchObject({ establishedMember: true, badge: null, showHud: false, progressiveDisclosureActive: false });
    expect(established.card).toBeNull();
    expect(established.badge).toBeNull();
    expect(established.nav).toMatchObject({ guided: false, hiddenCount: 0, spotlight: null });
    expect(established.parity).toMatchObject({ checked: true, differences: [] });
    expect(why(established, "R2").key).toBe("guideEngine.why.r2.established");
    expect(why(established, "R4").key).toBe("guideEngine.why.r4.off");
    // An untouched automatic plan: no Home onboarding reminder either.
    const autoPlan = plan({ ...scenario({ establishedMember: true, navLists }), who: freshAccount });
    expect(autoPlan.card).toBeNull();
    expect(autoPlan.nudge).toBeNull();

    const newMember = plan({ ...scenario({ enrolled: false, navLists }), who: freshAccount });
    expect(newMember.applies).toBe(true);
    expect(newMember.legacy).toMatchObject({ establishedMember: false, badge: "new_member" });
    expect(newMember.card).toMatchObject({ badge: "new_member", ctaKey: "onboardingGuide.startOnboarding" });
    expect(newMember.nav).toMatchObject({ guided: true, hiddenCount: 2 });
    expect(why(newMember, "R2").key).toBe("guideEngine.why.r2.member");
  });

  it("someone who is not worker only gets no worker guide", () => {
    const view = plan(scenario({ memberOnly: false, hat: "member" }));
    expect(view.applies).toBe(false);
    expect(view.memberOnly).toBe(false);
    expect(why(view, "R2").key).toBe("guideEngine.why.r2.notMemberOnly");
    expect(why(view, "R33").key).toBe("guideEngine.why.r33.keepsMember");
  });

  it("R33 shows the memberOnly computation when the grant facts are known", () => {
    const view = plan({ ...scenario(), who: { orgGrants: ["steward"], mfa: true, secondFactor: false, staffMfaRequired: true } });
    expect(why(view, "R33")).toEqual({
      key: "guideEngine.why.memberOnlyCalc",
      params: {
        org: { key: "guideEngine.common.yes" },
        mfa: { key: "guideEngine.common.yes" },
        factor: { key: "guideEngine.common.no" },
        notRequired: { key: "guideEngine.common.no" },
        result: { key: "guideEngine.common.yes" },
      },
    });
    const unknown = plan({ ...scenario(), guide: null, guideFailed: true, who: { orgGrants: [], mfa: false } });
    expect(why(unknown, "R33").params.result).toEqual({ key: "guideEngine.common.yes" });
  });
});

describe("guide state: unavailable and errors fail open", () => {
  it.each([
    ["unavailable", { guide: UNAVAILABLE_GUIDE_PAYLOAD }, "guideEngine.why.r38.unavailable"],
    ["error", { guide: null, guideFailed: true }, "guideEngine.why.r38.error"],
    ["malformed", { guide: { state: "surprise" } }, "guideEngine.why.r38.error"],
  ])("%s: no card, no spotlight, full navigation", (state, patch, key) => {
    const view = plan({ ...scenario(), ...patch, nudges: null, nudgesState: "error" });
    expect(view.guideState).toBe(state === "malformed" ? "error" : state);
    expect(view).toMatchObject({ applies: false, card: null, badge: null, ring: null, action: null });
    expect(view.nav).toMatchObject({ guided: false, spotlight: null });
    expect(why(view, "R38").key).toBe(key);
    expect(why(view, "R2").key).toBe(key);
    expect(why(view, "R3").key).toBe(key);
    expect(why(view, "R1").key).toBe("guideEngine.why.r1.unavailable");
    expect(why(view, "R9").key).toBe("guideEngine.why.r38.error");
  });

  it("says so when a new worker's guided navigation outlives a failed guide call", () => {
    const fresh = { memberOnlyAccount: true, accountCreatedAt: new Date(NOW - 3 * DAY).toISOString() };
    const view = plan({ ...scenario(), guide: null, guideFailed: true, who: fresh });
    expect(view.nav.guided).toBe(true);
    expect(why(view, "R38")).toEqual({ key: "guideEngine.why.r38.newMemberNav", params: { state: { key: "guideEngine.why.r38.error" } } });
    expect(why(view, "R2")).toEqual(why(view, "R38"));
    expect(renderGuideCopy("en", why(view, "R38"))).toBe("The guide call failed: full navigation, no card, no spotlight and no error text. Guided navigation still shows for a worker's first 14 days.");
    const old = plan({ ...scenario(), guide: UNAVAILABLE_GUIDE_PAYLOAD, who: { ...fresh, accountCreatedAt: new Date(NOW - 20 * DAY).toISOString() } });
    expect(old.nav.guided).toBe(false);
    expect(why(old, "R38").key).toBe("guideEngine.why.r38.unavailable");
  });

  it("a chapterless worker's refused nudge read means no nudges at all", () => {
    const view = plan({ ...scenario(), nudges: null, nudgesState: "unauthorized" });
    expect(view.nudge).toBeNull();
    expect(why(view, "R9").key).toBe("guideEngine.why.r9.noChapter");
  });
});

describe("the Home nudge and its two clocks", () => {
  const quiet = { ...ALL_ON, hudTooltips: false, badgeAchievements: false, progressiveDisclosure: false };

  it("m-nudge: Step 4 of 6 when nothing guided owns Home", () => {
    const view = plan(scenario({ switches: quiet, done: [stepId(1), stepId(2), stepId(3)] }));
    expect(view.nudge).toEqual({ kind: "onboarding", titleKey: "homeNudge.onboardingTitle", bodyKey: "homeNudge.onboardingBody", actionKey: "homeNudge.onboardingAction", notNowKey: "homeNudge.notNowOnboarding", params: { step: 4, total: 6 } });
    expect(why(view, "R9").key).toBe("guideEngine.why.r9.shows");
    expect(why(view, "R24").key).toBe("guideEngine.why.r24.none");
    expect(view.hiddenUntil).toBeNull();
  });

  it("m-snoozed: Not now on day 2 with a 3-day snooze, and the 7-day cap after it", () => {
    const shownAt = NOW + DAY;
    const history = { onboarding: { shownAt, dismissedAt: shownAt } };
    const day4 = plan({ ...scenario({ switches: quiet, snoozeDays: 3, done: [stepId(1)] }), now: NOW + 3 * DAY, nudgeContext: { history } });
    expect(day4.nudge).toBeNull();
    expect(why(day4, "R24")).toEqual({ key: "guideEngine.why.r24.snoozed", params: { day: new Date(shownAt).toISOString(), days: 3, until: new Date(shownAt + 3 * DAY).toISOString() } });
    expect(why(day4, "R9").key).toBe("guideEngine.why.r24.snoozed");
    const day5 = plan({ ...scenario({ switches: quiet, snoozeDays: 3, done: [stepId(1)] }), now: NOW + 4 * DAY, nudgeContext: { history } });
    expect(day5.nudge).toBeNull();
    expect(why(day5, "R24").key).toBe("guideEngine.why.r24.cooldownOn");
    expect(day5.hiddenUntil).toBe(new Date(shownAt + 7 * DAY).toISOString());
    const day9 = plan({ ...scenario({ switches: quiet, snoozeDays: 3, done: [stepId(1)] }), now: NOW + 8 * DAY, nudgeContext: { history } });
    expect(day9.nudge?.kind).toBe("onboarding");
  });

  it("explains why no onboarding nudge shows", () => {
    expect(why(plan(scenario({ switches: quiet, nudgeSwitch: false })), "R9").key).toBe("guideEngine.why.r9.switchOff");
    expect(why(plan(scenario({ switches: quiet, enrolled: false })), "R9").key).toBe("guideEngine.why.r9.noPlan");
    expect(why(plan(scenario({ switches: quiet, done: STEPS.map((step) => step.id), status: "completed" })), "R9").key).toBe("guideEngine.why.r9.finished");
    expect(why(plan(scenario({ switches: quiet, nudgeContext: { welcomeTourActive: true } })), "R9").key).toBe("guideEngine.why.r9.guidedFirstRun");
  });

  it("the starting list nudge reaches a worker whose organization has no steps", () => {
    const view = plan(scenario({ steps: [], switches: quiet }));
    expect(view.nudge).toMatchObject({ kind: "starter", titleKey: "homeNudge.starterTitle", params: {} });
    expect(why(view, "R9")).toEqual({ key: "guideEngine.why.r9.starterShows", params: { onboarding: { key: "guideEngine.why.r9.finished" } } });
  });

  it("R24 keeps the passkey reminder's own clocks when it is the one being hidden", () => {
    const input = scenario({ switches: quiet, enrolled: false });
    const nudges = { ...input.nudges, passkey: true };
    const context = { passkeySupported: true, hasPasskey: false, signedInAt: NOW - 11 * 60_000 };
    const shown = plan({ ...input, nudges, nudgeContext: context });
    expect(shown.nudge?.kind).toBe("passkey");
    expect(why(shown, "R9")).toEqual({ key: "guideEngine.why.r9.passkeyShows", params: { onboarding: { key: "guideEngine.why.r9.noPlan" } } });
    expect(why(shown, "R24").key).toBe("guideEngine.why.r24.none");
    const dismissedAt = NOW - DAY;
    const snoozed = plan({ ...input, nudges, nudgeContext: { ...context, history: { passkey: { shownAt: dismissedAt, dismissedAt } } } });
    expect(snoozed.nudge).toBeNull();
    expect(why(snoozed, "R24")).toEqual({ key: "guideEngine.why.r24.snoozed", params: { day: new Date(dismissedAt).toISOString(), days: 28, until: new Date(dismissedAt + 28 * DAY).toISOString() } });
    expect(snoozed.hiddenUntil).toBe(new Date(dismissedAt + 28 * DAY).toISOString());
    expect(why(snoozed, "R9").key).toBe("guideEngine.why.r9.noPlan");
  });

  it("the passkey nudge waits for device support and ten minutes", () => {
    const input = scenario({ switches: quiet, enrolled: false });
    const nudges = { ...input.nudges, passkey: true };
    const context = { passkeySupported: true, hasPasskey: false, signedInAt: NOW - 11 * 60_000 };
    expect(plan({ ...input, nudges, nudgeContext: context }).nudge?.kind).toBe("passkey");
    expect(plan({ ...input, nudges, nudgeContext: { ...context, signedInAt: NOW - 60_000 } }).nudge).toBeNull();
  });
});

describe("every rule decides, in order, with an English and a Spanish line", () => {
  const inputs = [
    scenario(), scenario({ done: [stepId(1), stepId(3)] }), scenario({ done: STEPS.map((step) => step.id), status: "completed" }),
    scenario({ switches: ALL_OFF }), scenario({ steps: [] }), scenario({ hat: "steward" }), scenario({ enrolled: false }),
    { ...scenario(), guide: UNAVAILABLE_GUIDE_PAYLOAD }, { ...scenario(), guide: null, guideFailed: true },
    { ...scenario(), prefs: { textScale: 2, reducedMotion: true }, who: { orgGrants: [], mfa: true } },
    { ...scenario(), prefs: { textScale: 2 } }, { ...scenario(), prefs: { reducedMotion: true } },
  ];

  it("returns R1 to R38 exactly once each, with a source tag", () => {
    expect(GUIDE_ENGINE_RULES.map((rule) => rule.id)).toEqual(Array.from({ length: 38 }, (_, index) => `R${index + 1}`));
    for (const input of inputs) {
      const view = plan(input);
      expect(view.decisions.map((decision) => decision.rule)).toEqual(GUIDE_ENGINE_RULES.map((rule) => rule.id));
      for (const decision of view.decisions) expect(["exists_today", "on_this_device", "proposed"]).toContain(decision.source);
    }
  });

  it("emits only keys both languages carry", () => {
    const emitted = new Set();
    for (const input of inputs) keysIn(plan(input), emitted);
    expect(emitted.size).toBeGreaterThan(40);
    for (const key of emitted) {
      const table = key.startsWith("guideEngine.") ? guideEngineCatalogue : catalogue;
      expect(Object.hasOwn(table.en, key), `en ${key}`).toBe(true);
      expect(Object.hasOwn(table.es, key), `es ${key}`).toBe(true);
    }
  });

  it("renders text scale and motion", () => {
    const keys = inputs.slice(-3).map((input) => why(plan(input), "R32").key);
    expect(keys).toEqual(["guideEngine.why.r32.largeReduced", "guideEngine.why.r32.largeFull", "guideEngine.why.r32.normalReduced"]);
    expect(plan(inputs.at(-1)).motion).toBe("reduced");
    expect(plan(inputs[0]).motion).toBe("full");
    expect(why(plan(inputs[0]), "R32").key).toBe("guideEngine.why.r32.normalFull");
  });
});

describe("the engine's copy", () => {
  const { en, es } = guideEngineCatalogue;
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it("requires matching native English copy for every guide key added on the web", () => {
    expect(GUIDE_COPY_EN).toEqual(en);
  });

  it("ships every line in English and Spanish with the same placeholders", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(en)) {
      expect(key.startsWith("guideEngine."), key).toBe(true);
      expect(text.trim(), key).not.toBe("");
      expect(es[key].trim(), key).not.toBe("");
      expect(placeholders(es[key]), key).toEqual(placeholders(text));
      // The barrel's own copy scans: no "hat" for a role, no real union.
      for (const line of [text, es[key]]) expect(line, key).not.toMatch(/\bhats?\b|\b509\b|\bseeded\b/iu);
      // Port step 2 spread the chunk into both barrels: the barrel's t() and
      // the engine's own lookup read the same line.
      expect(catalogue.en[key], key).toBe(text);
      expect(catalogue.es[key], key).toBe(es[key]);
    }
  });

  it("keeps the owner-approved register lines word for word", () => {
    expect(en["guideEngine.action.startPlan"]).toBe("Start my onboarding plan");
    expect(es["guideEngine.action.startPlan"]).toBe("Empezar mi plan de bienvenida");
    expect(en["guideEngine.why.r37.rule"]).toBe("A staff or feature step never appears in, or counts toward, a worker's guide.");
    expect(en["guideEngine.why.r29.product"]).toBe("In the product, only organization-wide staff with MFA lose the worker guide; staff guides are a proposal.");
    expect(es["guideEngine.role.steward"]).toBe("Miembro del comité");
  });

});

describe("purity", () => {
  const source = readFileSync(resolve(process.cwd(), "src/features/onboardingGuideEngine/engine.js"), "utf8");
  const server = readFileSync(resolve(process.cwd(), "src/features/onboardingGuideEngine/memberServer.js"), "utf8");

  it("reads no clock, randomness, storage, DOM or network", () => {
    for (const text of [source, server]) {
      expect(text).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|localStorage|sessionStorage|window\.|document\.|fetch\(|\.rpc\(/);
    }
  });

  it("gives the same view for the same input and never changes its input", () => {
    const input = scenario({ done: [stepId(1)] });
    const before = JSON.stringify(input);
    expect(plan(input)).toEqual(plan(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("reads and writes", () => {
  it("reads only the three existing answers and fails each one open", async () => {
    const rpc = vi.fn(async (name) => (name === "get_member_home_nudges" ? { data: null, error: { code: "42501", message: "active organization membership required" } } : { data: { state: "ready" }, error: null }));
    const supportAdapter = { load: vi.fn(async () => ({ state: "ready", onboardingProgram: STEPS, onboardingPlan: null, accommodations: [] })) };
    const reads = await loadGuideEngineReads({ client: { rpc }, supportAdapter, actor: { userId: "u" } });
    expect(rpc.mock.calls.map(([name]) => name).sort()).toEqual(["get_member_home_nudges", "get_member_onboarding_guide"]);
    expect(supportAdapter.load).toHaveBeenCalledWith({ userId: "u" });
    expect(reads).toEqual({ guide: { state: "ready" }, guideFailed: false, nudges: null, nudgesState: "unauthorized", workspace: { onboardingProgram: STEPS, onboardingPlan: null } });
    expect(GUIDE_ENGINE_READS).toEqual(["get_member_onboarding_guide", "get_member_support_workspace", "get_member_home_nudges"]);

    const broken = await loadGuideEngineReads({ client: { rpc: vi.fn(async () => { throw new Error("offline"); }) }, supportAdapter: { load: async () => { throw new Error("offline"); } }, actor: {} });
    expect(broken).toEqual({ guide: null, guideFailed: true, nudges: null, nudgesState: "error", workspace: null });
    const refused = await loadGuideEngineReads({ client: { rpc: async () => ({ data: null, error: { code: "PGRST202" } }) }, supportAdapter: { load: async () => ({ state: "unauthorized" }) }, actor: {} });
    expect(refused).toMatchObject({ guideFailed: true, nudgesState: "error", workspace: null });
    expect(await loadGuideEngineReads({ client: null, supportAdapter: null, actor: {} })).toMatchObject({ guideFailed: true, workspace: null });
    expect(await loadGuideEngineReads({ client: { rpc: async () => ({ data: { state: "ready" } }) }, supportAdapter: null, actor: {} })).toMatchObject({ guideFailed: false, workspace: null });
  });

  it("writes only start_member_onboarding_plan and complete_member_onboarding_step", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    let n = 0;
    const supportAdapter = createMemberSupportAdapter({ rpc }, { randomUUID: () => `key-${++n}` });
    const actor = { userId: "member-1", organizationId: ORG, membershipStatus: "active", selectedHat: "member" };
    const target = new EventTarget();
    const refreshed = vi.fn();
    target.addEventListener(ONBOARDING_GUIDE_REFRESH_EVENT, refreshed);
    await performGuideAction({ supportAdapter, actor, action: plan(scenario({ enrolled: false })).action, target });
    await performGuideAction({ supportAdapter, actor, action: plan(scenario({ done: [stepId(1)] })).action, target });
    expect(rpc.mock.calls).toEqual([
      ["start_member_onboarding_plan", { p_member_user_id: null, p_idempotency_key: "key-1" }],
      ["complete_member_onboarding_step", { p_step_id: stepId(2), p_idempotency_key: "key-2" }],
    ]);
    expect(refreshed).toHaveBeenCalledTimes(2);
    expect(GUIDE_ENGINE_WRITES).toEqual(["start_member_onboarding_plan", "complete_member_onboarding_step"]);
    for (const action of [null, { kind: "undo", stepId: stepId(1) }, { kind: "complete_step" }, { kind: "skip", stepId: stepId(1) }]) {
      await expect(performGuideAction({ supportAdapter, actor, action, target })).rejects.toMatchObject({ code: "22023" });
    }
    expect(rpc).toHaveBeenCalledTimes(2);
    await performGuideAction({ supportAdapter, actor, action: { kind: "start_plan" }, target: null });
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
