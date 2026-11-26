// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023: the member
// surfaces render from the guide engine's plan() in "The product today"
// mode, with the same output as the product's own paths; the proposed member
// layers (feature guides R36, coach marks R26) render only behind their
// default-off switches. Expected values are typed here, not worked out by the
// code under test.
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingHud } from "../src/components/OnboardingHud.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import {
  ONBOARDING_GUIDE_ACTION_EVENT,
  announceGuideAction,
  guideLayerStorageKeys,
  normalizeOnboardingGuide,
  onboardingGuideCard,
  readCoachMarkSession,
  readCoachMarksSeen,
  readFeatureGuideMarks,
  readMemberOnboardingGuide,
  withNewMemberGuidedNav,
  writeCoachMarkSeen,
  writeCoachMarkSession,
  writeFeatureGuideMark,
} from "../src/lib/onboardingGuide.js";
import { chooseHomeNudge, normalizeHomeNudges } from "../src/features/memberHome/nudges.js";
import { plan } from "../src/features/onboardingGuideEngine/engine.js";
import { createSessionGuard } from "../src/lib/sessionGuard.js";
import { buildMemberGuidePayload, UNAVAILABLE_GUIDE_PAYLOAD } from "../src/features/onboardingGuideEngine/memberServer.js";
import { COACH_MARK_WAIT_SECONDS, MEMBER_FEATURES, PROPOSED_MEMBER_SWITCHES, coachMarkDecision, featureOfView, memberFeatureGuides, proposedSwitchOn } from "../src/features/onboardingGuideEngine/memberLayers.js";
import { COACH_MARK_ID, MemberCoachMark, MemberFeatureGuide, MemberGuideList, countGuideAction, noteGuideNavigation, useCoachMarkFacts, useMemberGuideLayers } from "../src/features/onboardingGuideEngine/MemberGuideLayers.jsx";

const DAY = 86_400_000;
// Monday, October 19, 2026, 9:00 AM Eastern.
const NOW = Date.UTC(2026, 9, 19, 13);
const TITLES = ["Finish your profile", "Meet your committee contact", "Read the worker guide", "Ask a question", "Answer an meeting invitation", "Choose your notifications"];
const stepId = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const STEPS = TITLES.map((title, index) => ({ id: stepId(index + 1), title, position: (index + 1) * 10, active: true }));
const ON = { featureDrip: true, hudTooltips: true, spotlight: true, progressiveDisclosure: true, badgeAchievements: true };
const GUIDE_SWITCHES_ON = { "features.guidance_onboarding.hud_tooltips": true };
const LAYERS_ON = { ...GUIDE_SWITCHES_ON, [PROPOSED_MEMBER_SWITCHES.featureGuides]: true, [PROPOSED_MEMBER_SWITCHES.coachMarks]: true };

function payload({ done = 0, enrolled = true, status, switches = ON, memberOnly = true, steps = STEPS } = {}) {
  const completedStepIds = steps.slice(0, done).map((step) => step.id);
  const planRow = enrolled ? { status: status ?? (done ? "in_progress" : "not_started"), completedStepIds } : null;
  return buildMemberGuidePayload({ organizationId: "org-1", memberOnly, steps, plan: planRow, switches });
}

const PAYLOADS = {
  welcomeDrip: payload({ done: 1 }),
  welcomePlain: payload({ done: 0, switches: { ...ON, featureDrip: false } }),
  activate: payload({ done: 3 }),
  notEnrolled: payload({ enrolled: false }),
  complete: payload({ done: 6, status: "completed" }),
  completeNoNav: payload({ done: 6, status: "completed", switches: { ...ON, progressiveDisclosure: false } }),
  badgesOnly: payload({ done: 2, switches: { featureDrip: false, hudTooltips: false, spotlight: false, progressiveDisclosure: false, badgeAchievements: true } }),
  cardOff: payload({ done: 2, switches: { ...ON, hudTooltips: false, badgeAchievements: false } }),
  staff: payload({ done: 1, memberOnly: false }),
  noSteps: payload({ steps: [] }),
  unavailable: UNAVAILABLE_GUIDE_PAYLOAD,
};

