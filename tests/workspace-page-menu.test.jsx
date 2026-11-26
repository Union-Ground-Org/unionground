import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { STAFF_PLANES } from "../src/lib/staffPlanes.js";
import { t } from "../src/lib/i18n.js";
import { pageMenuPaths, pageMenuTrigger } from "./helpers/workspacePageMenu.js";

// UX-UG-STAFF-DESK-PAGE-MENU-RAW-BROWSER-SELECT-20261108: every staff
// desk opened under a bare browser select that repeated the rail, and on a
// phone it stacked under the role select. The page jump is now one styled
// disclosure of page links, and the rail shells drop it for staff planes.
afterEach(() => { window.history.replaceState({}, "", "/m"); });

function renderMenu(view, { hat = view, path = `/m/${view}`, navigate = vi.fn(), lang = "en" } = {}) {
  window.history.replaceState({}, "", path);
  render(<LanguageProvider lang={lang}>
    <WorkspacePages view={view} hat={hat} location={window.location.href} navigate={navigate}><h1>Desk</h1></WorkspacePages>
  </LanguageProvider>);
  return { navigate, menu: screen.getByRole("navigation", { name: lang === "en" ? "Page menu" : t(lang, "workspace.pageMenu") }) };
}

describe("workspace page menu", () => {
  it.each(STAFF_PLANES.map((plane) => plane.view).filter((view) => STAFF_ROLE_NAVIGATION[view]))("offers every %s page through a styled disclosure, never a native select", (view) => {
    const { menu } = renderMenu(view);
    expect(menu.querySelector("select")).toBeNull();
    expect(within(menu).queryByRole("combobox")).toBeNull();
    const trigger = pageMenuTrigger(within(menu));
    expect(trigger).toHaveAccessibleName("Current page Overview");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    const pages = STAFF_ROLE_NAVIGATION[view].filter((item) => item.sectionId).map((item) => item.path);
    expect(pageMenuPaths(trigger)).toEqual([`/m/${view}`, ...pages]);
    // Closed, the list is out of the accessibility tree.
    expect(within(menu).queryAllByRole("link").map((link) => link.textContent)).toEqual([t("en", STAFF_PLANES.find((plane) => plane.view === view).labelKey)]);
  });

  it("does not duplicate the Organizer's own navigation with an empty desk menu", () => {
    render(<LanguageProvider lang="en">
      <WorkspacePages view="organize" hat="organize" location="/m/organize" navigate={vi.fn()}><h1>Organize</h1></WorkspacePages>
    </LanguageProvider>);
    expect(screen.getByRole("heading", { name: "Organize" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Page menu" })).toBeNull();
  });

  it("opens to labelled page links, marks the current page and navigates on a link", () => {
    const { menu, navigate } = renderMenu("steward", { path: "/m/steward/forms" });
    const trigger = pageMenuTrigger(within(menu));
    expect(trigger).toHaveAccessibleName("Current page Forms review");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(trigger.getAttribute("aria-controls"));
    expect(within(panel).getByRole("link", { name: "Forms review" })).toHaveAttribute("aria-current", "page");
    expect(within(panel).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    fireEvent.click(within(panel).getByRole("link", { name: "Worker requests" }));
    expect(navigate).toHaveBeenCalledWith("steward", "/m/steward/requests", null, { replace: false });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("returns focus to the button when the current page is chosen again", () => {
    const { menu } = renderMenu("steward", { path: "/m/steward/forms" });
    const trigger = pageMenuTrigger(within(menu));
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute("aria-controls"));
    const current = within(panel).getByRole("link", { name: "Forms review" });
    current.focus();
    fireEvent.click(current);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape with focus back on the button, and on a press outside", () => {
    const { menu } = renderMenu("coordinator");
    const trigger = pageMenuTrigger(within(menu));
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute("aria-controls"));
    const first = within(panel).getAllByRole("link")[0];
    first.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.mouseDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("names the trigger in Spanish from its visible words", () => {
    const { menu } = renderMenu("advisor", { lang: "es" });
    const trigger = menu.querySelector(".workspace-page-menu__trigger");
    expect(trigger).toHaveAccessibleName(`${t("es", "workspace.page")} ${t("es", "workspace.overview")}`);
  });


  it("drops the rail-listed menu on the desktop and tablet shells and styles no native select", () => {
    const css = readFileSync("src/components/workspacePages.css", "utf8");
    expect(css).toContain(".sg-app:is(.sg-app--desktop, .sg-app--tablet) .workspace-page-menu[data-rail-listed] { display: none; }");
    expect(css).not.toMatch(/\.workspace-page-menu select/);
  });
});
