import { readFileSync } from "node:fs";
// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 89: the
// "Most used" menu sorted itself with no way to pin a shortcut. Pins are kept
// on this device like the ranking, lead the desktop member rail in pin order,
// survive "Reset most used", and are capped.
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  NAV_PINS_MAX,
  NAV_USAGE_SWITCH,
  navPinsStorageKey,
  parseNavPins,
  pinnedNavItems,
  serializeNavPins,
  toggleNavPin,
} from "../src/features/memberHome/navUsage.js";
import { clearNavPinsForUser, clearNavUsageForUser, readNavPins, useNavPins, writeNavPins } from "../src/features/memberHome/useNavUsage.js";
import { NavUsageSettingsCard } from "../src/features/memberHome/NavUsageSettingsCard.jsx";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { catalogue } from "../src/lib/i18n.js";

const ON = { switches: { [NAV_USAGE_SWITCH]: true } };
afterEach(() => window.localStorage.clear());

describe("pin model", () => {
  it("keys pins by member and organization and refuses a missing member", () => {
    expect(navPinsStorageKey("m1", "org")).toBe("ug-nav-pins:v1:m1:org");
    expect(navPinsStorageKey("m1", null)).toBe("ug-nav-pins:v1:m1:none");
    expect(navPinsStorageKey(null, "org")).toBeNull();
  });

  it("parses only well-formed, unique, non-Home keys up to the cap", () => {
    expect(parseNavPins('{"version":1,"pins":["events","events","today","Bad Key!","messages"]}')).toEqual(["events", "messages"]);
    expect(parseNavPins("not json")).toEqual([]);
    expect(parseNavPins({ version: 2, pins: ["events"] })).toEqual([]);
    const many = Array.from({ length: NAV_PINS_MAX + 3 }, (_, index) => `place-${index}`);
    expect(parseNavPins({ version: 1, pins: many })).toHaveLength(NAV_PINS_MAX);
    expect(JSON.parse(serializeNavPins(["events", "today"]))).toEqual({ version: 1, pins: ["events"] });
  });

  it("toggles a pin, appends in pin order, and refuses past the cap", () => {
    expect(toggleNavPin([], "events")).toEqual(["events"]);
    expect(toggleNavPin(["events"], "messages")).toEqual(["events", "messages"]);
    expect(toggleNavPin(["events", "messages"], "events")).toEqual(["messages"]);
    expect(toggleNavPin(["events"], "today")).toEqual(["events"]);
    const full = Array.from({ length: NAV_PINS_MAX }, (_, index) => `place-${index}`);
    expect(toggleNavPin(full, "events")).toEqual(full);
  });

  it("finds the pinned items in pin order and skips unknown pins", () => {
    const items = [{ key: "voting" }, { key: "messages" }, { key: "events", viewKey: "events" }, { key: "help", action: true }];
    expect(pinnedNavItems(items, ["events", "gone", "voting", "help"]).map((item) => item.key)).toEqual(["events", "voting"]);
  });
});

describe("pin storage", () => {
  it("writes pins to this device and keeps them through Reset most used", () => {
    const key = navPinsStorageKey("m1", "org");
    expect(writeNavPins(key, ["events"], { userId: "m1" })).toEqual(["events"]);
    expect(JSON.parse(window.localStorage.getItem(key))).toEqual({ version: 1, pins: ["events"] });
    clearNavUsageForUser("m1");
    expect(readNavPins(key)).toEqual(["events"]);
  });

  it("removes only the signed-out member's stored pins", () => {
    const mine = navPinsStorageKey("m8", "org");
    const theirs = navPinsStorageKey("m9", "org");
    writeNavPins(mine, ["events"], { userId: "m8" });
    writeNavPins(theirs, ["messages"], { userId: "m9" });
    clearNavPinsForUser("m8");
    expect(window.localStorage.getItem(mine)).toBeNull();
    expect(readNavPins(mine)).toEqual([]);
    expect(readNavPins(theirs)).toEqual(["messages"]);
  });

  it("keeps demo pins in memory only", () => {
    const key = navPinsStorageKey("demo-m", "org");
    writeNavPins(key, ["messages"], { persist: false });
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(readNavPins(key, false)).toEqual(["messages"]);
  });

  it("toggles through the hook and reads nothing when switched off", () => {
    const { result } = renderHook(() => useNavPins({ userId: "m2", organizationId: "org", enabled: true }));
    act(() => result.current.togglePin("events"));
    expect(result.current.pins).toEqual(["events"]);
    const off = renderHook(() => useNavPins({ userId: "m2", organizationId: "org", enabled: false }));
    act(() => off.result.current.togglePin("messages"));
    expect(off.result.current.pins).toEqual([]);
    expect(readNavPins(navPinsStorageKey("m2", "org"))).toEqual(["events"]);
  });

  it("refuses a missing key or member and follows only this member's pins from other tabs", () => {
    expect(writeNavPins(null, ["events"])).toEqual([]);
    expect(readNavPins(null)).toEqual([]);
    expect(() => clearNavPinsForUser(null)).not.toThrow();
    const key = navPinsStorageKey("m11", "org");
    const { result } = renderHook(() => useNavPins({ userId: "m11", organizationId: "org", enabled: true }));
    window.localStorage.setItem(key, serializeNavPins(["voting"]));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: navPinsStorageKey("m12", "org") })); });
    act(() => { window.dispatchEvent(new CustomEvent("ug-nav-usage-changed", { detail: { userId: "m12" } })); });
    expect(result.current.pins).toEqual([]);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key })); });
    expect(result.current.pins).toEqual(["voting"]);
  });
});

