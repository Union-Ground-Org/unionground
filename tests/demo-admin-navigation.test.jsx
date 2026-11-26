import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { BottomNav, STAFF_PLANE_TABS } from "../src/components/BottomNav.jsx";
import { primeDemoData } from "../src/data/demoData.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

const unshipped = [
  ["Organization verification", "/m/admin/catalog-verification"],
  ["Platform verification", "/m/admin/catalog-verifier"],
  ["Vouch for chapters", "/m/admin/catalog-vouch"],
];
const intake = ["People waiting", "/m/admin/people-waiting", "Only Union Ground's intake reviewers can see these requests. That role is unavailable in the demo."];

keepKeyboardShortcutsOn();

beforeEach(() => {
  window.localStorage.setItem("sg-lang", "en");
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  primeDemoHat("admin");
  primeDemoData({ ...fallbackData, roles: ["admin"], member: { ...fallbackData.member, organizationId: "org-1", membershipStatus: "active", organizationRoles: ["admin"] } });
});

afterEach(() => {
  primeDemoData(fallbackData);
  window.history.replaceState({}, "", "/m");
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe.each([["demo", true], ["live", false]])("%s Admin navigation", (_mode, demoNavigation) => {
  it("offers the right entries in the phone Work card and staff bottom menu", async () => {
    vi.stubGlobal("matchMedia", (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
    window.history.replaceState({}, "", `/m?shell=classic${demoNavigation ? "&demo=1" : ""}`);
    const { container, unmount } = render(<App />);
    const workLinks = () => [...container.querySelectorAll("#card-nav-panel-work a")].map((link) => new URL(link.href).pathname);
    await waitFor(() => expect(workLinks()).toContain("/m/admin/access"), { timeout: 4000 });
    for (const [label, path] of unshipped) expect(workLinks(), `Work card ${label}`).not.toContain(path);
    expect(workLinks().includes(intake[1])).toBe(!demoNavigation);
    unmount();

    render(<LanguageProvider lang="en"><BottomNav active="admin" tabs={STAFF_PLANE_TABS.admin} demoNavigation={demoNavigation} onNavigate={vi.fn()} /></LanguageProvider>);
    for (const [label] of unshipped) expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    expect(Boolean(screen.queryByRole("link", { name: intake[0] }))).toBe(!demoNavigation);
  });
});

it("does not suggest the Admin desk for an unavailable demo Guide page", async () => {
  window.history.replaceState({}, "", "/m/guide?shell=classic&demo=1");
  render(<App />);

  const search = await screen.findByRole("searchbox", { name: "Search the guide" });
  fireEvent.change(search, { target: { value: "Platform verification" } });

  expect(screen.queryByRole("button", { name: "Platform verification" })).not.toBeInTheDocument();
  expect(screen.queryByText(/is staff work for/)).not.toBeInTheDocument();
  expect(screen.getByText(/Nothing in the guide matches "Platform verification"/)).toBeInTheDocument();
});

it.each([intake])("keeps the demo direct link and notice for %s", async (label, path, reason) => {
  window.history.replaceState({}, "", `${path}?shell=classic&demo=1`);
  render(<App />);
  expect(await screen.findByRole("heading", { level: 1, name: label })).toBeInTheDocument();
  expect(await screen.findByText(reason)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to Campaign admin" })).toHaveAttribute("href", "/m/admin?demo=1");
  expect(window.location.pathname).toBe(path);
});
