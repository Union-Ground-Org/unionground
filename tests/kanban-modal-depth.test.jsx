import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { catalogue } from "../src/lib/i18n.js";
import { statusCycle } from "../src/lib/kanban.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { KanbanBoard } from "../src/views/KanbanBoard.jsx";
import { TaskModal } from "../src/views/TaskModal.jsx";

// Phase-2 modal depth: the dependencies card, the history popover and the
// actions menu. Same stance as kanban-modal.test.jsx — the modal is rendered
// directly, the copy under test is the real shipped catalogue, and the pins
// are about WHICH call fires with WHAT arguments, not about rendering.
//
// The graph pins matter most. The add-picker's exclusions are the client twin
// of the migration's cycle guard, and the specific regression they close is
// offering an edge the server will refuse: the picker must hide the task
// itself, every existing depends-on, and every candidate that already REACHES
// this task through the demo graph (task-demo-2 depends on task-demo-7, so
// 7 must never be offered 2). The 23505/22023 branches are the race the
// exclusions cannot see — another editor adding the same edge between paint
// and click — and each maps to its own named copy. An uncoded failure keeps
// the generic save error. The parametrized dependency-add case pins all three.

const MEMBER = "11111111-1111-4111-8111-111111111111";

function Harness(props) {
  const { lang, t } = useLang();
  return <TaskModal {...props} t={t} lang={lang} />;
}

function renderModal({ taskId = "task-demo-1", task: taskPatch = {}, ...overrides } = {}, lang = "en") {
  const data = structuredClone(fallbackData);
  const props = {
    task: { ...data.tasks.find((item) => item.id === taskId), ...taskPatch },
    chapterId: data.member.chapterId,
    assignees: data.taskAssignees,
    workstreamNames: ["Bargaining", "Chapter", "Communications", "Grievances", "Organizing", "Safety"],
    memberId: data.member.id,
    messages: data.taskMessages,
    creatorName: "Maria Santos",
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onSendMessage: vi.fn(async () => ({ id: "task-message-new" })),
    tasks: data.tasks,
    dependencies: data.taskDependencies,
    subtasks: data.taskSubtasks,
    watches: data.taskWatches,
    onCreateSubtask: vi.fn(async () => ({ task: { id: "new" }, edge: { id: "new-edge" } })),
    onRemoveSubtask: vi.fn(async () => ({ deleted: true })),
    onUpdateSubtask: vi.fn(async () => ({ id: "updated" })),
    onWatch: vi.fn(async () => ({ taskId })),
    onUnwatch: vi.fn(async () => ({ taskId })),
    onAddDependency: vi.fn(async () => ({ id: "edge-new" })),
    onRemoveDependency: vi.fn(async () => ({ deleted: true })),
    onOpenTask: vi.fn(),
    onDuplicate: vi.fn(),
    onAnnounce: vi.fn(),
    ...overrides,
  };
  render(<LanguageProvider lang={lang}><Harness {...props} /></LanguageProvider>);
  return props;
}

