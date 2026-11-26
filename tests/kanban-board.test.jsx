import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { KanbanBoard, TOUCH_HOLD_MS } from "../src/views/KanbanBoard.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

// This is the board AFTER the t0ggles inversion, and the inversion is the
// whole bug class I am guarding: columns are WORKSTREAMS and status is the
// card's colour, so every question the old board answered with "which column
// am I in" now has two answers (which workstream, which status group). A
// regression here does not crash anything — it quietly puts a card in the
// wrong column, or sorts Done above the work that needs attention, and the
// board still looks like a board. So the pins below are about ORDER and
// PLACEMENT first: caller order for columns, KAN_GROUP_ORDER for the groups
// inside them, and the five status columns of focus mode.
//
// I render KanbanBoard DIRECTLY rather than through TasksView because every
// write it can make is a prop: onCreateInline, onCycleStatus, onDropTask,
// onReorder, onOpenTask, onFocusWorkstream. Driving the component and reading
// the vi.fn() arguments is the only way to state the contract the parent is
// entitled to rely on — TasksView's mapping of those payloads to updateTask
// writes is pinned separately in tasks-board-drag.test.jsx.
//
// No matchMedia stub on purpose. The kanban board scrolls horizontally at
// every width, so it has no wide/compact fork left to fake; the only
// matchMedia call in the file is the reduced-motion check at drag lift, and
// jsdom's default "false" is the right answer for these tests.
//
// jsdom reports every rect as 0x0, so nothing here goes near drag
// hit-testing. The pointer engine's geometry is unit-tested against fixture
// rects through the exported computeDropTarget in tasks-board-drag.test.jsx.

const t = (key, vars) => translate("en", key, vars);

// Caller order, deliberately NOT alphabetical, and with one workstream that
// owns no cards: the column list is the chapter's own vocabulary, and a
// freshly added workstream must still get a column to put its first card in.
const WORKSTREAMS = ["Organizing", "Chapter", "Communications", "Issues", "Safety", "Bargaining", "Political action"];

function renderBoard(overrides = {}) {
  const data = structuredClone(fallbackData);
  const props = {
    tasks: data.tasks,
    workstreamNames: WORKSTREAMS,
    chapterId: "wor",
    t,
    lang: "en",
    doneVisible: true,
    focusWorkstream: null,
    onFocusWorkstream: vi.fn(),
    onOpenTask: vi.fn(),
    onCycleStatus: vi.fn(),
    onDropTask: vi.fn(),
    onCreateInline: vi.fn(async () => ({ id: "task-new" })),
    onReorder: vi.fn(),
    commentCounts: new Map([["task-demo-1", 2]]),
    attachmentCounts: new Map([["task-demo-1", 1]]),
    liveAnnounce: vi.fn(),
    ...overrides,
  };
  const ui = (boardProps) => (
    <LanguageProvider lang="en"><KanbanBoard {...boardProps} /></LanguageProvider>
  );
  const view = render(ui(props));
  return Object.assign(props, {
    rerenderBoard(next = {}) {
      Object.assign(props, next);
      const { rerenderBoard, ...boardProps } = props;
      view.rerender(ui(boardProps));
    },
  });
}

// Every fallback card in ONE column, so the status grouping inside a column
// can be read as a single ordered list.
function oneColumnTasks() {
  return structuredClone(fallbackData).tasks.map((task) => ({ ...task, workstream: "Chapter" }));
}

function columnFor(workstream) {
  return document.querySelector(`.kan-col[data-workstream="${workstream}"]`);
}

function cardFor(title) {
  return screen.getByText(title).closest("article");
}

describe("columns are workstreams", () => {
  it("renders one column per workstream in the caller's order, empty ones included", () => {
    renderBoard();
    const columns = [...document.querySelectorAll(".kan-col")].map((el) => el.dataset.workstream);
    // Not sorted, not filtered: the parent decides the vocabulary and the
    // order, and "Political action" has no cards at all.
    expect(columns).toEqual(WORKSTREAMS);
    expect(within(columnFor("Political action")).queryByRole("article")).toBeNull();
  });

  it("heads each column with a quiet label and focus target, without glyphs or counters", () => {
    const props = renderBoard();
    const head = columnFor("Chapter").querySelector(".kan-ws-head");
    expect(head).toHaveTextContent("Chapter");
    expect(head).not.toHaveTextContent("2 tasks");
    expect(head.querySelector(".kan-ws-head__count")).toBeNull();
    expect(head.querySelector(".kan-ws-icon")).toBeNull();
    expect(within(head).getByRole("heading", { level: 3, name: "Chapter" })).toBeInTheDocument();

    fireEvent.click(within(head).getByRole("button", { name: "Focus on Chapter" }));
    expect(props.onFocusWorkstream).toHaveBeenCalledWith("Chapter");
    expect(props.liveAnnounce).toHaveBeenCalledWith("Focused on Chapter");
  });

  it("omits the workstream menu from every lane header", () => {
    renderBoard();
    expect(document.querySelectorAll(".kan-ws-head__menu")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Workstreams — / })).toBeNull();
  });
});

