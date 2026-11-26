import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { DRAG_LIFT_PX, computeDropTarget } from "../src/views/KanbanBoard.jsx";
import { TasksView, orderBetween } from "../src/views/TasksView.jsx";

// The DROP CONTRACT, end to end, in the three places it can break.
//
// This file used to pin the HTML5-drag board (draggable articles, a task id
// riding on dataTransfer, one column per status). All of that is retired: the
// board is pointer-driven now, columns are WORKSTREAMS, and a drop can change
// the workstream, the status, the order, or any combination — while still
// costing exactly ONE write. The bug class I care about is a drop that writes
// twice, writes the wrong partition, or silently writes nothing.
//
// Three layers, deliberately separated:
//
// 1. computeDropTarget, against FIXTURE RECTS. jsdom reports every rect as
//    0x0, so a hit-test driven through the DOM would be asserting that zero
//    equals zero. The board exports the pure function precisely so the
//    geometry can be stated in numbers here: column snap, the slack boundary,
//    group adoption, and the beforeId/index math.
// 2. The drag SESSION, through the real board in jsdom — but only the parts
//    that carry no geometry: what lifts, what never lifts, and what aborts.
//    Nothing in that describe block asserts WHERE a card lands.
// 3. TasksView's mapping from a drop payload to updateTask. The board's
//    onDropTask prop is not reachable from outside the component, so the
//    board is stubbed for these tests and the captured prop is called with an
//    exact payload. That is the honest seam: the mapping is what is under
//    test, and feeding it a hand-written payload is the only way to state the
//    cross-column case at all (no keyboard path changes a workstream).

const t = (key, vars) => translate("en", key, vars);

// The stub records the props TasksView hands the board. `...actual` keeps
// every other export (computeDropTarget, DRAG_LIFT_PX) real — only the
// component is replaced.
const boardSpy = vi.hoisted(() => ({ props: null }));
vi.mock("../src/views/KanbanBoard.jsx", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    KanbanBoard: (props) => {
      boardSpy.props = props;
      return null;
    },
  };
});
const { KanbanBoard } = await vi.importActual("../src/views/KanbanBoard.jsx");

// The WIDE (>=1024px) render: TasksView reads the 1024 threshold for top-bar
// density, and the stub answers true for every query. That also makes the
// reduced-motion check true, which the clone assertions below account for.
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  boardSpy.props = null;
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  document.body.classList.remove("kan-dragging");
});

// ---------------------------------------------------------------- fixtures

function rect(left, top, right, bottom) {
  return { left, top, right, bottom };
}

function card(id, top, bottom) {
  return { id, rect: rect(16, top, 272, bottom) };
}

function group(status, cards) {
  return {
    status,
    cards,
    rect: rect(16, cards[0].rect.top, 272, cards[cards.length - 1].rect.bottom),
  };
}

function column({ key, workstream = null, status = null, left, right, groups = [] }) {
  return { key, workstream, status, rect: rect(left, 80, right, 900), listRect: rect(left, 120, right, 900), groups };
}

// Board mode: two workstream columns with a 16px gutter between them
// (0…272 and 288…560). Chapter holds an in_progress group of two and a
// backlog group of one; Communications is empty.
function boardRects() {
  return {
    draggedId: "dragged",
    columns: [
      column({
        key: "Chapter",
        workstream: "Chapter",
        left: 0,
        right: 272,
        groups: [
          group("in_progress", [card("c1", 200, 300), card("c2", 316, 416)]),
          group("backlog", [card("c3", 432, 532)]),
        ],
      }),
      column({ key: "Communications", workstream: "Communications", left: 288, right: 560 }),
    ],
  };
}

// Focus mode: the columns ARE statuses, and they all belong to one workstream.
function focusRects() {
  return {
    draggedId: "dragged",
    columns: [
      column({
        key: "status:backlog",
        workstream: "Organizing",
        status: "backlog",
        left: 0,
        right: 272,
        groups: [group("backlog", [card("f1", 200, 300)])],
      }),
      column({ key: "status:done", workstream: "Organizing", status: "done", left: 288, right: 560 }),
    ],
  };
}