function depsCard() {
  const heading = screen.getByRole("heading", { name: "Dependencies" });
  const card = heading.closest("article");
  const disclosure = within(heading).getByRole("button", { name: "Dependencies" });
  if (disclosure.getAttribute("aria-expanded") === "false") fireEvent.click(disclosure);
  return card;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dependencies card", () => {
  it("lists depends-on and blocking rows from the edge list, keyed and status-marked", () => {
    renderModal({ taskId: "task-demo-1" });
    const card = depsCard();
    const dependsOn = within(card).getByRole("heading", { name: "Depends on" }).parentElement;
    // task-demo-1 depends on task-demo-5 (WOR-5) and task-demo-3 (WOR-3).
    expect(within(dependsOn).getByText("WOR-5")).toBeInTheDocument();
    expect(within(dependsOn).getByText("Review chapter newsletter")).toBeInTheDocument();
    expect(within(dependsOn).getByText("WOR-3")).toBeInTheDocument();
    expect(within(card).queryByRole("heading", { name: "Blocking" })).toBeNull();
    expect(within(card).getByText("2")).toBeInTheDocument();
  });

  it("reads the same edge in reverse as Blocking on the other endpoint", () => {
    renderModal({ taskId: "task-demo-5" });
    const card = depsCard();
    const blocking = within(card).getByRole("heading", { name: "Blocking" }).parentElement;
    expect(within(blocking).getByText("WOR-1")).toBeInTheDocument();
    expect(within(blocking).getByText("Prepare August campaign meeting")).toBeInTheDocument();
  });

  it("opens the far endpoint from the row body and removes the EDGE from the ✕", () => {
    const props = renderModal({ taskId: "task-demo-1" });
    const card = depsCard();
    fireEvent.click(within(card).getByText("Review chapter newsletter").closest("button"));
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-5" }));
    fireEvent.click(within(card).getByRole("button", { name: "Remove dependency on WOR-5" }));
    // The remove handler receives the edge id, not a task id — deleting by
    // task would take out every edge the task touches.
    expect(props.onRemoveDependency).toHaveBeenCalledWith("task-dep-demo-2");
  });

  it("shows the empty state when the task touches no edges", () => {
    renderModal({ taskId: "task-demo-8" });
    expect(within(depsCard()).getByText("No dependencies yet")).toBeInTheDocument();
  });

  it("offers only edges the server would accept: no self, no duplicates, no cycle-closers", () => {
    renderModal({ taskId: "task-demo-7" });
    const card = depsCard();
    fireEvent.click(within(card).getByRole("button", { name: "Add dependency" }));
    const options = within(card).getAllByRole("option").map((option) => option.textContent);
    // Not itself…
    expect(options.some((text) => text.includes("Publish bargaining priorities poll"))).toBe(false);
    // …and not task-demo-2, which already depends on task-demo-7: offering it
    // would let 7→2 close the loop the migration's walk refuses.
    expect(options.some((text) => text.includes("Translate bargaining pulse"))).toBe(false);
    expect(options.some((text) => text.includes("Update committee contact roster"))).toBe(true);
  });

  it("adds through the picker with (taskId, dependsOnId) and filters by text", async () => {
    const props = renderModal({ taskId: "task-demo-8" });
    const card = depsCard();
    fireEvent.click(within(card).getByRole("button", { name: "Add dependency" }));
    fireEvent.change(screen.getByLabelText("Search tasks to depend on"), { target: { value: "safety" } });
    const option = screen.getByRole("option", { name: /Approve workplace safety checklist/ });
    fireEvent.click(option);
    await waitFor(() => expect(props.onAddDependency).toHaveBeenCalledWith("task-demo-8", "task-demo-6"));
  });

  it.each([
    { label: "23505", code: "23505", key: "kanban.depExists" },
    { label: "22023", code: "22023", key: "kanban.depRefused" },
    { label: "uncoded", code: undefined, key: "tasks.errorSave" },
  ])("maps a $label dependency-add failure to $key", async ({ code, key }) => {
    const failure = code
      ? Object.assign(new Error("Add dependency failed"), { code })
      : new Error("Add dependency failed");
    const props = renderModal({ taskId: "task-demo-8", onAddDependency: vi.fn(async () => { throw failure; }) });
    const card = depsCard();
    fireEvent.click(within(card).getByRole("button", { name: "Add dependency" }));
    fireEvent.click(within(card).getAllByRole("option")[0]);
    expect(await screen.findByText(catalogue.en[key])).toBeInTheDocument();
    for (const other of ["kanban.depExists", "kanban.depRefused", "tasks.errorSave"]) {
      if (other !== key) expect(screen.queryByText(catalogue.en[other])).toBeNull();
    }
    expect(props.onAddDependency).toHaveBeenCalled();
  });
});

describe("history popover", () => {
  it("shows creator and last-updated actor with machine-readable stamps", () => {
    renderModal({ taskId: "task-demo-3" });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const popover = screen.getByRole("group", { name: "History" });
    expect(within(popover).getByText("Created")).toBeInTheDocument();
    expect(within(popover).getByText("Maria Santos")).toBeInTheDocument();
    // task-demo-3's updatedBy is Priya Shah in the fixture.
    expect(within(popover).getByText("Last updated")).toBeInTheDocument();
    expect(within(popover).getByText("Priya Shah")).toBeInTheDocument();
    // The stamps assert as attributes: rendered text is timezone-dependent.
    const times = popover.querySelectorAll("time");
    expect([...times].map((node) => node.getAttribute("datetime"))).toEqual([
      "2026-07-22T12:00:00Z",
      "2026-08-20T12:00:00Z",
    ]);
  });

  it("renders the update row dateless-actor when updated_by never loaded", () => {
    renderModal({ taskId: "task-demo-2" });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const popover = screen.getByRole("group", { name: "History" });
    expect(within(popover).getByText("Last updated")).toBeInTheDocument();
    // No actor row: the fixture card has no updatedBy, and inventing one
    // ("chapter member") would claim an author the row never carried.
    expect(within(popover).queryByText("Priya Shah")).toBeNull();
  });
});

