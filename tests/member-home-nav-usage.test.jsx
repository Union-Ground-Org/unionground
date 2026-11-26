// REQ-UG-USAGE-BASED-NAVIGATION-20261001: device-only usage ranking.
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  NAV_USAGE_SWITCH,
  computeNavWeights,
  emptyNavUsage,
  navUsageDay,
  navUsageKeysForUser,
  navUsageStorageKey,
  parseNavUsage,
  personalizeNavGroups,
  personalizeNavOrder,
  primaryNavKeys,
  recordNavVisit,
} from "../src/features/memberHome/navUsage.js";
import { clearNavUsageForUser, useNavUsage } from "../src/features/memberHome/useNavUsage.js";
import { NavUsageSettingsCard } from "../src/features/memberHome/NavUsageSettingsCard.jsx";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { MobileCardNav } from "../src/components/MobileCardNav.jsx";
import { catalogue } from "../src/lib/i18n.js";

const NOW = new Date(2026, 9, 1, 12);
const daysAgo = (days) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - days, 12);
const ON = { switches: { [NAV_USAGE_SWITCH]: true } };
const OFF = { switches: { [NAV_USAGE_SWITCH]: false } };

function visits(entries) {
  let usage = emptyNavUsage();
  for (const [key, ago, count = 1] of entries) for (let i = 0; i < count; i += 1) usage = recordNavVisit(usage, key, daysAgo(ago));
  return usage;
}

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("navUsage model", () => {
  it("weights recent visits 4x / 2x / 1x and drops visits older than 30 days", () => {
    const usage = visits([["voting", 0], ["messages", 10], ["numbers", 20], ["events", 31]]);
    expect(computeNavWeights(usage, NOW)).toEqual([
      { key: "voting", weight: 8 },
      { key: "messages", weight: 4 },
      { key: "numbers", weight: 2 },
    ]);
  });

  it("keeps the old base weights: cases 3x, resources 1x", () => {
    const usage = visits([["cases", 0], ["rights", 0], ["voting", 0]]);
    expect(computeNavWeights(usage, NOW)).toEqual([
      { key: "cases", weight: 12 },
      { key: "voting", weight: 8 },
      { key: "rights", weight: 4 },
    ]);
  });

  it("counts per day, bounds storage and survives malformed input", () => {
    const usage = visits([["voting", 0, 3]]);
    expect(usage.visits.voting[navUsageDay(daysAgo(0))]).toBe(3);
    expect(parseNavUsage("not json")).toEqual(emptyNavUsage());
    expect(parseNavUsage({ version: 1, visits: { "bad key!": { 1: 1 }, ok: { x: 2, 20000: -1, 20001: 2 } } })).toEqual({ version: 1, visits: { ok: { 20001: 2 } } });
    let small = emptyNavUsage();
    for (let day = 0; day < 20; day += 1) small = recordNavVisit(small, "voting", daysAgo(day), { maxDaysPerKey: 5 });
    expect(Object.keys(small.visits.voting)).toHaveLength(5);
    let many = emptyNavUsage();
    for (let index = 0; index < 20; index += 1) many = recordNavVisit(many, `dest-${index}`, NOW, { maxDestinations: 12 });
    expect(Object.keys(many.visits)).toHaveLength(12);
    expect(recordNavVisit(emptyNavUsage(), "../etc", NOW)).toEqual(emptyNavUsage());
  });

  it("never puts Home or a pinned destination in the most-used four", () => {
    const weights = [{ key: "today", weight: 99 }, { key: "voting", weight: 9 }, { key: "rights", weight: 8 }, { key: "cases", weight: 7 }, { key: "events", weight: 6 }, { key: "forms", weight: 5 }];
    expect(primaryNavKeys(weights, { pinned: ["rights"] })).toEqual(["voting", "cases", "events", "forms"]);
    expect(primaryNavKeys(weights, { allowed: ["cases", "forms"] })).toEqual(["cases", "forms"]);
  });

  it("orders a strip pinned first, then by use, keeping Home first", () => {
    const items = [{ key: "today" }, { key: "numbers" }, { key: "voting" }, { key: "rights" }];
    const weights = [{ key: "rights", weight: 9 }, { key: "numbers", weight: 1 }];
    expect(personalizeNavOrder(items, weights).map((item) => item.key)).toEqual(["today", "rights", "numbers", "voting"]);
    expect(personalizeNavOrder(items, weights, { pinned: ["voting"] }).map((item) => item.key)).toEqual(["today", "voting", "rights", "numbers"]);
    expect(personalizeNavOrder(items, [], { keepFirst: false }).map((item) => item.key)).toEqual(["today", "numbers", "voting", "rights"]);
  });

  it("moves the most-used items into a leading group and changes nothing without use", () => {
    const groups = [
      { key: "me", items: [{ key: "voting" }, { key: "cases" }, { key: "compass", action: "assistant" }] },
      { key: "union", items: [{ key: "org-structure", viewKey: "orgStructure" }, { key: "events" }] },
    ];
    expect(personalizeNavGroups(groups, [])).toBe(groups);
    const result = personalizeNavGroups(groups, [{ key: "orgStructure", weight: 5 }, { key: "compass", weight: 4 }, { key: "cases", weight: 3 }]);
    expect(result.map((group) => group.key)).toEqual(["most-used", "me", "union"]);
    expect(result[0].items.map((item) => item.key)).toEqual(["org-structure", "cases"]);
    expect(result[1].items.map((item) => item.key)).toEqual(["voting", "compass"]);
    expect(result[2].items.map((item) => item.key)).toEqual(["events"]);
  });

  it("scopes storage to the account and organization", () => {
    expect(navUsageStorageKey("u1", "o1")).toBe("ug-nav-usage:v1:u1:o1");
    expect(navUsageStorageKey(null, "o1")).toBeNull();
    expect(navUsageKeysForUser(["ug-nav-usage:v1:u1:o1", "ug-nav-usage:v1:u10:o1", "other"], "u1")).toEqual(["ug-nav-usage:v1:u1:o1"]);
  });

  it("has Spanish copy for every English key", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("navUsage.") || key.startsWith(`settings.def.${NAV_USAGE_SWITCH}.`));
    expect(keys).toHaveLength(16);
    for (const key of keys) expect(catalogue.es[key], key).toBeTruthy();
  });
});