describe("computeDropTarget", () => {
  it("puts the card in the column it is over, above the card it is above", () => {
    const rects = boardRects();
    // c1 spans 200…300, so its midpoint is 250: above it the card goes first.
    expect(computeDropTarget(rects, { x: 100, y: 240 })).toEqual({
      colKey: "Chapter",
      workstream: "Chapter",
      status: "in_progress",
      index: 0,
      beforeId: "c1",
    });
    // Past c1's midpoint but not c2's (366): second place, before c2.
    expect(computeDropTarget(rects, { x: 100, y: 260 })).toMatchObject({ index: 1, beforeId: "c2" });
    // Past both midpoints: end of the group, beforeId null.
    expect(computeDropTarget(rects, { x: 100, y: 400 })).toMatchObject({ index: 2, beforeId: null });
  });

  it("adopts the STATUS of the group it is dropped into — this is how a board-mode drag changes status", () => {
    const rects = boardRects();
    // y=500 is past the in_progress group's bottom (416) and inside backlog's
    // (432…532). An in_progress card dropped here becomes a backlog card,
    // without the member touching a status control.
    expect(computeDropTarget(rects, { x: 100, y: 500 })).toMatchObject({
      workstream: "Chapter",
      status: "backlog",
      index: 1,
      beforeId: null,
    });
    // Below every group: the last group, not "no group".
    expect(computeDropTarget(rects, { x: 100, y: 880 })).toMatchObject({ status: "backlog", beforeId: null });
  });

  it("returns a NULL status for an empty board column — keep the card's own", () => {
    // There is no group region to adopt from, so the parent reads "workstream
    // changes, status does not". A guessed status here would silently reopen
    // finished work every time someone tidied a card into a new column.
    expect(computeDropTarget(boardRects(), { x: 400, y: 300 })).toEqual({
      colKey: "Communications",
      workstream: "Communications",
      status: null,
      index: 0,
      beforeId: null,
    });
  });

  it("reads an empty FOCUS column as its own status — there the column IS the status", () => {
    const rects = focusRects();
    expect(computeDropTarget(rects, { x: 400, y: 300 })).toMatchObject({
      colKey: "status:done",
      workstream: "Organizing",
      status: "done",
      beforeId: null,
    });
    // A populated focus column answers with the group's status, which is the
    // same answer by a different route.
    expect(computeDropTarget(rects, { x: 100, y: 240 })).toMatchObject({
      workstream: "Organizing",
      status: "backlog",
      beforeId: "f1",
    });
  });

  it("snaps a gutter drop to the NEAREST column, not to the one it started in", () => {
    const rects = boardRects();
    // The gutter runs 272…288. Six pixels from the right edge of Chapter:
    expect(computeDropTarget(rects, { x: 278, y: 240 })).toMatchObject({ colKey: "Chapter" });
    // Six pixels from the left edge of Communications:
    expect(computeDropTarget(rects, { x: 282, y: 240 })).toMatchObject({ colKey: "Communications" });
  });

  it("forgives half a column of overshoot and refuses more", () => {
    const rects = boardRects();
    // 160px outside the leftmost column still lands in it…
    expect(computeDropTarget(rects, { x: -160, y: 240 })).toMatchObject({ colKey: "Chapter" });
    // …one pixel further is an abort, not a guess. A drop out on the page
    // chrome must cancel rather than fire a write at the closest column.
    expect(computeDropTarget(rects, { x: -161, y: 240 })).toBeNull();
    expect(computeDropTarget(rects, { x: 721, y: 240 })).toBeNull();
  });

  it("answers null rather than throwing when there is nothing to hit", () => {
    expect(computeDropTarget(null, { x: 10, y: 10 })).toBeNull();
    expect(computeDropTarget({ columns: [] }, { x: 10, y: 10 })).toBeNull();
    expect(computeDropTarget(boardRects(), null)).toBeNull();
  });
});