describe("actions menu", () => {
  function stubClipboard() {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  }

  it("copies the deep-link URL and announces through the live region", async () => {
    const writeText = stubClipboard();
    const props = renderModal({ taskId: "task-demo-3" });
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy task link/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.href));
    await waitFor(() => expect(props.onAnnounce).toHaveBeenCalledWith("Link copied"));
  });

  // Record #9891 (audit W6-5): on Main both copies showed nothing on screen,
  // and a refused clipboard left the person with no way to copy by hand.
  it.each([
    ["en", "Copy task link", "Link copied"],
    ["es", "Copiar clave de la tarea", "Clave de la tarea copiada"],
  ])("shows the copy result inside the task window (%s)", async (lang, action, copied) => {
    stubClipboard();
    renderModal({ taskId: "task-demo-3" }, lang);
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["kanban.actions"] }));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(action) }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(copied)).toHaveClass("kan-copy-notice");
  });

  it.each([
    ["en", "Copy task link", "kanban.copyFailedLink", () => window.location.href],
    ["es", "Copiar clave de la tarea", "kanban.copyFailedKey", () => "WOR-3"],
  ])("says a refused copy failed and offers the text to copy by hand (%s)", async (lang, action, failedKey, expected) => {
    const writeText = vi.fn(async () => { throw new DOMException("Denied", "NotAllowedError"); });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const props = renderModal({ taskId: "task-demo-3" }, lang);
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["kanban.actions"] }));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(action) }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(catalogue[lang][failedKey]);
    const field = screen.getByRole("textbox", { name: catalogue[lang][failedKey] });
    expect(field).toHaveAttribute("readonly");
    expect(field).toHaveValue(expected());
    expect(props.onAnnounce).not.toHaveBeenCalled();
  });

  // Sol read of record #9891: a refusal can be closed, and a task switch in
  // the same window retires both the notice and any copy still in flight.
  function refuseClipboard() {
    const writeText = vi.fn(async () => { throw new DOMException("Denied", "NotAllowedError"); });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  }

  function switchableModal(lang = "en") {
    const data = structuredClone(fallbackData);
    const taskOf = (id) => data.tasks.find((item) => item.id === id);
    const onAnnounce = vi.fn();
    const props = { chapterId: data.member.chapterId, assignees: data.taskAssignees, memberId: data.member.id, tasks: data.tasks, onClose: vi.fn(), onUpdate: vi.fn(), onAnnounce };
    const ui = (id) => <LanguageProvider lang={lang}><Harness {...props} task={taskOf(id)} /></LanguageProvider>;
    const view = render(ui("task-demo-3"));
    return { onAnnounce, show: (id) => view.rerender(ui(id)) };
  }

  it.each(["en", "es"])("closes a refused-copy notice with its own named control (%s)", async (lang) => {
    refuseClipboard();
    renderModal({ taskId: "task-demo-3" }, lang);
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["kanban.actions"] }));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(catalogue[lang]["kanban.copyTaskUrl"]) }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["kanban.copyNoticeDismiss"] }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("textbox", { name: catalogue[lang]["kanban.copyFailedLink"] })).toBeNull();
  });

  it("drops a refusal when the window moves to another task, and does not bring it back", async () => {
    refuseClipboard();
    const modal = switchableModal();
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy task link/ }));
    await screen.findByRole("alert");
    modal.show("task-demo-1");
    expect(screen.queryByRole("alert")).toBeNull();
    modal.show("task-demo-3");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(catalogue.en["kanban.copyFailedLink"])).toBeNull();
  });

  it("lets a copy still pending at a task switch neither show nor announce its result", async () => {
    let finish;
    const writeText = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const modal = switchableModal();
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy task link/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    modal.show("task-demo-1");
    await act(async () => { finish(); });
    modal.show("task-demo-3");
    expect(screen.queryByText("Link copied")).toBeNull();
    expect(modal.onAnnounce).not.toHaveBeenCalled();
  });

  it("copies the mono key, not the title", async () => {
    const writeText = stubClipboard();
    renderModal({ taskId: "task-demo-3" });
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy task key/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("WOR-3"));
  });

  it("duplicates the CURRENT task and honours the quick-pick digit", () => {
    const props = renderModal({ taskId: "task-demo-3" });
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    const menu = screen.getByRole("menu");
    // The rendered digits and the handler read the same actionItems list.
    expect(within(menu).getByRole("menuitem", { name: /Duplicate task/ }).textContent).toContain("3");
    fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0], { key: "3" });
    expect(props.onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-3" }));
  });

  it("lets Escape close the menu without closing the modal", () => {
    const props = renderModal({ taskId: "task-demo-3" });
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("board card dependency count", () => {
  it("stays out of the compact card preview", () => {
    const data = structuredClone(fallbackData);
    const depCounts = new Map([["task-demo-1", 2], ["task-demo-3", 1]]);
    const t = (key, vars = {}) => {
      if (key === "kanban.dependencyCount") return `${vars.count} dependencies`;
      return key;
    };
    render(
      <KanbanBoard
        tasks={data.tasks}
        workstreamNames={["Chapter", "Organizing"]}
        chapterId="wor"
        t={t}
        lang="en"
        doneVisible
        focusWorkstream={null}
        onFocusWorkstream={() => {}}
        onOpenTask={() => {}}
        onCycleStatus={() => {}}
        onDropTask={() => {}}
        onCreateInline={() => {}}
        onReorder={() => {}}
        depCounts={depCounts}
        liveAnnounce={() => {}}
      />,
    );
    expect(screen.queryByText("2 dependencies")).not.toBeInTheDocument();
    expect(screen.queryByText("1 dependencies")).not.toBeInTheDocument();
    // Dependencies remain available in the task detail, not the board card.
    const unbadged = screen.getByText("Update committee contact roster").closest("article");
    expect(unbadged.querySelector(".kan-card__deps")).toBeNull();
  });
});
describe("Phase 3 subtasks and private watch", () => {
  it("exposes only the current member's self-watch switch and removes by task id", async () => {
    const props = renderModal({ taskId: "task-demo-1" });
    const toggle = screen.getByRole("switch", { name: "Watch task" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // The honest-inertness copy retired with the notifications wave: watch
    // now delivers real alerts, so the description promises them.
    expect(toggle).toHaveAccessibleDescription("Watching — you'll be notified when this task changes.");
    expect(screen.getByText("Watching — you'll be notified when this task changes.")).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(props.onUnwatch).toHaveBeenCalledWith("task-demo-1"));
  });

  it("adds an unwatched task without exposing a watcher roster", async () => {
    const props = renderModal({ taskId: "task-demo-2" });
    const toggle = screen.getByRole("switch", { name: "Watch task" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(props.onWatch).toHaveBeenCalledWith("task-demo-2"));
    expect(document.querySelector(".kan-watchers")).toBeNull();
  });

  it("creates, completes, opens and unlinks full-task subtasks", async () => {
    const props = renderModal({ taskId: "task-demo-1" });
    const card = screen.getByRole("heading", { name: "Subtasks" }).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: "Subtasks" }));
    expect(within(card).getByText("Translate bargaining pulse")).toBeInTheDocument();
    expect(within(card).getByText("Coworker outreach calls")).toBeInTheDocument();

    fireEvent.change(within(card).getByPlaceholderText("Add subtask"), { target: { value: "Confirm speakers" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(props.onCreateSubtask).toHaveBeenCalledWith("task-demo-1", "Confirm speakers"));

    fireEvent.click(within(card).getAllByRole("button", { name: "Complete subtask" })[0]);
    await waitFor(() => expect(props.onUpdateSubtask).toHaveBeenCalledWith("task-demo-2", { status: "done" }));

    fireEvent.click(within(card).getByRole("button", { name: /Translate bargaining pulse/ }));
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-2" }));

    fireEvent.click(within(card).getAllByRole("button", { name: "Unlink subtask" })[0]);
    await waitFor(() => expect(props.onRemoveSubtask).toHaveBeenCalledWith("task-subtask-demo-1"));
  });

  it("reopens a finished subtask to the status statusCycle gives a reopen, never backlog", async () => {
    const tasks = structuredClone(fallbackData.tasks).map((item) => (item.id === "task-demo-2" ? { ...item, status: "done" } : item));
    const props = renderModal({ taskId: "task-demo-1", tasks });
    const card = screen.getByRole("heading", { name: "Subtasks" }).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: "Subtasks" }));

    fireEvent.click(within(card).getByRole("button", { name: "Reopen subtask" }));
    await waitFor(() => expect(props.onUpdateSubtask).toHaveBeenCalledTimes(1));
    expect(props.onUpdateSubtask).toHaveBeenCalledWith("task-demo-2", { status: statusCycle("done").to });
    expect(props.onUpdateSubtask).not.toHaveBeenCalledWith("task-demo-2", { status: "backlog" });
  });
});
