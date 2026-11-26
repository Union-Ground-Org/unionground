import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspaceOverview, WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LegalView } from "../src/views/LegalView.jsx";

// A11Y-UG-DUPLICATE-LANDMARK-ACCESSIBLE-NAMES-20260920. A landmark list is
// how screen-reader users move around a page, so two landmarks rendered at the
// same time with the same role and the same name are indistinguishable there.

const IMPLICIT_ROLE = { NAV: "navigation", ASIDE: "complementary", MAIN: "main", SEARCH: "search" };

function landmarkName(element) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent.trim() || "").join(" ").trim();
  }
  return (element.getAttribute("aria-label") || "").trim();
}

function landmarks(container) {
  const found = [];
  for (const element of container.querySelectorAll("nav, aside, main, search, section, form, header, footer, [role]")) {
    const explicit = element.getAttribute("role");
    const name = landmarkName(element);
    let role = explicit || IMPLICIT_ROLE[element.tagName];
    // section and form are landmarks only when named; header/footer only at
    // the top level, which is the only way these views render them.
    if (!role && (element.tagName === "SECTION" || element.tagName === "FORM") && name) role = element.tagName === "SECTION" ? "region" : "form";
    if (!role && element.tagName === "HEADER" && !element.closest("main, aside, nav, section, article")) role = "banner";
    if (!role && element.tagName === "FOOTER" && !element.closest("main, aside, nav, section, article")) role = "contentinfo";
    if (!["navigation", "complementary", "main", "search", "region", "form", "banner", "contentinfo"].includes(role)) continue;
    found.push({ role, name, element });
  }
  return found;
}

function collisions(container) {
  const seen = new Map();
  const clashes = [];
  for (const landmark of landmarks(container)) {
    const key = `${landmark.role}::${landmark.name}`;
    if (seen.has(key)) clashes.push(key);
    seen.set(key, landmark);
  }
  return clashes;
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("concurrent landmarks never share a role and a name", () => {
  for (const lang of ["en", "es"]) {
    for (const plane of ["admin", "steward"]) {
      it(`names the ${plane} overview page menu and directory apart in ${lang}`, () => {
        window.history.replaceState({}, "", `/m/${plane}`);
        const { container } = render(
          <LanguageProvider lang={lang}>
            <WorkspacePages view={plane} hat={plane} location={window.location.href} navigate={vi.fn()}>
              <WorkspaceOverview />
            </WorkspacePages>
          </LanguageProvider>,
        );
        const menu = container.querySelector(".workspace-page-menu");
        const directory = container.querySelector(".workspace-directory");
        expect(menu).toBeTruthy();
        expect(directory).toBeTruthy();
        const names = landmarks(container).filter((landmark) => landmark.role === "navigation");
        const menuName = names.find((landmark) => landmark.element === menu)?.name;
        const directoryName = names.find((landmark) => landmark.element === directory)?.name;
        expect(menuName).toMatch(/\S/);
        expect(directoryName).toMatch(/\S/);
        expect(menuName).not.toBe(directoryName);
        expect(collisions(container)).toEqual([]);
      });
    }

    it(`names the legal on-page index once in ${lang}`, () => {
      const { container } = render(<LanguageProvider lang={lang}><LegalView page="privacy" /></LanguageProvider>);
      const index = container.querySelector(".public-document-index");
      const indexName = index.querySelector("strong").textContent.trim();
      const named = landmarks(container).filter((landmark) => landmark.name === indexName);
      expect(named).toHaveLength(1);
      expect(named[0].role).toBe("navigation");
      expect(index.contains(named[0].element)).toBe(true);
      expect(collisions(container)).toEqual([]);
    });
  }

  it("fails a page where two concurrent navigation landmarks share a name", () => {
    const { container } = render(<div><nav aria-label="Pages" /><nav aria-label="Pages" /></div>);
    expect(collisions(container)).toEqual(["navigation::Pages"]);
  });
});