// ------------------------------------------------- the drag session, no geometry

function renderRealBoard(overrides = {}) {
  const props = {
    tasks: structuredClone(fallbackData).tasks,
    workstreamNames: ["Chapter", "Communications", "Organizing", "Grievances", "Safety", "Bargaining"],
    chapterId: "wor",
    t,
    lang: "en",
    doneVisible: true,
    focusWorkstream: null,
    onFocusWorkstream: vi.fn(),
    onOpenTask: vi.fn(),
    onCycleStatus: vi.fn(),
    onDropTask: vi.fn(),
    onCreateInline: vi.fn(async () => null),
    onReorder: vi.fn(),
    liveAnnounce: vi.fn(),
    ...overrides,
  };
  const view = render(<LanguageProvider lang="en"><KanbanBoard {...props} /></LanguageProvider>);
  return { props, view };
}

function down(target, x = 100, y = 100, init = {}) {
  fireEvent.pointerDown(target, { button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, ...init });
}

function move(x, y = 100) {
  fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y });
}

describe("the drag session", () => {
  it("opens the whole card for a click without writing a drop", () => {
    const { props } = renderRealBoard();
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    down(card);
    // Exactly the threshold is still a click: DRAG_LIFT_PX is a floor to
    // exceed, or a member with an unsteady hand drags every card they tap.
    move(100 + DRAG_LIFT_PX);
    expect(document.body.classList.contains("kan-dragging")).toBe(false);
    expect(document.querySelector(".kan-dragclone")).toBeNull();

    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(props.onDropTask).not.toHaveBeenCalled();
    expect(props.onOpenTask).toHaveBeenCalledTimes(1);
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-1" }));
  });

  it("lifts past the threshold: clone, ghost, and a body class that kills text selection", () => {
    renderRealBoard();
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    down(card);
    move(100 + DRAG_LIFT_PX + 1);

    expect(document.body.classList.contains("kan-dragging")).toBe(true);
    const clone = document.querySelector(".kan-dragclone");
    expect(clone).not.toBeNull();
    // matchMedia answers true for everything here, including the
    // reduced-motion query, so the clone must skip its scale-up modifier.
    expect(clone.className).not.toContain("kan-dragclone--lift");
    // The origin keeps its space as a ghost, and the clone is NOT a second
    // drop anchor: it carries no data-task-id and is aria-hidden.
    expect(document.querySelectorAll(".kan-card--ghost")).toHaveLength(1);
    expect(clone.getAttribute("aria-hidden")).toBe("true");
    expect(clone.querySelector("[data-task-id]")).toBeNull();
  });

  it("aborts on Escape with no write and says so", () => {
    const { props } = renderRealBoard();
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    down(card);
    move(140);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(props.onDropTask).not.toHaveBeenCalled();
    expect(props.liveAnnounce).toHaveBeenLastCalledWith("Move cancelled");
    expect(document.body.classList.contains("kan-dragging")).toBe(false);
    expect(document.querySelector(".kan-dragclone")).toBeNull();

    // The abort consumed the drag; a later pointerup is not a late drop.
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(props.onDropTask).not.toHaveBeenCalled();
  });

  it("aborts on pointercancel — the gesture the OS takes back", () => {
    const { props } = renderRealBoard();
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    down(card);
    move(140);
    fireEvent.pointerCancel(window, { pointerId: 1 });

    expect(props.onDropTask).not.toHaveBeenCalled();
    expect(props.liveAnnounce).toHaveBeenLastCalledWith("Move cancelled");
    expect(document.body.classList.contains("kan-dragging")).toBe(false);
  });

  it("never starts a session from a control on the card", () => {
    const { props } = renderRealBoard();
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    const circle = card.querySelector(".kan-card__circle");
    down(circle);
    move(200);

    // The quick-action circle, the title button and any input keep their own
    // gestures: pressing one and twitching must not turn into a card move.
    expect(document.body.classList.contains("kan-dragging")).toBe(false);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(props.onDropTask).not.toHaveBeenCalled();
  });

  it("emits exactly ONE payload on drop", () => {
    const { props } = renderRealBoard();
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    down(card);
    move(140);
    fireEvent.pointerUp(window, { pointerId: 1 });

    // WHERE it lands is the hit-test's business (fixture-rect tests above);
    // what this pins is that one gesture produces one call, for the card the
    // gesture started on, carrying a beforeId.
    expect(props.onDropTask).toHaveBeenCalledTimes(1);
    expect(props.onDropTask.mock.calls[0][0]).toBe("task-demo-1");
    expect(props.onDropTask.mock.calls[0][1]).toHaveProperty("beforeId");
    expect(document.body.classList.contains("kan-dragging")).toBe(false);
  });

  it("announces a drop that changed neither workstream nor status as a reorder", () => {
    // ONE column holding ONE backlog card: whatever jsdom's 0x0 rects resolve
    // to, the only group on the board is the card's own, so the drop payload
    // carries an order change and nothing else. That is the same-column
    // reorder, and it used to be announced with the transfer sentence.
    const { props } = renderRealBoard({
      tasks: structuredClone(fallbackData).tasks.filter((task) => task.workstream === "Chapter" && task.status === "backlog"),
      workstreamNames: ["Chapter"],
    });
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    down(card);
    move(140);
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(props.onDropTask).toHaveBeenCalledWith("task-demo-1", { beforeId: null });
    expect(props.liveAnnounce).toHaveBeenLastCalledWith("Reordered in Chapter");
    expect(props.liveAnnounce).not.toHaveBeenCalledWith(t("kanban.moved", { name: "Chapter" }));
  });

  it("cleans up after itself when the board unmounts mid-drag", () => {
    const { view } = renderRealBoard();
    const card = screen.getByText("Prepare August campaign meeting").closest("article");
    down(card);
    move(140);
    expect(document.body.classList.contains("kan-dragging")).toBe(true);

    // Switching views mid-drag must not leave the document unselectable and
    // window listeners running against a dead component.
    view.unmount();
    expect(document.body.classList.contains("kan-dragging")).toBe(false);
  });
});

