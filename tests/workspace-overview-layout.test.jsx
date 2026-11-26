import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspaceOverview, WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { pageMenuPaths, pageMenuTrigger } from "./helpers/workspacePageMenu.js";

// UB-UG-WORKSPACE-OVERVIEW-COUNTS-AND-PAGE-MENU-20261106, 's
// decision for the shared workspace navigation on an overview page:
// - the directory's group headings carry no page counts (they read as a site
//   map, and opening a group lists its pages);
// - the page menu stays (on a phone it is the one-tap jump to any page), but
//   where the crumb would only repeat "Overview" (member Settings "More") the
//   crumb is dropped; staff planes keep "Steward / Overview" because the crumb
//   names the hat;
// - on any page other than the overview the crumb and menu are unchanged.
function renderOverview(view, path = `/m/${view}`) {
  window.history.replaceState({}, "", path);
  return render(<LanguageProvider lang="en">
    <WorkspacePages view={view} hat={view === "settings" ? undefined : view} location={window.location.href} navigate={vi.fn()}>
      <WorkspaceOverview />
    </WorkspacePages>
  </LanguageProvider>);
}

describe("workspace overview layout", () => {
  it("shows member Settings' overview with the page menu alone and uncounted groups", () => {
    const { container } = renderOverview("settings");
    const menu = screen.getByRole("navigation", { name: "Page menu" });
    expect(menu.querySelector(".workspace-page-menu__crumb")).toBeNull();
    expect(menu.querySelector(".workspace-page-menu__sep")).toBeNull();
    expect(pageMenuTrigger(within(menu))).toHaveAccessibleName("Current page Overview");
    const summaries = [...container.querySelectorAll(".workspace-directory summary")];
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) expect(summary.textContent).not.toMatch(/\(\d+ pages?\)/);
  });


  it("keeps the crumb back to the overview on a Settings page", () => {
    window.history.replaceState({}, "", "/m/settings");
    const { unmount } = renderOverview("settings");
    const firstPage = pageMenuPaths(pageMenuTrigger()).find((path) => path !== "/m/settings");
    unmount();
    renderOverview("settings", firstPage);
    const crumb = screen.getByRole("navigation", { name: "Page menu" }).querySelector(".workspace-page-menu__crumb");
    expect(crumb).not.toBeNull();
    expect(crumb.getAttribute("href")).toContain("/m/settings");
  });
});