describe("status groups inside a column", () => {
  it("orders the groups needs-attention-first, not by the canonical status order", () => {
    renderBoard({ tasks: oneColumnTasks(), workstreamNames: ["Chapter"] });
    const cards = [...columnFor("Chapter").querySelectorAll("[data-task-id]")];
    // KAN_GROUP_ORDER: to_do -> in_progress -> needs_review -> backlog -> done. Done
    // sinks last because it is the one group the board can hide entirely.
    expect(cards.map((el) => el.dataset.status)).toEqual([
      "to_do",
      "in_progress", "in_progress",
      "needs_review", "needs_review",
      "backlog",
      "done", "done",
    ]);
    // …and inside each group, order_index ascending (byBoardOrder).
    expect(cards.map((el) => el.dataset.taskId)).toEqual([
      "task-demo-2",
      "task-demo-3", "task-demo-4",
      "task-demo-5", "task-demo-6",
      "task-demo-1",
      "task-demo-7", "task-demo-8",
    ]);
  });

  it("collapses the done group to a counted reveal button, per column", () => {
    renderBoard({ doneVisible: false });
    // Chapter's done card and Bargaining's done card each hide behind their
    // own button — hiding is a per-column decision, not a board-wide one.
    const chapterReveal = within(columnFor("Chapter")).getByRole("button", { name: "1 done hidden" });
    expect(within(columnFor("Bargaining")).getByRole("button", { name: "1 done hidden" })).toBeInTheDocument();
    expect(screen.queryByText("Update committee contact roster")).toBeNull();
    expect(screen.queryByText("Publish bargaining priorities poll")).toBeNull();

    fireEvent.click(chapterReveal);
    expect(screen.getByText("Update committee contact roster")).toBeInTheDocument();
    // The other column stayed collapsed: reveal is scoped to the column that
    // was asked, so a member checking one workstream's finished work does not
    // re-flood the whole board.
    expect(screen.queryByText("Publish bargaining priorities poll")).toBeNull();
  });

  it("keeps done cards in place when the view setting shows them", () => {
    renderBoard({ doneVisible: true });
    expect(screen.queryByRole("button", { name: /done hidden/ })).toBeNull();
    expect(screen.getByText("Update committee contact roster")).toBeInTheDocument();
  });
});

describe("focus mode", () => {
  it("swaps the workstream columns for the five status columns", () => {
    renderBoard({ focusWorkstream: "Communications" });
    const columns = [...document.querySelectorAll(".kan-col--status")];
    // All five render even when empty — each one owns a composer, so an empty
    // status column is where "start this in review" lives.
    expect(columns.map((el) => el.dataset.status)).toEqual(["backlog", "to_do", "in_progress", "needs_review", "done"]);
    expect(columns.every((el) => el.dataset.workstream === "Communications")).toBe(true);
    expect(columns.every((el) => el.querySelector(".kan-ws-head__count") === null)).toBe(true);
    expect(columns.every((el) => !/\d+ tasks/.test(el.querySelector(".kan-ws-head").textContent))).toBe(true);
    expect(within(columns[1]).getByText("Translate bargaining pulse")).toBeInTheDocument();
    expect(within(columns[3]).getByText("Review chapter newsletter")).toBeInTheDocument();
    // Only the focused workstream's cards are on the board.
    expect(screen.queryByText("Prepare August campaign meeting")).toBeNull();
  });

  it("offers every OTHER workstream as a chip and a way back out", () => {
    const props = renderBoard({ focusWorkstream: "Communications" });
    const bar = document.querySelector(".kan-focus-bar");
    expect(bar).toHaveTextContent("Communications");
    expect(within(bar).queryByRole("button", { name: "Focus on Communications" })).toBeNull();
    expect(within(bar).getAllByRole("button", { name: /^Focus on / })).toHaveLength(WORKSTREAMS.length - 1);

    fireEvent.click(within(bar).getByRole("button", { name: "Focus on Issues" }));
    expect(props.onFocusWorkstream).toHaveBeenCalledWith("Issues");
    expect(props.liveAnnounce).toHaveBeenCalledWith("Focused on Issues");

    fireEvent.click(within(bar).getByRole("button", { name: /Exit focus mode/ }));
    expect(props.onFocusWorkstream).toHaveBeenLastCalledWith(null);
  });
});