// ------------------------------------------- one drop, one write (TasksView)

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

// The payload the board would have handed over, handed over directly.
async function drop(taskId, target) {
  await act(async () => {
    await boardSpy.props.onDropTask(taskId, target);
  });
}

// task-demo-1 (backlog, 10) and task-demo-2 (backlog, 20) sharing one column
// is the only same-group pair the fixture can offer.
function twoInChapterBacklog() {
  const data = structuredClone(fallbackData);
  data.tasks.find((task) => task.id === "task-demo-2").workstream = "Chapter";
  data.tasks.find((task) => task.id === "task-demo-2").status = "backlog";
  return data;
}

describe("rapid task-circle clicks", () => {
  function setup(overrides = {}) {
    const data = structuredClone(fallbackData);
    const task = data.tasks.find((item) => item.id === "task-demo-1");
    task.status = "to_do";
    const writes = [];
    const onUpdateTask = vi.fn((id, patch) => new Promise((resolve, reject) => {
      writes.push({ id, patch, resolve, reject });
    }));
    const props = { data, onUpdateTask, ...overrides };
    const view = render(<LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>);
    return {
      task, writes, onUpdateTask,
      current: () => boardSpy.props.tasks.find((item) => item.id === task.id),
      click: () => act(async () => {
        boardSpy.props.onCycleStatus(boardSpy.props.tasks.find((item) => item.id === task.id));
      }),
      resync: (row) => view.rerender(<LanguageProvider lang="en"><TasksView {...props}
        data={{ ...data, tasks: data.tasks.map((item) => item.id === row.id ? row : item) }} /></LanguageProvider>),
    };
  }

  it("keeps Review through an earlier response and source refresh, then sends Done", async () => {
    const run = setup();
    await run.click();
    await run.click();
    expect(run.current().status).toBe("needs_review");
    expect(run.onUpdateTask).toHaveBeenCalledTimes(1);
    const first = { ...run.task, status: "in_progress", updatedAt: "2026-10-17T20:00:01Z" };
    await act(async () => { run.writes[0].resolve(first); });
    expect(run.current().status).toBe("needs_review");
    run.resync(first);
    expect(run.current().status).toBe("needs_review");
    await run.click();
    expect(run.current().status).toBe("done");
    await act(async () => { run.writes[1].resolve({ ...first, status: "needs_review", updatedAt: "2026-10-17T20:00:02Z" }); });
    expect(run.current().status).toBe("done");
    expect(run.onUpdateTask.mock.calls.map(([, patch]) => patch.status)).toEqual(["in_progress", "needs_review", "done"]);
    await act(async () => { run.writes[2].resolve({ ...first, status: "done", progress: 100, updatedAt: "2026-10-17T20:00:03Z" }); });
    expect(run.current()).toMatchObject({ status: "done", progress: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(run.onUpdateTask).toHaveBeenLastCalledWith(run.task.id, { status: "needs_review", progress: 40 }));
    await act(async () => { run.writes[3].resolve({ ...first, status: "needs_review", progress: 40 }); });
    // Once the queue drains, a subsequent source refresh is authoritative.
    run.resync({ ...first, status: "backlog" });
    expect(run.current().status).toBe("backlog");
  });

  it("retains the later click when an earlier write fails and rolls back the final refusal", async () => {
    const run = setup();
    await run.click();
    await run.click();
    await act(async () => { run.writes[0].reject(new Error("first refused")); });
    expect(run.current().status).toBe("needs_review");
    await act(async () => { run.writes[1].reject(new Error("second refused")); });
    expect(run.current().status).toBe("to_do");
    expect(screen.getByText(t("tasks.errorUpdate"))).toBeInTheDocument();
  });

  it("advances from the latest pending status even before React renders another card", async () => {
    const run = setup();
    await act(async () => {
      const card = run.current();
      boardSpy.props.onCycleStatus(card);
      boardSpy.props.onCycleStatus(card);
      boardSpy.props.onCycleStatus(card);
    });
    expect(run.current().status).toBe("done");
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { run.writes[index].resolve({ ...run.task, ...run.writes[index].patch }); });
    }
    expect(run.onUpdateTask.mock.calls.map(([, patch]) => patch.status)).toEqual(["in_progress", "needs_review", "done"]);
  });

  it.each([false, true])("orders a circle, production drag, and final circle (drag refused: %s)", async (refused) => {
    let resolveMove;
    let rejectMove;
    const onMoveTask = vi.fn(() => new Promise((resolve, reject) => { resolveMove = resolve; rejectMove = reject; }));
    const run = setup({ onMoveTask });
    await run.click();
    let move;
    await act(async () => { move = boardSpy.props.onDropTask(run.task.id, { status: "needs_review" }).catch(() => {}); });
    expect(run.current().status).toBe("needs_review");
    await run.click();
    expect(run.current().status).toBe("done");
    expect(onMoveTask).not.toHaveBeenCalled();
    const first = { ...run.task, status: "in_progress", updatedAt: "2026-10-17T20:00:01Z" };
    await act(async () => { run.writes[0].resolve(first); });
    expect(onMoveTask).toHaveBeenCalledExactlyOnceWith(run.task.id,
      expect.objectContaining({ status: "needs_review" }), first.updatedAt);
    run.resync(first);
    expect(run.current().status).toBe("done");
    await act(async () => {
      if (refused) rejectMove(new Error("move refused"));
      else resolveMove([{ ...first, status: "needs_review", updatedAt: "2026-10-17T20:00:02Z" }]);
      await move;
    });
    expect(run.current().status).toBe("done");
    expect(run.onUpdateTask).toHaveBeenLastCalledWith(run.task.id, { status: "done" });
    await act(async () => { run.writes[1].resolve({ ...first, status: "done", progress: 100 }); });
    expect(run.current()).toMatchObject({ status: "done", progress: 100 });
  });

  it("does not lend a queued drag a teammate's newer CAS token", async () => {
    const onMoveTask = vi.fn().mockRejectedValue(Object.assign(new Error("changed"), { code: "40001" }));
    const run = setup({ onMoveTask });
    await run.click();
    let move;
    await act(async () => { move = boardSpy.props.onDropTask(run.task.id, { status: "needs_review" }).catch(() => {}); });
    const remote = { ...run.task, title: "Teammate edit", updatedAt: "2026-10-17T20:00:02Z" };
    run.resync(remote);
    await act(async () => {
      run.writes[0].resolve({ ...run.task, status: "in_progress", updatedAt: "2026-10-17T20:00:01Z" });
      await move;
    });
    expect(onMoveTask).toHaveBeenCalledExactlyOnceWith(run.task.id,
      expect.objectContaining({ status: "needs_review" }), run.task.updatedAt);
    expect(run.current()).toMatchObject(remote);
  });

  it("keeps the last successful CAS token through a refused circle before a drag", async () => {
    const version = "2026-10-17T20:00:01Z";
    const onMoveTask = vi.fn(async (id) => [{ id, status: "done", progress: 100, updatedAt: "2026-10-17T20:00:02Z" }]);
    const run = setup({ onMoveTask });
    await run.click();
    await run.click();
    let move;
    await act(async () => { move = boardSpy.props.onDropTask(run.task.id, { status: "done" }); });
    await act(async () => { run.writes[0].resolve({ ...run.task, status: "in_progress", updatedAt: version }); });
    await act(async () => {
      run.writes[1].reject(Object.assign(new Error("busy"), { code: "57014" }));
      await move;
    });
    expect(onMoveTask).toHaveBeenCalledExactlyOnceWith(run.task.id,
      expect.objectContaining({ status: "done" }), version);
    expect(run.current()).toMatchObject({ status: "done", progress: 100 });
  });
});

