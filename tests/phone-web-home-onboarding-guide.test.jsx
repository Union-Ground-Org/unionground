// BUG-UG-PHONE-WEB-HOME-HIDES-ONBOARDING-GUIDE-20261018: on
// phone-width web, Home must show the onboarding guide card while the guide
// is active. The desktop and tablet shells render the card in the app column
// above the view; the phone shell has no such chrome, so TodayView's phone
// branch places the same card in its own card flow, next to the nudge slot
// the server empties (guidedFirstRun true, onboarding null) while the guide
// runs.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { OnboardingHud } from "../src/components/OnboardingHud.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const OPEN_CHECKLIST = catalogue.en["onboardingGuide.openOnboarding"];

const ACTIVE_GUIDE = Object.freeze({
  state: "ready",
  applies: true,
  memberOnly: true,
  programConfigured: true,
  enrolled: true,
  totalSteps: 6,
  completedSteps: 1,
  onboardingComplete: false,
  progressiveDisclosureActive: true,
  stage: "welcome",
  nextStep: { id: "step-2", title: "Meet your steward" },
  featureDrip: true,
  showHud: true,
  spotlight: "member-support",
  badge: "new_member",
  switches: { featureDrip: true, hudTooltips: true, spotlight: true, progressiveDisclosure: true, badgeAchievements: true },
});

// The shell hook is the only client-side source of the guide; the App test
// stands in for get_member_onboarding_guide answering an active guide. Since
// port step 2 the shell plans from the server's answer (`payload`), and the
// guide engine, like the hook, reads it only while an organization guide
// switch is on, so the test says the organization turned one on.
vi.mock("../src/lib/useMemberOnboardingGuide.js", () => ({
  useMemberOnboardingGuide: () => ({ guide: ACTIVE_GUIDE, payload: ACTIVE_GUIDE, showAll: false, setShowAll: () => {} }),
}));
vi.mock("../src/lib/onboardingGuide.js", async (importOriginal) => ({
  ...(await importOriginal()),
  onboardingGuideSwitchesOn: () => true,
}));

// The server's nudge answer while the guide is active (member_home_nudges
// migration): guidedFirstRun true, onboarding null, so no nudge is chosen.
function guidedNudgeTransport() {
  const rpc = vi.fn(async () => ({ data: { passkey: false, onboarding: null, guidedFirstRun: true, snoozeDays: 28 }, error: null }));
  return { createSessionClient: () => ({ rpc }), session: { access_token: "t", user: { last_sign_in_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() } } };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

describe("phone-width web Home with an active onboarding guide", () => {
  it("renders the guide card in the phone Home card flow while the server holds the nudge back", async () => {
    render(
      <LanguageProvider>
        <TodayView
          data={fallbackData}
          desktop={false}
          onPlanAction={() => {}}
          learningContent={guidedNudgeTransport()}
          homeNudges={{ onOpenOnboarding: vi.fn() }}
          onboardingHud={<OnboardingHud guide={ACTIVE_GUIDE} className="onboarding-hud--home" />}
        />
      </LanguageProvider>,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const home = document.querySelector(".screen--today.home");
    expect(home).not.toBeNull();
    const card = home.querySelector(".onboarding-hud");
    expect(card).not.toBeNull();
    expect(card.classList.contains("onboarding-hud--home")).toBe(true);
    expect(within(card).getByText("Getting started")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "Start with one clear next step" })).toBeInTheDocument();
    expect(within(card).getByText("Next step: Meet your steward")).toBeInTheDocument();
    expect(within(card).getByRole("progressbar")).toBeInTheDocument();
    expect(within(card).getByRole("button")).toBeInTheDocument();
    // The guide replaces the onboarding nudge; both would say the same thing.
    expect(screen.queryByRole("heading", { name: "Complete your onboarding" })).toBeNull();
    expect(document.querySelectorAll(".onboarding-hud")).toHaveLength(1);
  });

  it("renders the guide in the desktop Home slot, coordinated with the other nudges", () => {
    render(
      <LanguageProvider>
        <TodayView data={fallbackData} desktop onPlanAction={() => {}} onboardingHud={<OnboardingHud guide={ACTIVE_GUIDE} />} />
      </LanguageProvider>,
    );
    expect(document.querySelectorAll(".onboarding-hud")).toHaveLength(1);
  });

  it("shows the guide card once on phone-width Home through the real shell", async () => {
    // jsdom answers narrow to every media query, so render(<App />) is the
    // phone shell: no rail, the three-card Home space, TodayView's phone branch.
    render(<App />);
    const home = await screen.findByRole("heading", { name: /Good (morning|afternoon|evening)/ });
    expect(home).toBeInTheDocument();
    const cards = document.querySelectorAll(".onboarding-hud");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.classList.contains("onboarding-hud--home")).toBe(true);
    expect(document.querySelector(".card-nav__panel--home")?.contains(card)).toBe(true);
    expect(within(card).getByText("Getting started")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: OPEN_CHECKLIST })).toBeInTheDocument();
  });

  it("keeps the phone Home vote, quorum and quick-row actions working around the guide card", () => {
    // Coverage ratchet companion for the phone branch this record touches:
    // the hero vote, the second vote's Later, the quorum button and a quick
    // row all still reach onPlanAction with the guide card in the flow.
    const onPlanAction = vi.fn();
    render(
      <LanguageProvider>
        <TodayView data={fallbackData} desktop={false} onPlanAction={onPlanAction} onboardingHud={<OnboardingHud guide={ACTIVE_GUIDE} className="onboarding-hud--home" />} />
      </LanguageProvider>,
    );
    const en = catalogue.en;
    const hero = document.querySelector(".home-vote-hero:not(.home-vote-hero--second)");
    fireEvent.click(within(hero).getByRole("button", { name: en["today.castYourVote"] }));
    expect(onPlanAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ballot-2026", kind: "ballot" }));
    fireEvent.click(document.querySelector(".home-quorum"));
    expect(onPlanAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ballot-2026" }));
    const second = document.querySelector(".home-vote-hero--second");
    expect(second).not.toBeNull();
    fireEvent.click(within(second).getByRole("button", { name: en["today.later"] }));
    expect(document.querySelector(".home-vote-hero--second")).toBeNull();
    const row = Array.from(document.querySelectorAll(".home-row")).find((button) => within(button).queryByText(en["today.logWorkload"]) === null && !button.disabled);
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(onPlanAction).toHaveBeenCalledTimes(3);
    expect(document.querySelectorAll(".onboarding-hud")).toHaveLength(1);
  });
});
