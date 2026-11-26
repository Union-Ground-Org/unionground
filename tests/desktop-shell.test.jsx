import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { Dialog } from "../src/components/Dialog.jsx";
import { primeDemoData } from "../src/data/demoData.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { homeRelevantEvents } from "../src/lib/homeFeed.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { registerEscapeLayer } from "../src/lib/escapeLayers.js";
import { applyDeviceParityState, clearDeviceParityState, deviceParityValue } from "../src/lib/deviceParity.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { labelInNameMismatches } from "./helpers/labelInName.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

// The desktop shell is gated on matchMedia("(min-width: 1024px)"), so these
// tests own the stub. jsdom's real matchMedia answers false to every width
// query — which is exactly what every OTHER suite relies on to keep the
// phone shell and its single bottom nav; the last test here pins that.
function stubMatchMedia(matches) {
  const listeners = new Set();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: typeof matches === "function" ? matches(query) : matches,
    media: query,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  }));
  return listeners;
}

const realMatchMedia = window.matchMedia;
const realParentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
const LIVE_DESKTOP_RAIL_COLLAPSE_KEY = `sg:member:${fallbackData.member.id}:desktop-main-rail:collapsed`;
const DEMO_DESKTOP_RAIL_COLLAPSE_KEY = "sg:demo:desktop-main-rail:collapsed";

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

// After the storage reset above, so the choice survives it.
keepKeyboardShortcutsOn();

afterEach(() => {
  window.matchMedia = realMatchMedia;
  if (realParentDescriptor) Object.defineProperty(window, "parent", realParentDescriptor);
  else delete window.parent;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.useRealTimers();
});

function renderDesktopRail({ demo = false, lang = "en", memberId = "member-a", ...props } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <DesktopRail
        active="today"
        activeHat="member"
        demo={demo}
        memberId={memberId}
        onAsk={() => {}}
        onNavigate={() => {}}
        onNotifications={() => {}}
        onSwitchHat={() => {}}
        renderMode="desktop"
        staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]}
        user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }}
        {...props}
      />
    </LanguageProvider>,
  );
}

function topHatTrigger(name) {
  return within(document.querySelector(".demo-bar")).getByRole("button", {
    name: `Switch role, current: ${name}`,
  });
}

function topHatMenu() {
  const bar = document.querySelector(".demo-bar");
  const scope = within(bar);
  const existing = scope.queryByRole("menu", { name: "Switch role" });
  if (existing) return existing;
  fireEvent.click(scope.getByRole("button", { name: /Switch role, current:/ }));
  return scope.getByRole("menu", { name: "Switch role" });
}

function selectTopHat(name) {
  fireEvent.click(within(topHatMenu()).getByRole("menuitemradio", { name }));
}

// REQ-UG-NAV-LIGHT-IDENTITY-20261102: the chapter catalog is a
// flyout from the one rail's chapter button, closed until it is opened.
function openChapterFlyout() {
  const trigger = document.getElementById("chapter-flyout-trigger");
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.getByRole("navigation", { name: "Campaigns" });
}

