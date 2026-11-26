import { render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CaseList } from "../src/components/CaseList.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { declaredFor, mediaRule, mountStylesheets } from "./helpers/appStylesheet.js";

// BUG-UG-WEB-CASELOAD-MEMBER-COLUMN-SQUEEZED-20261002. The table is
// table-layout: fixed with no declared column widths, so it split five ways,
// and the first cell holds the row select box, the initials avatar, the
// member's name, the case reference and the reason chip. On the steward desk
// that left about 25px for the name, and `overflow-wrap: anywhere` on every
// cell broke "Darnell Foster" two letters at a time. The 98px in the finding
// was a measurement; the selectors below are what was wrong.

const rows = [
  { id: "case-a", memberName: "Darnell Foster", memberInitials: "DF", reference: "GR-2026-139", title: "Weekend rotation changed without notice", caseType: "Scheduling", step: "Step 1", status: "active", deadline: "2026-08-27", deadlineLabel: "Aug 27" },
  { id: "case-b", memberName: "Guadalupe Vasquez-Hernandez", memberInitials: "GV", reference: "GR-2026-133", title: "Written warning after a documented staffing shortage", caseType: "Discipline", step: "Step 2", status: "active", deadline: "2026-08-18", deadlineLabel: "Aug 18" },
];

let unmountStyles;
beforeAll(() => { unmountStyles = mountStylesheets(); });
afterAll(() => unmountStyles());
afterEach(() => window.history.replaceState({}, "", "/"));

function renderStewardList() {
  window.history.replaceState({}, "", "/m/steward/caseload");
  return render(
    <LanguageProvider lang="en">
      <CaseList
        plane="steward"
        rows={rows}
        onOpenCase={vi.fn()}
        renderRowLead={(item) => <input type="checkbox" aria-label={`Select ${item.reference}`} />}
        urgencyOf={() => ({ tone: "over", label: "Overdue" })}
      />
    </LanguageProvider>,
  );
}

describe("case list column widths", () => {
  it("names every header cell by its column so widths can be declared per column", () => {
    const { container } = renderStewardList();
    const headers = [...container.querySelectorAll(".case-list__table thead th")].map((th) => th.getAttribute("data-column"));
    // There is no step column: Union Ground issues have no grievance
    // procedure (owner decision, 2026-10-13), even when a row carries a step.
    expect(headers).toEqual(["member", "title", "deadline", "status"]);
    expect(container.querySelector('[data-column="step"]')).toBeNull();
  });

  it("gives the member column a declared share at least 180px wide at the table's narrowest", () => {
    const { container } = renderStewardList();
    const table = container.querySelector(".case-list__table");
    const member = table.querySelector('th[data-column="member"]');
    expect(getComputedStyle(table).tableLayout).toBe("fixed");
    const share = Number.parseFloat(getComputedStyle(member).width) / 100;
    const narrowest = Number.parseFloat(getComputedStyle(table).minWidth);
    expect(getComputedStyle(member).width).toMatch(/%$/);
    expect(share * narrowest).toBeGreaterThanOrEqual(180);
    // The short status chip gives width back; case and deadline keep the
    // undeclared remainder.
    for (const column of ["status"]) {
      expect(Number.parseFloat(getComputedStyle(table.querySelector(`th[data-column="${column}"]`)).width)).toBeLessThan(share * 100);
    }
  });

  it("keeps the avatar, name, reference and reason chip in the member cell", () => {
    const { container } = renderStewardList();
    const cell = [...container.querySelectorAll('.case-list__table tbody td[data-column="member"]')]
      .find((td) => td.textContent.includes("Darnell Foster"));
    expect(cell.querySelector(".case-list__lead input[type=checkbox]")).not.toBeNull();
    expect(cell.querySelector(".case-list__av")).toHaveAttribute("data-initials", "DF");
    expect(cell.querySelector(".gq-name")).toHaveTextContent("Darnell Foster");
    expect(cell.querySelector(".gq-ref")).toHaveTextContent("GR-2026-139");
    expect(cell.querySelector(".gq-reason")).toHaveTextContent("Overdue");
  });

  it("wraps cells only between words: no case-list cell uses overflow-wrap anywhere", () => {
    const { container } = renderStewardList();
    for (const cell of container.querySelectorAll(".case-list__table td, .case-list__table td small")) {
      expect(getComputedStyle(cell).overflowWrap).not.toBe("anywhere");
    }
    for (const selector of [".case-list__table td", ".case-list__table td small"]) {
      expect(declaredFor(selector)).not.toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it("drops the declared widths when the list stacks into records on a narrow column", () => {
    renderStewardList();
    expect(mediaRule("(max-width: 680px)", ".case-list__table th[data-column]")).toBeNull();
    const stacked = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
      .find((rule) => rule.cssText.startsWith("@container case-list (max-width: 680px)"));
    expect(stacked.cssText).toMatch(/\.case-list__table th\[data-column\]\s*\{\s*width:\s*auto;/);
  });
});