describe("the inline composers", () => {
  it("sits at the top AND the bottom of every column", () => {
    renderBoard();
    const column = columnFor("Chapter");
    expect(within(column).getAllByRole("button", { name: "New task" })).toHaveLength(2);
  });

  it("creates into the column's workstream at To do, then stays open and clears", async () => {
    const props = renderBoard();
    const column = columnFor("Chapter");
    fireEvent.click(within(column).getAllByRole("button", { name: "New task" })[0]);
    const input = within(column).getByPlaceholderText("Task title…");

    fireEvent.change(input, { target: { value: "  Book the hall  " } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    // Board quick creation uses the Standard Task default.
    await waitFor(() => expect(props.onCreateInline).toHaveBeenCalledWith("Chapter", "to_do", "Book the hall"));

    // Still open, and cleared: the composer is built for typing a list.
    expect(within(column).getByPlaceholderText("Task title…")).toHaveValue("");
  });

  it("gives the bottom composer the same workstream and Standard Task defaults", async () => {
    const props = renderBoard();
    const column = columnFor("Chapter");
    fireEvent.click(within(column).getAllByRole("button", { name: "New task" })[1]);
    const input = within(column).getByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "Bottom-of-column task" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    await waitFor(() => expect(props.onCreateInline).toHaveBeenCalledWith(
      "Chapter",
      "to_do",
      "Bottom-of-column task",
    ));
  });

  it("closes on Escape without creating anything", () => {
    const props = renderBoard();
    const column = columnFor("Chapter");
    fireEvent.click(within(column).getAllByRole("button", { name: "New task" })[0]);
    const input = within(column).getByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "Never mind" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(props.onCreateInline).not.toHaveBeenCalled();
    expect(within(column).getAllByRole("button", { name: "New task" })).toHaveLength(2);
  });

  // Escape during a create in flight keeps the composer
  // and its title, so a failed create can be retried without retyping.
  it("keeps the composer and its title when Escape is pressed while a create runs, then fails", async () => {
    const props = renderBoard();
    let fail;
    props.onCreateInline.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const column = columnFor("Chapter");
    fireEvent.click(within(column).getAllByRole("button", { name: "New task" })[0]);
    const input = within(column).getByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "Book the hall" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(props.onCreateInline).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(within(column).getByPlaceholderText("Task title…")).toHaveValue("Book the hall");
    await act(async () => { fail(new Error("offline")); });
    expect(within(column).getByPlaceholderText("Task title…")).toHaveValue("Book the hall");
    // Once it settles, Escape closes as before.
    fireEvent.keyDown(within(column).getByPlaceholderText("Task title…"), { key: "Escape" });
    expect(within(column).queryByPlaceholderText("Task title…")).not.toBeInTheDocument();
  });

  it("refuses an empty title", async () => {
    const props = renderBoard();
    const column = columnFor("Chapter");
    fireEvent.click(within(column).getAllByRole("button", { name: "New task" })[0]);
    const input = within(column).getByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "   " } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(props.onCreateInline).not.toHaveBeenCalled();
  });

  it("names its column's status in focus mode, and creates with it", async () => {
    const props = renderBoard({ focusWorkstream: "Communications" });
    const column = document.querySelector('.kan-col--status[data-status="needs_review"]');
    expect(within(column).getAllByRole("button", { name: "New Review task" })).toHaveLength(2);

    fireEvent.click(within(column).getAllByRole("button", { name: "New Review task" })[0]);
    const input = within(column).getByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "Second read of the newsletter" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    // Focus-mode columns ARE statuses, so the composer inherits the column's.
    await waitFor(() => expect(props.onCreateInline).toHaveBeenCalledWith(
      "Communications",
      "needs_review",
      "Second read of the newsletter",
    ));
  });
});

describe("card anatomy", () => {
  it("labels the quick-action circle by what the click will DO, not by the target", () => {
    const props = renderBoard();
    // backlog -> to do, needs_review -> complete, done -> reopen.
    fireEvent.click(within(cardFor("Prepare August campaign meeting")).getByRole("button", { name: "Advance to To do" }));
    expect(props.onCycleStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-1" }));

    expect(within(cardFor("Coworker outreach calls")).getByRole("button", { name: "Advance to Review" })).toBeInTheDocument();
    fireEvent.click(within(cardFor("Review chapter newsletter")).getByRole("button", { name: "Mark complete" }));
    expect(props.onCycleStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: "task-demo-5" }));
    fireEvent.click(within(cardFor("Update committee contact roster")).getByRole("button", { name: "Reopen" }));
    expect(props.onCycleStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: "task-demo-8" }));
  });

  it("keeps card previews keyless and opens the modal from the title", () => {
    const props = renderBoard();
    const card = cardFor("Prepare August campaign meeting");
    expect(within(card).queryByText("WOR-1")).toBeNull();
    expect(card).toHaveAttribute("aria-label", "Prepare August campaign meeting");

    fireEvent.click(within(card).getByRole("button", { name: "Prepare August campaign meeting" }));
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-1" }));
  });

  it("omits the key line entirely when the card has no number yet", () => {
    const tasks = structuredClone(fallbackData).tasks.map((task) => ({ ...task, taskNumber: null }));
    renderBoard({ tasks });
    // "WOR-undefined" on a real card would ship a broken deep link.
    expect(document.querySelector(".kan-card__key")).toBeNull();
    expect(cardFor("Prepare August campaign meeting")).toHaveAttribute("aria-label", "Prepare August campaign meeting");
  });

  it("keeps milestone and progress metadata off the quiet card preview", () => {
    renderBoard();
    const card = cardFor("Prepare August campaign meeting");
    expect(card.querySelector(".kan-mile")).toBeNull();
    expect(card.querySelector(".kan-card__who")).toHaveTextContent("Darnell");
    expect(card.querySelector(".kan-card__due")).toHaveTextContent("Aug 31");
  });

  it("gives an ordinary card the assignee first name and the due flag", () => {
    renderBoard();
    const card = cardFor("Coworker outreach calls");
    expect(card.querySelector(".kan-mile")).toBeNull();
    expect(card.querySelector(".kan-card__who")).toHaveTextContent("Priya");
    expect(card.querySelector(".kan-av")).toHaveTextContent("PS");
    expect(card.querySelector(".kan-card__due")).toHaveTextContent("Aug 28");
  });

  it("counts a description checklist on the card face", () => {
    renderBoard();
    // task-demo-3's description carries two boxes with one ticked.
    const badge = cardFor("Coworker outreach calls").querySelector(".kan-check");
    expect(badge).toHaveTextContent("1/2");
    expect(badge).toHaveAccessibleName("1 of 2 done");
    expect(badge).toHaveAttribute("role", "img");
    // A plain description stays off the card preview.
    expect(cardFor("Translate bargaining pulse").querySelector(".kan-check")).toBeNull();
    expect(cardFor("Translate bargaining pulse").querySelector(".kan-card__desc")).toBeNull();
  });

  it("shows type plus comment and authorized-record counts, but no priority or dependency metadata", () => {
    renderBoard();
    const card = cardFor("Prepare August campaign meeting");
    expect(card.querySelector(".kan-type")).toHaveTextContent("General");
    expect(card.querySelector('[aria-label="Comments: 2"]')).toHaveAttribute("role", "img");
    expect(card.querySelector('[aria-label="Authorized records: 1"]')).toHaveAttribute("role", "img");
    expect(card.querySelector(".kan-pri")).toBeNull();
    expect(card.querySelector(".kan-card__deps")).toBeNull();
  });
});

