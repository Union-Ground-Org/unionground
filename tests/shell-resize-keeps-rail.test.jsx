// A resize across 1024px changes the shell in one
// commit. App held one state per media query, and the desktop query's change
// event committed before the tablet query's, so going from the desktop shell
// down to the tablet shell passed through one commit with neither: the phone
// shell mounted for that commit and the rail element was replaced, losing its
// keyboard focus, an open tooltip and its scroll (for example a tablet
// rotated from 1180 to 820 wide).
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";

let resize;
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
  let width = 1180;
  const lists = new Map();
  const matches = (query) => query.includes("min-width: 1024px") ? width >= 1024
    : query.includes("min-width: 768px") && query.includes("max-width: 1023px") ? width >= 768 && width <= 1023
      : false;
  vi.stubGlobal("matchMedia", (query) => {
    if (!lists.has(query)) lists.set(query, {
      media: query, get matches() { return matches(query); }, listeners: new Set(),
      addEventListener(_type, listener) { this.listeners.add(listener); },
      removeEventListener(_type, listener) { this.listeners.delete(listener); },
      addListener(listener) { this.listeners.add(listener); },
      removeListener(listener) { this.listeners.delete(listener); },
    });
    return lists.get(query);
  });
  // As a browser does it: every list whose answer changed fires its own
  // change event, in the order the lists were made, and each event is its
  // own task, so React commits after each one (an act per event). The lists
  // answer the new width from the first event on.
  resize = (next) => {
    const before = new Map([...lists].map(([query]) => [query, matches(query)]));
    width = next;
    for (const [query, list] of lists) {
      if (before.get(query) === matches(query)) continue;
      act(() => { for (const listener of [...list.listeners]) listener({ matches: matches(query), media: query }); });
    }
  };
});
afterEach(() => vi.unstubAllGlobals());

// Records whether the phone shell's top bar or a second rail ever mounted.
function watchShell() {
  const seen = { phoneTopBar: 0, railsRemoved: 0 };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node.nodeType === 1 && (node.matches(".mobile-top") || node.querySelector(".mobile-top"))) seen.phoneTopBar += 1;
      for (const node of record.removedNodes) if (node.nodeType === 1 && (node.matches(".desktop-rail") || node.querySelector(".desktop-rail"))) seen.railsRemoved += 1;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return { seen, stop: () => observer.disconnect() };
}

describe("a resize across the 1024px desktop threshold", () => {
  it.each([[1180, 820], [1024, 1023], [1440, 768]])("keeps the rail element, its focus and its scroll from %ipx down to %ipx, and back", (wide, narrow) => {
    resize(wide);
    render(<App />);
    const rail = document.querySelector(".desktop-rail");
    expect(rail).toHaveAttribute("data-render-mode", "desktop");
    const home = rail.querySelector('a[href="/m"]') ?? rail.querySelector("a");
    home.focus();
    expect(document.activeElement).toBe(home);
    const items = rail.querySelector(".desktop-rail__items");
    items.scrollTop = 40;

    const watch = watchShell();
    resize(narrow);
    watch.stop();
    expect(document.querySelector(".desktop-rail")).toBe(rail);
    expect(rail).toHaveAttribute("data-render-mode", "tablet");
    expect(document.querySelector(".sg-app")).toHaveClass("sg-app--tablet");
    expect(watch.seen).toEqual({ phoneTopBar: 0, railsRemoved: 0 });
    expect(document.activeElement).toBe(home);
    expect(items.scrollTop).toBe(40);

    resize(wide);
    expect(document.querySelector(".desktop-rail")).toBe(rail);
    expect(rail).toHaveAttribute("data-render-mode", "desktop");
    expect(document.activeElement).toBe(home);
  });

  it("still moves to the phone shell below 768px and back to the rail", () => {
    resize(1180);
    render(<App />);
    resize(600);
    expect(document.querySelector(".desktop-rail")).toBeNull();
    expect(document.querySelector(".sg-app")).not.toHaveClass("sg-app--desktop");
    expect(document.querySelector(".sg-app")).not.toHaveClass("sg-app--tablet");
    resize(900);
    expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-render-mode", "tablet");
    resize(1300);
    expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-render-mode", "desktop");
  });
});