describe("a drop is one write", () => {
  it("reorders inside a group with the order index alone", async () => {
    const props = renderTasks({ data: twoInChapterBacklog() });
    await drop("task-demo-2", { beforeId: "task-demo-1" });

    // Insert before order 10 with no predecessor: floor(10 / 2) = 5.
    expect(props.onUpdateTask).toHaveBeenCalledTimes(1);
    expect(props.onUpdateTask).toHaveBeenCalledWith("task-demo-2", { orderIndex: 5 });
    // Nothing else travels: the board never rewrites status, workstream or a
    // typed progress number on a reorder.
    const patch = props.onUpdateTask.mock.calls[0][1];
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("workstream");
    expect(patch).not.toHaveProperty("progress");
  });

  it("adds the status when the drop landed in another group of the same column", async () => {
    const props = renderTasks();
    await drop("task-demo-1", { status: "done", beforeId: null });

    // Chapter's done group ends at order 20, so the append lands at 20 + 1000.
    expect(props.onUpdateTask).toHaveBeenCalledTimes(1);
    expect(props.onUpdateTask).toHaveBeenCalledWith("task-demo-1", { status: "done", orderIndex: 1020 });
    expect(props.onUpdateTask.mock.calls[0][1]).not.toHaveProperty("workstream");
  });

  it("adds the workstream when the drop crossed columns, and nothing else", async () => {
    const props = renderTasks();
    await drop("task-demo-1", { workstream: "Communications", beforeId: null });

    // The card keeps its backlog status (the drop reported none). That target
    // partition is empty under the Standard Task fixture, so it starts at 1000.
    expect(props.onUpdateTask).toHaveBeenCalledTimes(1);
    expect(props.onUpdateTask).toHaveBeenCalledWith("task-demo-1", { workstream: "Communications", orderIndex: 1000 });
    expect(props.onUpdateTask.mock.calls[0][1]).not.toHaveProperty("status");
    await waitFor(() => expect(document.querySelector("p.visually-hidden[aria-live='polite']")).toHaveTextContent("Moved to Communications"));
  });

  it("carries both keys when the drop crossed a column AND a group", async () => {
    const props = renderTasks();
    await drop("task-demo-1", { workstream: "Communications", status: "needs_review", beforeId: null });

    // Communications' needs_review group holds one card at order 10.
    expect(props.onUpdateTask).toHaveBeenCalledTimes(1);
    expect(props.onUpdateTask).toHaveBeenCalledWith("task-demo-1", {
      workstream: "Communications",
      status: "needs_review",
      orderIndex: 1010,
    });
  });

  it("writes nothing when the card is dropped back where it already was", async () => {
    const props = renderTasks();
    await drop("task-demo-1", { beforeId: null });
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  it("writes nothing for a card that is not on the board", async () => {
    const props = renderTasks();
    await drop("task-does-not-exist", { status: "done", beforeId: null });
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });
});

describe("the renumber, when the midpoint gap has closed", () => {
  it("renumbers by 1,000s and touches only the (workstream x status) partition", async () => {
    const data = twoInChapterBacklog();
    // Two Chapter/backlog cards one index apart: no midpoint remains.
    data.tasks.find((task) => task.id === "task-demo-1").orderIndex = 10;
    data.tasks.find((task) => task.id === "task-demo-2").orderIndex = 11;
    const props = renderTasks({ data });

    // Drop the Organizing in_progress card between them.
    await drop("task-demo-3", { workstream: "Chapter", status: "backlog", beforeId: "task-demo-2" });

    expect(props.onUpdateTask.mock.calls).toEqual([
      ["task-demo-1", { orderIndex: 1000 }],
      ["task-demo-3", { workstream: "Chapter", status: "backlog", orderIndex: 2000 }],
      ["task-demo-2", { orderIndex: 3000 }],
    ]);
    // task-demo-8 is Chapter/DONE at order 20 — inside the same workstream,
    // outside the target group. A renumber scoped to the column instead of
    // the group would have rewritten a finished card's position for nothing.
    const touched = props.onUpdateTask.mock.calls.map(([id]) => id);
    expect(touched).not.toContain("task-demo-8");
  });

  it("uses one atomic server call when the production move RPC is present", async () => {
    const data = twoInChapterBacklog();
    data.tasks.find((task) => task.id === "task-demo-1").orderIndex = 10;
    data.tasks.find((task) => task.id === "task-demo-2").orderIndex = 11;
    const onMoveTask = vi.fn(async () => [
      { ...data.tasks.find((task) => task.id === "task-demo-1"), orderIndex: 1000 },
      { ...data.tasks.find((task) => task.id === "task-demo-3"), workstream: "Chapter", status: "backlog", orderIndex: 2000 },
      { ...data.tasks.find((task) => task.id === "task-demo-2"), orderIndex: 3000 },
    ]);
    const props = renderTasks({ data, onMoveTask });

    await drop("task-demo-3", { workstream: "Chapter", status: "backlog", beforeId: "task-demo-2" });

    expect(onMoveTask).toHaveBeenCalledTimes(1);
    expect(onMoveTask).toHaveBeenCalledWith("task-demo-3", {
      workstream: "Chapter",
      status: "backlog",
      beforeId: "task-demo-2",
      orderIndex: 2000,
    }, "2026-08-20T12:00:00Z");
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });
});

describe("the keyboard reorder rides the same path", () => {
  it("moves a card up by dropping it before its neighbour", async () => {
    const props = renderTasks({ data: twoInChapterBacklog() });
    await act(async () => { boardSpy.props.onReorder("task-demo-2", "up"); });
    await waitFor(() => expect(props.onUpdateTask).toHaveBeenCalledWith("task-demo-2", { orderIndex: 5 }));
  });

  it("moves a card down past its neighbour", async () => {
    const props = renderTasks({ data: twoInChapterBacklog() });
    await act(async () => { boardSpy.props.onReorder("task-demo-1", "down"); });
    // Past task-demo-2 (order 20) with nothing after it: 20 + 1000.
    await waitFor(() => expect(props.onUpdateTask).toHaveBeenCalledWith("task-demo-1", { orderIndex: 1020 }));
  });

  it("refuses to walk off either end of the group", async () => {
    const props = renderTasks({ data: twoInChapterBacklog() });
    await act(async () => { boardSpy.props.onReorder("task-demo-1", "up"); });
    await act(async () => { boardSpy.props.onReorder("task-demo-2", "down"); });
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  // The board announces; TasksView is the only one that knows whether a move
  // actually happened. A bare refusal used to be indistinguishable from a
  // move, so the board announced every keypress as a completed one.
  it("answers what it did, so a refusal cannot be announced as a move", async () => {
    renderTasks({ data: twoInChapterBacklog() });
    let outcome = null;
    await act(async () => { outcome = boardSpy.props.onReorder("task-demo-1", "up"); });
    expect(outcome).toBe("atStart");
    await act(async () => { outcome = boardSpy.props.onReorder("task-demo-2", "down"); });
    expect(outcome).toBe("atEnd");
    await act(async () => { outcome = boardSpy.props.onReorder("task-does-not-exist", "up"); });
    expect(outcome).toBeNull();
  });

  it("answers \"moved\" for the reorder it really wrote", async () => {
    const props = renderTasks({ data: twoInChapterBacklog() });
    let outcome = null;
    await act(async () => { outcome = boardSpy.props.onReorder("task-demo-2", "up"); });
    expect(outcome).toBe("moved");
    await waitFor(() => expect(props.onUpdateTask).toHaveBeenCalledWith("task-demo-2", { orderIndex: 5 }));
  });
});

describe("a drop into Done keeps the toast and its Undo", () => {
  it("states the one automatic write and restores status AND percentage", async () => {
    const props = renderTasks();
    // task-demo-1: backlog at 40% — a number a member typed.
    await drop("task-demo-1", { status: "done", beforeId: null });

    await waitFor(() => expect(screen.getByText("Marked done · progress set to 100%")).toBeInTheDocument());
    expect(document.querySelector("p.visually-hidden[aria-live='polite']")).toHaveTextContent("Moved to Done");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    // Undo restores both: once done_at is nulled the server cannot give the
    // old percentage back.
    await waitFor(() => expect(props.onUpdateTask).toHaveBeenLastCalledWith("task-demo-1", {
      status: "backlog",
      progress: 40,
    }));
    expect(screen.queryByText("Marked done · progress set to 100%")).not.toBeInTheDocument();
  });
});

describe("orderBetween", () => {
  it("computes midpoints from the neighbours", () => {
    expect(orderBetween(null, null)).toBe(1000);
    expect(orderBetween(null, { orderIndex: 10 })).toBe(5);
    expect(orderBetween({ orderIndex: 20 }, null)).toBe(1020);
    expect(orderBetween({ orderIndex: 10 }, { orderIndex: 20 })).toBe(15);
  });

  it("collides (equals a neighbour) exactly when the gap has closed", () => {
    expect(orderBetween({ orderIndex: 10 }, { orderIndex: 11 })).toBe(10);
    expect(orderBetween(null, { orderIndex: 0 })).toBe(0);
  });
});