// A11Y-UG-KANBAN-CARD-DESCRIPTION-OMITS-STATUS-ASSIGNEE-DUE-DATE-20260920.
// The default workstream columns render no status headings, so the card's
// own focus stop has to carry what the card face shows.
describe("card focus stop description", () => {
  function cardTasks() {
    return structuredClone(fallbackData).tasks.map((task) => {
      if (task.id === "task-demo-2") return { ...task, assigneeId: null, assigneeName: null, assigneeNames: [] };
      // A far-future date keeps this card out of the overdue state on any run date.
      if (task.id === "task-demo-3") return { ...task, dueDate: "2099-08-28", assigneeNames: ["Priya Shah", "Maria Santos"] };
      return task;
    });
  }

  it("exposes status, assignee and due date on an ordinary card while keeping the title as its name", () => {
    renderBoard({ tasks: cardTasks() });
    const card = screen.getByRole("article", { name: "Coworker outreach calls" });
    expect(card).toHaveAccessibleDescription("Status: In progress. Assigned to Priya Shah, Maria Santos. Due Aug 28");
    expect(card).toHaveAccessibleName("Coworker outreach calls");
  });

  it("names the unassigned and no-due-date states", () => {
    renderBoard({ tasks: cardTasks() });
    expect(screen.getByRole("article", { name: "Translate bargaining pulse" }))
      .toHaveAccessibleDescription("Status: To do. Unassigned. No due date");
  });

  it("adds overdue and blocked at the same focus stop", () => {
    renderBoard({ tasks: cardTasks() });
    expect(screen.getByRole("article", { name: "Clear issue intake backlog" }))
      .toHaveAccessibleDescription("Status: In progress. Assigned to Jordan Lee. Due Jul 25. Overdue. This task is blocked");
    // A done card past its date is not overdue.
    expect(screen.getByRole("article", { name: "Update committee contact roster" }).getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("article", { name: "Update committee contact roster" })).not.toHaveAccessibleDescription(/Overdue/);
  });

  it("reads in Spanish from the same keys", () => {
    renderBoard({ tasks: cardTasks(), t: (key, vars) => translate("es", key, vars), lang: "es" });
    expect(screen.getByRole("article", { name: "Translate bargaining pulse" }))
      .toHaveAccessibleDescription("Estado: Por hacer. Sin asignar. Sin fecha de vencimiento");
    expect(screen.getByRole("article", { name: "Clear issue intake backlog" }))
      .toHaveAccessibleDescription(/^Estado: En progreso\. Asignada a Jordan Lee\. Vence el .+\. Vencida\. Esta tarea está bloqueada$/);
  });

  it("keeps the status and title controls independently focusable with their actions", () => {
    const props = renderBoard({ tasks: cardTasks() });
    const card = screen.getByRole("article", { name: "Coworker outreach calls" });
    const circle = within(card).getByRole("button", { name: "Advance to Review" });
    const title = within(card).getByRole("button", { name: "Coworker outreach calls" });
    circle.focus();
    expect(document.activeElement).toBe(circle);
    fireEvent.click(circle);
    expect(props.onCycleStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-3" }));
    title.focus();
    expect(document.activeElement).toBe(title);
    fireEvent.click(title);
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-3" }));
  });
});

describe("the card keyboard map", () => {
  it("opens the task on Enter and on e", () => {
    const props = renderBoard();
    const card = cardFor("Prepare August campaign meeting");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "e" });
    expect(props.onOpenTask).toHaveBeenCalledTimes(2);
    expect(props.onOpenTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: "task-demo-1" }));
  });

  it("sends x through the SAME drop handler the pointer uses", () => {
    const props = renderBoard();
    fireEvent.keyDown(cardFor("Prepare August campaign meeting"), { key: "x" });
    // beforeId null = append to the end of the target group, exactly like a
    // drop past the last card. One path, one payload shape.
    expect(props.onDropTask).toHaveBeenCalledWith("task-demo-1", { status: "done", beforeId: null });
    expect(props.liveAnnounce).toHaveBeenCalledWith("Moved to Done");
  });

  it("walks [ and ] along the canonical status order and clamps at both ends", () => {
    const props = renderBoard();
    fireEvent.keyDown(cardFor("Prepare August campaign meeting"), { key: "]" });
    expect(props.onDropTask).toHaveBeenCalledWith("task-demo-1", { status: "to_do", beforeId: null });

    props.onDropTask.mockClear();
    // Already at the first status: [ clamps to backlog, and a move to the
    // status it already has must not write.
    fireEvent.keyDown(cardFor("Prepare August campaign meeting"), { key: "[" });
    // …and the last status clamps the same way.
    fireEvent.keyDown(cardFor("Update committee contact roster"), { key: "]" });
    expect(props.onDropTask).not.toHaveBeenCalled();

    fireEvent.keyDown(cardFor("Update committee contact roster"), { key: "[" });
    expect(props.onDropTask).toHaveBeenCalledWith("task-demo-8", { status: "needs_review", beforeId: null });
  });

  it("reorders within the group on Alt+Arrow", () => {
    const props = renderBoard();
    const card = cardFor("Prepare August campaign meeting");
    fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    expect(props.onReorder.mock.calls).toEqual([
      ["task-demo-1", "up"],
      ["task-demo-1", "down"],
    ]);
    // Reorder never travels through the drop handler's status keys.
    expect(props.onDropTask).not.toHaveBeenCalled();
  });

  it("announces a keyboard reorder as a reorder — never as a move into the column it never left", () => {
    // A same-column reorder keeps the card's workstream AND its status. The
    // transfer sentence ("Moved to Chapter") told a screen-reader member the
    // card had travelled somewhere, which is the one thing that did not happen.
    const props = renderBoard({ onReorder: vi.fn(() => "moved") });
    fireEvent.keyDown(cardFor("Prepare August campaign meeting"), { key: "ArrowUp", altKey: true });
    expect(props.liveAnnounce).toHaveBeenLastCalledWith("Reordered in Chapter");
    expect(props.liveAnnounce).not.toHaveBeenCalledWith(t("kanban.moved", { name: "Chapter" }));
  });

  it.each([["ArrowUp", "atStart"], ["ArrowDown", "atEnd"]])(
    "stays silent when %s is refused at the %s of the group",
    (key, outcome) => {
      const props = renderBoard({ onReorder: vi.fn(() => outcome) });
      fireEvent.keyDown(cardFor("Prepare August campaign meeting"), { key, altKey: true });
      expect(props.onReorder).toHaveBeenCalled();
      expect(props.liveAnnounce).not.toHaveBeenCalled();
    },
  );

  it("says nothing at all when the parent has no such card to move", () => {
    const props = renderBoard({ onReorder: vi.fn(() => null) });
    fireEvent.keyDown(cardFor("Prepare August campaign meeting"), { key: "ArrowDown", altKey: true });
    expect(props.liveAnnounce).not.toHaveBeenCalled();
  });

  it("ignores the same letters under a modifier — those belong to the browser", () => {
    const props = renderBoard();
    const card = cardFor("Prepare August campaign meeting");
    fireEvent.keyDown(card, { key: "x", ctrlKey: true });
    fireEvent.keyDown(card, { key: "e", metaKey: true });
    fireEvent.keyDown(card, { key: "ArrowUp" });
    expect(props.onDropTask).not.toHaveBeenCalled();
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onReorder).not.toHaveBeenCalled();
  });

  it("leaves the card's own buttons alone: a keypress on the circle is not a card key", () => {
    const props = renderBoard();
    const card = cardFor("Prepare August campaign meeting");
    // The handler bails unless the event lands on the article itself — the
    // circle and the title button own Enter/Space, and double-firing them
    // would both advance the status AND open the modal.
    fireEvent.keyDown(within(card).getByRole("button", { name: "Advance to To do" }), { key: "Enter" });
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });
});

