import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// Fixed "now" so deadline ordering is a fact about the data, not about the
// clock the suite happens to run on.
const NOW = new Date("2026-07-20T09:00:00Z");

// Local calendar day, matching the deadlineValue the loader stores (a date with
// no time of day).
function isoDay(offsetDays) {
  const day = new Date(NOW);
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() + offsetDays);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

// The row still carries legacy step and articles values, as an older projection
// or the inert schema could hand over: Union Ground issues have no grievance
// step and no contract articles, so the view must not surface either.
function caseRow(overrides) {
  return {
    id: "c-1",
    reference: "G-1",
    title: "Case",
    type: "Discipline",
    articles: "Art. 12",
    step: "Step 1",
    status: "active",
    deadline: "",
    deadlineValue: "",
    overdue: false,
    updates: [],
    ...overrides,
  };
}

function renderCases(cases, props = {}) {
  return render(
    <LanguageProvider lang="en">
      <CasesView
        data={{ member: { initials: "MV" }, cases }}
        onProfile={vi.fn()}
        onAssistant={vi.fn()}
        onCreateCase={vi.fn()}
        onUpdateCase={vi.fn()}
        onAddCaseUpdate={vi.fn()}
        {...props}
      />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("member issues list", () => {
  it("orders open issues deadline-first, undated last, and lists resolved ones under Closed", () => {
    renderCases([
      caseRow({ id: "c-none", title: "Undated", deadlineValue: "" }),
      caseRow({ id: "c-later", title: "Later", deadlineValue: isoDay(9), deadline: "Jul 29" }),
      caseRow({ id: "c-soon", title: "Soon", deadlineValue: isoDay(3), deadline: "Jul 23" }),
      caseRow({ id: "c-resolved", title: "Settled", status: "resolved", deadlineValue: isoDay(2) }),
    ]);

    const titles = [...document.querySelectorAll(".mcases-case .mcases-case__title")].map((node) => node.textContent.replace("›", "").trim());
    expect(titles).toEqual(["Soon", "Later", "Undated"]);

    expect(screen.getByRole("heading", { name: "Closed" })).toBeInTheDocument();
    const closed = document.querySelector(".mcases-closed");
    expect(within(closed).getByRole("button", { name: /Settled/ })).toBeInTheDocument();
    expect(within(closed).queryByRole("button", { name: /Soon|Later|Undated/ })).toBeNull();
  });

  it("names a real deadline and says plainly when there is none", () => {
    renderCases([
      caseRow({ id: "c-soon", title: "Soon", deadlineValue: isoDay(3), deadline: "Jul 23" }),
      caseRow({ id: "c-none", title: "Undated", deadlineValue: "", deadline: "Not set" }),
    ]);
    const [soon, undated] = document.querySelectorAll(".mcases-case");
    expect(within(soon).getByText("Due Jul 23")).toBeInTheDocument();
    expect(within(undated).getByText("No deadline yet")).toBeInTheDocument();
    expect(within(undated).queryByText(/Due Not set/)).toBeNull();
  });

  it("shows no grievance step on the issue cards, mobile or desktop", () => {
    const { unmount } = renderCases([caseRow({ id: "c-1", title: "Shift swap", step: "Step 2" })]);
    const card = document.querySelector(".mcases-case");
    expect(card.querySelector(".mcases-case__stepchip").textContent).toBe("Open");
    expect(within(card).queryByText(/Step 2/)).toBeNull();
    unmount();

    renderCases([caseRow({ id: "c-1", title: "Shift swap", step: "Step 2" })], { desktop: true });
    const desk = document.querySelector(".mcases-desk");
    expect(desk.querySelector(".mcases-desk__chip").textContent).toBe("Open");
    expect(within(desk).queryByText(/Step 2/)).toBeNull();
  });
});

describe("member issue forms carry no step or contract articles", () => {
  it("offers no contract-articles field when starting a new issue", () => {
    renderCases([]);
    fireEvent.click(screen.getAllByRole("button", { name: /Start|New/ })[0]);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("[name='title']")).not.toBeNull();
    expect(dialog.querySelector("[name='caseType']")).not.toBeNull();
    expect(dialog.querySelector("[name='deadline']")).not.toBeNull();
    expect(dialog.querySelector("[name='articles']")).toBeNull();
    expect(dialog.querySelector("[name='step']")).toBeNull();
  });

  it("offers no step field and names no articles in the issue detail", () => {
    renderCases([caseRow({ id: "c-1", title: "Shift swap", step: "Step 2", articles: "Art. 12" })]);
    fireEvent.click(screen.getByRole("button", { name: /Shift swap/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("[name='status']")).not.toBeNull();
    expect(dialog.querySelector("[name='deadline']")).not.toBeNull();
    expect(dialog.querySelector("[name='step']")).toBeNull();
    expect(dialog.querySelector(".case-detail-copy").textContent).toBe("Discipline");
    expect(within(dialog).queryByText(/Art\. 12/)).toBeNull();
    expect(within(dialog).queryByText(/Step 2/)).toBeNull();
  });
});
