import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TodayView } from "../src/views/TodayView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { hasPriorActivity, homeGreetingKey } from "../src/lib/homeGreeting.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// UX-UG-WEB-FIRST-HOME-WELCOME-BACK-AND-REWARDS-ERROR-20261018: a
// first-session member is not told "Welcome back", and an empty tier ladder is
// not reported as a catalog that could not load.
afterEach(cleanup);

const brandNew = {
  ...fallbackData,
  cases: [], conversations: [], notifications: [], planItems: [], events: [],
  rewards: { ...fallbackData.rewards, totalPoints: 0, weekStreak: 0, tierNumber: 1, tierName: "Member", nextTierName: null, pointsToGo: null, isMaxTier: false },
  rewardsCatalog: { ...fallbackData.rewardsCatalog, tiers: [], tiersUnavailable: false },
};
const returning = { ...brandNew, rewards: { ...brandNew.rewards, totalPoints: 120 } };
const heading = (lang, data) => {
  render(<LanguageProvider lang={lang}><TodayView data={data} desktop onPlanAction={() => {}} /></LanguageProvider>);
  return screen.getByRole("heading", { level: 1 }).textContent;
};

describe("Home greeting", () => {
  it("decides from the member's own activity, and treats an empty account as first-session", () => {
    expect(hasPriorActivity(brandNew)).toBe(false);
    expect(hasPriorActivity(returning)).toBe(true);
    expect(hasPriorActivity({ ...brandNew, cases: [{ id: "c1" }] })).toBe(true);
    // BUG-UG-WEB-HOME-GREETING-ACTIVITY-AND-TOP-TIER-SIGNALS-20261021:
    // conversations arrive only with the Messages resources, so they never decide
    // the greeting, and RSVPs are read from events, not plan items.
    expect(hasPriorActivity({ ...brandNew, conversations: [{ id: "k1" }] })).toBe(false);
    expect(hasPriorActivity({ ...brandNew, events: [{ id: "e1", rsvpStatus: "going" }] })).toBe(true);
    expect(hasPriorActivity({ ...brandNew, events: [{ id: "e1", rsvpStatus: null }] })).toBe(false);
    expect(hasPriorActivity({ ...brandNew, planItems: [{ id: "s1", kind: "survey", rsvpStatus: "going" }] })).toBe(false);
    expect(hasPriorActivity({ ...brandNew, notifications: [{ id: "n1", read_at: null }] })).toBe(false);
    expect(hasPriorActivity({ ...brandNew, notifications: [{ id: "n1", read_at: "2026-10-01T00:00:00Z" }] })).toBe(true);
    expect(hasPriorActivity({ ...brandNew, planItems: [{ id: "b1", kind: "ballot", receiptCode: "R-1" }] })).toBe(true);
    expect(hasPriorActivity(undefined)).toBe(false);
    expect(homeGreetingKey(brandNew)).toBe("today.welcome");
    expect(homeGreetingKey(returning)).toBe("today.welcomeBack");
  });



  it("ships both greetings in both catalogues", () => {
    for (const key of ["today.welcome", "today.welcomeBack"]) {
      expect(catalogue.en[key], key).toBeTruthy();
      expect(catalogue.es[key], key).toBeTruthy();
    }
    expect(catalogue.en["today.welcome"]).not.toMatch(/back/i);
    const firstGreeting = heading("en", brandNew);
    expect(firstGreeting).toContain("Welcome");
    expect(firstGreeting).not.toMatch(/back/i);
  });
});
