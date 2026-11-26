import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";

// The "Due this wk" tile these tests used to pin was once a hardcoded literal
// 0 — a live lie on production for any member with a near deadline. Wave 2b's
// prototype rebuild removed the counts strip (and with it the week-window
// counter) entirely, so the honesty contract this file pins moved to the
// per-case surfaces that replaced it: every open case renders its OWN
// deadline (or overdue state) on the timeline's gold now-node, the open queue
// orders deadline-first with undated cases last, and resolved cases leave the
// queue for the Closed list, which never resurrects a deadline. Nothing may
// be invented: each date on screen is the case's own field, and an empty
// caseload renders the computed empty state — never a fabricated number.

const member = { initials: "DF" };

function isoFromToday(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function captionFromToday(days) {
  return new Date(`${isoFromToday(days)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function caseRow(id, { status = "active", days = null, overdue = false } = {}) {
  const deadlineValue = days === null ? "" : isoFromToday(days);
  return { id, reference: `GR-${id}`, title: `Case ${id}`, deadline: deadlineValue || "Not set", deadlineValue, type: "Discipline", articles: "Art. 12", step: "Step 1", status, overdue, updates: [] };
}

// One entry per rendered open-case card, in DOM order: the reference plus the
// gold now-node's deadline line. Exact strings, exact order — the sample the
// assertions compare against covers membership, ordering, and wording at once.
function dueLines(container) {
  return [...container.querySelectorAll(".mcases-case")].map((card) => ({
    ref: card.querySelector(".mcases-case__ref").textContent,
    due: card.querySelector(".mcases-tl__due")?.textContent ?? null,
  }));
}

describe("cases deadline honesty (wave 2b timeline)", () => {
  it("renders each active case's own near deadline, today included, deadline-first", () => {
    // Fed out of order on purpose: the queue must sort by deadline itself.
    const { container } = render(<CasesView data={{ member, cases: [
      caseRow("edge-six", { days: 6 }),
      caseRow("today", { days: 0 }),
      caseRow("midweek", { days: 3 }),
    ] }} onCreateCase={() => {}} />);
    expect(dueLines(container)).toEqual([
      { ref: "GR-today", due: `Due ${captionFromToday(0)}` },
      { ref: "GR-midweek", due: `Due ${captionFromToday(3)}` },
      { ref: "GR-edge-six", due: `Due ${captionFromToday(6)}` },
    ]);
    // A deadline still ahead — today included — is never painted overdue.
    expect(container.textContent).not.toContain("Overdue");
    expect(container.querySelector(".mcases-closed")).toBeNull();
  });

  it("separates past, future, resolved, and undated deadlines without inventing one", () => {
    const { container } = render(<CasesView data={{ member, cases: [
      caseRow("overdue", { days: -2, overdue: true }),
      caseRow("next-week", { days: 7 }),
      caseRow("resolved-soon", { status: "resolved", days: 2 }),
      caseRow("undated"),
      caseRow("counts", { days: 1 }),
    ] }} onCreateCase={() => {}} />);
    // Open queue only, deadline-first, undated last. A past deadline says
    // Overdue — never a friendly future date — and an undated case renders
    // the data layer's own "Not set", never a fabricated date.
    expect(dueLines(container)).toEqual([
      { ref: "GR-overdue", due: `Overdue — ${captionFromToday(-2)}` },
      { ref: "GR-counts", due: `Due ${captionFromToday(1)}` },
      { ref: "GR-next-week", due: `Due ${captionFromToday(7)}` },
      // Undated cases must not read the grammatical accident "Due Not set":
      // the view gates on deadlineValue and prints the honest no-deadline line.
      { ref: "GR-undated", due: "No deadline yet" },
    ]);
    // The resolved case leaves the open queue for the Closed list — exactly
    // one row, Resolved chip, and NO deadline resurrected on it.
    const closedRows = container.querySelectorAll(".mcases-closed__row");
    expect(closedRows).toHaveLength(1);
    expect(closedRows[0].textContent).toContain("Case resolved-soon");
    expect(closedRows[0].querySelector(".mcases-closed__chip").textContent).toBe("Resolved");
    expect(closedRows[0].textContent).not.toContain("Due");
  });

  it("keeps the far-future and empty caseloads computed, never hardcoded", () => {
    // A distant deadline renders as its own real date — no urgency invented.
    const far = render(<CasesView data={{ member, cases: [caseRow("far", { days: 30 })] }} onCreateCase={() => {}} />);
    expect(dueLines(far.container)).toEqual([{ ref: "GR-far", due: `Due ${captionFromToday(30)}` }]);
    expect(far.container.textContent).not.toContain("Overdue");
    // No cases at all: the computed empty state, not a fabricated queue.
    const empty = render(<CasesView data={{ member, cases: [] }} onCreateCase={() => {}} />);
    expect(empty.container.querySelectorAll(".mcases-case")).toHaveLength(0);
    expect(empty.container.querySelector(".mcases-empty")).not.toBeNull();
    expect(empty.container.textContent).toContain("No open issues — good.");
  });
});
