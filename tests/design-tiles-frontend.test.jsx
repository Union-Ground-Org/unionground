import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { primeDemoHat } from "./helpers/demoHat.js";

// Frontend for the 20260728 data layer: the desktop dashboard tiles, the case
// assignee line, and the steward rail badge. The honesty contract under test: every surface renders
// ONLY when its backing value exists, and falls back to the pre-slice real
// equivalents — never to an invented number — when it does not.

function stubMatchMedia(matches) {
  const listeners = new Set();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  }));
  return listeners;
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  primeDemoData(fallbackData);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  primeDemoData(fallbackData);
});

// Union Ground has no points economy and no chapter league table: the Home
// stat row shows only the worker's backed organizing facts, and the points,
// tier, actions-YTD and banded-standing tiles never render, even when a
// payload still carries their fields.
describe("desktop dashboard tiles", () => {
  const RETIRED_TILES = /Actions YTD|Chapter standing|Campaign standing|Total points|Top 25%|\bpts\b/;

  it("renders the backed organizing tiles and no points or standing tile", () => {
    stubMatchMedia(true);
    render(<App />);
    const tiles = [...document.querySelectorAll(".home-tile")].map((tile) => tile.textContent);
    expect(tiles).toEqual(["1Open issues", "3Committee ready"]);
    for (const tile of tiles) expect(tile).not.toMatch(RETIRED_TILES);
    expect(screen.queryByText("Actions YTD")).toBeNull();
    expect(screen.queryByText(/Chapter standing/)).toBeNull();
    expect(screen.queryByText("Total points")).toBeNull();
    // The RPC's cohort-size band never reaches the screen either.
    expect(screen.queryByText(/50-99/)).toBeNull();
  });

  it("renders no points, tier or standing tile even when a payload carries those fields", () => {
    stubMatchMedia(true);
    primeDemoData({
      ...fallbackData,
      rewards: { totalPoints: 1240, tierName: "Organizer", actionsYtd: 41 },
      chapterStanding: { enoughData: true, band: "top_25", period: "2026 Q2", cohortBand: "50-99" },
    });
    render(<App />);
    expect(screen.queryByText("Actions YTD")).toBeNull();
    expect(screen.queryByText("41")).toBeNull();
    expect(screen.queryByText(/Chapter standing/)).toBeNull();
    expect(screen.queryByText("Total points")).toBeNull();
    expect(screen.queryByText(/1,?240/)).toBeNull();
    expect(screen.getByText("Open issues")).toBeInTheDocument();
  });

  it("gives the phone the same backed dashboard facts as desktop", () => {
    render(<App />);
    const overview = document.querySelector(".home-mobile-overview");
    expect(overview).not.toBeNull();
    expect(within(overview).getByText("Open issues")).toBeInTheDocument();
    expect(within(overview).getByText("Committee ready")).toBeInTheDocument();
    expect(overview.textContent).not.toMatch(RETIRED_TILES);
  });
});

describe("case assignee line", () => {
  it("shows the server-stamped names on the desk card and in the dialog", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m/cases");
    render(<App />);
    const line = "Committee Sam Okafor · Campaign lead Jordan Patel";
    // Wave 2b desk card (ISS-2026-042 is the only active issue in the fixture):
    // the meta line joins the reference and the assignees — nothing else.
    expect(await screen.findByText(`ISS-2026-042 · ${line}`)).toBeInTheDocument();
    // The dialog renders the SAME line for the SAME issue object.
    fireEvent.click(screen.getByRole("button", { name: /Supervisor meeting with no stated reason/ }));
    expect(document.querySelector(".case-assignees").textContent).toBe(line);
    // The issue type stays reachable on the dialog's copy line; Union Ground
    // issues cite no contract article.
    expect(document.querySelector(".case-detail-copy").textContent).toBe("Rights");
    expect(document.querySelector(".case-detail-copy").textContent).not.toMatch(/Article|Steward|Coordinator/);
  });

  it("renders no assignee line for an unassigned case", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m/cases");
    const unassigned = {
      ...fallbackData,
      cases: fallbackData.cases.map((item) => ({ ...item, stewardName: "", coordinatorName: "" })),
    };
    primeDemoData(unassigned);
    render(<App />);
    // The meta line is the reference ALONE — no assignee tail is invented…
    expect(await screen.findByText("ISS-2026-042")).toBeInTheDocument();
    expect(document.querySelector(".mcases-desk__meta").textContent).toBe("ISS-2026-042");
    // …and the dialog draws the same blank.
    fireEvent.click(screen.getByRole("button", { name: /Supervisor meeting with no stated reason/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(document.querySelector(".case-assignees")).toBeNull();
  });
});

describe("steward rail badge", () => {
  // Issue work lives under the Committee role on the SAMPLE origin, so each pin
  // opens demo mode and wears that hat before reading the link.
  const wearStewardHat = () => {
    const bar = within(document.querySelector(".demo-bar"));
    fireEvent.click(bar.getByRole("button", { name: "Switch role, current: Worker" }));
    fireEvent.click(bar.getByRole("menuitemradio", { name: "Committee" }));
  };

  it("sums the desk counts on the Issue work destination", () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    primeDemoData({
      ...fallbackData,
      roles: ["steward"],
      stewardBadges: { openRequests: 3, formsInbox: 1 },
    });
    render(<App />);
    wearStewardHat();
    const casework = screen.getByRole("link", { name: "Issue work 4", exact: true });
    const badge = casework.querySelector(".rail-badge");
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("4");
    expect(screen.queryByRole("link", { name: /^Casework/ })).toBeNull();
  });

  it("renders no badge when the counts are absent — never a fake zero", () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    primeDemoData({ ...fallbackData, roles: ["steward"] });
    render(<App />);
    wearStewardHat();
    // Worker items (Issues, Forms) may carry their own data-derived badges;
    // the pin here is that Issue work shows none without the steward RPC.
    const casework = screen.getByRole("link", { name: "Issue work" });
    expect(casework.querySelector(".rail-badge")).toBeNull();
  });
});