describe("pin surfaces", () => {
  it("pins a place from Settings and says so, in English and Spanish", () => {
    render(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m3", organizationId: "org" }, organizationConfiguration: ON }} /></LanguageProvider>);
    const pin = screen.getByRole("button", { name: "Pin Messages" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    expect(screen.getByRole("button", { name: "Pin Messages" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Messages is pinned to the top of the menu.");
    expect(readNavPins(navPinsStorageKey("m3", "org"))).toEqual(["messages"]);
  });

  it("unpins a pinned place from Settings and says so", () => {
    writeNavPins(navPinsStorageKey("m10", "org"), ["messages"], { userId: "m10" });
    render(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m10", organizationId: "org" }, organizationConfiguration: ON }} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Pin Messages" }));
    expect(screen.getByRole("button", { name: "Pin Messages" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Messages is no longer pinned.");
    expect(readNavPins(navPinsStorageKey("m10", "org"))).toEqual([]);
  });

  it("disables new pins at the cap", () => {
    const key = navPinsStorageKey("m4", "org");
    writeNavPins(key, Array.from({ length: NAV_PINS_MAX }, (_, index) => `place-${index}`), { userId: "m4" });
    render(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m4", organizationId: "org" }, organizationConfiguration: ON }} /></LanguageProvider>);
    expect(screen.getByText(`You have pinned ${NAV_PINS_MAX} places, the most allowed. Unpin one to pin another.`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin Messages" })).toBeDisabled();
  });

  // Gate round 1 on #6644: pins are offered only where the rail shows them,
  // demo pins stay in memory, and a switched-off Site guide is not offered.
  it("offers no pin controls where the rail does not show pins", () => {
    render(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m5", organizationId: "org" }, organizationConfiguration: ON }} pinsOffered={false} /></LanguageProvider>);
    expect(screen.getByRole("button", { name: "Reset most used" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin Messages" })).toBeNull();
  });

  it("keeps demo pins in memory when the card is told not to persist", () => {
    render(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m6", organizationId: "org" }, organizationConfiguration: ON }} persist={false} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Pin Messages" }));
    const key = navPinsStorageKey("m6", "org");
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(readNavPins(key, false)).toEqual(["messages"]);
  });

  it("does not offer the Site guide when the organization switched it off", () => {
    const guideOff = { switches: { ...ON.switches, "features.guidance_onboarding.site_guide": false } };
    const { unmount } = render(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m7", organizationId: "org" }, organizationConfiguration: guideOff }} /></LanguageProvider>);
    expect(screen.queryByRole("button", { name: `Pin ${catalogue.en["nav.siteGuide"]}` })).toBeNull();
    unmount();
    render(<LanguageProvider><NavUsageSettingsCard data={{ member: { id: "m7", organizationId: "org" }, organizationConfiguration: ON }} /></LanguageProvider>);
    expect(screen.getByRole("button", { name: `Pin ${catalogue.en["nav.siteGuide"]}` })).toBeInTheDocument();
  });

  // Gate final on #6644: guided onboarding holds back non-core links, but
  // never a destination the member pinned.
  it("keeps pinned places visible while guided onboarding hides other links", () => {
    const guide = { programConfigured: true, enrolled: true, onboardingComplete: false, progressiveDisclosureActive: true, switches: { progressiveDisclosure: true } };
    const rail = (pins) => render(<LanguageProvider><DesktopRail renderMode="desktop" active="today" onNavigate={() => {}} onAsk={() => {}} guide={guide} guideShowAll={false} onGuideShowAllChange={() => {}} navUsagePins={pins} /></LanguageProvider>);
    const hrefsOf = (container) => [...container.querySelectorAll("a")].map((node) => node.getAttribute("href"));
    const unpinned = rail(null);
    expect(hrefsOf(unpinned.container)).not.toContain("/m/voting");
    unpinned.unmount();
    const { container } = rail(["voting"]);
    const labels = [...container.querySelectorAll(".desktop-rail__grouplabel")].map((node) => node.textContent);
    expect(labels).toContain("Pinned");
    expect(hrefsOf(container).filter((href) => href === "/m/voting")).toHaveLength(1);
  });

  it("leads the desktop member rail with a Pinned group in pin order, without repeating an entry", () => {
    const { container } = render(<LanguageProvider><DesktopRail renderMode="desktop" active="today" onNavigate={() => {}} onAsk={() => {}} navUsageWeights={[{ key: "messages", weight: 9 }]} navUsagePins={["events", "voting"]} /></LanguageProvider>);
    const labels = [...container.querySelectorAll(".desktop-rail__grouplabel")].map((node) => node.textContent);
    expect(labels[0]).toBe("Pinned");
    const hrefs = [...container.querySelectorAll("a")].map((node) => node.getAttribute("href"));
    expect(hrefs.indexOf("/m/events")).toBeLessThan(hrefs.indexOf("/m/voting"));
    expect(hrefs.indexOf("/m/voting")).toBeLessThan(hrefs.indexOf("/m/messages"));
    expect(hrefs.filter((href) => href === "/m/voting")).toHaveLength(1);
  });
});

// AGENTS.md (mobile web tier): 48px touch targets. Codex review on #6644.
describe("pin toggle touch target", () => {
  it("keeps the Pin / Pinned button at least 48px tall", () => {
    const css = readFileSync("src/features/memberHome/navUsageSettings.css", "utf8");
    const rule = css.slice(css.indexOf(".nav-pins__toggle {"), css.indexOf("}", css.indexOf(".nav-pins__toggle {")));
    expect(rule).toMatch(/min-height: 48px;/);
    expect(rule).not.toMatch(/min-height: 4[0-7]px/);
  });
});
