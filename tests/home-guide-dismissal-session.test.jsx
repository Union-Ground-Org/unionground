// BUG-UG-HOME-GUIDE-DISMISSAL-SESSION-AND-FAILED-READ-NUDGE-TEST-20261027:
// since #6162 Home renders the onboarding guide card inside its own guidance
// slot while other member destinations keep the shell-level card, so the card
// that takes a Dismiss click is unmounted by the next navigation. When the
// device write fails (quota, denied storage), the put-away choice must still
// hold for the session: a remount on another route, or back on Home, must not
// show the completed card again.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { OnboardingHud } from "../src/components/OnboardingHud.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { forgetGuideCompleteDismissedThisSession } from "../src/lib/onboardingGuide.js";

const COMPLETE_GUIDE = Object.freeze({
  state: "ready",
  applies: true,
  memberOnly: true,
  programConfigured: true,
  enrolled: true,
  totalSteps: 6,
  completedSteps: 6,
  onboardingComplete: true,
  progressiveDisclosureActive: false,
  stage: "complete",
  nextStep: null,
  featureDrip: true,
  showHud: true,
  spotlight: null,
  badge: "ready_to_roll",
  switches: { featureDrip: true, hudTooltips: true, spotlight: true, progressiveDisclosure: true, badgeAchievements: true },
});

vi.mock("../src/lib/useMemberOnboardingGuide.js", () => ({
  useMemberOnboardingGuide: () => ({ guide: COMPLETE_GUIDE, payload: COMPLETE_GUIDE, showAll: false, setShowAll: () => {} }),
}));
vi.mock("../src/lib/onboardingGuide.js", async (importOriginal) => ({
  ...(await importOriginal()),
  onboardingGuideSwitchesOn: () => true,
}));

const COMPLETE = "Onboarding complete";

function refuseWrites() {
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function refuse(key, value) {
    if (key.endsWith(":onboarding-guide:complete-dismissed")) throw new DOMException("QuotaExceededError", "QuotaExceededError");
    return setItem.call(this, key, value);
  });
}

function go(path) {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  forgetGuideCompleteDismissedThisSession();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});
afterEach(() => vi.restoreAllMocks());

describe("completed guide dismissal across remounts when storage writes fail", () => {
  it("keeps the card away on a fresh mount of the same member's card", () => {
    refuseWrites();
    const first = render(<LanguageProvider><OnboardingHud guide={COMPLETE_GUIDE} memberId="member-a" onNavigate={() => {}} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("heading", { name: COMPLETE })).toBeNull();
    expect(window.localStorage.getItem("sg:member:member-a:onboarding-guide:complete-dismissed")).toBeNull();
    first.unmount();
    render(<LanguageProvider><OnboardingHud guide={COMPLETE_GUIDE} memberId="member-a" onNavigate={() => {}} /></LanguageProvider>);
    expect(screen.queryByRole("heading", { name: COMPLETE })).toBeNull();
    render(<LanguageProvider><OnboardingHud guide={COMPLETE_GUIDE} memberId="member-b" onNavigate={() => {}} /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: COMPLETE })).toBeInTheDocument();
  });

  it("keeps the card away through the real shell after navigating off Home and back", async () => {
    refuseWrites();
    render(<App />);
    await screen.findByRole("heading", { name: /Good (morning|afternoon|evening)/ });
    const card = await screen.findByRole("heading", { name: COMPLETE });
    expect(document.querySelectorAll(".onboarding-hud")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(card).not.toBeInTheDocument();
    expect(document.querySelector(".onboarding-hud")).toBeNull();
    go("/m/events");
    await screen.findAllByRole("heading", { name: /meetings/i });
    expect(document.querySelector(".onboarding-hud")).toBeNull();
    expect(screen.queryByRole("heading", { name: COMPLETE })).toBeNull();
    go("/m");
    await screen.findByRole("heading", { name: /Good (morning|afternoon|evening)/ });
    expect(document.querySelector(".onboarding-hud")).toBeNull();
    expect(screen.queryByRole("heading", { name: COMPLETE })).toBeNull();
  });
});
