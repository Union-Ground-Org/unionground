import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { primeDemoData } from "../src/data/demoData.js";
import { shellStrings as en } from "../src/lib/i18n/locales/en/shell.js";
import { shellStrings as es } from "../src/lib/i18n/locales/es/shell.js";
import { STAFF_ROLE_NAVIGATION, STAFF_TAB_PAGES, staffTabPagesFor } from "../src/lib/staffNavigation.js";
import { TAB_PAGE_GROUPS, WORKSPACE_PATH_VIEWS, isStaffOnlyWorkspaceTabPath } from "../src/lib/workspacePages.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// UX-UG-STAFF-PAGES-WITH-NO-MENU-OR-SEARCH-ENTRY-20261111 (#8219):
// Officers looked for Worker support: Handoffs,
// Coordination: Mobilize and Campaigns: Polls through the menu and command
// search and found nothing, because those pages are tabs inside a workspace
// page and command search named only desk entries.

const LABELS = {
  "support-handoffs": "Worker support: Handoffs",
  "coordination-mobilize": "Coordination: Mobilize",
  "campaigns-polls": "Campaigns: Live polls",
};

describe("staff tab pages", () => {
  it("are real tab pages, and the organization-only ones are the staff-only tabs their page hides", () => {
    for (const page of STAFF_TAB_PAGES) {
      expect(WORKSPACE_PATH_VIEWS[page.path], page.path).toBe(page.viewKey);
      expect(en[page.labelKey]).toBe(LABELS[page.key]);
      expect(es[page.labelKey]).toMatch(/\S+: \S+/u);
    }
    for (const key of ["support-handoffs", "coordination-mobilize"]) {
      expect(isStaffOnlyWorkspaceTabPath(STAFF_TAB_PAGES.find((page) => page.key === key).path)).toBe(true);
    }
    expect(TAB_PAGE_GROUPS.engagement.tabs).toContain("polls");
  });

  it("are offered only where the hat's desk links the page and the page's own rule lets the hat open it", () => {
    const keys = (hat, opens) => staffTabPagesFor(STAFF_ROLE_NAVIGATION[hat], opens).map((page) => page.key);
    for (const hat of ["advisor", "admin", "vp"]) expect(keys(hat)).toEqual(Object.keys(LABELS));
    expect(STAFF_TAB_PAGES.some((page) => page.key === "pay-bargaining")).toBe(false);
    expect(keys("admin", { "support-handoffs": false, "coordination-mobilize": false }))
      .toEqual(["campaigns-polls"]);
    expect(staffTabPagesFor([], {})).toEqual([]);
  });

  it("names the profile editor so it cannot be taken for the membership card", () => {
    expect(en["morehub.card"]).toBe("Edit profile");
    expect(es["morehub.card"]).toBe("Editar perfil");
    expect(en["morehub.card"]).not.toBe(en["nav.card"]);
    expect(es["morehub.card"]).not.toBe(es["nav.card"]);
  });
});

describe("command search for staff tab pages", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  });
  afterEach(() => primeDemoData(fallbackData));

  async function search(query) {
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: query } });
    return box;
  }

  it("finds and opens every tab page by name for an Admin holding the organization grant", async () => {
    primeDemoData({ ...fallbackData, roles: ["admin"], member: { ...fallbackData.member, organizationId: "org-1", membershipStatus: "active", organizationRoles: ["admin"] } });
    window.history.replaceState({}, "", "/m/admin");
    render(<App />);
    for (const [query, label, path] of [
      ["handoffs", LABELS["support-handoffs"], "/m/support/handoffs"],
      ["mobilize", LABELS["coordination-mobilize"], "/m/coordination/mobilize"],
      ["polls", LABELS["campaigns-polls"], "/m/campaigns/engagement/polls"],
    ]) {
      await search(query);
      fireEvent.click(await screen.findByRole("option", { name: label }));
      await waitFor(() => expect(window.location.pathname).toBe(path));
      // The next search starts only once this one has closed.
      await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull());
    }
  }, 60000);

  it("does not offer the excluded Bargaining tab to an Admin", async () => {
    primeDemoData({ ...fallbackData, roles: ["admin"], member: { ...fallbackData.member, organizationId: "org-1", membershipStatus: "active", organizationRoles: [] } });
    window.history.replaceState({}, "", "/m/admin");
    render(<App />);
    await search("polls");
    expect(await screen.findByRole("option", { name: LABELS["campaigns-polls"] })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Search commands" }), { target: { value: "bargaining" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Pay tools: Bargaining/i })).toBeNull());
  }, 60000);

});