// Still no hit-testing here (jsdom rects are 0x0) — these pins are about who
// OWNS a drag session, not where the card lands. The clone's transform is the
// one geometry-free tell: it is written imperatively from session.last, so a
// pointer the session must ignore is visible as a transform that did not move.
describe("the pointer session belongs to ONE pointer", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.classList.remove("kan-dragging");
  });

  // Same helper shape as tasks-board-drag.test.jsx: pointerId 1 is the
  // session's pointer unless a test says otherwise.
  function down(target, init = {}) {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 100, ...init });
  }

  function move(x, y, init = {}) {
    fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y, ...init });
  }

  it("ignores moves, drops and cancels from a pointer that is not the session's", () => {
    const props = renderBoard();
    down(cardFor("Prepare August campaign meeting"));
    move(140, 100);
    expect(document.body.classList.contains("kan-dragging")).toBe(true);
    const clone = document.querySelector(".kan-dragclone");
    // jsdom rects sit at 0,0, so dx/dy both equal the 100,100 start point and
    // the clone rides at (last - start); CSSOM omits the zero Y component.
    expect(clone.style.transform).toBe("translate(40px)");

    // A second finger moves: the clone must not follow it…
    move(300, 300, { pointerId: 2 });
    expect(clone.style.transform).toBe("translate(40px)");
    // …its lift must not drop the first finger's card…
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(props.onDropTask).not.toHaveBeenCalled();
    expect(document.body.classList.contains("kan-dragging")).toBe(true);
    // …and a foreign pointercancel must not abort the drag either.
    fireEvent.pointerCancel(window, { pointerId: 2 });
    expect(document.body.classList.contains("kan-dragging")).toBe(true);

    // The original pointer still owns the session and completes it normally.
    move(160, 120);
    expect(clone.style.transform).toBe("translate(60px, 20px)");
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(props.onDropTask).toHaveBeenCalledTimes(1);
    expect(props.onDropTask.mock.calls[0][0]).toBe("task-demo-1");
    expect(document.body.classList.contains("kan-dragging")).toBe(false);
  });

  it("Escape during the touch hold window cancels the lift before it happens", () => {
    vi.useFakeTimers();
    const props = renderBoard();
    down(cardFor("Prepare August campaign meeting"), { pointerType: "touch" });
    fireEvent.keyDown(window, { key: "Escape" });

    // The hold timer died with the session: waiting out the full hold must
    // not lift the card the member already said no to.
    act(() => { vi.advanceTimersByTime(TOUCH_HOLD_MS + 50); });
    expect(document.body.classList.contains("kan-dragging")).toBe(false);
    expect(document.querySelector(".kan-dragclone")).toBeNull();

    // …and the finger coming up afterwards is not a late drop.
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(props.onDropTask).not.toHaveBeenCalled();
  });
});

