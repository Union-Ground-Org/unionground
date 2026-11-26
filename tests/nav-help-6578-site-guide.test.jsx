import { readFileSync } from "node:fs";
// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 31: the Site
// guide answers at the address people type, sits under Account, can be
// searched, and shows officer desks, including a desk the staff two-step policy
// is holding back (as a section with a note, never as live links).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { APP_PATH_ALIASES, MEMBER_PATH_VIEWS } from "../src/lib/appRoutes.js";
import { t as translate } from "../src/lib/i18n.js";
import { buildSiteGuide, filterSiteGuideSections, siteGuideSectionSkeletons } from "../src/lib/siteGuide.js";
import { SiteGuideView } from "../src/views/SiteGuideView.jsx";

const en = (key, vars) => translate("en", key, vars);
const es = (key, vars) => translate("es", key, vars);

function renderGuide(props = {}, lang = "en") {
  return render(<LanguageProvider lang={lang}><SiteGuideView onNavigate={vi.fn()} {...props} /></LanguageProvider>);
}

describe("site guide address and place in the menu", () => {
  it("answers /m/site-guide with the guide page", () => {
    expect(APP_PATH_ALIASES["/m/site-guide"]).toBe("/m/guide");
    expect(MEMBER_PATH_VIEWS["/m/guide"]).toBe("siteGuide");
  });

  it("lists Site guide in the Account group of the member rail", () => {
    const { container } = render(<LanguageProvider><DesktopRail renderMode="desktop" active="today" onNavigate={() => {}} /></LanguageProvider>);
    const nodes = [...container.querySelectorAll(".desktop-rail__items > *")];
    const account = nodes.findIndex((node) => node.textContent === en("shell.groupAccount"));
    const guide = nodes.findIndex((node) => node.getAttribute("href") === "/m/guide");
    expect(account).toBeGreaterThan(-1);
    expect(guide).toBe(account + 1);
  });
});

describe("site guide model", () => {
  it("gives a paused officer role its desk section without links", () => {
    const sections = siteGuideSectionSkeletons([], ["admin", "member", "not-a-role"]);
    expect(sections.map((section) => section.key)).toEqual(["me", "union", "account", "admin"]);
    expect(sections.at(-1)).toMatchObject({ key: "admin", staff: true, paused: true, destinations: [] });
  });

  it("does not repeat a role that is both held and listed as paused", () => {
    const sections = siteGuideSectionSkeletons(["admin"], ["admin"]);
    expect(sections.filter((section) => section.key === "admin")).toHaveLength(1);
    expect(sections.find((section) => section.key === "admin").paused).toBeUndefined();
    expect(siteGuideSectionSkeletons(null, null).map((section) => section.key)).toEqual(["me", "union", "account"]);
  });

  it("filters by section words and by page names, accent-insensitively", () => {
    const guide = buildSiteGuide({ t: en, roles: ["admin"] });
    const label = (item) => en(item.labelKey);
    expect(filterSiteGuideSections(guide.sections, "   ", label)).toBe(guide.sections);
    const roster = filterSiteGuideSections(guide.sections, "roster", label);
    expect(roster.map((section) => section.key)).toContain("admin");
    // The admin section's own words name the roster, so all of its links stay.
    const admin = roster.find((section) => section.key === "admin");
    expect(admin.destinations).toHaveLength(guide.sections.find((section) => section.key === "admin").destinations.length);
    // A page name alone keeps the section and narrows its links to that page.
    const structure = filterSiteGuideSections(guide.sections, "org structure", label);
    const union = structure.find((section) => section.key === "union");
    expect(union.destinations.map((item) => item.key)).toEqual(["org-structure"]);
    const spanish = buildSiteGuide({ t: es, roles: [] });
    expect(filterSiteGuideSections(spanish.sections, "CONFIGURACION", (item) => es(item.labelKey)).length).toBeGreaterThan(0);
    expect(filterSiteGuideSections(guide.sections, "zzzz-no-match", label)).toEqual([]);
  });
});

describe("site guide page", () => {
  it("searches the guide, says how many sections match, and clears", () => {
    renderGuide({ roles: ["admin"] });
    const search = screen.getByRole("searchbox", { name: "Search the guide" });
    expect(screen.getByRole("heading", { level: 2, name: en("shell.groupMe") })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "invitations" } });
    expect(screen.queryByRole("heading", { level: 2, name: en("shell.groupMe") })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: en("demo.hatAdmin") })).toBeInTheDocument();
    expect(screen.getByText(/matching section/)).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "access history" } });
    expect(screen.getByText("1 matching section")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "qqqqq" } });
    expect(screen.getByText(en("siteGuide.searchEmpty", { query: "qqqqq" }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("heading", { level: 2, name: en("shell.groupMe") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("shows a paused officer desk with a two-step note and no links", () => {
    renderGuide({ roles: [], pausedRoles: ["admin"] });
    const section = screen.getByRole("heading", { level: 2, name: en("demo.hatAdmin") }).closest("article");
    expect(within(section).getByText(en("siteGuide.pausedNote"))).toBeInTheDocument();
    expect(within(section).queryByRole("list", { name: /Pages in/ })).not.toBeInTheDocument();
  });

  it("says in the intro that officer roles get their own sections, in both languages", () => {
    renderGuide({}, "es");
    expect(screen.getByText(es("siteGuide.intro"))).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Buscar en la guía" })).toBeInTheDocument();
    expect(en("siteGuide.intro")).not.toMatch(/match your role/);
    expect(en("siteGuide.intro")).toMatch(/officer or staff role/);
  });
});

// Codex review on #6640: at 960px and up the layout is two columns (contents
// and sections); the search box spans both so neither is pushed out of place.
describe("site guide search placement", () => {
  it("gives the search box a full-width row in the two-column layout", () => {
    const css = readFileSync("src/views/siteGuide.css", "utf8");
    const wide = css.slice(css.indexOf("@media (min-width: 960px)"));
    const block = wide.slice(0, wide.indexOf("\n}") + 2);
    expect(block).toContain(".site-guide__layout { grid-template-columns: 14rem minmax(0, 1fr);");
    expect(block).toMatch(/\.site-guide__search \{ grid-column: 1 \/ -1; \}/);
  });
});

// Merged root coverage on #6640: the default label reader matches each
// destination by its label key when no shown-name function is passed.
describe("site guide search without a label reader", () => {
  it("filters page links by their label key", () => {
    const sections = [
      { key: "a", label: "Home", body: "", steps: [], destinations: [{ key: "x", labelKey: "nav.messages" }, { key: "y", labelKey: "nav.voting" }] },
      { key: "b", label: "Other", body: "", steps: [], destinations: [{ key: "z", labelKey: "nav.cases" }] },
    ];
    expect(filterSiteGuideSections(sections, "voting")).toEqual([{ ...sections[0], destinations: [{ key: "y", labelKey: "nav.voting" }] }]);
    expect(filterSiteGuideSections(sections, "  ")).toBe(sections);
  });
});
