import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceOverview, WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { choosePage, pageMenuPaths, pageMenuTrigger } from "./helpers/workspacePageMenu.js";

describe("Settings menu groups", () => {
  it.each(["en", "es"])("groups every existing destination in the menu and directory (%s)", (lang) => {
    window.history.replaceState({}, "", "/m/settings");
    const navigate = vi.fn();
    render(<LanguageProvider lang={lang}><WorkspacePages view="settings" location="/m/settings" navigate={navigate}>
      <WorkspaceOverview />
    </WorkspacePages></LanguageProvider>);
    const menu = document.querySelector(".workspace-page-menu__trigger");
    const panel = document.getElementById(menu.getAttribute("aria-controls"));
    const groups = within(panel).getAllByRole("group", { hidden: true });
    expect(groups).toHaveLength(4);
    expect(groups.map((group) => [...group.querySelectorAll("a")].map((link) => link.getAttribute("href")))).toEqual([
      ["profile", "security", "sessions", "privacy", "requests"], ["notifications", "messages"],
      ["language", "appearance", "shortcuts"], ["calendar"],
    ].map((group) => group.map((key) => `/m/settings/${key}`)));
    for (const group of groups) expect(document.getElementById(group.getAttribute("aria-labelledby")).textContent).not.toContain("settings.");
    for (const detail of document.querySelectorAll("details")) detail.open = true;
    expect(document.querySelectorAll(".workspace-directory a")).toHaveLength(11);
    choosePage(menu, "/m/settings/sessions");
    expect(navigate).toHaveBeenCalledWith("settings", "/m/settings/sessions", null, { replace: false });
  });

  // #6634: where the Requests panel is not drawn (fixture demo, SAMPLE, a
  // restricted session) the page is not offered.
  it("drops Requests from the menu and directory when its panel is not drawn", () => {
    render(<LanguageProvider lang="en"><WorkspacePages view="settings" location="/m/settings" navigate={vi.fn()} hiddenPageKeys={["settings-requests"]}>
      <WorkspaceOverview />
    </WorkspacePages></LanguageProvider>);
    const options = pageMenuPaths(pageMenuTrigger());
    expect(options).not.toContain("/m/settings/requests");
    expect(options).toContain("/m/settings/privacy");
    expect([...document.querySelectorAll(".workspace-directory a")].map((link) => link.getAttribute("href"))).not.toContain("/m/settings/requests");
  });
});