describe("useNavUsage", () => {
  it("records member views in this browser only and ranks them", () => {
    const { result, rerender } = renderHook((props) => useNavUsage(props), {
      initialProps: { userId: "u1", organizationId: "o1", configuration: ON, view: "voting", tracking: true },
    });
    rerender({ userId: "u1", organizationId: "o1", configuration: ON, view: "cases", tracking: true });
    expect(result.current.weights.map((row) => row.key)).toEqual(["cases", "voting"]);
    expect(JSON.parse(window.localStorage.getItem("ug-nav-usage:v1:u1:o1")).visits).toHaveProperty("cases");
  });

  it("does not record staff-hat views or anything while the switch is off", () => {
    renderHook(() => useNavUsage({ userId: "u1", organizationId: "o1", configuration: ON, view: "tasks", tracking: false }));
    const off = renderHook(() => useNavUsage({ userId: "u1", organizationId: "o1", configuration: OFF, view: "voting", tracking: true }));
    expect(window.localStorage.length).toBe(0);
    expect(off.result.current.weights).toEqual([]);
  });

  it("forgets every organization's counts for the account on reset", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    window.localStorage.setItem("ug-nav-usage:v1:u1:o1", JSON.stringify(visits([["voting", 0]])));
    window.localStorage.setItem("ug-nav-usage:v1:u1:o2", JSON.stringify(visits([["voting", 0]])));
    window.localStorage.setItem("ug-nav-usage:v1:u2:o1", JSON.stringify(visits([["voting", 0]])));
    const { result } = renderHook(() => useNavUsage({ userId: "u1", organizationId: "o1", configuration: ON, view: null }));
    expect(result.current.weights).toHaveLength(1);
    act(() => clearNavUsageForUser("u1"));
    expect(result.current.weights).toEqual([]);
    expect(Object.keys(window.localStorage)).toEqual(["ug-nav-usage:v1:u2:o1"]);
    vi.useRealTimers();
  });
});

describe("visible controls", () => {
  it("offers a member reset in Settings only while the switch is on", () => {
    window.localStorage.setItem("ug-nav-usage:v1:m1:o1", JSON.stringify(visits([["voting", 0]])));
    const { rerender } = render(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m1" }, organizationConfiguration: ON }} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Reset most used" }));
    expect(screen.getByRole("status").textContent).toContain("Most used is cleared on this device; your pins stay");
    expect(window.localStorage.getItem("ug-nav-usage:v1:m1:o1")).toBeNull();
    rerender(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m1" }, organizationConfiguration: OFF }} /></LanguageProvider>);
    expect(screen.queryByRole("button", { name: "Reset most used" })).toBeNull();
  });

  it("moves the most-used destinations to a Most used group in the desktop member rail", () => {
    const { container } = render(<LanguageProvider><DesktopRail renderMode="desktop" active="today" onNavigate={() => {}} onAsk={() => {}} navUsageWeights={[{ key: "events", weight: 9 }, { key: "messages", weight: 5 }]} /></LanguageProvider>);
    const labels = [...container.querySelectorAll(".desktop-rail__grouplabel")].map((node) => node.textContent);
    expect(labels[0]).toBe("Most used");
    expect(screen.getAllByRole("link", { name: /Messages/ })).toHaveLength(1);
    const links = [...container.querySelectorAll("a")].map((node) => node.getAttribute("href"));
    expect(links.indexOf("/m/messages")).toBeLessThan(links.indexOf("/m/voting"));
  });

  it("keeps the designed rail without usage", () => {
    const { container } = render(<LanguageProvider><DesktopRail renderMode="desktop" active="today" onNavigate={() => {}} onAsk={() => {}} navUsageWeights={[]} /></LanguageProvider>);
    expect([...container.querySelectorAll(".desktop-rail__grouplabel")].map((node) => node.textContent)).not.toContain("Most used");
  });

  it("leads the phone All features card with Most used and never moves a pinned shortcut", () => {
    render(<LanguageProvider><MobileCardNav onNavigate={() => {}} onAsk={() => {}} shortcutKeys={["today", "voting"]} navUsageWeights={[{ key: "voting", weight: 9 }, { key: "events", weight: 5 }]}><p>feed</p></MobileCardNav></LanguageProvider>);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
    expect(headings).toContain("Most used");
    const mostUsed = screen.getAllByRole("heading", { level: 3 }).find((node) => node.textContent === "Most used").parentElement;
    expect(mostUsed.textContent).toContain("Meetings");
    expect(mostUsed.textContent).not.toContain("Voting");
  });
});