const wrap = (node) => render(<LanguageProvider lang="en">{node}</LanguageProvider>);

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe("product today: the surfaces match the product's own paths", () => {
  it("hands the page's single guide slot to its feature guide after a remembered onboarding dismissal", () => {
    const card = plan({ now: NOW, hat: "member", switches: GUIDE_SWITCHES_ON, guide: PAYLOADS.complete }).card;
    const feature = memberFeatureGuides({ on: true, memberHat: true, memberOnly: true, view: "voting", marks: {} }).view;
    const page = () => <OnboardingHud card={card} memberId="single-slot"><MemberFeatureGuide guides={feature} /></OnboardingHud>;
    const first = wrap(page());
    expect(screen.getByRole("heading", { name: "Onboarding complete" })).toBeInTheDocument();
    expect(document.querySelector('[data-guide-surface="feature-guide"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector('.onboarding-hud')).toBeNull();
    expect(document.querySelectorAll('[data-guide-surface="feature-guide"]')).toHaveLength(1);
    first.unmount();
    wrap(page());
    expect(document.querySelector('.onboarding-hud')).toBeNull();
    expect(screen.getByRole("heading", { name: "About Voting" })).toBeInTheDocument();
    // The actual shell must use this slot rather than mounting a second sibling.
    // #9543 (B-39), #9776: the slot also tells a finished card to stay on Home, on every shell
    // (the desktop demo showed "Onboarding complete" above every page heading).
    expect(readFileSync("src/App.jsx", "utf8")).toContain('onboardingHudCard("", featureGuideCard(resolvedView), { hideComplete: true })');
  });

  it.each(Object.entries(PAYLOADS))("renders the same guide card from plan() as from the payload (%s)", (_name, answer) => {
    const engineCard = plan({ now: NOW, hat: "member", switches: GUIDE_SWITCHES_ON, guide: answer }).card;
    expect(engineCard).toEqual(onboardingGuideCard(normalizeOnboardingGuide(answer)));
    const legacy = wrap(<OnboardingHud guide={normalizeOnboardingGuide(answer)} memberId="m-1" onNavigate={() => {}} />);
    const before = legacy.container.innerHTML;
    legacy.unmount();
    const engine = wrap(<OnboardingHud card={engineCard} memberId="m-1" onNavigate={() => {}} />);
    expect(engine.container.innerHTML).toBe(before);
    engine.unmount();
  });

  it("shows the welcome card's exact product copy from the engine", () => {
    const card = plan({ now: NOW, hat: "member", switches: GUIDE_SWITCHES_ON, guide: PAYLOADS.welcomeDrip }).card;
    const onNavigate = vi.fn();
    wrap(<OnboardingHud card={card} memberId="m-1" onNavigate={onNavigate} />);
    const hud = document.querySelector(".onboarding-hud");
    expect(within(hud).getByRole("heading", { name: "Start with one clear next step" })).toBeInTheDocument();
    expect(within(hud).getByText("You have finished 1 of 6 onboarding steps so far.")).toBeInTheDocument();
    expect(within(hud).getByText("Next step: Meet your committee contact")).toBeInTheDocument();
    expect(within(hud).getByText("New Worker")).toBeInTheDocument();
    fireEvent.click(within(hud).getByRole("button", { name: "Open onboarding" }));
    expect(onNavigate).toHaveBeenCalledWith("memberSupport", "/m/support/onboarding");
  });

  it("puts the finished card away when the worker dismissed it, in the engine as in the card", () => {
    window.localStorage.setItem("sg:member:m-1:onboarding-guide:complete-dismissed", "true");
    expect(plan({ now: NOW, hat: "member", switches: GUIDE_SWITCHES_ON, guide: PAYLOADS.complete, prefs: { completeDismissed: true } }).card).toBeNull();
    const card = plan({ now: NOW, hat: "member", switches: GUIDE_SWITCHES_ON, guide: PAYLOADS.complete }).card;
    const { container } = wrap(<OnboardingHud card={card} memberId="m-1" onNavigate={() => {}} />);
    expect(container.querySelector(".onboarding-hud")).toBeNull();
  });

  it.each([
    ["an active guide", PAYLOADS.welcomeDrip, null, true],
    ["a finished guide", PAYLOADS.complete, null, true],
    ["no guide, a worker's first days", null, "2026-10-15T12:00:00Z", true],
    ["no guide, a worker of a month", null, "2026-09-15T12:00:00Z", true],
    ["no guide, staff", null, "2026-10-15T12:00:00Z", false],
  ])("hands the navigation the product's guided view (%s)", (_name, answer, createdAt, memberOnly) => {
    const view = plan({ now: NOW, hat: "member", switches: GUIDE_SWITCHES_ON, guide: answer, who: { memberOnlyAccount: memberOnly, accountCreatedAt: createdAt } });
    const product = withNewMemberGuidedNav(normalizeOnboardingGuide(answer), { accountCreatedAt: createdAt, memberOnly, now: NOW });
    expect(view.nav.guide).toEqual(product);
  });

  it("keeps the navigation guide inactive while every guide switch is off, as the shell never reads the guide then", () => {
    const view = plan({ now: NOW, hat: "member", switches: {}, guide: PAYLOADS.welcomeDrip, who: { memberOnlyAccount: true, accountCreatedAt: "2026-09-01T00:00:00Z" } });
    expect(view.nav.guide.progressiveDisclosureActive).toBe(false);
    expect(view.card).toBeNull();
  });

  const histories = [
    {},
    { onboarding: { dismissedAt: NOW - 2 * DAY } },
    { onboarding: { shownAt: NOW - 3 * DAY } },
    { onboarding: { shownAt: NOW - 3 * DAY, shownThisSession: true } },
    { onboarding: { dismissedAt: NOW - 30 * DAY } },
    { starter: { dismissedAt: NOW - DAY } },
    { passkey: { dismissedAt: NOW - DAY } },
  ];
  const answers = [
    { passkey: false, onboarding: { completed: 2, total: 6 }, guidedFirstRun: false, snoozeDays: 28 },
    { passkey: true, onboarding: { completed: 2, total: 6 }, guidedFirstRun: false, snoozeDays: 3 },
    { passkey: true, onboarding: null, guidedFirstRun: false, snoozeDays: 28 },
    { passkey: true, onboarding: { completed: 2, total: 6 }, guidedFirstRun: true, snoozeDays: 28 },
    { passkey: false, onboarding: null, guidedFirstRun: false, snoozeDays: 28 },
  ];
  it("chooses the same Home nudge as the product for every server answer and device history", () => {
    let compared = 0;
    for (const answer of answers) {
      for (const guide of [null, PAYLOADS.noSteps]) {
        for (const history of histories) {
          for (const [hasPasskey, signedInAt, welcomeTourActive] of [[false, NOW - DAY, false], [null, NOW - DAY, false], [false, NOW - 60_000, false], [false, NOW - DAY, true]]) {
            const context = { welcomeTourActive, passkeySupported: true, hasPasskey, signedInAt, history };
            const product = chooseHomeNudge({ server: normalizeHomeNudges(answer, guide), ...context, now: NOW });
            const engine = plan({ now: NOW, guide, nudges: answer, nudgesState: "ready", nudgeContext: context }).nudge;
            expect(engine?.kind ?? null).toBe(product?.kind ?? null);
            if (product?.kind === "onboarding") expect(engine.params).toEqual({ step: product.completed + 1, total: product.total });
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(280);
  });

  it("reads the server's answer as it arrived for the engine, and refuses on error", async () => {
    await expect(readMemberOnboardingGuide({ rpc: vi.fn().mockResolvedValue({ data: PAYLOADS.activate, error: null }) })).resolves.toBe(PAYLOADS.activate);
    await expect(readMemberOnboardingGuide({ rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })).resolves.toBeNull();
    await expect(readMemberOnboardingGuide(null)).resolves.toBeNull();
    await expect(readMemberOnboardingGuide({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) })).rejects.toMatchObject({ code: "42501" });
  });
});

describe("proposed layers stay off unless their own switch is on", () => {
  it("names two switches the product does not send", () => {
    expect(PROPOSED_MEMBER_SWITCHES).toEqual({ featureGuides: "features.guidance_onboarding.feature_guides", coachMarks: "features.guidance_onboarding.coach_marks" });
    expect(proposedSwitchOn(null, "featureGuides")).toBe(false);
    expect(proposedSwitchOn({ [PROPOSED_MEMBER_SWITCHES.featureGuides]: "true" }, "featureGuides")).toBe(false);
    expect(proposedSwitchOn({ [PROPOSED_MEMBER_SWITCHES.featureGuides]: true }, "featureGuides")).toBe(true);
  });

  it("returns no feature guides and no coach mark with the switches absent, and says why", () => {
    const view = plan({ now: NOW, hat: "member", switches: GUIDE_SWITCHES_ON, guide: PAYLOADS.welcomeDrip, screen: { view: "events" } });
    expect(view.featureGuides).toBeNull();
    expect(view.coachMark).toBeNull();
    const rule = (id) => view.decisions.find((decision) => decision.rule === id).why.key;
    expect(rule("R26")).toBe("guideEngine.why.r26.today");
    expect(rule("R36")).toBe("guideEngine.why.r36.today");
    expect(rule("R34")).toBe("guideEngine.why.r34.today");
  });

  it("turns each layer on only through its own switch", () => {
    const guidesOnly = plan({ now: NOW, hat: "member", switches: { ...GUIDE_SWITCHES_ON, [PROPOSED_MEMBER_SWITCHES.featureGuides]: true }, guide: PAYLOADS.welcomeDrip });
    expect(guidesOnly.featureGuides.items.map((item) => item.feature)).toEqual(["home", "member-support", "rights", "events", "messages", "pulse", "ballots", "settings"]);
    expect(guidesOnly.decisions.find((decision) => decision.rule === "R26").why.key).toBe("guideEngine.why.r26.today");
    expect(guidesOnly.decisions.find((decision) => decision.rule === "R34").why.key).toBe("guideEngine.why.r34.proposed");
    const coachOnly = plan({ now: NOW, hat: "member", switches: { ...GUIDE_SWITCHES_ON, [PROPOSED_MEMBER_SWITCHES.coachMarks]: true }, guide: PAYLOADS.welcomeDrip });
    expect(coachOnly.featureGuides).toBeNull();
    expect(coachOnly.decisions.find((decision) => decision.rule === "R26").why.key).toBe("guideEngine.why.r26.notReached");
  });
});

describe("R36 per-feature guides for workers (proposed)", () => {
  const base = { on: true, memberHat: true, memberOnly: true };

  it("lists every worker feature as Optional, in the engine's order, with product names", () => {
    const { view, why } = memberFeatureGuides(base);
    expect(view.items).toHaveLength(8);
    expect(view.items.every((item) => item.optional && !item.done)).toBe(true);
    expect(view.items.map((item) => item.title.key)).toEqual(["nav.home", "nav.memberSupport", "nav.knowRights", "morehub.events", "nav.messages", "morehub.beHeard", "nav.voting", "nav.settings"]);
    expect(view.items[0].why.key).toBe("guideEngine.why.r36.core");
    expect(view.items[1].why.key).toBe("guideEngine.why.r36.rest");
    expect(view.showing).toBeNull();
    expect(why).toEqual({ key: "guideEngine.why.r36.list", params: { count: 8, done: 0 } });
    expect(featureOfView("voice")).toBe("pulse");
    expect(featureOfView("issues")).toBeNull();
  });

  it("gives no guide to the staff hat or to a person who is not worker only", () => {
    expect(memberFeatureGuides({ ...base, memberHat: false })).toEqual({ view: null, why: { key: "guideEngine.why.r2.noStaffToday" } });
    expect(memberFeatureGuides({ ...base, memberOnly: false })).toEqual({ view: null, why: { key: "guideEngine.why.r2.notMemberOnly" } });
    expect(plan({ now: NOW, hat: "member", switches: LAYERS_ON, guide: PAYLOADS.staff }).featureGuides).toBeNull();
    expect(plan({ now: NOW, hat: "member", switches: LAYERS_ON, guide: null, who: { memberOnlyAccount: true } }).featureGuides).not.toBeNull();
  });

  it("names the worker's one committee worker in the Ask line and the Worker support action, never a made-up one", () => {
    const named = memberFeatureGuides({ ...base, stewardName: " Robin Vale " }).view.items.find((item) => item.feature === "member-support");
    expect(named.askWho).toEqual({ key: "guideEngine.fg.member.askName", params: { name: "Robin Vale" } });
    expect(named.firstLabel).toEqual({ key: "guideEngine.fg.memberFirst.memberSupport.name", params: { name: "Robin Vale" } });
    const unnamed = memberFeatureGuides({ ...base, stewardName: "" }).view.items.find((item) => item.feature === "member-support");
    expect(unnamed.askWho).toBeNull();
    expect(unnamed.firstLabel).toEqual({ key: "guideEngine.fg.default.memberSupport" });
  });

  it("shows a feature's guide on first reach until Got it, and again when reopened", () => {
    const first = memberFeatureGuides({ ...base, view: "events" });
    expect(first.view.showing.feature).toBe("events");
    expect(first.view.showingAs).toBe("first");
    expect(first.why).toEqual({ key: "guideEngine.why.r36.showing", params: { feature: { key: "morehub.events" } } });
    const seen = memberFeatureGuides({ ...base, view: "events", marks: { seen: { events: 10 } } });
    expect(seen.view.showingAs).toBe("first");
    const closed = memberFeatureGuides({ ...base, view: "events", marks: { seen: { events: 10 }, got: { events: 20 } } });
    expect(closed.view.showing).toBeNull();
    const reopened = memberFeatureGuides({ ...base, view: "events", marks: { seen: { events: 10 }, got: { events: 20 }, reopen: { events: 30 } } });
    expect(reopened.view.showingAs).toBe("reopened");
    const closedAgain = memberFeatureGuides({ ...base, view: "events", marks: { seen: { events: 10 }, got: { events: 40 }, reopen: { events: 30 } } });
    expect(closedAgain.view.showing).toBeNull();
    expect(memberFeatureGuides({ ...base, view: "issues" }).view.showing).toBeNull();
  });

  it("finishes a guide by its real action, telling done-before-opened from done", () => {
    const early = memberFeatureGuides({ ...base, view: "events", marks: { acted: { events: 5 } } });
    expect(early.view.done.map((item) => item.feature)).toEqual(["events"]);
    expect(early.view.done[0]).toMatchObject({ done: true, doneBeforeOpened: true, why: { key: "guideEngine.why.r36.done" } });
    expect(early.view.items).toHaveLength(7);
    const later = memberFeatureGuides({ ...base, marks: { seen: { events: 5 }, acted: { events: 9 } } });
    expect(later.view.done[0].doneBeforeOpened).toBe(false);
    expect(later.why.params).toEqual({ count: 8, done: 1 });
  });

  it("labels Be heard's first action as what it does: sharing, since Be heard has no answer action (gate round 1)", () => {
    const pulse = memberFeatureGuides(base).view.items.find((item) => item.feature === "pulse");
    expect(pulse.firstLabel).toEqual({ key: "guideEngine.fg.first.pulse" });
    expect(catalogue.en["guideEngine.fg.first.pulse"]).toBe("Share what's going on");
    expect(catalogue.es["guideEngine.fg.first.pulse"]).toBe("Cuenta lo que pasa");
  });

  it("marks only the two looking guides as done by their own button", () => {
    expect(MEMBER_FEATURES.filter((entry) => entry.doneOnPrimary).map((entry) => entry.feature)).toEqual(["home", "ballots"]);
  });
});

describe("R26 coach marks (proposed)", () => {
  const ready = { on: true, applies: true, anchor: "next-step:s2", control: "Meet your committee contact", anchorReached: true, secondsOnScreen: COACH_MARK_WAIT_SECONDS };
  const whyOf = (input) => coachMarkDecision(input).why.key.replace("guideEngine.why.r26.", "");

  it("shows one mark for the next step's control once every condition holds", () => {
    expect(coachMarkDecision(ready)).toEqual({ show: true, anchor: "next-step:s2", why: { key: "guideEngine.why.r26.first", params: { control: "Meet your committee contact" } } });
  });

  it.each([
    ["switchOff", { on: false }],
    ["noGuide", { applies: false }],
    ["noGuide", { anchor: null }],
    ["notReached", { anchorReached: false }],
    ["wait", { secondsOnScreen: COACH_MARK_WAIT_SECONDS - 1 }],
    ["held", { featureGuideOpen: true }],
    ["blocked", { blocked: true }],
    ["oneSession", { shownThisSession: "next-step:s1" }],
    ["seen", { seen: { "next-step:s2": 5 } }],
  ])("holds the mark back: %s", (expected, patch) => {
    expect(whyOf({ ...ready, ...patch })).toBe(expected);
    expect(coachMarkDecision({ ...ready, ...patch }).show).toBe(false);
  });

  it("keeps this session's mark on screen until Got it, even when the timer restarts", () => {
    expect(coachMarkDecision({ ...ready, secondsOnScreen: 0, shownThisSession: "next-step:s2" }).show).toBe(true);
  });

  it("hides this session's mark while a dialog or a feature guide is open, and brings it back after (gate round 1)", () => {
    expect(whyOf({ ...ready, shownThisSession: "next-step:s2", blocked: true })).toBe("blocked");
    expect(whyOf({ ...ready, shownThisSession: "next-step:s2", featureGuideOpen: true })).toBe("held");
    expect(coachMarkDecision({ ...ready, shownThisSession: "next-step:s2", secondsOnScreen: 0 }).show).toBe(true);
  });

  it("anchors to the Complete button of the server's next step, with the product's own words", () => {
    const view = plan({ now: NOW, hat: "member", switches: LAYERS_ON, guide: PAYLOADS.welcomeDrip, layers: { coach: { anchorReached: true, secondsOnScreen: 10 } } });
    expect(view.coachMark).toEqual({ anchor: `next-step:${stepId(2)}`, titleKey: "onboardingGuide.spotlight", bodyKey: "onboardingGuide.nextStep", params: { title: "Meet your committee contact" } });
    expect(plan({ now: NOW, hat: "member", switches: LAYERS_ON, guide: PAYLOADS.notEnrolled, layers: { coach: { anchorReached: true, secondsOnScreen: 10 } } }).coachMark).toBeNull();
    expect(plan({ now: NOW, hat: "member", switches: LAYERS_ON, guide: PAYLOADS.welcomeDrip, screen: { view: "memberSupport" }, layers: { coach: { anchorReached: true, secondsOnScreen: 10 } } }).coachMark).toBeNull();
  });
});

describe("device marks for the layers", () => {
  it("keeps first-shown and first-done times, moves Got it, and drops tampered values", () => {
    expect(guideLayerStorageKeys(null)).toBeNull();
    writeFeatureGuideMark("m-1", "seen", "events", 10);
    writeFeatureGuideMark("m-1", "seen", "events", 20);
    writeFeatureGuideMark("m-1", "got", "events", 30);
    writeFeatureGuideMark("m-1", "got", "events", 40);
    writeFeatureGuideMark("m-1", "nope", "events", 50);
    expect(readFeatureGuideMarks("m-1")).toEqual({ seen: { events: 10 }, got: { events: 40 }, reopen: {}, acted: {} });
    window.localStorage.setItem("sg:member:m-1:onboarding-guide:feature-guides", JSON.stringify({ seen: { events: "x", "<b>": 3, rights: 4 }, acted: [1] }));
    expect(readFeatureGuideMarks("m-1")).toEqual({ seen: { rights: 4 }, got: {}, reopen: {}, acted: {} });
    window.localStorage.setItem("sg:member:m-1:onboarding-guide:feature-guides", "not json");
    expect(readFeatureGuideMarks("m-1").seen).toEqual({});
    writeCoachMarkSeen("m-1", "next-step:s2", 7);
    window.localStorage.setItem("sg:member:m-2:onboarding-guide:coach-marks", JSON.stringify({ seen: { "javascript:x": 1, "next-step:s3": 2 } }));
    expect(readCoachMarksSeen("m-1")).toEqual({ "next-step:s2": 7 });
    expect(readCoachMarksSeen("m-2")).toEqual({ "next-step:s3": 2 });
    writeCoachMarkSession("m-1", "next-step:s2");
    expect(readCoachMarkSession("m-1")).toBe("next-step:s2");
    expect(window.sessionStorage.getItem("sg:member:m-1:onboarding-guide:coach-mark-shown")).toBe("next-step:s2");
  });

  it("writes nothing while both switches are off, and counts a real action only when feature guides are on", () => {
    const off = renderHook(() => useMemberGuideLayers({ memberId: "m-1", featureGuidesOn: false, coachMarksOn: false }));
    act(() => { announceGuideAction("events", window); off.result.current.markFeature("seen", "events"); off.result.current.markCoachShown("next-step:s2"); off.result.current.markCoachSeen("next-step:s2"); });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    off.unmount();
    const on = renderHook(() => useMemberGuideLayers({ memberId: "m-1", featureGuidesOn: true, coachMarksOn: true }));
    act(() => { window.dispatchEvent(new CustomEvent(ONBOARDING_GUIDE_ACTION_EVENT, { detail: { feature: "events" } })); });
    expect(on.result.current.featureMarks.acted.events).toEqual(expect.any(Number));
    act(() => { on.result.current.markFeature("got", "events"); on.result.current.markCoachShown("next-step:s2"); });
    expect(on.result.current.featureMarks.got.events).toEqual(expect.any(Number));
    expect(on.result.current.coachSession).toBe("next-step:s2");
    act(() => { on.result.current.markCoachShown("next-step:s2"); on.result.current.markCoachSeen("next-step:s2"); });
    expect(on.result.current.coachSeen["next-step:s2"]).toEqual(expect.any(Number));
    on.unmount();
  });

  it("measures the screen for R26 only while active", () => {
    vi.useFakeTimers();
    const anchor = document.createElement("button");
    anchor.setAttribute("data-guide-anchor", "next-step");
    document.body.append(anchor);
    const idle = renderHook(() => useCoachMarkFacts({ active: false, screenKey: "memberSupport" }));
    expect(idle.result.current).toEqual({ secondsOnScreen: 0, anchorReached: false, blocked: false });
    idle.unmount();
    const live = renderHook(() => useCoachMarkFacts({ active: true, screenKey: "memberSupport" }));
    expect(live.result.current.anchorReached).toBe(true);
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(live.result.current.secondsOnScreen).toBe(10);
    live.unmount();
    anchor.remove();
  });
});

describe("gate round 1 repairs", () => {
  it.each(["queued first", "committed first"])("isolates concurrent RSVP guide outcomes when %s", async order => {
    const source = readFileSync("src/App.jsx", "utf8");
    const mutationStart = source.indexOf("  async function mutate(");
    const mutation = source.slice(mutationStart, source.indexOf("\n  function handlePlanAction", mutationStart));
    const rsvpStart = source.indexOf("  async function handleRsvp(");
    const rsvp = source.slice(rsvpStart, source.indexOf("\n  async function handleCheckIn", rsvpStart));
    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    };
    const queuedWrite = deferred(), committedWrite = deferred(), refreshed = deferred();
    const offline = new Error("offline");
    const refresh = vi.fn(() => refreshed.promise);
    const env = {
      memberOperation: { run: fn => fn(), wait: value => value, assertCurrent: () => {} },
      demoActive: false, sessionRef: { current: { user: { id: "m-1" } } },
      isOfflineError: error => error === offline, enqueueOffline: async () => true,
      setNotice: vi.fn(), tr: key => key,
      isStepUpRequired: () => false, mutationFailureNotice: () => "failed", refresh,
      // The pseudonymous product-analytics action (#6247) is outside this proof.
      captureProductAction: () => false,
      // So is the learning period's practice-history link on the toast (#6947).
      learningToastAction: () => null, learningPeriod: null,
      data: { events: [] }, memberMutationResources: () => ["events"], supabase: {},
      submitEventRsvp: (_client, id) => id === "queued-event" ? queuedWrite.promise : committedWrite.promise,
    };
    // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
    const handler = new Function(...Object.keys(env), `const sessionDataClient = supabase;\n${mutation}\n${rsvp}\nreturn handleRsvp;`)(...Object.values(env));
    const target = new EventTarget(), heard = vi.fn();
    target.addEventListener(ONBOARDING_GUIDE_ACTION_EVENT, event => heard(event.detail.feature));
    const action = countGuideAction("events", handler, target);
    const queuedAction = action("queued-event", "going");
    const committedAction = action("committed-event", "going");
    if (order === "queued first") {
      queuedWrite.reject(offline);
      await expect(queuedAction).resolves.toBeNull();
    }
    committedWrite.resolve({ awardedPoints: 0 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(heard).not.toHaveBeenCalled();
    refreshed.resolve();
    await expect(committedAction).resolves.toEqual({ awardedPoints: 0 });
    if (order === "committed first") {
      queuedWrite.reject(offline);
      await expect(queuedAction).resolves.toBeNull();
    }
    expect(heard).toHaveBeenCalledExactlyOnceWith("events");
  });

  it("records a first-shown guide once even when the parent passes a new callback every render", () => {
    const calls = vi.fn();
    function Shell() {
      const layers = useMemberGuideLayers({ memberId: "m-1", featureGuidesOn: true, coachMarksOn: false });
      const view = memberFeatureGuides({ on: true, memberHat: true, memberOnly: true, view: "events", marks: layers.featureMarks }).view;
      return <MemberFeatureGuide guides={view} onSeen={(feature) => { calls(feature); layers.markFeature("seen", feature); }} />;
    }
    wrap(<Shell />);
    expect(screen.getByRole("heading", { name: "About Meetings" })).toBeInTheDocument();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(readFeatureGuideMarks("m-1").seen.events).toEqual(expect.any(Number));
  });

  it("counts an action only once its write lands, not when it was only queued offline", async () => {
    const target = new EventTarget();
    const heard = vi.fn();
    target.addEventListener(ONBOARDING_GUIDE_ACTION_EVENT, (event) => heard(event.detail.feature));
    const landed = countGuideAction("events", async () => ({ status: "committed", value: { ok: true } }), target);
    await expect(landed("e-1", "going")).resolves.toEqual({ ok: true });
    const offline = countGuideAction("events", async () => ({ status: "queued", value: null }), target);
    await expect(offline("e-1", "going")).resolves.toBeNull();
    const notSaved = countGuideAction("events", async () => ({ status: "not_saved", value: null }), target);
    await expect(notSaved()).resolves.toBeNull();
    const stale = countGuideAction("events", async () => undefined, target);
    await expect(stale()).resolves.toBeUndefined();
    const failed = countGuideAction("events", async () => { throw new Error("refused"); }, target);
    await expect(failed()).rejects.toThrow("refused");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith("events");
  });

  // BUG-UG-FEATURE-GUIDE-SESSION-COMPLETION-20261025: member A's
  // delayed RSVP settles after the same tab switched to member B and B's guide
  // listener mounted. Neither a superseded run nor a write that committed for A
  // may finish B's Events guide; the current session's own write still does.
  it("never finishes the next worker's guide from a delayed action after a same-tab account switch", async () => {
    const guard = createSessionGuard();
    guard.beginSession("user-a");
    const sessionA = guard.captureOperation();
    const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
    const write = deferred(), settle = deferred();
    // Superseded inside the guard: A's write resolves after the switch, so run() resolves undefined.
    const superseded = countGuideAction("events", () => sessionA.run(async () => {
      await write.promise; return { status: "committed", value: { rsvp: "a" } };
    }), window, sessionA);
    // Committed for A, then the handler settles after the switch.
    const committed = countGuideAction("events", async () => {
      const outcome = await sessionA.run(async () => ({ status: "committed", value: { rsvp: "a" } }));
      await settle.promise;
      return outcome;
    }, window, sessionA);
    const pendingSuperseded = superseded("e-1", "going");
    const pendingCommitted = committed("e-1", "going");
    await Promise.resolve();
    guard.beginSession("user-b");
    const sessionB = guard.captureOperation();
    const { result } = renderHook(() => useMemberGuideLayers({ memberId: "member-b", featureGuidesOn: true, coachMarksOn: false }));
    write.resolve();
    settle.resolve();
    await act(async () => {
      await expect(pendingSuperseded).resolves.toBeUndefined();
      await expect(pendingCommitted).resolves.toEqual({ rsvp: "a" });
    });
    expect(result.current.featureMarks.acted?.events).toBeUndefined();
    expect(readFeatureGuideMarks("member-b").acted?.events).toBeUndefined();
    // B's own committed RSVP still finishes B's guide.
    const own = countGuideAction("events", () => sessionB.run(async () => ({ status: "committed", value: { rsvp: "b" } })), window, sessionB);
    await act(async () => { await expect(own("e-1", "going")).resolves.toEqual({ rsvp: "b" }); });
    expect(result.current.featureMarks.acted?.events).toEqual(expect.any(Number));
    // The shell hands each wrapper the session operation of the render that built it.
    expect(readFileSync("src/App.jsx", "utf8")).toContain("countGuideAction(feature, handler, globalThis, memberOperation)");
  });

  it("keeps guide observation off and returns the raw action value while the switch is off", async () => {
    const source = readFileSync("src/App.jsx", "utf8");
    const expression = source.split("\n").find(line => line.includes("const guideActionAfter ="))
      .split("const guideActionAfter = ")[1].replace(/;$/u, "");
    const observe = vi.fn();
    // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
    const wrapAction = new Function("featureGuidesOn", "countGuideAction", `return (${expression});`)(false, observe);
    const action = wrapAction("events", async () => ({ status: "committed", value: { saved: true } }));
    await expect(action()).resolves.toEqual({ saved: true });
    expect(observe).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(guideLayerStorageKeys("m-1").featureGuides)).toBeNull();
  });

  it("leaves Escape to an open dialog instead of closing the coach mark for good", () => {
    const onClose = vi.fn();
    const mark = { anchor: "next-step:s2", titleKey: "onboardingGuide.spotlight", bodyKey: "onboardingGuide.nextStep", params: { title: "Meet your committee contact" } };
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    dialog.getClientRects = () => [{ width: 10, height: 10 }];
    document.body.append(dialog);
    wrap(<MemberCoachMark mark={mark} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    dialog.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays silent on a page load and speaks when the in-app move is noted after the card mounted", async () => {
    vi.resetModules();
    const fresh = await import("../src/features/onboardingGuideEngine/MemberGuideLayers.jsx");
    const { LanguageProvider: FreshProvider } = await import("../src/lib/LanguageContext.jsx");
    const guides = memberFeatureGuides({ on: true, memberHat: true, memberOnly: true, view: "rights" }).view;
    vi.useFakeTimers();
    const load = render(<FreshProvider lang="en"><fresh.MemberFeatureGuide guides={guides} /></FreshProvider>);
    act(() => { vi.advanceTimersByTime(100); });
    expect(load.container.querySelector("[role=\"status\"]").textContent).toBe("");
    load.unmount();
    const moved = render(<FreshProvider lang="en"><fresh.MemberFeatureGuide guides={guides} /></FreshProvider>);
    fresh.noteGuideNavigation();
    act(() => { vi.advanceTimersByTime(100); });
    expect(moved.container.querySelector("[role=\"status\"]").textContent).toBe("Guide for Organizing rights.");
  });
});

describe("gate round 2 repairs", () => {
  const COACH = { titleKey: "onboardingGuide.spotlight", bodyKey: "onboardingGuide.nextStep", params: { title: "Meet your committee contact" } };
  function CoachShell({ blocked, seconds }) {
    const layers = useMemberGuideLayers({ memberId: "m-2", featureGuidesOn: false, coachMarksOn: true });
    const decision = coachMarkDecision({ on: true, applies: true, anchor: "next-step:s2", control: "Complete", anchorReached: true, secondsOnScreen: seconds, blocked, shownThisSession: layers.coachSession, seen: layers.coachSeen });
    return decision.show ? <MemberCoachMark mark={{ anchor: decision.anchor, ...COACH }} onShown={layers.markCoachShown} onClose={layers.markCoachSeen} /> : null;
  }
  const at = (blocked, seconds) => <LanguageProvider lang="en"><CoachShell blocked={blocked} seconds={seconds} /></LanguageProvider>;

  it("brings this session's coach mark back when the dialog that hid it closes", () => {
    const view = render(at(false, COACH_MARK_WAIT_SECONDS));
    expect(screen.getByText("Meet your committee contact", { exact: false })).toBeInTheDocument();
    expect(readCoachMarkSession("m-2")).toBe("next-step:s2");
    view.rerender(at(true, 0));
    expect(screen.queryByText("Meet your committee contact", { exact: false })).toBeNull();
    expect(readCoachMarkSession("m-2")).toBe("next-step:s2");
    view.rerender(at(false, 0));
    expect(screen.getByText("Meet your committee contact", { exact: false })).toBeInTheDocument();
  });

  it("keeps only a next-step anchor as this session's mark", () => {
    writeCoachMarkSession("m-2", "next-step:s2");
    writeCoachMarkSession("m-2", null);
    writeCoachMarkSession("m-2", "elsewhere");
    expect(readCoachMarkSession("m-2")).toBe("next-step:s2");
    window.sessionStorage.setItem(guideLayerStorageKeys("m-2").coachSession, "null");
    expect(readCoachMarkSession("m-2")).toBeNull();
  });

  it("hides the Home nudge as the product does when a stored time is outside the date range", () => {
    const answer = { passkey: false, onboarding: { completed: 0, total: 2 }, guidedFirstRun: false, snoozeDays: 28 };
    for (const history of [{ onboarding: { dismissedAt: 1e20 } }, { onboarding: { shownAt: 1e20 } }]) {
      const context = { welcomeTourActive: false, passkeySupported: true, hasPasskey: false, signedInAt: NOW - DAY, history };
      const product = chooseHomeNudge({ server: normalizeHomeNudges(answer, null), ...context, now: NOW });
      const engine = plan({ now: NOW, guide: null, nudges: answer, nudgesState: "ready", nudgeContext: context }).nudge;
      expect(product).toBeNull();
      expect(engine).toBeNull();
    }
  });
});

describe("the layers on screen", () => {
  const guides = (marks = {}, view = "events") => memberFeatureGuides({ on: true, memberHat: true, memberOnly: true, view, stewardName: "Robin Vale", marks }).view;

  it("renders the feature guide inline, with You can, Never and Ask, and never takes focus", () => {
    const onPrimary = vi.fn();
    const onGotIt = vi.fn();
    const onSeen = vi.fn();
    const before = document.activeElement;
    wrap(<MemberFeatureGuide guides={guides()} onPrimary={onPrimary} onGotIt={onGotIt} onSeen={onSeen} />);
    const card = document.querySelector("[data-guide-surface=\"feature-guide\"]");
    expect(card.tagName).toBe("SECTION");
    expect(card.getAttribute("role")).toBeNull();
    // B-52 (#9525): the heading itself says "About Events"; it no longer
    // repeats a page titled Events.
    expect(within(card).getByRole("heading", { name: "About Meetings" })).toBeInTheDocument();
    expect(within(card).queryByRole("heading", { name: "Meetings" })).toBeNull();
    expect(within(card).getByText("Optional guide")).toBeInTheDocument();
    expect(within(card).getByText("See campaign meetings and RSVP.")).toBeInTheDocument();
    // Events carries the member rule, not the Voting page line (BUG-UG-EVENTS-GUIDE-REPEATS-VOTING-NEVER-20261106).
    expect(within(card).getByText("Post a coworker's health, discipline or personal details.")).toBeInTheDocument();
    expect(within(card).queryByText("Need to tell anyone how you voted.")).toBeNull();
    expect(within(card).getByText("Ask Robin Vale, your committee contact")).toBeInTheDocument();
    expect(document.activeElement).toBe(before);
    expect(onSeen).toHaveBeenCalledWith("events");
    fireEvent.click(within(card).getByRole("button", { name: "RSVP to a meeting" }));
    expect(onPrimary).toHaveBeenCalledWith(expect.objectContaining({ feature: "events" }));
    fireEvent.click(within(card).getByRole("button", { name: "Got it" }));
    expect(within(card).getByRole("button", { name: "Got it" })).toHaveClass("member-guide-card__quiet");
    expect(onGotIt).toHaveBeenCalledWith(expect.objectContaining({ feature: "events" }));
  });

  it("says done before opened, offers only Got it, and speaks after an in-app move", () => {
    noteGuideNavigation();
    vi.useFakeTimers();
    wrap(<MemberFeatureGuide guides={guides({ acted: { events: 1 } })} />);
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByText("Done before you opened this guide")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "RSVP to a meeting" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Guide for Meetings.");
    expect(screen.getByRole("button", { name: "Got it" })).toHaveClass("member-guide-card__quiet");
  });

  it("renders nothing without a guide to show", () => {
    const { container } = wrap(<MemberFeatureGuide guides={guides({}, "issues")} />);
    expect(container.innerHTML).toBe("");
    expect(wrap(<MemberGuideList guides={null} />).container.innerHTML).toBe("");
  });

  it("lists Your guides in order with Done folded, and reopens one", () => {
    const onOpen = vi.fn();
    wrap(<MemberGuideList guides={guides({ acted: { events: 1, ballots: 2 }, seen: { ballots: 1 } })} onOpen={onOpen} />);
    const list = screen.getByRole("region", { name: "Your guides" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    const fold = within(list).getByRole("button", { name: "Done (2)" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(fold);
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(within(list).getByText("Done before you opened this guide")).toBeInTheDocument();
    expect(within(list).getAllByText("Done").length).toBeGreaterThan(0);
    fireEvent.click(within(list).getByRole("button", { name: /Organizing rights/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ feature: "rights", view: "rights", path: "/m/rights" }));
  });

  it("shows the coach mark as a note under its control, closed by Got it or Escape", () => {
    const onShown = vi.fn();
    const onClose = vi.fn();
    const mark = { anchor: "next-step:s2", titleKey: "onboardingGuide.spotlight", bodyKey: "onboardingGuide.nextStep", params: { title: "Meet your committee contact" } };
    wrap(<MemberCoachMark mark={mark} onShown={onShown} onClose={onClose} />);
    expect(onShown).toHaveBeenCalledWith("next-step:s2");
    expect(document.getElementById(COACH_MARK_ID)).toHaveTextContent("Next stepNext step: Meet your committee contact");
    expect(document.querySelector("[aria-modal]")).toBeNull();
    expect(screen.getByRole("button", { name: "Got it" })).toHaveClass("member-guide-card__quiet");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(wrap(<MemberCoachMark mark={null} />).container.innerHTML).toBe("");
  });
});

describe("the engine's lines in the barrels", () => {
  it("resolves every layer line in English and Spanish through the barrel", () => {
    const keys = new Set(["guideEngine.fg.about", "guideEngine.fg.gotIt", "guideEngine.fg.yourGuides", "guideEngine.fg.member.askName", "guideEngine.fg.memberFirst.memberSupport.name", "guideEngine.fg.default.memberSupport"]);
    for (const entry of MEMBER_FEATURES) for (const key of [...entry.can, ...entry.never, entry.firstKey, entry.nameKey]) keys.add(key);
    for (const key of keys) {
      expect(typeof catalogue.en[key], key).toBe("string");
      expect(typeof catalogue.es[key], key).toBe("string");
    }
  });

  it("does not assume a real committee worker's gender in Spanish", () => {
    expect(catalogue.es["guideEngine.fg.member.askName"]).toBe("{name}, tu representante sindical");
    expect(catalogue.es["guideEngine.fg.memberFirst.memberSupport.name"]).toBe("Saluda a {name}, tu representante sindical");
  });
});
