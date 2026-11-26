// BUG-UG-PASSWORD-PROMPT-OVERLAPS-ONBOARDING-20261020: web Home has
// one guidance slot. The choose-your-password prompt goes first, then the
// onboarding guide card, then the ordinary nudge; dismissing or clearing the
// one in front reveals the next, and nothing resets a dismissal. Desktop,
// responsive and alternate Home share the slot.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../src/views/TodayView.jsx";
import AltNowPage from "../src/alt/AltNowPage.jsx";
import { OnboardingHud } from "../src/components/OnboardingHud.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { forgetGuideCompleteDismissedThisSession } from "../src/lib/onboardingGuide.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const issuedAt = "2026-10-19T14:00:00.000Z";
const guide = { applies: true, showHud: true, stage: "welcome", totalSteps: 4, completedSteps: 1, featureDrip: true, nextStep: { id: "step-2", title: "Meet your steward" } };
const inactiveGuide = { ...guide, showHud: false };
const completeGuide = { ...guide, stage: "complete", onboardingComplete: true, completedSteps: 4 };
// The server's nudge answer for a member with an unfinished checklist whose
// organization runs no guided first run: the ordinary onboarding nudge.
const transport = {
  session: { access_token: "local-test", user: { id: "member-1" } },
  createSessionClient: () => ({ rpc: vi.fn(async () => ({ data: { onboarding: { completed: 1, total: 4 }, passkey: false, guidedFirstRun: false }, error: null })) }),
};
const PASSWORD = "Choose your own password";
const GUIDE = "Start with one clear next step";
const COMPLETE = "Onboarding complete";
const NUDGE = "Complete your onboarding";

// The put-away choice also lives in session memory now, so each case starts
// a fresh session as well as a fresh device.
beforeEach(() => { localStorage.clear(); forgetGuideCompleteDismissedThisSession(); });

describe.each([
  ["desktop", TodayView, true],
  ["responsive", TodayView, false],
  ["alternate", AltNowPage, true],
])("%s Home guidance slot", (_name, Home, desktop) => {
  function tree(activeGuide = guide, password = { userId: "member-1", issuedAt }) {
    return <LanguageProvider><Home data={fallbackData} desktop={desktop} onPlanAction={() => {}}
      learningContent={transport} homeNudges={{ onOpenOnboarding: vi.fn() }} choosePassword={password}
      onboardingHud={<OnboardingHud guide={activeGuide} memberId="member-1" className="onboarding-hud--home" />} /></LanguageProvider>;
  }

  it("shows the password prompt alone, then the guide, then the ordinary nudge, keeping the password dismissal", async () => {
    const view = render(tree());
    expect(screen.getByRole("heading", { name: PASSWORD })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: GUIDE })).toBeNull();
    expect(screen.queryByRole("heading", { name: NUDGE })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not now: hide the password reminder" }));
    expect(screen.getByRole("heading", { name: GUIDE })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: PASSWORD })).toBeNull();
    expect(screen.queryByRole("heading", { name: NUDGE })).toBeNull();
    expect(document.querySelectorAll(".onboarding-hud")).toHaveLength(1);
    view.rerender(tree(inactiveGuide));
    expect(await screen.findByRole("heading", { name: NUDGE })).toBeInTheDocument();
    expect(document.querySelector(".onboarding-hud")).toBeNull();
    view.rerender(tree());
    expect(screen.queryByRole("heading", { name: PASSWORD })).toBeNull();
    expect(screen.getByRole("heading", { name: GUIDE })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: NUDGE })).toBeNull();
  });

  it("shows the password prompt alone beside an ordinary onboarding nudge, which resumes once the stamp clears", async () => {
    const view = render(tree(inactiveGuide));
    expect(screen.getByRole("heading", { name: PASSWORD })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: NUDGE })).toBeNull();
    view.rerender(tree(inactiveGuide, null));
    expect(await screen.findByRole("heading", { name: NUDGE })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: PASSWORD })).toBeNull();
  });

  it("hands the slot from the finished guide card to the ordinary nudge when the member puts it away", async () => {
    render(tree(completeGuide, null));
    expect(screen.getByRole("heading", { name: COMPLETE })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: NUDGE })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector(".onboarding-hud")).toBeNull();
    expect(await screen.findByRole("heading", { name: NUDGE })).toBeInTheDocument();
  });

  it("keeps a failed guide read in the slot and suppresses the ordinary nudge the same Home would otherwise show", async () => {
    // BUG-UG-HOME-GUIDE-DISMISSAL-SESSION-AND-FAILED-READ-NUDGE-TEST-20261027:
    // one Home, first with the nudge showing, then the same Home's read fails.
    // The nudge is fetched asynchronously, so the assertion waits for the
    // mocked RPC and pending effects to settle before saying none remains.
    const rpc = vi.fn(async () => ({ data: { onboarding: { completed: 1, total: 4 }, passkey: false, guidedFirstRun: false }, error: null }));
    const settledTransport = { ...transport, createSessionClient: () => ({ rpc }) };
    const page = (activeGuide, failed) => <LanguageProvider><Home data={fallbackData} desktop={desktop} onPlanAction={() => {}}
      learningContent={settledTransport} homeNudges={{ onOpenOnboarding: vi.fn() }} choosePassword={null}
      onboardingHud={<OnboardingHud guide={activeGuide} memberId="member-1" loadFailed={failed} onRetry={() => {}} />} /></LanguageProvider>;
    const view = render(page(inactiveGuide, false));
    await screen.findByRole("heading", { name: NUDGE });
    const fetches = rpc.mock.calls.length;
    view.rerender(page(inactiveGuide, true));
    expect(document.querySelectorAll(".onboarding-hud--failed")).toHaveLength(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(screen.queryByRole("heading", { name: NUDGE })).toBeNull());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByRole("heading", { name: NUDGE })).toBeNull();
    expect(document.querySelectorAll(".onboarding-hud--failed")).toHaveLength(1);
    expect(rpc.mock.calls.length).toBe(fetches);
  });

  it("keeps Home's feature guide and \"Your guides\" after the content whichever prompt shows", async () => {
    const guides = <p data-testid="your-guides">Your guides</p>;
    const page = (activeGuide) => <LanguageProvider><Home data={fallbackData} desktop={desktop} onPlanAction={() => {}}
      learningContent={transport} homeNudges={{ onOpenOnboarding: vi.fn() }} choosePassword={{ userId: "member-1", issuedAt }}
      onboardingHud={<OnboardingHud guide={activeGuide} memberId="member-1" />} homeGuides={guides} /></LanguageProvider>;
    const view = render(page(guide));
    expect(screen.getByRole("heading", { name: PASSWORD })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: GUIDE })).toBeNull();
    expect(screen.getByTestId("your-guides")).toBeInTheDocument();
    const optionalGuide = screen.getByTestId("your-guides");
    expect(view.container.querySelector('.screen--today, .ug-now-page').lastElementChild).toBe(optionalGuide);
    fireEvent.click(screen.getByRole("button", { name: "Not now: hide the password reminder" }));
    expect(screen.getByRole("heading", { name: GUIDE })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: NUDGE })).toBeNull();
    expect(screen.getByTestId("your-guides")).toBeInTheDocument();
    view.rerender(page(inactiveGuide));
    expect(await screen.findByRole("heading", { name: NUDGE })).toBeInTheDocument();
    expect(screen.getByTestId("your-guides")).toBeInTheDocument();
  });
});