describe("focus bar name and hidden-done keyboard restore", () => {
  it("exposes the focused-workstream label as the accessible name of a group", () => {
    renderBoard({ focusWorkstream: "Communications" });
    expect(screen.getByRole("group", {
      name: t("kanban.focusedOn", { name: "Communications" }),
    })).toHaveClass("kan-focus-bar");
  });

  it("moves focus to the first revealed done card in a workstream column", () => {
    renderBoard({ doneVisible: false });
    const column = columnFor("Chapter");
    const trigger = within(column).getByRole("button", { name: t("kanban.hiddenDone", { count: 1 }) });
    fireEvent.click(trigger);

    const revealed = screen.getByRole("article", { name: "Update committee contact roster" });
    expect(revealed).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(column).toContainElement(revealed);
    expect(revealed).toHaveAttribute("data-status", "done");
    // The column already had other cards; restore must land on the revealed
    // done group, not the first card in the lane.
    expect(document.activeElement).not.toBe(within(column).getByRole("article", {
      name: "Prepare August campaign meeting",
    }));
  });

  it("moves focus to the first revealed card in a focused-status column", () => {
    renderBoard({ focusWorkstream: "Chapter", doneVisible: false });
    const column = document.querySelector('.kan-col--status[data-status="done"]');
    const trigger = within(column).getByRole("button", { name: t("kanban.hiddenDone", { count: 1 }) });
    fireEvent.click(trigger);

    const revealed = within(column).getByRole("article", { name: "Update committee contact roster" });
    expect(revealed).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(column).toContainElement(document.activeElement);
  });

  it("does not move focus or crash when the done group that would be revealed is empty", () => {
    const tasks = structuredClone(fallbackData).tasks.filter((task) => task.status !== "done");
    renderBoard({ tasks, workstreamNames: WORKSTREAMS, doneVisible: false });
    expect(screen.queryByRole("button", { name: /done hidden/ })).toBeNull();

    const composer = within(columnFor("Chapter")).getAllByRole("button", { name: "New task" })[0];
    composer.focus();
    expect(document.activeElement).toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("does not steal focus when the view setting shows done cards", () => {
    const props = renderBoard({ doneVisible: false });
    const composer = within(columnFor("Chapter")).getAllByRole("button", { name: "New task" })[0];
    composer.focus();
    expect(screen.queryByRole("article", { name: "Update committee contact roster" })).toBeNull();

    props.rerenderBoard({ doneVisible: true });
    expect(screen.getByRole("article", { name: "Update committee contact roster" })).toBeInTheDocument();
    expect(document.activeElement).toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("board inline creation keeps the title field focused while it saves (#8435)", () => {
  it("keeps the new-task field focused through the save, and creates the task once", async () => {
    const props = renderBoard();
    const column = columnFor("Chapter");
    fireEvent.click(within(column).getAllByRole("button", { name: "New task" })[0]);
    const input = within(column).getByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "Book the hall" } });
    await expectHeldWriteFocus(props.onCreateInline, input, () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(props.onCreateInline).toHaveBeenCalledTimes(1);
  });
});
