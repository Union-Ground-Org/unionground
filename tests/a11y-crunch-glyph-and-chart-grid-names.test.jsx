// Accessible names on the Voting crunch chip, the VP membership-trend chart and
// the VP/advisor KPI grids
// (A11Y-UG-VOTING-CRUNCH-GLYPH-AND-VP-CHART-GRID-NAMES-20260920).
//
// Three defects, one record: the crunch chip concatenated a bare hourglass into
// its own text, so assistive technology read "hourglass not done" before the
// countdown; the trend chart named itself with a raw "2024: 718, 2025: 766"
// built outside the catalogue, so neither language said what was counted; and
// the two KPI grids hung an aria-label on a plain div with no role to carry it,
// while the admin/coordinator/steward siblings already carry role="group".
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdvisorView } from "../src/views/AdvisorView.jsx";
import { VotingView } from "../src/views/VotingView.jsx";
import { VpView } from "../src/views/VpView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const HOURGLASS = "⏳";

// The chip only renders its countdown inside the two-hour crunch window, so the
// close stamp is relative to the test clock rather than the fixture's fixed one.
function renderCrunchVoting() {
  const ballot = fallbackData.planItems.find((item) => item.kind === "ballot" && !item.closed);
  const data = {
    ...fallbackData,
    planItems: [{ ...ballot, receiptCode: "", closesAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }],
  };
  return render(
    <LanguageProvider lang="en">
      <VotingView data={data} demo desktop />
    </LanguageProvider>,
  );
}

function renderVp(lang, overrides = {}) {
  const desk = overrides.desk || JSON.parse(JSON.stringify(fallbackData.vpOverview));
  const api = { loadDesk: vi.fn().mockResolvedValue(desk), markReviewed: vi.fn() };
  return render(
    <LanguageProvider lang={lang}>
      <VpView data={{ member: { initials: "TM" } }} api={api} />
    </LanguageProvider>,
  );
}

function renderAdvisor(lang) {
  const api = { loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.advisorDesk))) };
  return render(
    <LanguageProvider lang={lang}>
      <AdvisorView data={{ member: { initials: "CL" } }} api={api} />
    </LanguageProvider>,
  );
}

// What a screen reader is left with once every aria-hidden subtree is dropped.
function unhiddenText(element) {
  const clone = element.cloneNode(true);
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return clone.textContent;
}

const series = fallbackData.vpOverview.overview.membershipTrend
  .map((item) => `${item.year}: ${item.count}`)
  .join(", ");

describe("voting crunch chip glyph", () => {
  it("hides the hourglass from assistive technology and keeps the visible chip text", () => {
    const view = renderCrunchVoting();
    const chip = view.container.querySelector(".voting-chip--crunch");
    expect(chip).not.toBeNull();
    // The glyph is still painted, inside an aria-hidden element…
    expect(chip.querySelector('[aria-hidden="true"]')?.textContent).toBe(HOURGLASS);
    expect(chip.textContent).toMatch(/^⏳ CLOSES IN \d+:\d{2}:\d{2}$/);
    // …and nothing an assistive technology reads carries it.
    expect(unhiddenText(chip)).not.toContain(HOURGLASS);
    expect(unhiddenText(chip).trim()).toMatch(/^CLOSES IN \d+:\d{2}:\d{2}$/);
    view.unmount();
  });
});

describe("vp membership trend chart name", () => {
  it("names the chart with its unit in English", async () => {
    const view = renderVp("en");
    expect(await screen.findByRole("img", { name: `Campaign workers by join year: ${series}` })).toBeInTheDocument();
    view.unmount();
  });

  it("names the chart with its unit in Spanish", async () => {
    const view = renderVp("es");
    const chart = await screen.findByRole("img", {
      name: `Trabajadores de la campaña por año de ingreso: ${series}`,
    });
    // The old raw template literal was byte-identical in both languages.
    expect(chart.getAttribute("aria-label")).not.toBe(`Campaign workers by join year: ${series}`);
    view.unmount();
  });

  // BUG-UG-LEADERSHIP-MEMBERSHIP-TREND-CHART-BLANK-20261111: with no
  // series the card used to show an empty chart and nothing else.
  it.each([[[]], [[{ year: 2025, count: 0 }, { year: 2026, count: 0 }]]])("says so in plain words instead of drawing an empty chart: %j", async (membershipTrend) => {
    const desk = JSON.parse(JSON.stringify(fallbackData.vpOverview));
    desk.overview.membershipTrend = membershipTrend;
    const view = renderVp("en", { desk });
    await screen.findByText("Participation trend");
    expect(view.container.querySelector(".vp-trend-chart")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("No worker records carry a join year from the last five years yet, so there is no trend to draw.")).toBeInTheDocument();
    view.unmount();
  });

  it("draws the chart for an organization with a handful of members", async () => {
    const desk = JSON.parse(JSON.stringify(fallbackData.vpOverview));
    desk.overview.membershipTrend = [{ year: 2025, count: 2 }, { year: 2026, count: 5 }];
    const view = renderVp("en", { desk });
    const chart = await screen.findByRole("img", { name: "Campaign workers by join year: 2025: 2, 2026: 5" });
    expect(chart.querySelectorAll(".vp-trend-chart__column")).toHaveLength(2);
    expect(screen.queryByText(/no trend to draw/u)).toBeNull();
    view.unmount();
  });
});

describe("kpi grid roles", () => {
  it("gives the VP and advisor KPI grids a role to carry their name", async () => {
    const vp = renderVp("en");
    expect(await screen.findByRole("group", { name: "Leadership overview" })).toHaveClass("pkpi-grid");
    vp.unmount();

    const advisor = renderAdvisor("en");
    expect(await screen.findByRole("group", { name: "Campaign health" })).toHaveClass("ach-kpi-grid");
    advisor.unmount();
  });
});