describe("desktop shell", () => {
  it.each(["en", "es"])("names every expanded %s rail control with the words it shows (WCAG 2.5.3)", (lang) => {
    renderDesktopRail({ lang, badges: { forms: 2 } });
    const rail = document.querySelector(".desktop-rail");
    expect(labelInNameMismatches(rail.querySelectorAll("a, button"))).toEqual([]);
    expect(rail.querySelector(".desktop-rail__shortcut")).toHaveAttribute("data-keys", "Ctrl+1");
    expect(rail.querySelector(".desktop-rail__user-avatar")).toHaveAttribute("data-glyph", "DF");
  });

  it.each([["en", "AI"], ["es", "IA"]])("keeps the %s Guide name saying AI while painting no promotional badge", (lang, badgeText) => {
    const onAsk = vi.fn();
    renderDesktopRail({ lang, onAsk });
    const compass = screen.getByRole("button", { name: `${lang === "es" ? "Guía de Union Ground" : "Union Ground Guide"} ${badgeText}`, exact: true });
    expect(compass.querySelector(".rail-badge")).toBeNull();
    expect(compass).not.toHaveTextContent(badgeText);
    fireEvent.click(compass);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it.each(["member", "steward"])("marks Worker support current in the %s rail using its resolved view", (activeHat) => {
    const navigate = vi.fn();
    renderDesktopRail({ active: "memberSupport", activeHat, onNavigate: navigate });
    const support = screen.getByRole("link", { name: "Worker support" });
    expect(support).toHaveAttribute("aria-current", "page");
    expect(support).toHaveClass("active");
    fireEvent.click(support);
    expect(navigate).toHaveBeenCalledWith("memberSupport", "/m/support", undefined);
  });

  // The window widens after the shell's first
  // read but before its effect subscribes, so no change event ever fires.
  // The effect reads the lists once more after subscribing.
  it("takes the desktop shell when the window widened before the shell subscribed", () => {
    let wide = false;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      get matches() { return query === "(min-width: 1024px)" && wide; },
      media: query,
      addEventListener: () => { wide = true; },
      removeEventListener: () => {},
      addListener: () => { wide = true; },
      removeListener: () => {},
    }));
    render(<App />);
    expect(document.querySelector(".desktop-rail")).toBeInTheDocument();
    expect(document.querySelector(".bottom-nav")).toBeNull();
  });

  it("renders the rail, not the bottom nav, on a wide screen", () => {
    stubMatchMedia(true);
    render(<App />);
    expect(document.querySelector(".sg-app--desktop")).toHaveAttribute("data-workspace-theme", "union-ground");
    const rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-workspace-theme", "union-ground");
    expect(rail).toHaveAttribute("data-render-mode", "desktop");
    expect(rail).toHaveAttribute("data-collapsed", "false");
    // The rail's brand link draws the official Union Ground mark
    // (branding/official/), not a "UG" monogram.
    expect(rail.querySelector(".desktop-rail__mark")).toBeNull();
    expect(rail.querySelector(".brand-home .brand-mark--official")).not.toBeNull();
    expect(within(rail).getByText("Union Ground")).toBeInTheDocument();
    expect(within(rail).queryByText("Union Base")).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /Profile$/ })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Collapse rail" })).toBeInTheDocument();
    expect(document.querySelector(".bottom-nav")).toBeNull();
    // Exactly one nav in the DOM means exactly one of each link name. The
    // rail's home entry is "Home" since the wave-2a prototype sidebar.
    expect(screen.getAllByRole("link", { name: "Home" })).toHaveLength(1);
    // The desktop greeting is the design's "Welcome back"; the time-of-day
    // greeting stays on the phone (pinned in design-dashboard-parity).
    expect(screen.getByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();
    // The plain member gets the prototype's Me/Union/Account groups — never
    // the Steward group or its entries. The steward side of this contract
    // lives in tests/steward-rail.test.jsx.
    expect(screen.getByText("Me")).toBeInTheDocument();
    expect(document.querySelectorAll(".desktop-rail__grouplabel")).toHaveLength(3);
    expect(screen.queryByRole("link", { name: "Issue work" })).toBeNull();
    // One permanent rail; the campaign catalog opens from it as a flyout.
    expect(screen.getAllByRole("navigation").map((landmark) => landmark.getAttribute("aria-label"))).toEqual(["Primary"]);
    const chapterButton = within(rail).getByRole("button", { name: "Campaigns Harborview Care United" });
    expect(chapterButton).toHaveAttribute("aria-expanded", "false");
    expect(within(rail).getByText("Working as Worker")).toBeInTheDocument();
    const flyout = openChapterFlyout();
    expect(chapterButton).toHaveAttribute("aria-expanded", "true");
    expect(chapterButton).toHaveAttribute("aria-controls", flyout.id);
    expect(flyout).toHaveAttribute("data-flyout", "true");
    expect(within(flyout).getByRole("button", { name: /^Open Harborview Care United\b/ })).toHaveAttribute("aria-pressed", "true");
    expect(flyout).not.toHaveTextContent("SAMPLE");
  });

  it("keeps staff-only destinations out of the Worker hat even when staff hats are authorized", () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);

    const rail = document.querySelector(".desktop-rail");
    expect(topHatTrigger("Worker")).toBeInTheDocument();
    expect(within(rail).queryByRole("group", { name: "Switch role" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Issue work" })).not.toBeInTheDocument();
    // Union Ground's worker Work list (/m/work) is a member destination; the
    // staff-only shared work tool (/m/tasks) is what must stay off this hat.
    expect(rail.querySelector('a[href="/m/tasks"]')).toBeNull();
    expect(within(rail).queryByText("Work", { selector: ".desktop-rail__grouplabel" })).not.toBeInTheDocument();
  });

  it("keeps staff controls and intake triage out of Worker My campaign until a staff hat is selected", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);

    fireEvent.click(within(document.querySelector(".desktop-rail")).getByRole("link", { name: "My campaign" }));
    // Wait for the real cold route and React commit, as for Coordinator below.
    await act(async () => { await import("../src/views/ProductHubView.jsx"); });
    expect(await screen.findByRole("heading", { level: 1, name: "My campaign" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New space" })).not.toBeInTheDocument();
    fireEvent.click(within(document.querySelector(".hub2-tabs")).getByRole("link", { name: "Be heard" }));
    expect(screen.queryByRole("button", { name: "Triage report" })).not.toBeInTheDocument();

    const rail = document.querySelector(".desktop-rail");
    selectTopHat("Campaign lead");
    // This first visit loads the desk's real lazy module. Its cold transform
    // can outlast findByRole's budget under CI contention; wait for that work
    // and its React commit before asserting the role-gated contents.
    await act(async () => { await import("../src/views/CoordinatorView.jsx"); });
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" }, { timeout: 3000 })).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("link", { name: "Organize" }));
    expect(await screen.findByRole("button", { name: "New space" })).toBeInTheDocument();
    fireEvent.click(within(document.querySelector(".hub2-tabs")).getByRole("link", { name: "Be heard" }));
    expect(screen.getByRole("button", { name: "Triage report" })).toBeInTheDocument();
    expect(topHatTrigger("Campaign lead")).toBeInTheDocument();
  });

  it("keeps the Worker hat when a SAMPLE worker reloads the network URL they land on", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    const first = render(<App />);
    fireEvent.click(within(document.querySelector(".desktop-rail")).getByRole("link", { name: "Organization network" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/network"));
    expect(topHatTrigger("Worker")).toBeInTheDocument();
    const landed = `${window.location.pathname}${window.location.search}`;
    first.unmount();
    clearDeviceParityState();
    window.history.replaceState({}, "", landed);
    render(<App />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/m/network");
      expect(topHatTrigger("Worker")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Switch role, current: Steward/ })).not.toBeInTheDocument();
  });

  it("does not infer a Campaign lead or Committee worker role from a direct Campaign work route", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/tasks?demo=1");
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    const rail = document.querySelector(".desktop-rail");
    expect(topHatTrigger("Worker")).toBeInTheDocument();
    expect(document.querySelector(".tasks-screen")).toBeNull();
    expect(within(rail).queryByRole("link", { name: "Issue queue" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Issue work" })).not.toBeInTheDocument();
  });

  // A fresh Union Ground preview wears Worker (DEFAULT_SAMPLE_HAT), so a cold
  // staff deep link opens the worker Home and says why.
  it("explains why a cold SAMPLE staff deep link opens with the Worker role", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/vp?demo=1");
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(screen.getByText(/This link starts as Worker/).closest('[role="status"]')).toHaveTextContent(
      "use Switch role to open the requested staff desk.",
    );
  });

  it("does not claim a Worker start when a remembered staff hat opens the deep link", async () => {
    stubMatchMedia(true);
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m/vp?demo=1");
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/m/steward"));
    expect(screen.queryByText(/This link starts as/)).not.toBeInTheDocument();
  });

  it("never shows Switch role on the live desktop rail after an authorized staff role is primed", () => {
    stubMatchMedia(true);
    primeDemoData({ ...structuredClone(fallbackData), roles: ["coordinator"] });
    const mounted = render(<App />);
    try {
      const rail = document.querySelector(".desktop-rail");
      expect(within(rail).queryByRole("group", { name: "Switch role" })).not.toBeInTheDocument();
      expect(within(rail).queryByRole("button", { name: "Campaign lead" })).not.toBeInTheDocument();
      expect(document.querySelector(".staff-switcher")).toBeNull();
    } finally {
      mounted.unmount();
      primeDemoData(fallbackData);
    }
  });

  it("returns a selected SAMPLE staff hat to its plane when popstate reaches a member-only route", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    selectTopHat("Campaign lead");
    expect(await screen.findByRole("heading", { name: "Issue queue" })).toBeInTheDocument();
    window.history.pushState({}, "", "/m/voting?demo=1");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(window.location.pathname).toBe("/m/coordinator");
    expect(topHatTrigger("Campaign lead")).toBeInTheDocument();
  });

  it.each([
    ["/m/settings", "Settings"],
    ["/m/settings/sessions", "Signed-in devices"],
    ["/m/settings/security", "Security"],
    ["/m/access-history", "Access history"],
    ["/m/appointments", "One-on-ones"],
  ])("keeps a selected Campaign lead hat on %s without switching to Worker", async (path, heading) => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    selectTopHat("Campaign lead");
    expect(await screen.findByRole("heading", { name: "Issue queue" })).toBeInTheDocument();
    window.history.pushState({}, "", `${path}?demo=1`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
    expect(topHatTrigger("Campaign lead")).toBeInTheDocument();
  });

  it("opens Profile Settings for a staff hat without changing the hat", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    selectTopHat("Committee");
    expect(await screen.findByRole("heading", { name: "Committee desk" })).toBeInTheDocument();
    fireEvent.click(within(document.querySelector(".desktop-rail")).getByRole("button", { name: /Profile$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/settings");
    expect(topHatTrigger("Committee")).toBeInTheDocument();
  });

  // Superseded in design Step 2: this test asserted the coordinator's own
  // palette survived into Chapter work (not the member's "aubergine-ledger"),
  // under the 2026-08-25 one-palette-per-hat rule. Every hat now wears the one
  // identity, so the shell keeps it through Organize into Chapter work.
  it("keeps the one identity when a staff hat's Organize leads into Campaign work on tablet", async () => {
    stubMatchMedia((query) => query === "(min-width: 768px) and (max-width: 1023px)");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);

    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Campaign lead" }));
    expect(await screen.findByRole("heading", { name: "Issue queue" })).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("link", { name: "Organize" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Organize" })).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("link", { name: "Campaign duty" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Work" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Board" })).toBeInTheDocument();
    expect(document.querySelector(".sg-app")).toHaveAttribute("data-workspace-theme", "union-ground");
  });

  it("opens the campaign rail collapsed and keeps it expanded from the profile menu's switch (#6989)", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);

    // Closed by default: no catalog landmark until the rail button opens it.
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    expect(document.getElementById("chapter-flyout-trigger")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /Profile$/ }));
    const keepExpanded = await screen.findByRole("switch", { name: "Open Campaigns by default" });
    expect(keepExpanded).toHaveAttribute("aria-checked", "false");
    fireEvent.click(keepExpanded);
    expect(keepExpanded).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "false");
    expect(document.getElementById("chapter-flyout-trigger")).toHaveAttribute("aria-expanded", "true");
    expect(window.sessionStorage.getItem("sg:demo:chapter-rail:expanded-by-default")).toBe("true");
    expect(window.localStorage.getItem("sg:demo:chapter-rail:expanded-by-default")).toBeNull();
  });

  it("uses only explicit demo mode for seeded SAMPLE campaign context", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    // Reads the expanded rail's group text, so keep the rail expanded (#6989).
    window.sessionStorage.setItem("sg:demo:chapter-rail:expanded-by-default", "true");
    const memberBefore = structuredClone(fallbackData.member);
    render(<App />);

    const chapterRail = screen.getByRole("navigation", { name: "Campaigns" });
    expect(within(chapterRail).queryByText("PREVIEW")).not.toBeInTheDocument();
    expect(within(chapterRail).getByText("North County Transit Workers")).toBeInTheDocument();
    const invokingChoice = within(chapterRail).getByRole("button", { name: /^Open North County Transit Workers\b/ });
    invokingChoice.focus();
    fireEvent.click(invokingChoice);

    const landingHeading = await screen.findByRole("heading", { name: "North County Transit Workers" });
    expect(landingHeading).toBeInTheDocument();
    expect(landingHeading).toHaveAttribute("tabindex", "-1");
    expect(landingHeading).toHaveFocus();
    expect(screen.getByText("CAMPAIGN SNAPSHOT")).toBeInTheDocument();
    expect(screen.getByText("Backed campaign profile and counts. Your current role and permissions stay unchanged.")).toBeInTheDocument();
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m");
    expect(fallbackData.member).toEqual(memberBefore);

    fireEvent.click(screen.getByRole("button", { name: "Return to current workspace" }));
    expect(await screen.findByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();
    expect(screen.queryByText("CAMPAIGN SNAPSHOT")).toBeNull();
    // The flyout closed on the choice, so focus returns to the rail button.
    expect(document.getElementById("chapter-flyout-trigger")).toHaveFocus();
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    expect(fallbackData.member).toEqual(memberBefore);
  });

  it("clears a route-less SAMPLE landing through Primary navigation and browser history synchronization", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);

    fireEvent.click(within(openChapterFlyout()).getByRole("button", { name: /^Open North County Transit Workers\b/ }));
    expect(await screen.findByText("CAMPAIGN SNAPSHOT")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Messages" }));
    expect(await screen.findByRole("heading", { name: "Messages" })).toBeInTheDocument();
    expect(screen.queryByText("CAMPAIGN SNAPSHOT")).toBeNull();

    fireEvent.click(within(openChapterFlyout()).getByRole("button", { name: /^Open North County Transit Workers\b/ }));
    expect(await screen.findByText("CAMPAIGN SNAPSHOT")).toBeInTheDocument();
    window.history.pushState({}, "", "/m?demo=1");
    fireEvent.popState(window);
    expect(await screen.findByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();
    expect(screen.queryByText("CAMPAIGN SNAPSHOT")).toBeNull();
  });

  it("clears a route-less SAMPLE landing from Primary navigation without a companion phone", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    expect(document.querySelector(".companion-phone")).toBeNull();
    fireEvent.click(within(openChapterFlyout()).getByRole("button", { name: /^Open North County Transit Workers\b/ }));
    expect(await screen.findByText("CAMPAIGN SNAPSHOT")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Messages" }));
    expect(await screen.findByRole("heading", { name: "Messages" })).toBeInTheDocument();
    expect(screen.queryByText("CAMPAIGN SNAPSHOT")).toBeNull();
  });

  it("opens the backed campaign surface from the one live campaign", async () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(within(openChapterFlyout()).getByRole("button", { name: /^Open Harborview Care United\b/ }));
    expect(await screen.findByRole("heading", { name: "My campaign" })).toBeInTheDocument();
    // Union Ground: the bare /m/organize address is the Organize plane, so
    // the campaign workspace opens on its first tab.
    expect(window.location.pathname).toBe("/m/organize/organize");
  });

  it("surfaces the rail-only destinations: Rewards, Forms, Workload log, Be heard", async () => {
    stubMatchMedia(true);
    render(<App />);
    // The member rail, pinned in full — exact labels, exact order. The
    // Union Ground Site design puts Be heard in the Me group after Forms;
    // a reshuffled, relabeled or dropped row fails here by name.
    // Each link is [icon span, label span, optional badge span], so [1] is
    // always the bare label. (Compass is a button, not a link — pinned by the
    // dialog test below.)
    const labels = [...document.querySelectorAll(".desktop-rail__items a")]
      .map((link) => link.querySelectorAll("span")[1].textContent);
    // Union Ground: Work sits beside Home, rewards read as Contributions and
    // cases as Issues, Meetings joins the campaign group, and Dues, Contract
    // clauses, Civic and the Membership card are left out.
    expect(labels).toEqual([
      "Home", "Work", "Voting", "Contributions",
      "Issues", "Forms", "Be heard", "Workplace log", "My reports", "Messages", "Pulse",
      "Meetings", "Rights", "Worker support", "Org structure", "My campaign", "Organization network", "Pay tools", "Search",
      // REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001 adds Site guide;
      // UG 2da673888d puts it first in Account.
      "Site guide", "Access history", "Settings",
    ]);
    const railIcons = [...document.querySelectorAll(".desktop-rail__items .desktop-rail__ic")];
    // The links, the Guide button and the command palette button.
    expect(railIcons).toHaveLength(24);
    expect(labels).not.toContain("Membership card");
    expect(railIcons.every((icon) => icon.querySelector("svg"))).toBe(true);
    expect(screen.getByRole("link", { name: "My campaign" }).querySelector("svg")).not.toBeNull();
    const shortcutContract = [
      ["Home", "Control+1 Meta+1"],
      ["Work", "Control+2 Meta+2"],
      ["Voting", "Control+3 Meta+3"],
      ["Contributions", "Control+4 Meta+4"],
      [/^Issues/, "Control+6 Meta+6"],
      [/^Forms/, "Control+7 Meta+7"],
      ["Be heard", "Control+8 Meta+8"],
      ["Workplace log", "Control+9 Meta+9"],
      ["My reports", "Control+0 Meta+0"],
    ];
    for (const [name, keys] of shortcutContract) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("aria-keyshortcuts", keys);
    }
    expect(screen.getByRole("button", { name: "Union Ground Guide AI" })).toHaveAttribute("aria-keyshortcuts", "Control+5 Meta+5");
    // Real screens that had no nav entry anywhere — the rail rescues them.
    fireEvent.click(screen.getByRole("link", { name: "Workplace log" }));
    // Wave 2c retitled the SCREEN to the prototype's tracker; Union
    // Ground names both the screen and the nav entry "Workplace log".
    expect(await screen.findByRole("heading", { name: "Workplace log" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/workload");
    fireEvent.click(screen.getByRole("link", { name: "Contributions" }));
    expect(await screen.findByRole("heading", { name: "Contributions" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/rewards");
    fireEvent.click(screen.getByRole("link", { name: /^Forms/ }));
    expect(await screen.findByRole("heading", { name: "Forms" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/forms");
    // Be heard shipped with wave 2c: the phone reaches it through the More
    // hub; on desktop the rail row is the only way in.
    fireEvent.click(screen.getByRole("link", { name: "Be heard" }));
    expect(await screen.findByRole("heading", { name: "Be heard" }, { timeout: 3000 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/voice");
  });

  it("navigates from the rail like the bottom nav navigates", async () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "Messages" }));
    expect(await screen.findByRole("heading", { name: "Messages" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/messages");
    expect(screen.getByRole("link", { name: "Messages" })).toHaveAttribute("aria-current", "page");
  });

  it("does not mount a companion-phone preview beside the desktop plane", () => {
    stubMatchMedia(true);
    render(<App />);
    // Rail AND phone at once — the design's side-by-side composition, not a
    // toggle. The phone is an iframe (a second instance of the app), so the
    // outer DOM still carries exactly one nav.
    expect(document.querySelector(".desktop-rail")).not.toBeNull();
    expect(document.querySelector(".companion-phone")).toBeNull();
    expect(document.querySelector(".phone-frame")).toBeNull();
    expect(document.querySelector(".companion-phone__app")).toBeNull();
    expect(document.querySelector(".bottom-nav")).toBeNull();
    // The old desktop/phone toggle is gone with the mode it drove.
    expect(screen.queryByRole("button", { name: "Phone" })).toBeNull();
  });

  it("does not mount a companion-phone preview on the SAMPLE demo origin either", () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    expect(document.querySelector(".companion-phone")).toBeNull();
  });

  // Union Ground: navigation never selects a staff hat the visitor did not
  // choose (PRODUCT.md, design principle 1), so a fresh demo visit starts as
  // Worker on Home rather than Union Ground's Steward desk.
  it("defaults a fresh SAMPLE visit to the Worker role", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    expect(topHatTrigger("Worker")).toBeInTheDocument();
    expect(within(document.querySelector(".desktop-rail")).queryByRole("group", { name: "Switch role" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Committee desk" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/m");
  });

  it("renders an embedded App with the boot hat's phone theme and announces ready after roles settle", async () => {
    stubMatchMedia(true);
    // ?embed=phone only counts inside a real frame — shadow window.parent so
    // this top-level jsdom window reads as the companion iframe (with the
    // postMessage the sg-embed-ready handshake calls). Restored in this
    // suite's afterEach.
    const postMessage = vi.fn();
    Object.defineProperty(window, "parent", { configurable: true, value: { postMessage } });
    window.history.replaceState({}, "", "/m?demo=1&embed=phone");
    render(<App />);
    // Even on a wide screen the embed stays the phone shell — this is the
    // recursion guard and the reason the iframe shows mobile layout.
    expect(document.querySelector(".desktop-rail")).toBeNull();
    expect(document.querySelector(".companion-phone")).toBeNull();
    // A fresh SAMPLE visit boots on the Steward role, which wears the one
    // Union Ground identity like every hat (owner ruling, November 3, 2026).
    // Union Ground ships one theme for every hat (no steward exception).
    expect(document.querySelector(".sg-app")).toHaveAttribute("data-workspace-theme", "union-ground");
    expect(document.querySelector(".sg-app")).not.toHaveClass("sg-app--desktop");
    // No demo chrome inside the bezel (owner call, 2026-07-31): the phone
    // preview shows the product; the outer shell's demo bar and Guide pill
    // stay out there. The hat select is PRODUCT chrome — a real phone
    // carries it, so the companion previews it too (all six hats), riding
    // the home space's floating chrome pill (2026-08-05 look-and-feel pass).
    expect(document.querySelector(".demo-bar")).toBeNull();
    expect(document.querySelector(".chapter-rail")).toBeNull();
    const embedPicker = within(document.querySelector(".card-nav__chrome")).getByRole("combobox", { name: "Switch role" });
    expect(within(embedPicker).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Worker", "Organizer", "Committee", "Campaign lead", "Advisor", "Admin", "Campaign chair",
    ]);
    // The tab bar and the shortcut bubble are both retired (2026-08-07
    // chrome-free wave): at rest on the feed the phone carries no floating
    // nav chrome at all, in the embed too.
    expect(document.querySelector(".shortcut-bubble__fab")).toBeNull();
    expect(document.querySelector(".home-orb")).toBeNull();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "sg-embed-ready" }, window.location.origin));
  });

  it("does not announce companion readiness while its role projection is unknown", async () => {
    stubMatchMedia(false);
    const postMessage = vi.fn();
    Object.defineProperty(window, "parent", { configurable: true, value: { postMessage } });
    primeDemoData({ ...structuredClone(fallbackData), rolesUnknown: true });
    try {
      primeDemoHat("member");
      window.history.replaceState({}, "", "/m?demo=1&embed=phone");
      render(<App />);
      await act(async () => Promise.resolve());
      expect(postMessage).not.toHaveBeenCalledWith({ type: "sg-embed-ready" }, window.location.origin);
      // Unknown roles suppress READY but never make an already mounted frame
      // deaf. Member-safe parent navigation remains processable while a
      // degraded role refresh is waiting to recover.
      fireEvent(window, new MessageEvent("message", {
        data: { type: "sg-nav", path: "/m/messages" },
        origin: window.location.origin,
        source: window.parent,
      }));
      expect(window.location.pathname).toBe("/m/messages");
    } finally {
      primeDemoData(fallbackData);
    }
  });

  it("posts a phone-selected hat before its immediately following route", async () => {
    stubMatchMedia(false);
    const postMessage = vi.fn();
    Object.defineProperty(window, "parent", { configurable: true, value: { postMessage } });
    window.history.replaceState({}, "", "/m?demo=1&embed=phone");
    render(<App />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "sg-embed-ready" }, window.location.origin));
    postMessage.mockClear();
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "coordinator" } });
    await waitFor(() => expect(window.location.pathname).toBe("/m/coordinator"));
    const messages = postMessage.mock.calls.map(([message]) => message);
    const hatIndex = messages.findIndex((message) => message.type === "sg-ui-state-up"
      && message.key === "app.selectedStaffHat" && message.value === "coordinator");
    const routeIndex = messages.findIndex((message) => message.type === "sg-nav-up"
      && new URL(message.path, window.location.origin).pathname === "/m/coordinator");
    expect(hatIndex).toBeGreaterThanOrEqual(0);
    expect(routeIndex).toBeGreaterThan(hatIndex);
  });

  it("keeps the full demo bar on the desktop shell: banner, Guide pill, and all six hats", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();
    // The embed dropped its strip (2026-07-31), which makes THIS bar the only
    // demo marker and hat entry on desktop — pin its full anatomy so a
    // regression cannot hide behind the embed assertions above.
    const bar = document.querySelector(".demo-bar");
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain("PREVIEW");
    expect(within(bar).getByRole("button", { name: "Guide" })).toBeInTheDocument();
    expect(topHatTrigger("Worker")).toBeInTheDocument();
    expect(within(topHatMenu()).getAllByRole("menuitemradio").map((option) => option.textContent.trim())).toEqual([
      "Worker", "Organizer", "Committee", "Campaign lead", "Advisor", "Admin", "Campaign chair",
    ]);
    expect(within(document.querySelector(".desktop-rail")).queryByRole("group", { name: "Switch role" })).not.toBeInTheDocument();
  });

  it("keeps the notifications bell on the worker hat, not just staff hats", async () => {
    stubMatchMedia(true);
    render(<App />);
    // Role-map UB-NAV-06: on desktop the rail IS the shell chrome, so a
    // staff-gated bell left a member-hat route with no notifications entry
    // point at all (TodayView's own bell went in c1f8268bd). This is /m —
    // the plainest member route there is.
    expect(window.location.pathname).toBe("/m");
    const rail = document.querySelector(".desktop-rail");
    // The count rides the accessible name, as on both phone surfaces, so one
    // selector finds the bell everywhere.
    const bell = within(rail).getByRole("button", { name: /^Notifications, \d+ unread$/ });
    expect(bell).toHaveAccessibleName("Notifications, 3 unread");
    expect(rail.querySelector(".desktop-rail__bell-dot")).not.toBeNull();
    expect(bell).toBeInTheDocument();
    fireEvent.click(bell);
    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeInTheDocument();
  });

  it("collapses only the desktop rail, preserving every worker action, icon, badge, shortcut, active state, and persisted preference", async () => {
    stubMatchMedia(true);
    const first = render(<App />);
    let rail = document.querySelector(".desktop-rail");
    const expandedLinks = within(rail).getAllByRole("link").map((link) => ({
      name: link.getAttribute("aria-label") || link.textContent.replace(/\s+/g, " ").trim(),
      href: link.getAttribute("href"),
      current: link.getAttribute("aria-current"),
      shortcuts: link.getAttribute("aria-keyshortcuts"),
      icon: link.querySelector(".desktop-rail__ic")?.textContent || "",
    }));
    const expandedActions = within(rail).getAllByRole("button").map((button) => button.getAttribute("aria-label") || button.textContent.replace(/\s+/g, " ").trim());

    const collapseButton = within(rail).getByRole("button", { name: "Collapse rail" });
    collapseButton.focus();
    fireEvent.click(collapseButton);

    expect(rail).toHaveAttribute("data-collapsed", "true");
    expect(window.localStorage.getItem(LIVE_DESKTOP_RAIL_COLLAPSE_KEY)).toBe("true");
    expect(within(rail).getByRole("button", { name: "Expand rail" })).toHaveFocus();
    expect(within(rail).getAllByRole("link").map((link) => ({
      name: link.getAttribute("aria-label") || link.textContent.replace(/\s+/g, " ").trim(),
      href: link.getAttribute("href"),
      current: link.getAttribute("aria-current"),
      shortcuts: link.getAttribute("aria-keyshortcuts"),
      icon: link.querySelector(".desktop-rail__ic")?.textContent || "",
    }))).toEqual(expandedLinks);
    expect(within(rail).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("link", { name: "Issues 1" }).querySelector(".rail-count")).toHaveTextContent("1");
    expect(within(rail).getByRole("link", { name: "Forms 2" }).querySelector(".rail-count")).toHaveTextContent("2");
    expect(within(rail).getByRole("button", { name: "Union Ground Guide AI" })).toHaveAttribute("aria-keyshortcuts", "Control+5 Meta+5");
    expect(within(rail).getByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /Profile$/ })).toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: /Switch role/ })).not.toBeInTheDocument();
    expect(within(rail).getAllByRole("button").map((button) => button.getAttribute("aria-label") || button.textContent.replace(/\s+/g, " ").trim())).toEqual(
      // The expanded member rail names its logo for the product (finding 84 of
      // #6578); the icon-only compact logo stays the Home control, and the
      // compact profile card, which hides the name, is named Profile.
      expandedActions.map((name) => name === "Collapse rail" ? "Expand rail" : name === "Union Ground" ? "Home" : name.endsWith(", Profile") ? "Profile" : name),
    );

    // Ctrl+2 is Union Ground's Work, second after Home.
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    await waitFor(() => expect(window.location.pathname).toBe("/m/work"));
    expect(within(rail).getByRole("link", { name: "Work" })).toHaveAttribute("aria-current", "page");

    first.unmount();
    window.history.replaceState({}, "", "/m");
    render(<App />);
    rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-render-mode", "desktop");
    expect(rail).toHaveAttribute("data-collapsed", "true");
    expect(within(rail).getByRole("button", { name: "Expand rail" })).toBeInTheDocument();
  });

  it("does not expose numeric staff shortcuts when the active staff hat is unavailable", () => {
    const navigate = vi.fn();
    renderDesktopRail({
      activeHat: "steward",
      onNavigate: navigate,
      staffPlanes: [],
      steward: false,
    });
    const rail = document.querySelector(".desktop-rail");
    expect(within(rail).queryByRole("link", { name: "Issue work" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Committee" })).not.toBeInTheDocument();

    const shortcut = new KeyboardEvent("keydown", {
      key: "2",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, shortcut);

    expect(shortcut.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("rolls back a true hat switch when the parent neither navigates nor acknowledges it", () => {
    const navigate = vi.fn();
    renderDesktopRail({
      onNavigate: navigate,
      onSwitchHat: () => true,
    });
    const rail = document.querySelector(".desktop-rail");

    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));
    const shortcut = new KeyboardEvent("keydown", {
      key: "2",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("work", "/m/work", "");
    expect(navigate).not.toHaveBeenCalledWith("steward", "/m/steward", "steward-caseload");
  });

  it("requires explicit parent acknowledgment even when the expected path was pushed", () => {
    const navigate = vi.fn();
    renderDesktopRail({
      onNavigate: navigate,
      onSwitchHat: () => {
        window.history.pushState({}, "", "/m/steward");
        return true;
      },
    });
    const rail = document.querySelector(".desktop-rail");

    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));
    const shortcut = new KeyboardEvent("keydown", {
      key: "2",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("work", "/m/work", "");
    expect(navigate).not.toHaveBeenCalledWith("steward", "/m/steward", "steward-caseload");
  });

  it("activates an accepted pending map only after its delayed explicit acknowledgment", () => {
    const navigate = vi.fn();
    let acknowledgeSwitch = null;
    renderDesktopRail({
      onNavigate: navigate,
      onSwitchHat: (_key, acknowledge) => {
        window.history.pushState({}, "", "/m/steward");
        acknowledgeSwitch = acknowledge;
        return true;
      },
    });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("work", "/m/work", "");

    navigate.mockClear();
    expect(acknowledgeSwitch?.()).toBe(true);
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("steward", "/m/steward/caseload", "steward-caseload");
  });

  it("permanently invalidates a delayed acknowledgment after external navigation", () => {
    const navigate = vi.fn();
    let acknowledgeSwitch = null;
    renderDesktopRail({
      onNavigate: navigate,
      onSwitchHat: (_key, acknowledge) => {
        window.history.pushState({}, "", "/m/steward");
        acknowledgeSwitch = acknowledge;
        return true;
      },
    });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));

    window.history.pushState({}, "", "/m");
    expect(acknowledgeSwitch?.()).toBe(false);
    window.history.pushState({}, "", "/m/steward");
    expect(acknowledgeSwitch?.()).toBe(false);

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("work", "/m/work", "");
  });

  it("invalidates an acknowledged pending map after silent programmatic navigation", () => {
    const navigate = vi.fn();
    renderDesktopRail({
      onNavigate: navigate,
      onSwitchHat: (_key, acknowledge) => {
        window.history.pushState({}, "", "/m/steward");
        acknowledge?.();
        return true;
      },
    });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));
    window.history.pushState({}, "", "/m");

    const shortcut = new KeyboardEvent("keydown", {
      key: "2",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("work", "/m/work", "");
    expect(navigate).not.toHaveBeenCalledWith("steward", "/m/steward/caseload", "steward-caseload");
  });

  it("keeps an explicitly acknowledged map until the delayed active hat render commits it", () => {
    const navigate = vi.fn();
    const switchHat = vi.fn((_key, acknowledge) => {
      window.history.pushState({}, "", "/m/steward");
      acknowledge?.();
      return true;
    });
    const view = renderDesktopRail({ onNavigate: navigate, onSwitchHat: switchHat });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("steward", "/m/steward/caseload", "steward-caseload");

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="steward" activeHat="steward" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={navigate} onNotifications={() => {}} onSwitchHat={switchHat} renderMode="desktop" staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("steward", "/m/steward/caseload", "steward-caseload");
  });

  it("invalidates a pending request when its authorized hat path changes", () => {
    const navigate = vi.fn();
    const switchHat = vi.fn((_key, acknowledge) => {
      window.history.pushState({}, "", "/m/steward");
      acknowledge?.();
      return true;
    });
    const view = renderDesktopRail({ onNavigate: navigate, onSwitchHat: switchHat });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={navigate} onNotifications={() => {}} onSwitchHat={switchHat} renderMode="desktop" staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward-v2" }]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });

    expect(navigate).toHaveBeenCalledWith("work", "/m/work", "");
    expect(navigate).not.toHaveBeenCalledWith("steward", "/m/steward", "steward-caseload");
  });

  it("drops a provisional staff map when authorization removes its pending hat", () => {
    const navigate = vi.fn();
    const switchHat = vi.fn((_key, acknowledge) => {
      window.history.pushState({}, "", "/m/steward");
      acknowledge?.();
      return true;
    });
    const view = renderDesktopRail({ onNavigate: navigate, onSwitchHat: switchHat });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));
    expect(window.location.pathname).toBe("/m/steward");

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={navigate} onNotifications={() => {}} onSwitchHat={switchHat} renderMode="desktop" staffPlanes={[]} steward={false} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );
    expect(within(rail).queryByRole("button", { name: "Committee" })).not.toBeInTheDocument();

    const shortcut = new KeyboardEvent("keydown", {
      key: "2",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("work", "/m/work", "");
    expect(navigate).not.toHaveBeenCalledWith("steward", "/m/steward", "steward-caseload");
  });

  it("resets a provisional hat map synchronously when popstate cancels navigation", () => {
    const navigate = vi.fn();
    renderDesktopRail({
      onNavigate: navigate,
      onSwitchHat: (_key, acknowledge) => {
        window.history.pushState({}, "", "/m/steward");
        acknowledge?.();
        return true;
      },
    });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));
    window.history.replaceState({}, "", "/m");

    window.dispatchEvent(new PopStateEvent("popstate"));
    const shortcut = new KeyboardEvent("keydown", {
      key: "2",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("work", "/m/work", "");
    expect(navigate).not.toHaveBeenCalledWith("steward", "/m/steward", "steward-caseload");
  });

  it("keeps the top hat menu complete and keyboard operable while the green rail is collapsed", async () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    const rail = document.querySelector(".desktop-rail");

    expect(within(rail).queryByRole("link", { name: "Issue work" })).not.toBeInTheDocument();
    // The worker Work list stays; the staff-only shared work tool does not.
    expect(rail.querySelector('a[href="/m/tasks"]')).toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));

    const bar = document.querySelector(".demo-bar");
    let chooser = topHatTrigger("Worker");
    expect(chooser).toHaveAttribute("aria-haspopup", "menu");
    expect(chooser).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chooser);
    let menu = within(bar).getByRole("menu", { name: "Switch role" });
    const options = within(menu).getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent.trim())).toEqual([
      "Worker", "Organizer", "Committee", "Campaign lead", "Advisor", "Admin", "Campaign chair",
    ]);
    expect(options[0]).toHaveAttribute("aria-checked", "true");
    expect(options[0]).toHaveFocus();

    // Seven hats in Union Ground (Organizer joins after Worker).
    fireEvent.keyDown(options[0], { key: "End" });
    expect(options[6]).toHaveFocus();
    fireEvent.keyDown(options[6], { key: "Home" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0], { key: "ArrowUp" });
    expect(options[6]).toHaveFocus();
    fireEvent.keyDown(options[6], { key: "ArrowDown" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(options[1]).toHaveFocus();
    fireEvent.keyDown(options[1], { key: "ArrowDown" });
    expect(options[2]).toHaveFocus();
    fireEvent.keyDown(options[2], { key: " " });

    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    chooser = topHatTrigger("Committee");
    expect(within(bar).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();

    fireEvent.keyDown(chooser, { key: "ArrowDown" });
    menu = within(bar).getByRole("menu", { name: "Switch role" });
    expect(within(menu).getByRole("menuitemradio", { name: "Committee" })).toHaveFocus();
    fireEvent.keyDown(within(menu).getByRole("menuitemradio", { name: "Committee" }), { key: "Escape" });
    expect(within(bar).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();

    fireEvent.keyDown(chooser, { key: "ArrowUp" });
    menu = within(bar).getByRole("menu", { name: "Switch role" });
    expect(within(menu).getByRole("menuitemradio", { name: "Campaign chair" })).toHaveFocus();
    fireEvent.mouseDown(document.body);
    expect(within(bar).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).not.toHaveFocus();

    fireEvent.click(chooser);
    menu = within(bar).getByRole("menu", { name: "Switch role" });
    const member = within(menu).getByRole("menuitemradio", { name: "Worker" });
    fireEvent.keyDown(member, { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();
    expect(topHatTrigger("Worker")).toHaveFocus();
  });

  it("closes the compact hat menu when Tab or Shift+Tab leaves it without stealing destination focus", () => {
    const profile = vi.fn();
    renderDesktopRail({ demo: true, memberId: null, user: { name: "Darnell Foster", initials: "DF", onProfile: profile } });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    const profileButton = within(rail).getByRole("button", { name: /Profile$/ });

    fireEvent.click(chooser);
    let member = within(rail).getByRole("menuitemradio", { name: "Worker" });
    fireEvent.blur(member, { relatedTarget: profileButton });
    profileButton.focus();
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(profileButton).toHaveFocus();

    fireEvent.click(chooser);
    member = within(rail).getByRole("menuitemradio", { name: "Worker" });
    fireEvent.blur(member, { relatedTarget: chooser });
    chooser.focus();
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();
  });

  it("opens, activates, and dismisses the compact hat chooser from the keyboard", () => {
    const switchHat = vi.fn();
    renderDesktopRail({ demo: true, memberId: null, onSwitchHat: switchHat });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });

    fireEvent.keyDown(chooser, { key: "ArrowUp" });
    let menu = within(rail).getByRole("menu", { name: "Switch role" });
    const steward = within(menu).getByRole("menuitemradio", { name: "Committee" });
    expect(steward).toHaveFocus();
    fireEvent.keyDown(steward, { key: " " });
    expect(switchHat).toHaveBeenCalledWith("steward", expect.any(Function));
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();

    fireEvent.click(chooser);
    menu = within(rail).getByRole("menu", { name: "Switch role" });
    const member = within(menu).getByRole("menuitemradio", { name: "Worker" });
    fireEvent.keyDown(member, { key: "Escape" });
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();
  });

  it("closes the compact menu and restores its trigger when the focused hat is removed", () => {
    const staffPlanes = [
      { key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" },
      { key: "advisor", labelKey: "demo.hatAdvisor", path: "/m/advisor" },
    ];
    const view = renderDesktopRail({ staffPlanes });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    let chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    fireEvent.click(chooser);
    const member = within(rail).getByRole("menuitemradio", { name: "Worker" });
    const advisor = within(rail).getByRole("menuitemradio", { name: "Advisor" });
    fireEvent.keyDown(member, { key: "End" });
    expect(advisor).toHaveFocus();

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} onNotifications={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[staffPlanes[0]]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );

    chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();
  });

  it("moves focus to Profile when removing the final authorized compact hat unmounts the chooser", () => {
    const stewardPlane = { key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" };
    const view = renderDesktopRail({ staffPlanes: [stewardPlane] });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    fireEvent.click(chooser);
    within(rail).getByRole("menuitemradio", { name: "Committee" }).focus();

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} onNotifications={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );

    expect(within(rail).queryByRole("button", { name: /Switch role/ })).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /Profile$/ })).toHaveFocus();
  });

  it("moves compact chooser focus to Profile when expansion and final-hat removal commit together", () => {
    const stewardPlane = { key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" };
    let removeAndExpand = null;
    function SimultaneousRailHarness() {
      const [staffPlanes, setStaffPlanes] = useState([stewardPlane]);
      removeAndExpand = () => {
        document.querySelector(".desktop-rail__collapse").click();
        setStaffPlanes([]);
      };
      return (
        <LanguageProvider lang="en">
          <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} onNotifications={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={staffPlanes} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
        </LanguageProvider>
      );
    }
    render(<SimultaneousRailHarness />);
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    fireEvent.click(within(rail).getByRole("button", { name: "Switch role, current: Worker" }));
    within(rail).getByRole("menuitemradio", { name: "Committee" }).focus();

    act(() => removeAndExpand());

    expect(rail).toHaveAttribute("data-collapsed", "false");
    expect(within(rail).queryByRole("button", { name: /Switch role/ })).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /Profile$/ })).toHaveFocus();
  });

  it.each([
    ["expanded desktop", "desktop"],
    ["tablet", "tablet"],
  ])("moves focused %s hat options to Profile when the final staff hat is removed", (_label, renderMode) => {
    const stewardPlane = { key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" };
    const railProps = {
      active: "today",
      activeHat: "member",
      demo: false,
      memberId: "member-a",
      onAsk: () => {},
      onNavigate: () => {},
      onNotifications: () => {},
      onSwitchHat: () => {},
      renderMode,
      user: { name: "Darnell Foster", initials: "DF", onProfile: () => {} },
    };
    const view = render(
      <LanguageProvider lang="en">
        <DesktopRail {...railProps} staffPlanes={[stewardPlane]} />
      </LanguageProvider>,
    );
    const rail = document.querySelector(".desktop-rail");
    within(rail).getByRole("button", { name: "Committee" }).focus();

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail {...railProps} staffPlanes={[]} />
      </LanguageProvider>,
    );

    expect(within(rail).queryByRole("button", { name: "Committee" })).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /Profile$/ })).toHaveFocus();
  });

  it.each([
    ["the collapse control", "desktop", "Collapse rail"],
    ["the brand control", "tablet", "Union Ground"],
  ])("falls back to %s when focused hat removal has no Profile button", (_label, renderMode, targetName) => {
    const stewardPlane = { key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" };
    const railProps = {
      active: "today",
      activeHat: "member",
      demo: false,
      memberId: "member-a",
      onAsk: () => {},
      onNavigate: () => {},
      onNotifications: () => {},
      onSwitchHat: () => {},
      renderMode,
    };
    const view = render(
      <LanguageProvider lang="en">
        <DesktopRail {...railProps} staffPlanes={[stewardPlane]} />
      </LanguageProvider>,
    );
    const rail = document.querySelector(".desktop-rail");
    within(rail).getByRole("button", { name: "Committee" }).focus();

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail {...railProps} staffPlanes={[]} />
      </LanguageProvider>,
    );

    expect(within(rail).getByRole("button", { name: targetName })).toHaveFocus();
  });

  it("does not steal focus after an outside control dismissed the compact chooser", () => {
    const stewardPlane = { key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" };
    const view = renderDesktopRail({ staffPlanes: [stewardPlane] });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    fireEvent.click(within(rail).getByRole("button", { name: "Switch role, current: Worker" }));
    within(rail).getByRole("menuitemradio", { name: "Committee" }).focus();
    const home = within(rail).getByRole("button", { name: "Home" });
    fireEvent.mouseDown(home);
    home.focus();
    expect(home).toHaveFocus();

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} onNotifications={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );

    expect(home).toHaveFocus();
  });

  it("does not reuse compact focus handoff after the switcher is replaced by its tablet representation", () => {
    const stewardPlane = { key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" };
    const railProps = {
      active: "today",
      activeHat: "member",
      demo: false,
      memberId: "member-a",
      onAsk: () => {},
      onNavigate: () => {},
      onNotifications: () => {},
      onSwitchHat: () => {},
      user: { name: "Darnell Foster", initials: "DF", onProfile: () => {} },
    };
    const renderRail = (renderMode, staffPlanes) => (
      <>
        <button type="button">Outside rail</button>
        <LanguageProvider lang="en">
          <DesktopRail {...railProps} renderMode={renderMode} staffPlanes={staffPlanes} />
        </LanguageProvider>
      </>
    );
    const view = render(renderRail("desktop", [stewardPlane]));
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    fireEvent.click(within(rail).getByRole("button", { name: "Switch role, current: Worker" }));
    within(rail).getByRole("menuitemradio", { name: "Committee" }).focus();

    view.rerender(renderRail("tablet", [stewardPlane]));

    expect(rail).toHaveAttribute("data-render-mode", "tablet");
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Committee" })).toBeInTheDocument();
    const outside = screen.getByRole("button", { name: "Outside rail" });
    outside.focus();
    expect(outside).toHaveFocus();

    view.rerender(renderRail("tablet", []));

    expect(within(rail).queryByRole("button", { name: "Committee" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("does not move outside focus when an unfocused expanded hat switcher disappears", () => {
    const stewardPlane = { key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" };
    const view = renderDesktopRail({ staffPlanes: [stewardPlane] });
    const rail = document.querySelector(".desktop-rail");
    const home = within(rail).getByRole("button", { name: "Union Ground" });
    home.focus();

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} onNotifications={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );

    expect(home).toHaveFocus();
  });

  it("closes the compact hat menu after a global numeric shortcut navigates", () => {
    const navigate = vi.fn();
    renderDesktopRail({ onNavigate: navigate });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    fireEvent.click(chooser);
    expect(within(rail).getByRole("menu", { name: "Switch role" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });

    expect(navigate).toHaveBeenCalledWith("work", "/m/work", "");
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();
  });

  it("shows the compact tooltip when keyboard collapse retains focus on the renamed control", () => {
    renderDesktopRail({ demo: true, memberId: null });
    const rail = document.querySelector(".desktop-rail");
    const collapse = within(rail).getByRole("button", { name: "Collapse rail" });
    collapse.focus();

    fireEvent.click(collapse);

    const expand = within(rail).getByRole("button", { name: "Expand rail" });
    const tooltip = document.getElementById(expand.getAttribute("aria-describedby"));
    expect(expand).toHaveFocus();
    expect(tooltip).toHaveAttribute("role", "tooltip");
    expect(tooltip).toHaveAttribute("data-visible", "true");
  });

  it("dismisses the compact hat menu on outside pointer or touch without restoring trigger focus", () => {
    renderDesktopRail({ demo: true, memberId: null });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    const profile = within(rail).getByRole("button", { name: /Profile$/ });

    fireEvent.click(chooser);
    fireEvent.mouseDown(profile);
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).not.toHaveFocus();
    profile.focus();
    expect(profile).toHaveFocus();

    fireEvent.click(chooser);
    fireEvent.touchStart(document.body);
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).not.toHaveFocus();
  });

  it("keeps Escape dismissal robust while the compact hat menu is open", () => {
    renderDesktopRail({ demo: true, memberId: null });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    fireEvent.click(chooser);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();
  });

  it("isolates collapse persistence across demo, live, and worker identity changes in one mounted rail", () => {
    const view = renderDesktopRail({ demo: true, memberId: null });
    let rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    expect(window.sessionStorage.getItem(DEMO_DESKTOP_RAIL_COLLAPSE_KEY)).toBe("true");
    expect(window.localStorage.getItem("sg:member:member-a:desktop-main-rail:collapsed")).toBeNull();

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} onNotifications={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );
    rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-collapsed", "false");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    expect(window.localStorage.getItem("sg:member:member-a:desktop-main-rail:collapsed")).toBe("true");

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-b" onAsk={() => {}} onNavigate={() => {}} onNotifications={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );
    rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-collapsed", "false");
    expect(window.localStorage.getItem("sg:member:member-b:desktop-main-rail:collapsed")).toBeNull();

    view.rerender(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} onNotifications={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]} user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }} />
      </LanguageProvider>,
    );
    expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-collapsed", "true");
  });

  it("associates every compact rail function with an explicit localized tooltip", () => {
    const english = renderDesktopRail();
    let rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const englishControls = [
      ["button", "Home", "Home"],
      ["button", "Notifications, 0 unread", "Notifications, 0 unread"],
      ["link", "Voting", "Voting"],
      ["button", "Union Ground Guide AI", "Union Ground Guide AI"],
      ["button", "Switch role, current: Worker", "Switch role, current: Worker"],
      ["button", "Profile", "Profile"],
      ["button", "Expand rail", "Expand rail"],
    ];
    for (const [role, name, tooltipText] of englishControls) {
      const control = within(rail).getByRole(role, { name });
      const tooltip = document.getElementById(control.getAttribute("aria-describedby"));
      expect(tooltip).toHaveAttribute("role", "tooltip");
      expect(tooltip).toHaveTextContent(tooltipText);
    }
    english.unmount();

    window.localStorage.removeItem("sg:member:member-a:desktop-main-rail:collapsed");
    renderDesktopRail({ lang: "es" });
    rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Contraer navegación" }));
    const spanishHome = within(rail).getByRole("button", { name: "Inicio" });
    const spanishProfile = within(rail).getByRole("button", { name: /Perfil$/ });
    const spanishExpand = within(rail).getByRole("button", { name: "Expandir navegación" });
    expect(document.getElementById(spanishHome.getAttribute("aria-describedby"))).toHaveTextContent("Inicio");
    expect(document.getElementById(spanishProfile.getAttribute("aria-describedby"))).toHaveTextContent("Perfil");
    expect(document.getElementById(spanishExpand.getAttribute("aria-describedby"))).toHaveTextContent("Expandir navegación");
  });

  it("keeps brand, pointer tooltip, and pointer hat actions live in compact mode", async () => {
    const navigate = vi.fn();
    const switchHat = vi.fn();
    renderDesktopRail({ onNavigate: navigate, onSwitchHat: switchHat });
    const rail = document.querySelector(".desktop-rail");

    fireEvent.click(within(rail).getByRole("button", { name: "Union Ground" }));
    expect(navigate).toHaveBeenCalledWith("today", "/m", "");

    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const compactHome = within(rail).getByRole("button", { name: "Home" });
    vi.spyOn(compactHome, "getBoundingClientRect").mockReturnValue({
      bottom: 64,
      height: 44,
      left: 8,
      right: 52,
      top: 20,
      width: 44,
      x: 8,
      y: 20,
      toJSON: () => ({}),
    });
    const tooltip = document.getElementById(compactHome.getAttribute("aria-describedby"));
    fireEvent.mouseEnter(compactHome);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    fireEvent(window, new Event("resize"));
    expect(tooltip).not.toHaveAttribute("data-visible");

    fireEvent.mouseEnter(compactHome);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    fireEvent.mouseLeave(compactHome);
    await waitFor(() => expect(tooltip).not.toHaveAttribute("data-visible"));

    fireEvent.click(within(rail).getByRole("button", { name: "Switch role, current: Worker" }));
    fireEvent(window, new Event("resize"));
    fireEvent.click(within(rail).getByRole("menuitemradio", { name: "Committee" }));
    expect(switchHat).toHaveBeenCalledWith("steward", expect.any(Function));
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
  });

  it("keeps a compact tooltip open across the pointer transfer onto its popup and back [en/es]", () => {
    for (const [lang, collapse, home] of [["en", "Collapse rail", "Home"], ["es", "Contraer navegación", "Inicio"]]) {
      vi.useFakeTimers();
      const view = renderDesktopRail({ lang });
      const rail = document.querySelector(".desktop-rail");
      fireEvent.click(within(rail).getByRole("button", { name: collapse }));
      const control = within(rail).getByRole("button", { name: home });
      const tooltip = document.getElementById(control.getAttribute("aria-describedby"));
      expect(tooltip).toHaveTextContent(home);

      fireEvent.mouseEnter(control);
      expect(tooltip).toHaveAttribute("data-visible", "true");
      fireEvent.mouseLeave(control, { relatedTarget: tooltip });
      fireEvent.mouseEnter(tooltip, { relatedTarget: control });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.mouseLeave(tooltip, { relatedTarget: control });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.mouseLeave(tooltip, { relatedTarget: document.body });
      expect(tooltip).toHaveAttribute("data-visible", "true");
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).not.toHaveAttribute("data-visible");
      view.unmount();
      vi.useRealTimers();
      window.localStorage.removeItem("sg:member:member-a:desktop-main-rail:collapsed");
    }
  });

  it("dismisses a focused compact tooltip on Escape without moving focus, navigating, or reaching window listeners", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    try {
      renderDesktopRail({ onNavigate: navigate });
      const rail = document.querySelector(".desktop-rail");
      fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
      const voting = within(rail).getByRole("link", { name: "Voting" });
      const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));
      // jsdom has no keyboard modality; a real browser proves :focus-visible
      // in e2e/p10-rail-tooltip-interactions.spec.js.
      const matches = voting.matches.bind(voting);
      vi.spyOn(voting, "matches").mockImplementation((selector) => selector === ":focus-visible" || matches(selector));
      act(() => { voting.focus(); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      // A capture listener (a calendar popover) that already answered Escape keeps it.
      const claimEscape = (event) => { if (event.key === "Escape") event.preventDefault(); };
      window.addEventListener("keydown", claimEscape, true);
      fireEvent.keyDown(voting, { key: "Escape" });
      window.removeEventListener("keydown", claimEscape, true);
      expect(tooltip).toHaveAttribute("data-visible", "true");
      windowEscape.mockClear();

      fireEvent.keyDown(voting, { key: "Escape" });
      expect(tooltip).not.toHaveAttribute("data-visible");
      expect(voting).toHaveFocus();
      expect(navigate).not.toHaveBeenCalled();
      expect(windowEscape).not.toHaveBeenCalled();

      fireEvent(window, new Event("resize"));
      fireEvent.scroll(window);
      fireEvent.mouseLeave(voting, { relatedTarget: document.body });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).not.toHaveAttribute("data-visible");
      expect(voting).toHaveFocus();

      fireEvent.mouseEnter(voting);
      expect(tooltip).toHaveAttribute("data-visible", "true");
    } finally {
      window.removeEventListener("keydown", windowEscape);
    }
  });

  it("keeps a dismissed compact tooltip hidden until a fresh hover, and clicking the popup never activates its control", () => {
    const navigate = vi.fn();
    renderDesktopRail({ onNavigate: navigate });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const voting = within(rail).getByRole("link", { name: "Voting" });
    const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));

    fireEvent.mouseEnter(voting);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    fireEvent.keyDown(voting, { key: "Escape" });
    expect(tooltip).not.toHaveAttribute("data-visible");
    fireEvent.mouseLeave(voting, { relatedTarget: document.body });
    fireEvent.mouseEnter(voting);
    expect(tooltip).toHaveAttribute("data-visible", "true");

    fireEvent.click(tooltip);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("dismisses a hovered compact tooltip on Escape ahead of an older panel layer, and yields a handled key", () => {
    const panelEscape = vi.fn();
    const unregisterPanel = registerEscapeLayer(panelEscape);
    const outside = document.createElement("input");
    document.body.append(outside);
    const claimEscape = (event) => { if (event.key === "Escape") event.preventDefault(); };
    try {
      renderDesktopRail();
      const rail = document.querySelector(".desktop-rail");
      fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
      const voting = within(rail).getByRole("link", { name: "Voting" });
      const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));
      act(() => { outside.focus(); });
      fireEvent.mouseEnter(voting);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      // A popover that already claimed the key keeps it; the tooltip stays.
      window.addEventListener("keydown", claimEscape, true);
      fireEvent.keyDown(outside, { key: "Escape" });
      window.removeEventListener("keydown", claimEscape, true);
      expect(tooltip).toHaveAttribute("data-visible", "true");
      expect(panelEscape).not.toHaveBeenCalled();

      // Otherwise the hovered tooltip is the newest layer: one press hides it
      // and leaves the older panel and the focused field alone.
      expect(fireEvent.keyDown(outside, { key: "Escape" })).toBe(false);
      expect(tooltip).not.toHaveAttribute("data-visible");
      expect(outside).toHaveFocus();
      expect(panelEscape).not.toHaveBeenCalled();

      fireEvent.keyDown(outside, { key: "Escape" });
      expect(panelEscape).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", claimEscape, true);
      unregisterPanel();
      outside.remove();
    }
  });

  it("leaves a hovered compact tooltip up while the Tasks keymap's Escape exits focus mode, in either listener order", () => {
    // Shaped like the TasksView window keymap: it skips typing surfaces and
    // exits focus mode on an Escape nobody prevented, without preventing it.
    const tasksKeymap = (event) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
      if (deviceParityValue("tasks.focusWorkstream")) applyDeviceParityState("tasks.focusWorkstream", null);
    };
    for (const keymapFirst of [true, false]) {
      // Whichever window listener is installed first runs first.
      const unregisterEarlier = keymapFirst ? () => {} : registerEscapeLayer(() => {});
      window.addEventListener("keydown", tasksKeymap);
      const field = document.createElement("input");
      document.body.append(field);
      const view = renderDesktopRail();
      try {
        applyDeviceParityState("tasks.focusWorkstream", "Organizing");
        const rail = document.querySelector(".desktop-rail");
        fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
        const voting = within(rail).getByRole("link", { name: "Voting" });
        const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));
        fireEvent.mouseEnter(voting);
        expect(tooltip).toHaveAttribute("data-visible", "true");

        expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
        expect(deviceParityValue("tasks.focusWorkstream")).toBeNull();
        expect(tooltip).toHaveAttribute("data-visible", "true");

        expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
        expect(tooltip).not.toHaveAttribute("data-visible");

        // In a typing field the Tasks keymap skips the press, so the tooltip takes it.
        applyDeviceParityState("tasks.focusWorkstream", "Organizing");
        fireEvent.mouseLeave(voting, { relatedTarget: document.body });
        fireEvent.mouseEnter(voting);
        expect(tooltip).toHaveAttribute("data-visible", "true");
        expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
        expect(tooltip).not.toHaveAttribute("data-visible");
        expect(deviceParityValue("tasks.focusWorkstream")).toBe("Organizing");
      } finally {
        view.unmount();
        window.removeEventListener("keydown", tasksKeymap);
        field.remove();
        unregisterEarlier();
        clearDeviceParityState();
        window.localStorage.clear();
      }
    }
  });

  it("leaves a hovered compact tooltip up while a mounted Tasks board popover takes the Escape", () => {
    // An earlier non-modal layer (Compass) installs the shared listener first,
    // so the tooltip layer would run before the popover's own window listener,
    // which closes on Escape and ignores defaultPrevented (TasksView Popover).
    const unregisterCompass = registerEscapeLayer(() => {});
    const popover = document.createElement("div");
    popover.className = "kan-popover";
    const closePopover = vi.fn(() => popover.remove());
    const popoverEscape = (event) => { if (event.key === "Escape") closePopover(); };
    try {
      renderDesktopRail();
      const rail = document.querySelector(".desktop-rail");
      fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
      const voting = within(rail).getByRole("link", { name: "Voting" });
      const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));
      document.body.append(popover);
      window.addEventListener("keydown", popoverEscape);
      fireEvent.mouseEnter(voting);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(closePopover).toHaveBeenCalledTimes(1);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      // With the popover gone, the next press is the tooltip's.
      expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
      expect(tooltip).not.toHaveAttribute("data-visible");
    } finally {
      window.removeEventListener("keydown", popoverEscape);
      popover.remove();
      unregisterCompass();
      window.localStorage.clear();
    }
  });

  it("composes compact hat tooltip Escape with the hat menu's arrow navigation", () => {
    renderDesktopRail({ demo: true, memberId: null });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    const tooltip = document.getElementById(chooser.getAttribute("aria-describedby"));
    act(() => { chooser.focus(); });
    expect(tooltip).toHaveAttribute("data-visible", "true");

    fireEvent.keyDown(chooser, { key: "Escape" });
    expect(tooltip).not.toHaveAttribute("data-visible");
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();

    fireEvent.keyDown(chooser, { key: "ArrowDown" });
    expect(within(rail).getByRole("menu", { name: "Switch role" })).toBeInTheDocument();
    expect(tooltip).not.toHaveAttribute("data-visible");
    // The open menu suppresses the chooser's tooltip even under the pointer.
    fireEvent.mouseEnter(chooser);
    expect(tooltip).not.toHaveAttribute("data-visible");
  });

  it("clears a pending compact tooltip close on expansion and unmount", () => {
    vi.useFakeTimers();
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const view = renderDesktopRail();
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const home = within(rail).getByRole("button", { name: "Home" });
    fireEvent.mouseEnter(home);
    fireEvent.mouseLeave(home, { relatedTarget: document.body });
    const expansionTimer = setTimer.mock.results.at(-1).value;

    fireEvent.click(within(rail).getByRole("button", { name: "Expand rail" }));
    expect(clearTimer).toHaveBeenCalledWith(expansionTimer);
    expect(home).not.toHaveAttribute("aria-describedby");

    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const profile = within(rail).getByRole("button", { name: /Profile$/ });
    fireEvent.mouseEnter(profile);
    fireEvent.mouseLeave(profile, { relatedTarget: document.body });
    const unmountTimer = setTimer.mock.results.at(-1).value;
    view.unmount();
    expect(clearTimer).toHaveBeenCalledWith(unmountTimer);
  });

  it("keeps a compact tooltip open across the pointer transfer onto its popup and back [en/es]", () => {
    for (const [lang, collapse, home] of [["en", "Collapse rail", "Home"], ["es", "Contraer navegación", "Inicio"]]) {
      vi.useFakeTimers();
      const view = renderDesktopRail({ lang });
      const rail = document.querySelector(".desktop-rail");
      fireEvent.click(within(rail).getByRole("button", { name: collapse }));
      const control = within(rail).getByRole("button", { name: home });
      const tooltip = document.getElementById(control.getAttribute("aria-describedby"));
      expect(tooltip).toHaveTextContent(home);

      fireEvent.mouseEnter(control);
      expect(tooltip).toHaveAttribute("data-visible", "true");
      fireEvent.mouseLeave(control, { relatedTarget: tooltip });
      fireEvent.mouseEnter(tooltip, { relatedTarget: control });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.mouseLeave(tooltip, { relatedTarget: control });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.mouseLeave(tooltip, { relatedTarget: document.body });
      expect(tooltip).toHaveAttribute("data-visible", "true");
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).not.toHaveAttribute("data-visible");
      view.unmount();
      vi.useRealTimers();
      window.localStorage.removeItem("sg:member:member-a:desktop-main-rail:collapsed");
    }
  });

  it("dismisses a focused compact tooltip on Escape without moving focus, navigating, or reaching window listeners", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    try {
      renderDesktopRail({ onNavigate: navigate });
      const rail = document.querySelector(".desktop-rail");
      fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
      const voting = within(rail).getByRole("link", { name: "Voting" });
      const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));
      // jsdom has no keyboard modality; a real browser proves :focus-visible
      // in e2e/p10-rail-tooltip-interactions.spec.js.
      const matches = voting.matches.bind(voting);
      vi.spyOn(voting, "matches").mockImplementation((selector) => selector === ":focus-visible" || matches(selector));
      act(() => { voting.focus(); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      // A capture listener (a calendar popover) that already answered Escape keeps it.
      const claimEscape = (event) => { if (event.key === "Escape") event.preventDefault(); };
      window.addEventListener("keydown", claimEscape, true);
      fireEvent.keyDown(voting, { key: "Escape" });
      window.removeEventListener("keydown", claimEscape, true);
      expect(tooltip).toHaveAttribute("data-visible", "true");
      windowEscape.mockClear();

      fireEvent.keyDown(voting, { key: "Escape" });
      expect(tooltip).not.toHaveAttribute("data-visible");
      expect(voting).toHaveFocus();
      expect(navigate).not.toHaveBeenCalled();
      expect(windowEscape).not.toHaveBeenCalled();

      fireEvent(window, new Event("resize"));
      fireEvent.scroll(window);
      fireEvent.mouseLeave(voting, { relatedTarget: document.body });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).not.toHaveAttribute("data-visible");
      expect(voting).toHaveFocus();

      fireEvent.mouseEnter(voting);
      expect(tooltip).toHaveAttribute("data-visible", "true");
    } finally {
      window.removeEventListener("keydown", windowEscape);
    }
  });

  it("keeps a dismissed compact tooltip hidden until a fresh hover, and clicking the popup never activates its control", () => {
    const navigate = vi.fn();
    renderDesktopRail({ onNavigate: navigate });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const voting = within(rail).getByRole("link", { name: "Voting" });
    const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));

    fireEvent.mouseEnter(voting);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    fireEvent.keyDown(voting, { key: "Escape" });
    expect(tooltip).not.toHaveAttribute("data-visible");
    fireEvent.mouseLeave(voting, { relatedTarget: document.body });
    fireEvent.mouseEnter(voting);
    expect(tooltip).toHaveAttribute("data-visible", "true");

    fireEvent.click(tooltip);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("dismisses a hovered compact tooltip on Escape ahead of an older panel layer, and yields a handled key", () => {
    const panelEscape = vi.fn();
    const unregisterPanel = registerEscapeLayer(panelEscape);
    const outside = document.createElement("input");
    document.body.append(outside);
    const claimEscape = (event) => { if (event.key === "Escape") event.preventDefault(); };
    try {
      renderDesktopRail();
      const rail = document.querySelector(".desktop-rail");
      fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
      const voting = within(rail).getByRole("link", { name: "Voting" });
      const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));
      act(() => { outside.focus(); });
      fireEvent.mouseEnter(voting);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      // A popover that already claimed the key keeps it; the tooltip stays.
      window.addEventListener("keydown", claimEscape, true);
      fireEvent.keyDown(outside, { key: "Escape" });
      window.removeEventListener("keydown", claimEscape, true);
      expect(tooltip).toHaveAttribute("data-visible", "true");
      expect(panelEscape).not.toHaveBeenCalled();

      // Otherwise the hovered tooltip is the newest layer: one press hides it
      // and leaves the older panel and the focused field alone.
      expect(fireEvent.keyDown(outside, { key: "Escape" })).toBe(false);
      expect(tooltip).not.toHaveAttribute("data-visible");
      expect(outside).toHaveFocus();
      expect(panelEscape).not.toHaveBeenCalled();

      fireEvent.keyDown(outside, { key: "Escape" });
      expect(panelEscape).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", claimEscape, true);
      unregisterPanel();
      outside.remove();
    }
  });

  it("leaves a hovered compact tooltip up while the Tasks keymap's Escape exits focus mode, in either listener order", () => {
    // Shaped like the TasksView window keymap: it skips typing surfaces and
    // exits focus mode on an Escape nobody prevented, without preventing it.
    const tasksKeymap = (event) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
      if (deviceParityValue("tasks.focusWorkstream")) applyDeviceParityState("tasks.focusWorkstream", null);
    };
    for (const keymapFirst of [true, false]) {
      // Whichever window listener is installed first runs first.
      const unregisterEarlier = keymapFirst ? () => {} : registerEscapeLayer(() => {});
      window.addEventListener("keydown", tasksKeymap);
      const field = document.createElement("input");
      document.body.append(field);
      const view = renderDesktopRail();
      try {
        applyDeviceParityState("tasks.focusWorkstream", "Organizing");
        const rail = document.querySelector(".desktop-rail");
        fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
        const voting = within(rail).getByRole("link", { name: "Voting" });
        const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));
        fireEvent.mouseEnter(voting);
        expect(tooltip).toHaveAttribute("data-visible", "true");

        expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
        expect(deviceParityValue("tasks.focusWorkstream")).toBeNull();
        expect(tooltip).toHaveAttribute("data-visible", "true");

        expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
        expect(tooltip).not.toHaveAttribute("data-visible");

        // In a typing field the Tasks keymap skips the press, so the tooltip takes it.
        applyDeviceParityState("tasks.focusWorkstream", "Organizing");
        fireEvent.mouseLeave(voting, { relatedTarget: document.body });
        fireEvent.mouseEnter(voting);
        expect(tooltip).toHaveAttribute("data-visible", "true");
        expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
        expect(tooltip).not.toHaveAttribute("data-visible");
        expect(deviceParityValue("tasks.focusWorkstream")).toBe("Organizing");
      } finally {
        view.unmount();
        window.removeEventListener("keydown", tasksKeymap);
        field.remove();
        unregisterEarlier();
        clearDeviceParityState();
        window.localStorage.clear();
      }
    }
  });

  it("leaves a hovered compact tooltip up while a mounted Tasks board popover takes the Escape", () => {
    // An earlier non-modal layer (Compass) installs the shared listener first,
    // so the tooltip layer would run before the popover's own window listener,
    // which closes on Escape and ignores defaultPrevented (TasksView Popover).
    const unregisterCompass = registerEscapeLayer(() => {});
    const popover = document.createElement("div");
    popover.className = "kan-popover";
    const closePopover = vi.fn(() => popover.remove());
    const popoverEscape = (event) => { if (event.key === "Escape") closePopover(); };
    try {
      renderDesktopRail();
      const rail = document.querySelector(".desktop-rail");
      fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
      const voting = within(rail).getByRole("link", { name: "Voting" });
      const tooltip = document.getElementById(voting.getAttribute("aria-describedby"));
      document.body.append(popover);
      window.addEventListener("keydown", popoverEscape);
      fireEvent.mouseEnter(voting);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(closePopover).toHaveBeenCalledTimes(1);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      // With the popover gone, the next press is the tooltip's.
      expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
      expect(tooltip).not.toHaveAttribute("data-visible");
    } finally {
      window.removeEventListener("keydown", popoverEscape);
      popover.remove();
      unregisterCompass();
      window.localStorage.clear();
    }
  });

  it("composes compact hat tooltip Escape with the hat menu's arrow navigation", () => {
    renderDesktopRail({ demo: true, memberId: null });
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const chooser = within(rail).getByRole("button", { name: "Switch role, current: Worker" });
    const tooltip = document.getElementById(chooser.getAttribute("aria-describedby"));
    act(() => { chooser.focus(); });
    expect(tooltip).toHaveAttribute("data-visible", "true");

    fireEvent.keyDown(chooser, { key: "Escape" });
    expect(tooltip).not.toHaveAttribute("data-visible");
    expect(within(rail).queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();

    fireEvent.keyDown(chooser, { key: "ArrowDown" });
    expect(within(rail).getByRole("menu", { name: "Switch role" })).toBeInTheDocument();
    expect(tooltip).not.toHaveAttribute("data-visible");
    // The open menu suppresses the chooser's tooltip even under the pointer.
    fireEvent.mouseEnter(chooser);
    expect(tooltip).not.toHaveAttribute("data-visible");
  });

  it("clears a pending compact tooltip close on expansion and unmount", () => {
    vi.useFakeTimers();
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const view = renderDesktopRail();
    const rail = document.querySelector(".desktop-rail");
    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const home = within(rail).getByRole("button", { name: "Home" });
    fireEvent.mouseEnter(home);
    fireEvent.mouseLeave(home, { relatedTarget: document.body });
    const expansionTimer = setTimer.mock.results.at(-1).value;

    fireEvent.click(within(rail).getByRole("button", { name: "Expand rail" }));
    expect(clearTimer).toHaveBeenCalledWith(expansionTimer);
    expect(home).not.toHaveAttribute("aria-describedby");

    fireEvent.click(within(rail).getByRole("button", { name: "Collapse rail" }));
    const profile = within(rail).getByRole("button", { name: "Profile" });
    fireEvent.mouseEnter(profile);
    fireEvent.mouseLeave(profile, { relatedTarget: document.body });
    const unmountTimer = setTimer.mock.results.at(-1).value;
    view.unmount();
    expect(clearTimer).toHaveBeenCalledWith(unmountTimer);
  });

  it("routes the brand Home control to the selected staff plane", () => {
    const navigate = vi.fn();
    renderDesktopRail({ active: "tasks", activeHat: "steward", onNavigate: navigate });
    const rail = document.querySelector(".desktop-rail");

    fireEvent.click(within(rail).getByRole("button", { name: "Home" }));

    expect(navigate).toHaveBeenCalledWith("steward", "/m/steward", "");
  });

  it("opens Guide from the rail as a dialog, not a route", async () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Union Ground Guide AI" }));
    expect(await screen.findByRole("dialog", { name: "Union Ground Guide" })).toBeInTheDocument();
    // Member and staff routes share the same dock contract: at companion
    // widths CSS places this panel immediately left of the phone. The old
    // staff-only class left the member Compass covering the device.
    expect(document.querySelector(".sg-app--compass-wide")).not.toBeNull();
  });

  it("keeps staff hats inside the SAME desktop shell: rail mounted, member-only chrome absent", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    selectTopHat("Campaign lead");
    expect(await screen.findByRole("heading", { name: "Issue queue" })).toBeInTheDocument();
    // One desktop experience for every hat (owner call, 2026-07-30): the rail
    // stays, while the top selector carries Member plus all five demo planes;
    // the selected hat's backed desk and desktop Work retain the middle slot.
    // A staff hat shows ONLY that role's functions (owner call, 2026-08-05,
    // reversing the 2026-08-04 shared-nav restore); member functions return
    // with the Member hat.
    // The member bottom nav stays gone. The companion phone persists on staff hats too
    // (owner call, 2026-07-31): the pair exists to show every page both ways.
    expect(document.querySelector(".desktop-rail")).not.toBeNull();
    expect(document.querySelector(".bottom-nav")).toBeNull();
    expect(document.querySelector(".companion-phone")).toBeNull();
    const rail = document.querySelector(".desktop-rail");
    expect(within(rail).queryByRole("group", { name: "Switch role" })).not.toBeInTheDocument();
    expect(topHatTrigger("Campaign lead")).toBeInTheDocument();
    for (const work of ["Issue queue", "Active issues", "Upcoming deadlines", "Work"]) {
      expect(within(rail).getByRole("link", { name: work })).toBeInTheDocument();
    }
    // The grievance-step funnel, contract articles and the procedure settings
    // page are left out of Union Ground.
    for (const leftOut of ["Escalation funnel", /contract articles/i, /procedure/i, /clauses/i, /civic/i]) {
      expect(within(rail).queryByRole("link", { name: leftOut })).not.toBeInTheDocument();
    }
    for (const memberOnly of [
      "Home", "Voting", "Contributions", /^My cases/, /^Forms/, "Workplace log",
      "My reports", "Messages", "Organizing rights", "Be heard", "Pay tools", "Search", "Settings",
    ]) {
      expect(within(rail).queryByRole("link", { name: memberOnly })).not.toBeInTheDocument();
    }
    // The Guide is not a worker-only destination. The desktop shell hides the
    // desk header button, so each staff rail carries the one opener.
    expect(within(rail).getAllByRole("button", { name: "Union Ground Guide AI" })).toHaveLength(1);
    expect(within(rail).getAllByText("Work")).toHaveLength(1);
    expect(within(rail).queryByText("Roles")).not.toBeInTheDocument();
    expect(within(rail).queryByText("Staff")).not.toBeInTheDocument();
  });

  it("switches hats from the top rail and isolates the selected role's links", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    const rail = document.querySelector(".desktop-rail");
    selectTopHat("Advisor");
    expect(await screen.findByRole("heading", { level: 1, name: "Campaign health" })).toBeInTheDocument();
    expect(topHatTrigger("Advisor")).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Campaign health" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Work" })).toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Organizing rights" })).not.toBeInTheDocument();
    expect(within(rail).getAllByRole("button", { name: "Union Ground Guide AI" })).toHaveLength(1);
  });

  it("keeps the selected staff hat active while desktop Work is open", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    const rail = document.querySelector(".desktop-rail");
    selectTopHat("Advisor");
    expect(await screen.findByRole("heading", { level: 1, name: "Campaign health" })).toBeInTheDocument();
    // The shared tool must not coerce the wearer to Coordinator: the Advisor
    // stays pressed and the Advisor's own desk links stay in the rail.
    fireEvent.click(within(rail).getByRole("link", { name: "Work" }));
    await waitFor(() => expect(document.querySelector(".tasks-screen")).not.toBeNull());
    expect(topHatTrigger("Advisor")).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Campaign health" })).toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Issue queue" })).not.toBeInTheDocument();
  });

  it.each([
    ["Committee", "Committee desk", ["Issue work", "Worker requests", "One-on-ones", "Forms review", "Committee messages", "Scan check-ins", "Broadcasts", "Organize", "Work"]],
    ["Campaign lead", "Issue queue", ["Issue queue", "Active issues", "Upcoming deadlines", "Organize", "Work"]],
    ["Advisor", "Campaign health", ["Campaign health", "Collective workplace log", "Latest vote turnout", "At-risk signals", "Leadership team", "Organize", "Work"]],
    ["Admin", "Campaign admin", ["Campaign admin", "Organization roles & access", "Two-step sign-in status", "Meetings & check-in codes", "Recent admin activity", "Organization audit ledger", "Job health", "Organize", "Work"]],
    ["Campaign chair", "Leadership overview", ["Leadership overview", "Participation trend", "Needs exec attention", "Leadership team", "Campaigns & priorities", "Upcoming meetings", "Organize", "Work"]],
  ])("keeps the %s hat's own navigation complete and isolated", async (hat, heading, workLinks) => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    const rail = document.querySelector(".desktop-rail");
    selectTopHat(hat);

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(topHatTrigger(hat)).toBeInTheDocument();
    for (const workLink of workLinks) {
      expect(within(rail).getByRole("link", { name: workLink })).toBeInTheDocument();
    }
    // Functions outside this hat's group stay off screen (owner rule,
    // 2026-08-05); the top selector is the way back to them.
    expect(within(rail).queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Organizing rights" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(within(rail).getAllByRole("button", { name: "Union Ground Guide AI" })).toHaveLength(1);
    expect(within(rail).getByRole("button", { name: "Home" })).toBeInTheDocument();
    // No hat offers a left-out destination: dues, contract clauses, civic
    // action, the grievance-step funnel, the points economy's rewards
    // administration and reward economy, union catalog verification, or SSO.
    for (const leftOut of [/\bdues\b/i, /clauses/i, /civic/i, "Escalation funnel", "Rewards administration", "Contributions administration", /reward economy/i, /catalog verification|vouch|platform verification/i, /single sign-on/i]) {
      expect(within(rail).queryByRole("link", { name: leftOut })).not.toBeInTheDocument();
    }
  });

  it("gives the Campaign chair plane the same shell instead of a floating phone column", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    selectTopHat("Campaign chair");
    expect(await screen.findByRole("heading", { level: 1, name: "Leadership overview" })).toBeInTheDocument();
    expect(document.querySelector(".desktop-rail")).not.toBeNull();
    // The persistent companion phone is the one phone column that SHOULD be
    // here now — inside the shell's aside, not floating over the plane.
    expect(document.querySelector(".companion-phone")).toBeNull();
    expect(document.querySelector(".sg-app--desktop")).not.toBeNull();
  });

  it("navigates Messages from the desktop rail without a companion phone", async () => {
    stubMatchMedia(true);
    render(<App />);
    expect(document.querySelector(".companion-phone")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Messages" }));
    expect(await screen.findByRole("heading", { name: "Messages" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/messages");
    expect(document.querySelector(".companion-phone")).toBeNull();
  });

  it("ignores a spoofed staff route while the explicit hat is Worker", () => {
    stubMatchMedia(true);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent(window, new MessageEvent("message", {
      data: { type: "sg-nav-up", path: "/m/coordinator?demo=1" },
      origin: window.location.origin,
      source: window,
    }));
    expect(window.location.pathname).toBe("/m");
    expect(screen.queryByRole("heading", { name: "Issue queue" })).not.toBeInTheDocument();
    expect(topHatTrigger("Worker")).toBeInTheDocument();
  });

  it("opens notifications from the rail and rejects spoofed companion UI state", async () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent(window, new MessageEvent("message", {
      data: { type: "sg-ui-state-up", key: "app.notificationsOpen", value: true },
      origin: window.location.origin,
      source: window,
    }));
    expect(screen.queryByRole("heading", { name: "Notifications" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Notifications, \d+ unread$/ }));
    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeInTheDocument();
  });

  it("switches a SAMPLE staff hat from the top selector without a companion phone", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    expect(document.querySelector(".companion-phone")).toBeNull();
    selectTopHat("Campaign lead");
    expect(await screen.findByRole("heading", { name: "Issue queue" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/coordinator");
    expect(window.location.search).toBe("?demo=1");
    expect(document.querySelector(".companion-phone")).toBeNull();
  });

  it("ignores sg-nav-up from any window now that no companion phone is mounted", () => {
    stubMatchMedia(true);
    render(<App />);
    fireEvent(window, new MessageEvent("message", {
      data: { type: "sg-nav-up", path: "/m/messages" },
      origin: window.location.origin,
      source: window,
    }));
    expect(window.location.pathname).toBe("/m");
    expect(screen.queryByRole("heading", { name: "Messages" })).not.toBeInTheDocument();
  });

  it("follows a mirrored staff path inside the embed, with phone staff chrome", async () => {
    // The embed lives in a ~394px iframe, so its own media query answers
    // narrow — stub accordingly (the wide-stub embed test above pins the
    // recursion guard; this one pins the phone chrome).
    stubMatchMedia(false);
    // embed=phone only counts inside a REAL frame now, and the embed only
    // obeys sg-nav from its parent — so shadow window.parent with a real
    // jsdom Window (an actual iframe's) and post from that same window.
    const host = document.createElement("iframe");
    document.body.appendChild(host);
    const parentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, value: host.contentWindow });
    try {
      window.history.replaceState({}, "", "/m?demo=1&embed=phone");
      render(<App />);
      fireEvent(window, new MessageEvent("message", {
        data: { type: "sg-ui-state", key: "app.selectedStaffHat", value: "coordinator" },
        origin: window.location.origin,
        source: host.contentWindow,
      }));
      fireEvent(window, new MessageEvent("message", {
        data: { type: "sg-nav", path: "/m/coordinator?demo=1" },
        origin: window.location.origin,
        source: host.contentWindow,
      }));
      expect(await screen.findByRole("heading", { name: "Issue queue" })).toBeInTheDocument();
      // The embed renders the same staff chrome a real narrow viewport gets:
      // the persistent Home orb below (2026-08-07 chrome-free wave), the
      // mobile top bar above (the staff tab strip retired with the bar,
      // 2026-08-05 card-nav wave).
      expect(document.querySelector(".home-orb")).not.toBeNull();
      expect(document.querySelector(".mobile-top")).not.toBeNull();
      fireEvent(window, new MessageEvent("message", {
        data: { type: "sg-ui-state", key: "app.assistantOpen", value: true },
        origin: window.location.origin,
        source: host.contentWindow,
      }));
      expect(await screen.findByRole("dialog", { name: "Union Ground Guide" })).toBeInTheDocument();
    } finally {
      if (parentDescriptor) Object.defineProperty(window, "parent", parentDescriptor);
      host.remove();
    }
  });

  it("lays Today out as the prototype desktop dashboard: the organizing tiles and the Coming up column", () => {
    stubMatchMedia(true);
    render(<App />);
    // Union Ground has no points economy, so the overview counts organizing
    // work only: open issues and the committee-ready count (or contact
    // coverage once it is known). Union Ground's points-ledger tiles (actions
    // YTD, banded chapter standing, total points) never render.
    const tiles = [...document.querySelectorAll(".home-tile")];
    expect(tiles.map((tile) => tile.querySelector("span").textContent)).toEqual(["Open issues", "Committee ready"]);
    expect(tiles[0].querySelector("strong").textContent).toBe(String(fallbackData.metrics.openCases));
    for (const pointsCopy of ["Actions YTD", "Top 25%", "Total points", /Chapter standing/]) {
      expect(screen.queryByText(pointsCopy)).toBeNull();
    }
    // Actions left, the vote/events column right (the prototype's home-grid).
    expect(document.querySelector(".home-grid")).not.toBeNull();
    const aside = document.querySelector(".home-side");
    expect(aside).not.toBeNull();
    // The old member card left the Today aside in wave 2a — the Card now
    // lives behind the More hub's profile row.
    expect(aside.querySelector(".member-card")).toBeNull();
    expect(screen.getByText("Coming up")).toBeInTheDocument();
    // The column lists the fixture's own upcoming meetings (Union Ground's
    // fixture names its committee meetings, not Union Ground's chapter one).
    const upcoming = homeRelevantEvents(fallbackData).filter((item) => item.isPast !== true);
    expect(upcoming.length).toBeGreaterThan(0);
    const coming = document.querySelector(".home-coming");
    for (const event of upcoming) expect(within(coming).getByText(event.title)).toBeInTheDocument();
    // Search left the nav bars in wave 2a; the desktop Home header keeps its
    // own entry to the still-live /m/search screen.
    expect(screen.getByRole("button", { name: "Search everything" })).toBeInTheDocument();
  });

  it("elevates the open vote into the vote card, wired to the same action", async () => {
    stubMatchMedia(true);
    render(<App />);
    // Wave 2a: the vote card is the prototype's .home-vote section in the
    // right-hand column; same contract as the old .vote-card.
    const card = document.querySelector(".home-vote");
    expect(card).not.toBeNull();
    // Same plan item, two surfaces: the title appears in the card AND the
    // week's-actions list.
    expect(screen.getAllByText(/file the representation petition this month/)).toHaveLength(2);
    expect(card.textContent).toContain("Open vote");
    expect(card.textContent).toContain("1 of 200 voted");
    // The card's CTA drives the SAME handler as the plan row: the ballot opens.
    fireEvent.click(within(card).getByRole("button", { name: "Cast vote" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("lays Issues out with the desk issue card and the closed summary on desktop", async () => {
    stubMatchMedia(true);
    render(<App />);
    // Rail vocabulary since wave 2a: "My issues" (the badge suffixes the
    // accessible name with the live active-case count).
    fireEvent.click(screen.getByRole("link", { name: /^Issues/ }));
    expect(await screen.findByRole("heading", { name: "My issues" })).toBeInTheDocument();
    // Wave 2b: the desktop plane is the prototype's stat-lift — one
    // .mcases-desk card per open case (the fixture has exactly one), no
    // list/spotlight split anymore.
    expect(document.querySelector(".mcases--desktop")).not.toBeNull();
    const cards = document.querySelectorAll(".mcases-desk");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    // Read from the fixture rather than spelled out: Union Ground's fixture
    // names its own organizing issue, not Union Ground's grievance step.
    const activeCase = fallbackData.cases.find((item) => item.status === "active");
    expect(card.textContent).toContain(activeCase.title);
    expect(card.querySelector(".mcases-desk__meta").textContent).toContain(activeCase.reference);
    // The fixture's active case is overdue; the gold now-node must say so,
    // not invent a friendly deadline.
    expect(card.querySelector(".mcases-desk__nsub--due").textContent).toBe("Overdue — Jun 21");
    // Closed cases live in the aside panel — all three of them, each once.
    const panel = document.querySelector(".mcases-panel");
    expect(panel).not.toBeNull();
    expect(panel.querySelectorAll(".mcases-panel__row")).toHaveLength(3);
    const closedCases = fallbackData.cases.filter((item) => item.status !== "active");
    expect(closedCases).toHaveLength(3);
    for (const closed of closedCases) expect(within(panel).getAllByText(closed.title)).toHaveLength(1);
    // The card's title opens the SAME detail dialog the closed rows open.
    fireEvent.click(within(card).getByRole("button", { name: new RegExp(activeCase.title) }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: activeCase.title })).toBeInTheDocument();
  });

  it("keeps the phone Issues free of the desktop-only regions", async () => {
    render(<App />);
    // The member phone bar has no Cases tab since wave 2a; the Home quick row
    // for the active case is the phone's way in.
    fireEvent.click(screen.getByRole("button", { name: /Check your issue/ }));
    expect(await screen.findByRole("heading", { name: "My issues" })).toBeInTheDocument();
    // Desktop-only anatomy stays off the phone…
    expect(document.querySelector(".mcases--desktop")).toBeNull();
    expect(document.querySelector(".mcases-desk")).toBeNull();
    expect(document.querySelector(".mcases-panel")).toBeNull();
    // …and the phone renders the prototype casework queue with every case
    // always visible (the old segmented filter left with the rebuild): the
    // one active case as a timeline card, the three resolved under Closed.
    expect(document.querySelectorAll(".mcases-case")).toHaveLength(1);
    expect(screen.getAllByText(fallbackData.cases.find((item) => item.status === "active").title)).toHaveLength(1);
    expect(document.querySelectorAll(".mcases-closed__row")).toHaveLength(3);
  });

  it("gives phone Today the same backed facts while keeping its responsive layout", () => {
    render(<App />);
    // Layout stays phone-native, but the desktop's backed overview facts are
    // no longer omitted from the paired phone page.
    expect(screen.queryByText("Coming up")).toBeNull();
    // The phone overview carries the same organizing tiles as the desktop,
    // and no points-economy tile.
    const overview = document.querySelector(".home-mobile-overview");
    expect([...overview.querySelectorAll(".home-tile span")].map((label) => label.textContent)).toEqual(["Open issues", "Committee ready"]);
    expect(within(overview).queryByText("Actions YTD")).toBeNull();
    expect(screen.queryByText(/Chapter standing/)).toBeNull();
    expect(screen.queryByText("Total points")).toBeNull();
    expect(document.querySelector(".home-grid")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Welcome back, Darnell" })).toBeNull();
    // The phone renders the prototype mobile Home: greeting, the ballot hero,
    // and the quick-row sections.
    expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    expect(document.querySelector(".home-vote-hero")).not.toBeNull();
    expect(screen.getByText("Next 2 minutes")).toBeInTheDocument();
    expect(screen.getByText("This week")).toBeInTheDocument();
  });

  it("renders the phone shell untouched when the screen is narrow", () => {
    // No stub: jsdom's own matchMedia (or its absence) answers not-wide,
    // which is the exact condition every legacy test runs under.
    render(<App />);
    // Phone chrome is the card layer alone now (2026-08-07 chrome-free
    // wave); the tab bar and the shortcut bubble never mount anywhere.
    expect(document.querySelector(".shortcut-bubble__fab")).toBeNull();
    expect(document.querySelector(".card-nav")).not.toBeNull();
    expect(document.querySelector(".bottom-nav")).toBeNull();
    expect(document.querySelector(".desktop-rail")).toBeNull();
    expect(document.querySelector(".chapter-rail")).toBeNull();
    expect(document.querySelector(".phone-frame")).toBeNull();
  });
});

function dispatchCtrlDigit(key) {
  const shortcut = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(window, shortcut);
  return shortcut;
}

function renderRailWithOpenDialog({ onNavigate = vi.fn(), onAsk = vi.fn() } = {}) {
  render(
    <LanguageProvider lang="en">
      <DesktopRail
        active="today"
        activeHat="member"
        demo={false}
        memberId="member-a"
        onAsk={onAsk}
        onNavigate={onNavigate}
        onNotifications={() => {}}
        onSwitchHat={() => {}}
        renderMode="desktop"
        staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]}
        user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }}
      />
      <Dialog title="Assign issue" onClose={() => {}}>
        <button type="button">Save assignment</button>
      </Dialog>
    </LanguageProvider>,
  );
  return { onNavigate, onAsk };
}

describe("desktop rail shortcuts beside a modal dialog", () => {
  // BUG-UG-RAIL-SHORTCUTS-BEHIND-MODAL-DIALOG-20260920
  it("does not navigate when a modal dialog is open", () => {
    const { onNavigate } = renderRailWithOpenDialog();
    const save = screen.getByRole("button", { name: "Save assignment" });
    save.focus();
    const shortcut = dispatchCtrlDigit("2");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Assign issue" })).toBeInTheDocument();
    expect(shortcut.defaultPrevented).toBe(false);
  });

  it("does not fire the Guide rail action when a modal dialog is open", () => {
    const { onAsk } = renderRailWithOpenDialog();
    screen.getByRole("button", { name: "Save assignment" }).focus();
    const shortcut = dispatchCtrlDigit("4");
    expect(onAsk).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Assign issue" })).toBeInTheDocument();
    expect(shortcut.defaultPrevented).toBe(false);
  });

  it("still navigates with Ctrl+2 while the nonmodal desktop Guide panel is open", () => {
    const onNavigate = vi.fn();
    render(
      <LanguageProvider lang="en">
        <DesktopRail
          active="today"
          activeHat="member"
          demo={false}
          memberId="member-a"
          onAsk={() => {}}
          onNavigate={onNavigate}
          onNotifications={() => {}}
          onSwitchHat={() => {}}
          renderMode="desktop"
          staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]}
          user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }}
        />
        <section className="assistant" role="dialog" aria-label="Union Ground Guide" tabIndex={-1}>
          <button type="button">New chat</button>
        </section>
      </LanguageProvider>,
    );
    const compass = screen.getByRole("dialog", { name: "Union Ground Guide" });
    expect(compass).not.toHaveAttribute("aria-modal");
    const shortcut = dispatchCtrlDigit("2");
    expect(onNavigate).toHaveBeenCalledWith("work", "/m/work", "");
    expect(shortcut.defaultPrevented).toBe(true);
  });
});

