import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { DRAG_LIFT_PX, TOUCH_HOLD_MS, KanbanBoard } from "../src/views/KanbanBoard.jsx";
import { TasksView } from "../src/views/TasksView.jsx";

// The PHONE contract (no matchMedia stub on purpose — jsdom answers false to
// every media query, which is exactly a narrow viewport). The old board
// swapped to a one-status segmented strip below 1024px because HTML5 drag
// never fires on touch; the kanban board retired that fork entirely. One
// board now scrolls horizontally at EVERY width, drags ride pointer events
// with a touch hold, and the only width-gated thing left is top-bar density:
// view pills drop their text and keep icon + aria-label. This suite pins the
// retirement — if the segmented strip, an HTML5 `draggable` attribute, or a
// pill text label reappears at phone width, the touch experience has silently
// regressed to the fork this rewrite deleted.

function renderTasks(overrides = {}) {
  const props = {
    data: structuredClone(fallbackData),
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "new-task" })),
    onUpdateTask: vi.fn(async (_id, fields) => fields),
    onDeleteTask: vi.fn(async () => ({ deleted: true })),
    onSendTaskMessage: vi.fn(async () => null),
    ...overrides,
  };
  render(<LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>);
  return props;
}

describe("phone board (no matchMedia stub)", () => {
  it("renders the full workstream board — the compact one-status strip is gone", () => {
    renderTasks();
    // The retired fork's segmented control must not exist at any width.
    expect(document.querySelector(".task-status-tabs")).toBeNull();
    expect(document.querySelector(".task-column")).toBeNull();
    // Columns are the chapter's workstreams, alphabetical, ALL of them — even
    // ones whose cards the default "mine" scope filters out (Issues holds
    // only other members' work here, but its column and composer must stay).
    const columns = [...document.querySelectorAll(".kan-col")];
    expect(columns.map((col) => col.dataset.workstream)).toEqual([
      "Bargaining", "Chapter", "Communications", "Issues", "Organizing", "Safety",
    ]);
    // Two statuses visible AT ONCE — the strip could only ever show one.
    expect(screen.getByText("Prepare August campaign meeting")).toBeInTheDocument();
    expect(screen.getByText("Coworker outreach calls")).toBeInTheDocument();
  });

  it("carries no HTML5 draggable attribute anywhere — touch drag is pointer-based now", () => {
    renderTasks();
    // draggable=true never fires on touch; the pointer engine replaced it and
    // a single surviving attribute means the old engine leaked back in.
    expect(document.querySelectorAll("[draggable]")).toHaveLength(0);
    expect(screen.queryByText("Drop a task here")).not.toBeInTheDocument();
  });

  it("renders the view pills icon-only below 1024 — aria-label carries the name", () => {
    renderTasks();
    const pills = within(document.querySelector(".kan-views"));
    for (const name of ["Board", "Calendar", "Timeline", "Progress", "Report"]) {
      const pill = pills.getByRole("button", { name });
      // Icon only: no text span, so the accessible name must live on the
      // aria-label (getByRole above already proves it resolves).
      expect(pill.querySelector("span")).toBeNull();
      expect(pill.textContent).toBe("");
    }
    expect(pills.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
  });

  it("pins the touch drag thresholds the pointer engine promises", () => {
    // 6px keeps a plain tap from lifting; the 250ms hold keeps a column
    // scroll a scroll. These are the board's exported touch contract — a
    // change here changes what every phone member's finger does.
    expect(DRAG_LIFT_PX).toBe(6);
    expect(TOUCH_HOLD_MS).toBe(250);
    expect(typeof KanbanBoard).toBe("function");
  });

  it("gives every card the quick-action circle — the non-drag status path on touch", async () => {
    const props = renderTasks();
    const cards = [...document.querySelectorAll(".kan-card")];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.querySelector(".kan-card__circle")).not.toBeNull();
    }
    // One tap walks the five-stage cycle: a backlog card advances to To do, as a
    // status-only write — no drag session required.
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    fireEvent.click(within(card).getByRole("button", { name: "Advance to To do" }));
    await waitFor(() => expect(props.onUpdateTask).toHaveBeenCalledWith("task-demo-1", { status: "to_do" }));
  });

  it("opens an inline composer input from the ghost row in every column", () => {
    renderTasks();
    // A ghost row tops every column, phone included; a second sits under the
    // cards, so an empty column shows one (#9514).
    const columns = [...document.querySelectorAll(".kan-col")];
    expect(columns).toHaveLength(6);
    for (const column of columns) {
      const expected = column.querySelector("[data-task-id]") ? 2 : 1;
      expect(column.querySelectorAll("button.kan-newtask"), column.dataset.workstream).toHaveLength(expected);
    }
    const ghosts = [...document.querySelectorAll("button.kan-newtask")];
    fireEvent.click(ghosts[0]);
    // The open composer is the 16px-input surface the zoom-floor CSS targets;
    // class presence is the contract jsdom can check.
    const open = document.querySelector(".kan-newtask--open");
    expect(open).not.toBeNull();
    const input = within(open).getByPlaceholderText("Task title…");
    expect(input).toHaveFocus();
  });
});
