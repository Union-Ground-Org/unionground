import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { primeDemoHat } from "./helpers/demoHat.js";

function installResponsiveMatchMedia(initialWidth) {
  let width = initialWidth;
  const queries = new Map();
  const matches = (query) => {
    const min = query.match(/min-width:\s*(\d+)px/);
    const max = query.match(/max-width:\s*(\d+)px/);
    return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
  };

  window.matchMedia = vi.fn((query) => {
    if (!queries.has(query)) queries.set(query, new Set());
    const listeners = queries.get(query);
    return {
      get matches() { return matches(query); },
      media: query,
      addEventListener: (_, listener) => listeners.add(listener),
      removeEventListener: (_, listener) => listeners.delete(listener),
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    };
  });

  return (nextWidth) => {
    width = nextWidth;
    for (const [query, listeners] of queries) {
      const event = { matches: matches(query), media: query };
      for (const listener of listeners) listener(event);
    }
  };
}

const realMatchMedia = window.matchMedia;
const DEMO_DESKTOP_RAIL_COLLAPSE_KEY = "sg:demo:desktop-main-rail:collapsed";

beforeEach(() => {
  primeDemoHat("member");
  window.history.replaceState({}, "", "/m?demo=1");
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("tablet shell", () => {
  it("owns the exclusive 768–1023px band and preserves the active route across resize", async () => {
    const setWidth = installResponsiveMatchMedia(767);
    render(<App />);

    expect(document.querySelector(".card-nav")).not.toBeNull();
    expect(document.querySelector(".desktop-rail")).toBeNull();
    expect(document.querySelector(".sg-app--tablet")).toBeNull();

    act(() => setWidth(768));
    expect(document.querySelector(".sg-app--tablet")).toHaveAttribute("data-workspace-theme", "union-ground");
    expect(document.querySelector(".chapter-rail")).toBeNull();
    expect(document.querySelectorAll(".desktop-rail")).toHaveLength(1);
    expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-workspace-theme", "union-ground");
    expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-render-mode", "tablet");
    expect(document.querySelector(".desktop-rail")).not.toHaveAttribute("data-collapsed");
    expect(within(document.querySelector(".desktop-rail")).getByText("Union Ground")).toBeInTheDocument();
    expect(within(document.querySelector(".desktop-rail")).queryByText("Union Base")).not.toBeInTheDocument();
    expect(within(document.querySelector(".desktop-rail")).queryByRole("button", { name: /(?:Expand|Collapse) rail/ })).not.toBeInTheDocument();
    expect(document.querySelector(".card-nav")).toBeNull();
    expect(document.querySelector(".mobile-top")).toBeNull();
    expect(document.querySelector(".home-orb")).toBeNull();
    expect(document.querySelector(".companion-phone")).toBeNull();
    expect(screen.getByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();

    act(() => setWidth(1023));
    expect(document.querySelector(".sg-app--tablet")).toHaveAttribute("data-workspace-theme", "union-ground");
    expect(document.querySelector(".chapter-rail")).toBeNull();
    expect(document.querySelectorAll(".desktop-rail")).toHaveLength(1);
    expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-workspace-theme", "union-ground");

    act(() => setWidth(1024));
    expect(document.querySelector(".sg-app--tablet")).toBeNull();
    expect(document.getElementById("chapter-flyout-trigger")).not.toBeNull();
    expect(document.querySelector(".sg-app--desktop")).toHaveAttribute("data-workspace-theme", "union-ground");
    expect(document.querySelectorAll(".desktop-rail")).toHaveLength(1);
    expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-workspace-theme", "union-ground");
    expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-render-mode", "desktop");
    expect(within(document.querySelector(".desktop-rail")).getByText("Union Ground")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m");

    act(() => setWidth(1360));
    expect(document.querySelector(".companion-phone")).toBeNull();
    expect(document.querySelector(".companion-phone__app")).toBeNull();
  });

  it("never applies a persisted desktop collapse or Green rail anatomy to tablet, then restores it on desktop", () => {
    window.sessionStorage.setItem(DEMO_DESKTOP_RAIL_COLLAPSE_KEY, "true");
    const setWidth = installResponsiveMatchMedia(820);
    render(<App />);

    let rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-render-mode", "tablet");
    expect(rail).not.toHaveAttribute("data-collapsed");
    expect(within(rail).getByText("Union Ground")).toBeInTheDocument();
    expect(within(rail).queryByText("PS")).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: /(?:Expand|Collapse) rail/ })).not.toBeInTheDocument();
    // Union Ground's worker rail lists Work beside Home on every surface.
    expect(within(rail).getByRole("link", { name: "Work" })).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("button", { name: "Committee" }));
    expect(within(rail).getByRole("link", { name: "Campaign duty" })).toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Work" })).not.toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("button", { name: "Worker" }));

    act(() => setWidth(1024));
    rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-render-mode", "desktop");
    expect(rail).toHaveAttribute("data-collapsed", "true");
    // The collapsed rail keeps only the Union Ground logo mark, as the home button.
    expect(rail.querySelector(".brand-home .brand-mark")).not.toBeNull();
    expect(within(rail).getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Expand rail" })).toBeInTheDocument();

    act(() => setWidth(1023));
    rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-render-mode", "tablet");
    expect(rail).not.toHaveAttribute("data-collapsed");
    expect(within(rail).getByText("Union Ground")).toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: /(?:Expand|Collapse) rail/ })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(DEMO_DESKTOP_RAIL_COLLAPSE_KEY)).toBe("true");
  });

  it("keeps the active route while moving between tablet portrait, landscape, and desktop", async () => {
    const setWidth = installResponsiveMatchMedia(820);
    render(<App />);

    fireEvent.click(screen.getByRole("link", { name: "Messages" }));
    expect(await screen.findByRole("heading", { name: "Messages" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/messages");

    act(() => setWidth(1023));
    expect(document.querySelector(".sg-app--tablet")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Messages" })).toHaveAttribute("aria-current", "page");

    act(() => setWidth(1024));
    expect(document.querySelector(".sg-app--desktop")).not.toBeNull();
    expect(window.location.pathname).toBe("/m/messages");
    expect(screen.getByRole("link", { name: "Messages" })).toHaveAttribute("aria-current", "page");
  });

  // #9543 (A-38, B-51): the tablet rail has the same Chapters button and
  // flyout as the desktop rail, so the SAMPLE chapter page a choice opens is
  // kept across the 1024px boundary and cleared only by the phone shell.

  // #9543 (A-38, B-51): at tablet width the rail had no Chapters control at
  // all, under any hat, so a tablet user could not switch chapter.
  it.each(["Worker", "Campaign lead"])("switches campaign from the tablet rail under the %s hat", async (hat) => {
    installResponsiveMatchMedia(820);
    render(<App />);
    let rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-render-mode", "tablet");
    if (hat !== "Worker") fireEvent.click(within(rail).getByRole("button", { name: hat }));
    rail = document.querySelector(".desktop-rail");
    const trigger = within(rail).getByRole("button", { name: /^Campaigns\b/ });
    expect(trigger).toHaveAttribute("id", "chapter-flyout-trigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(
      screen.getByRole("navigation", { name: "Campaigns" }),
    ).getByRole("button", { name: /^Open Lakeside Library Workers\b/ }));

    expect(await screen.findByText("CAMPAIGN SNAPSHOT", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Lakeside Library Workers" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    expect(document.getElementById("chapter-flyout-trigger")).toHaveTextContent("Lakeside Library Workers");

    fireEvent.click(screen.getByRole("button", { name: "Return to current workspace" }));
    await waitFor(() => expect(screen.queryByText("CAMPAIGN SNAPSHOT")).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("chapter-flyout-trigger")), { timeout: 3000 });
  });

  // The flyout belongs to the rail: when the window narrows to the phone
  // shell the rail and its flyout go, and widening again must not bring the
  // flyout back open by itself over the page.
  it("closes an open campaign flyout when the phone shell replaces the tablet rail", () => {
    const setWidth = installResponsiveMatchMedia(820);
    render(<App />);
    fireEvent.click(document.getElementById("chapter-flyout-trigger"));
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toBeInTheDocument();

    act(() => setWidth(767));
    expect(document.querySelector(".card-nav")).not.toBeNull();
    expect(document.getElementById("chapter-flyout-trigger")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();

    act(() => setWidth(820));
    expect(document.querySelector(".sg-app--tablet")).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    expect(document.getElementById("chapter-flyout-trigger")).toHaveAttribute("aria-expanded", "false");
  });

  it("uses one compact role-aware rail with demo, profile, and notification actions", async () => {
    installResponsiveMatchMedia(820);
    render(<App />);

    expect(screen.getAllByRole("navigation", { name: "Primary" })).toHaveLength(1);
    expect(document.querySelector(".demo-bar--tablet")).not.toBeNull();
    expect(document.querySelector(".demo-chip")).toBeNull();
    expect(document.querySelector(".mobile-top")).toBeNull();
    expect(document.querySelector(".card-nav")).toBeNull();
    expect(document.querySelector(".companion-phone")).toBeNull();
    expect(screen.getByRole("button", { name: /Profile$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Notifications, \d+ unread$/ })).toBeInTheDocument();

    const switcher = within(document.querySelector(".desktop-rail__hat-switcher"));
    expect(switcher.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Worker", "Organizer", "Committee", "Campaign lead", "Advisor", "Admin", "Campaign chair",
    ]);

    fireEvent.click(switcher.getByRole("button", { name: "Campaign lead" }));
    expect(await screen.findByRole("heading", { name: "Issue queue" })).toBeInTheDocument();
    expect(document.querySelector(".sg-app--tablet .desktop-rail")).not.toBeNull();
    const rail = within(document.querySelector(".sg-app--tablet .desktop-rail"));
    for (const name of ["Issue queue", "Active issues", "Upcoming deadlines", "One-on-ones", "Campaign duty"]) {
      expect(rail.getByRole("link", { name })).toBeInTheDocument();
    }
    // Grievance steps and contract articles are left out of Union Ground,
    // so the Issue queue carries no step funnel or by-article section.
    for (const name of ["Escalation funnel", "By article cited"]) {
      expect(rail.queryByRole("link", { name })).toBeNull();
    }
  });

  it("opens the Guide as a bounded tablet panel without adding a phone back sentinel", async () => {
    installResponsiveMatchMedia(768);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Union Ground Guide AI" }));
    const compass = await screen.findByRole("dialog", { name: "Union Ground Guide" });
    const rail = document.querySelector(".desktop-rail");

    expect(compass).not.toHaveAttribute("aria-modal");
    expect(rail).not.toHaveAttribute("inert");
    expect(rail).not.toHaveAttribute("aria-hidden");
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(document.querySelector(".sg-app--tablet .assistant")).not.toBeNull();
    expect(window.history.state?.sgCompass).not.toBe(true);
  });

  it("keeps the complete tablet rail usable in Spanish", async () => {
    window.localStorage.setItem("sg-lang", "es");
    installResponsiveMatchMedia(820);
    render(<App />);

    expect(await screen.findByRole("navigation", { name: "Principal" })).toBeInTheDocument();
    const switcher = within(document.querySelector(".desktop-rail__hat-switcher"));
    expect(switcher.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Trabajador", "Organizador", "Comité", "Liderazgo de campaña", "Asesor", "Administrador", "Presidencia de campaña",
    ]);
    fireEvent.click(screen.getByRole("link", { name: "Mensajes" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/messages"));
  });
});
