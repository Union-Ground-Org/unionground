import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TodayView } from "../src/views/TodayView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// Upstream's finding 41 hid the points, tier and weekly-goal card on Home from
// officers and organizers. Union Ground has no points economy, so Home shows
// that card to nobody: members, officers and organizers all get Home without
// it, on the desktop canvas and on the phone.
afterEach(cleanup);

const withRoles = (chapterRoles, organizationRoles = [], roles = []) => ({
  ...fallbackData, roles, member: { ...fallbackData.member, chapterRoles, organizationRoles },
});

function renderHome(data, { desktop = false, lang = "en" } = {}) {
  return render(<LanguageProvider lang={lang}><TodayView data={data} desktop={desktop} onRewards={() => {}} /></LanguageProvider>);
}

describe("Home has no rewards card for any office", () => {
  it.each([
    [[], [], []],
    [["steward"], [], []],
    [[], ["admin"], []],
    [[], ["vp"], []],
    [["coordinator"], [], []],
    [["advisor"], [], []],
    [[], [], ["admin"]],
  ])("Home renders without points or tiers (%j %j %j)", (chapterRoles, organizationRoles, roles) => {
    for (const desktop of [false, true]) {
      for (const lang of ["en", "es"]) {
        const { container, unmount } = renderHome(withRoles(chapterRoles, organizationRoles, roles), { desktop, lang });
        expect(screen.queryByRole("region", { name: catalogue[lang]["today.rewardsStatus"] })).toBeNull();
        expect(container.querySelector(".home-hero, .home-chip--tier")).toBeNull();
        expect(container.textContent).not.toContain(catalogue[lang]["today.weeklyGoal"]);
        // The rest of Home still renders.
        expect(container.querySelector(".screen--today")).not.toBeNull();
        unmount();
      }
    }
  });
});
