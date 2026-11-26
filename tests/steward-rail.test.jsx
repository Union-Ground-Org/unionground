import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";

// The fixture member holds no roles (fallback.js `roles: []`). This file
// re-primes the demo-data cache with a steward role and restores the original
// fixture afterwards. `demo` stays false here — no ?demo=1 — which is the
// empty SaaS surface after sign-in: authorized staff roles must not grow a
// Switch hat. Staff desks stay on the SAMPLE origin.
const stewardFixtures = { ...fallbackData, roles: ["steward"] };

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
  primeDemoData(stewardFixtures);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  primeDemoData(fallbackData);
});

describe("steward rail group", () => {
  // Role-Derived Desk Entrance: The steward role
  // is a Desks entry in the rail, never a Switch hat.
  it("never shows Switch hat on the empty SaaS surface, even with a steward role", async () => {
    stubMatchMedia(true);
    render(<App />);
    expect(screen.getByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();
    const labels = [...document.querySelectorAll(".desktop-rail__grouplabel")].map((node) => node.textContent);
    expect(labels).toEqual(["Desks", "Me", "Campaign", "Account"]);
    expect(document.querySelector(".desktop-rail__hat-switcher")).toBeNull();
    expect(document.querySelector(".staff-switcher")).toBeNull();
    expect(screen.queryByRole("group", { name: "Switch role" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Switch role" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Committee" })).toBeNull();
    expect(screen.getByRole("link", { name: "Committee" })).toHaveAttribute("href", "/m/steward");
    expect(screen.queryByRole("link", { name: "Issue work" })).toBeNull();
    // Union Ground's worker Work list is a Me destination beside Home;
    // the staff Campaign work shortcut still never appears in Member chrome.
    expect(screen.getByRole("link", { name: "Work" })).toHaveAttribute("href", "/m/work");
    expect(screen.queryByRole("link", { name: "Campaign work" })).toBeNull();
  });

  it("keeps staff functions off the phone Member surface without a hat picker", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Switch role" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "Committee desk" })).toBeNull();
    expect(document.querySelector(".staff-switcher")).toBeNull();
    expect(document.querySelector(".bottom-nav")).toBeNull();
    const work = document.querySelector(".card-nav__panel--work");
    expect(work).not.toBeNull();
    expect(work.textContent).not.toContain("Issue work");
    expect(work.textContent).not.toContain("Committee messages");
  });

  it("keeps the SaaS desktop rail without a companion phone or Committee role control", () => {
    stubMatchMedia(true);
    render(<App />);
    expect(document.querySelector(".companion-phone")).toBeNull();
    expect(document.querySelector(".phone-frame")).toBeNull();
    expect(document.querySelector(".desktop-rail__hat-switcher")).toBeNull();
    expect(screen.queryByRole("button", { name: "Committee" })).toBeNull();
    expect(document.querySelector(".bottom-nav")).toBeNull();
  });
});