// Union Ground's desktop organizing shell, on the rail.
describe("desktop organizing shell (Union Ground)", () => {
  it("keeps the sample-data banner and Exit demo on the desktop rail shell", async () => {
    window.history.replaceState({}, "", "/m?demo=1");
    stubMatchMedia((query) => /min-width:\s*(\d+)/.test(query) && 1440 >= Number(query.match(/min-width:\s*(\d+)/)[1]));
    render(<App />);
    expect(await screen.findByRole("button", { name: "Exit demo" })).toBeInTheDocument();
    expect(screen.getByText(/fictional/i)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Work" })).toHaveAttribute("href", "/m/work");
    expect(screen.getByRole("button", { name: /Switch role/ })).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector(".companion-phone")).toBeNull();
  });

  it("hides Campaigns when the current hat cannot open Organize", () => {
    render(
      <LanguageProvider lang="en">
        <DesktopRail
          active="steward"
          activeHat="steward"
          renderMode="desktop"
          staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", view: "steward", path: "/m/steward" }]}
          onSwitchHat={() => {}}
          onNavigate={() => {}}
        />
      </LanguageProvider>,
    );
    // Union Ground's engagement tool is also labelled Campaigns, so the
    // Organize plane is identified by its address.
    expect(document.querySelector('.desktop-rail a[href="/m/organize"]')).toBeNull();
    expect(document.querySelector('.desktop-rail a[href="/m/steward"]')).not.toBeNull();
    for (const leftOut of ["Contract clauses", "Civic", "Dues", "By article cited"]) {
      expect(screen.queryByRole("link", { name: leftOut })).toBeNull();
    }
  });

  it("gives the Organizer hat its campaign desk", () => {
    render(
      <LanguageProvider lang="en">
        <DesktopRail
          active="organize"
          activeHat="organize"
          renderMode="desktop"
          staffPlanes={[{ key: "organize", labelKey: "demo.hatOrganize", view: "organize", path: "/m/organize", roles: ["organizer"] }]}
          onSwitchHat={() => {}}
          onNavigate={() => {}}
        />
      </LanguageProvider>,
    );
    expect(document.querySelector('.desktop-rail a[href="/m/organize"]')).not.toBeNull();
  });
});

