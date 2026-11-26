import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUnsavedCharacterShortcutChoices } from "../src/lib/taskCharacterShortcuts.js";
import { registerEscapeLayer } from "../src/lib/escapeLayers.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { chapterTaskFromRow, updateChapterTask } from "../src/lib/memberApi.js";
import { TasksView } from "../src/views/TasksView.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";
import { setKeyboardShortcutsEnabled } from "../src/lib/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// This file pins the CHROME of the rebuilt tasks screen — everything that
// wraps the board rather than the board itself (KanbanBoard has its own suite,
// and so do the pure helpers, the modal and the drag write path).
//
// Why a chrome suite exists at all: the t0ggles rebuild moved six separate
// controls out of the page body and into two popovers and a sticky top bar.
// Scope, priority and workstream stopped being always-visible <select>s; the
// theme toggle and the done-visibility switch were born inside a popover; the
// create surface became an inline composer beside its lane. Every one of
// those is a control a member can no longer see until they
// open something, which is exactly the class of control that silently stops
// working — the trigger still renders, the panel still animates, and the state
// behind it was never wired. Rendering the screen and driving the real
// entrances is the only way that failure shows up.
//
// The other half of the file is the keyboard map. It is one window-level
// keydown listener guarding five behaviors against three skip rules (already
// handled, typing surface, unmapped chord). A regression there is invisible in
// review — the listener still installs — and unfindable by hand, because the
// symptom is "a key does nothing".
//
// Deliberately NOT here: anything that needs geometry. jsdom reports every
// rect as 0x0, so drag hit-testing is unit-tested against fixture rects in
// tests/tasks-board-drag.test.jsx instead of driven through this DOM.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tasksSource = readFileSync(join(root, "src/views/TasksView.jsx"), "utf8").replace(/\r\n/g, "\n");
const taskViewsSource = readFileSync(join(root, "src/lib/taskViews.js"), "utf8").replace(/\r\n/g, "\n");

// The WIDE (>=1024px) chrome: above the desktop threshold the view pills carry
// their text labels beside the icon. The pills keep an aria-label at every
// width, so the queries below read the same on a phone; the stub is here so
// the file exercises the branch a staff desktop actually renders.
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  // A refused storage write is remembered outside the view for the page load; forget it between cases.
  resetUnsavedCharacterShortcutChoices();
  window.sessionStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
  // The ?task deep link is read on mount from the real location.
  window.history.replaceState({}, "", "/m/tasks");
});
afterEach(() => {
  vi.useRealTimers();
  for (const key of Object.keys(window.localStorage)) {
    if (key.endsWith(":task-character-shortcuts")) window.localStorage.removeItem(key);
  }
  window.matchMedia = realMatchMedia;
  window.history.replaceState({}, "", "/m/tasks");
  document.title = "Union Ground";
});

function stubMotion(reduced) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query.includes("prefers-reduced-motion") ? reduced : true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}
const allowMotion = () => stubMotion(false);
const reduceMotionAgain = () => stubMotion(true);

function outsideBackdropSiblings(root) {
  const siblings = [];
  let branch = root;
  while (branch?.parentElement && branch !== document.body) {
    for (const child of branch.parentElement.children) {
      if (child === branch || ["SCRIPT", "STYLE", "LINK"].includes(child.tagName)) continue;
      siblings.push(child);
    }
    branch = branch.parentElement;
  }
  return siblings;
}

// WCAG 2.1.4: bare /, ? and c are an opt-in member preference, off by default.
function characterShortcutKey(memberId = fallbackData.member.id) {
  return `sg:member:${memberId}:task-character-shortcuts`;
}

function optInCharacterShortcuts(memberId) {
  window.localStorage.setItem(characterShortcutKey(memberId), "true");
}

function renderProps(overrides = {}) {
  return {
    data: structuredClone(fallbackData),
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onCreateTask: vi.fn(async (fields) => ({
      ...fields,
      id: "new-task",
      taskNumber: 9,
      createdAt: "2026-08-01T09:00:00Z",
      updatedAt: "2026-08-01T09:00:00Z",
    })),
    onUpdateTask: vi.fn(async (_id, fields) => fields),
    onDeleteTask: vi.fn(async () => ({ deleted: true })),
    onSendTaskMessage: vi.fn(async () => null),
    ...overrides,
  };
}

function renderTasks(overrides = {}, lang = "en") {
  const props = renderProps(overrides);
  render(<LanguageProvider lang={lang}><TasksView {...props} /></LanguageProvider>);
  return props;
}

// Exercise the actual task API mapper against a local RPC contract. The old
// mock returned a partial row dated August 5, before the boot row's August 20
// version. This is a monotonic two-write success scenario, so both responses
// must advance that boot row. Derive tokens from the current stored row instead.
function renderQueuedContent({ firstError = null } = {}) {
  const task = fallbackData.tasks.find((item) => item.id === "task-demo-1");
  let row = Object.fromEntries(Object.entries(task).map(([key, value]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value,
  ]));
  const bootVersion = row.updated_at;
  let releaseFirst;
  const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
  const store = (patch) => {
    row = { ...row, ...patch, updated_at: new Date(Date.parse(row.updated_at) + 1000).toISOString() };
    return { ...row };
  };
  const client = { rpc: vi.fn(async (name, args) => {
    expect(name).toBe("update_chapter_task_content");
    const first = client.rpc.mock.calls.length === 1;
    if (first && firstError) {
      await firstDone;
      return { data: null, error: firstError };
    }
    if (args.p_expected_updated_at !== row.updated_at) {
      return { data: null, error: { code: "40001", message: "stale test version" } };
    }
    const saved = store({ title: args.p_title ?? row.title, description: args.p_description ?? row.description });
    // The write has committed; only delivery of its full server row is delayed.
    if (first) await firstDone;
    return { data: [saved], error: null };
  }) };
  let data = { ...structuredClone(fallbackData), tasks: [task] };
  const onUpdateTask = vi.fn((...args) => updateChapterTask(client, ...args));
  const props = { onUpdateTask, onProfile: vi.fn(), onAssistant: vi.fn() };
  const view = render(<LanguageProvider lang="en"><TasksView {...props} data={data} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Prepare August campaign meeting" }));
  return {
    bootVersion, client, onUpdateTask, releaseFirst,
    stored: () => ({ ...row }),
    remote(patch) {
      store(patch);
      data = { ...data, tasks: [chapterTaskFromRow(row)] };
      view.rerender(<LanguageProvider lang="en"><TasksView {...props} data={data} /></LanguageProvider>);
    },
  };
}

// Both a second blur and a close-flush must wait for the first response and
// use its token. Assert stored content and closing too: a token-only assertion
// could hide a legitimate second edit being refused or a third phantom write.
it.each(["blur", "close"])("queues a second content write from %s and hands it the returned token", async (trigger) => {
  const run = renderQueuedContent();
  const title = screen.getByLabelText("Task title");
  fireEvent.change(title, { target: { value: "First write" } });
  fireEvent.blur(title);
  await waitFor(() => expect(run.onUpdateTask).toHaveBeenCalledTimes(1));
  const firstVersion = run.stored().updated_at;
  fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Second write" } });
  if (trigger === "close") fireEvent.keyDown(window, { key: "Escape" });
  else fireEvent.blur(screen.getByLabelText("Description"), { relatedTarget: title });
  await act(async () => {});
  expect(run.onUpdateTask).toHaveBeenCalledTimes(1);
  await act(async () => run.releaseFirst());
  await waitFor(() => expect(run.onUpdateTask).toHaveBeenCalledTimes(2));
  expect(Date.parse(firstVersion)).toBeGreaterThan(Date.parse(run.bootVersion));
  expect(run.onUpdateTask.mock.calls[0][2]).toBe(run.bootVersion);
  expect(run.onUpdateTask.mock.calls[1]).toEqual(["task-demo-1", { description: "Second write" }, firstVersion]);
  await waitFor(() => expect(run.stored()).toMatchObject({ title: "First write", description: "Second write" }));
  if (trigger === "blur") fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(run.onUpdateTask).toHaveBeenCalledTimes(2);
});

it("retains both drafts after a delayed first refusal and saves them on one explicit close retry", async () => {
  const run = renderQueuedContent({ firstError: { code: "57014", message: "synthetic timeout" } });
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Retry title" } });
  fireEvent.blur(screen.getByLabelText("Task title"));
  await waitFor(() => expect(run.onUpdateTask).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Retry description" } });
  fireEvent.keyDown(window, { key: "Escape" });
  await act(async () => run.releaseFirst());
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Union Ground is busy");
  expect(screen.getByLabelText("Task title")).toHaveValue("Retry title");
  expect(screen.getByLabelText("Description")).toHaveValue("Retry description");
  expect(run.onUpdateTask).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(run.onUpdateTask.mock.calls[1]).toEqual(["task-demo-1", { title: "Retry title", description: "Retry description" }, run.bootVersion]);
  expect(run.stored()).toMatchObject({ title: "Retry title", description: "Retry description" });
  expect(run.onUpdateTask).toHaveBeenCalledTimes(2);
});

it("keeps a newer remote row when an older successful response arrives and refuses the conflicting close draft", async () => {
  const run = renderQueuedContent();
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "First write" } });
  fireEvent.blur(screen.getByLabelText("Task title"));
  await waitFor(() => expect(run.onUpdateTask).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Unsaved second write" } });
  run.remote({ title: "Teammate title", description: "Teammate description" });
  fireEvent.keyDown(window, { key: "Escape" });
  await act(async () => run.releaseFirst());
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Somebody changed this first"));
  expect(screen.getByLabelText("Task title")).toHaveValue("Teammate title");
  expect(screen.getByLabelText("Description")).toHaveValue("Unsaved second write");
  expect(run.stored()).toMatchObject({ title: "Teammate title", description: "Teammate description" });
  expect(run.onUpdateTask).toHaveBeenCalledTimes(1);
});

function firstLaneComposer() {
  return document.querySelector(".kan-board .kan-col button.kan-newtask");
}

it("opens the staff template chooser, creates through the template RPC boundary, and follows the new task", async () => {
  const onCreateTaskFromTemplate = vi.fn(async (fields) => ({
    task: {
      id: "template-task-new",
      taskNumber: 10,
      title: fields.title,
      description: "- [ ] Confirm time and mode",
      status: "to_do",
      priority: "medium",
      taskType: fields.templateKey,
      workstream: fields.workstream,
      assigneeId: null,
      startDate: fields.fields.scheduled_on,
      dueDate: fields.fields.scheduled_on,
      progress: 0,
      blocked: false,
      milestone: false,
      orderIndex: 1000,
      createdBy: fallbackData.member.id,
      createdAt: "2026-08-12T12:00:00Z",
      updatedAt: "2026-08-12T12:00:00Z",
    },
    details: {
      taskId: "template-task-new", templateKey: fields.templateKey, flowStep: "planning",
      scheduledOn: fields.fields.scheduled_on, venueMode: fields.fields.venue_mode,
    },
  }));
  renderTasks({ staffAccess: true, onCreateTaskFromTemplate });

  fireEvent.click(screen.getByRole("button", { name: "Use a template" }));
  fireEvent.click(screen.getByRole("button", { name: /Meeting/i }));
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Plan September meeting" } });
  fireEvent.change(screen.getByLabelText("Scheduled date"), { target: { value: "2026-09-10" } });
  fireEvent.change(screen.getByLabelText("Venue mode"), { target: { value: "hybrid" } });
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));

  await waitFor(() => expect(onCreateTaskFromTemplate).toHaveBeenCalledWith(expect.objectContaining({
    templateKey: "meeting_event",
    title: "Plan September meeting",
    fields: { scheduled_on: "2026-09-10", venue_mode: "hybrid" },
  })));
  expect(await screen.findByLabelText("Task title")).toHaveValue("Plan September meeting");
  expect(screen.queryByRole("dialog", { name: "Use a task template" })).not.toBeInTheDocument();
});

it("lets the template picker fade out behind the task it created without taking focus back to its trigger", async () => {
  allowMotion();
  const onCreateTaskFromTemplate = vi.fn(async (fields) => ({
    task: {
      id: "template-task-fade", taskNumber: 11, title: fields.title, description: "", status: "to_do",
      priority: "medium", taskType: fields.templateKey, workstream: fields.workstream, assigneeId: null,
      startDate: fields.fields.scheduled_on, dueDate: fields.fields.scheduled_on, progress: 0, blocked: false,
      milestone: false, orderIndex: 1001, createdBy: fallbackData.member.id,
      createdAt: "2026-08-12T12:00:00Z", updatedAt: "2026-08-12T12:00:00Z",
    },
    details: { taskId: "template-task-fade", templateKey: fields.templateKey, flowStep: "planning", scheduledOn: fields.fields.scheduled_on, venueMode: fields.fields.venue_mode },
  }));
  renderTasks({ staffAccess: true, onCreateTaskFromTemplate });
  const trigger = screen.getByRole("button", { name: "Use a template" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: /Meeting/i }));
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Plan October meeting" } });
  fireEvent.change(screen.getByLabelText("Scheduled date"), { target: { value: "2026-10-08" } });
  fireEvent.change(screen.getByLabelText("Venue mode"), { target: { value: "hybrid" } });
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(document.querySelector(".task-template-backdrop")).toHaveAttribute("data-state", "closing"));
  // A second submission mid-fade writes nothing.
  fireEvent.submit(document.querySelector(".task-template-form"));
  expect(onCreateTaskFromTemplate).toHaveBeenCalledTimes(1);
  const focusedBeforeExit = document.activeElement;
  fireEvent.transitionEnd(document.querySelector(".task-template-backdrop"));
  expect(document.querySelector(".task-template-backdrop")).toBeNull();
  expect(trigger).not.toHaveFocus();
  expect(document.activeElement).toBe(focusedBeforeExit);
});

it("drives the timeline window and persists one-day task shifts", async () => {
  const onUpdateTask = vi.fn(async (_id, fields) => fields);
  renderTasks({ onUpdateTask });
  fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
  const timeline = screen.getByRole("region", { name: "Timeline" });

  fireEvent.click(within(timeline).getByRole("button", { name: "Show earlier dates" }));
  fireEvent.click(within(timeline).getByRole("button", { name: "Show later dates" }));
  fireEvent.click(within(timeline).getByRole("button", { name: "Move Prepare August campaign meeting 1 day earlier" }));

  await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(
    "task-demo-1",
    { startDate: "2026-07-26", dueDate: "2026-08-30" },
  ));
});

// The responsive Timeline used to feed task.startDate/task.dueDate straight
// into the strict taskSchedule parsers. One key that is not an exact
// YYYY-MM-DD threw a RangeError during render, and because the throw came from
// the row map it unmounted the entire Tasks screen rather than the one bar.
// The desktop timeline already read the same two fields through the
// fail-closed span helper; this pins the responsive layout to that behavior.
it("drops a task with an underivable date span from the timeline instead of unmounting the screen", () => {
  const data = structuredClone(fallbackData);
  data.tasks.find((task) => task.id === "task-demo-1").startDate = "not-a-date";
  renderTasks({ data });
  fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
  const timeline = screen.getByRole("region", { name: "Timeline" });

  // The malformed row is gone, and the screen around it still rendered.
  expect(within(timeline).queryByRole("button", { name: /^Prepare August campaign meeting/ })).not.toBeInTheDocument();
  expect(within(timeline).queryByRole("button", { name: "Move Prepare August campaign meeting 1 day earlier" })).not.toBeInTheDocument();
  expect(within(timeline).getByRole("button", { name: "Coworker outreach callsPriya Shah" })).toBeInTheDocument();
});

it("lets the desktop Timeline parent roll back a rejected shift and surface the shared alert", async () => {
  const onUpdateTask = vi.fn(async () => { throw new Error("schedule rejected"); });
  renderTasks({ desktopShell: true, onUpdateTask });
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  const timeline = screen.getByRole("region", { name: "Task timeline" });
  const taskRow = timeline.querySelector('[data-task-id="task-demo-1"]');
  const bar = taskRow.querySelector(".kan-timeline__bar");
  expect(bar).toHaveAttribute("data-start-date", "2026-07-27");
  expect(bar).toHaveAttribute("data-end-date", "2026-08-31");

  fireEvent.click(within(taskRow).getByRole("button", { name: "Move Prepare August campaign meeting 1 day earlier" }));

  await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(
    "task-demo-1",
    { startDate: "2026-07-26", dueDate: "2026-08-30" },
  ));
  expect(await screen.findByRole("alert")).toHaveTextContent("The change did not save. The task was restored.");
  await waitFor(() => {
    expect(bar).toHaveAttribute("data-start-date", "2026-07-27");
    expect(bar).toHaveAttribute("data-end-date", "2026-08-31");
  });
  expect(within(taskRow).getByRole("button", { name: /1 day earlier/ })).toBeEnabled();
});

describe("the plane header and its toolbar", () => {
  it("keeps ONE h1 and states the open count of the current filter in the subline", () => {
    renderTasks();
    // The board lost its summary tile row in the rebuild. What survives of the
    // old totals is exactly this line plus the done chip beside it, so the
    // number here is the only place "how much is still open" is printed.
    // Default scope is My work: 6 of the 8 fixture tasks, 1 of them done.
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Move the work together");
    expect(document.querySelector(".phead__sub")).toHaveTextContent("Harborview Care United · 5 open in this view");
    expect(document.querySelector(".phead.phead--toolbar")).toBeNull();
    expect(document.querySelector(".phead .wtk-actions")).toBeNull();
    expect(within(document.querySelector(".phead")).queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });

  it("removes the duplicate done chip from the page header", () => {
    renderTasks();
    expect(document.querySelector(".wtk-donechip")).toBeNull();
  });

  it("drops the done chip when the filter holds nothing finished", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Assigned to me 2" }));
    // Both cards assigned to the member are open; a "0 done" chip would be
    // chrome describing nothing.
    expect(document.querySelector(".wtk-donechip")).toBeNull();
  });
});

describe("the view pills", () => {
  it("uses pressed buttons for Board, List, Calendar, Timeline, Progress and Report", () => {
    renderTasks();
    const group = screen.getByRole("group", { name: "Task views" });
    const pills = within(group).getAllByRole("button");
    expect(pills.map((pill) => pill.getAttribute("aria-label")))
      .toEqual(["Board", "List", "Calendar", "Timeline", "Progress", "Report"]);
    expect(within(group).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    // Five independent views, not four fake tabs: there is no tablist and no
    // panel, so role=tab would be a lie the screen reader reads out loud.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("switches the rendered view and moves the pressed state with it", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(screen.getByRole("button", { name: "Calendar" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "false");
    // The pill and the view it mounts share a name, so the region is the one
    // that proves the VIEW changed rather than only the pressed state.
    expect(screen.getByRole("region", { name: "Calendar" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.getByRole("region", { name: "Timeline" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Progress" }));
    expect(screen.getByText("By workstream")).toBeInTheDocument();
  });

  it("keeps the Progress summary directly below the page heading", () => {
    renderTasks({ desktopShell: true });
    fireEvent.click(screen.getByRole("tab", { name: "Progress" }));
    expect(screen.getByRole("heading", { level: 1, name: "Work" })).toBeInTheDocument();
    // #9990: the open tab's title is the second level, the summary the third.
    expect(screen.getByRole("heading", { level: 2, name: "Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /complete$/ })).toBeInTheDocument();
    expect(document.querySelector(".tasks-progress-hero h4")).toBeNull();
  });

  // The owner omitted Gantt from this program: the Timeline is Union Ground-native
  // and predates t0ggles. The ONLY "gantt" the file is allowed to contain is
  // the lucide icon identifier for the timeline pill — no sixth view, no
  // Ctrl+Shift+G, no user-visible string.
  it("carries no Gantt view, shortcut or label", () => {
    renderTasks();
    expect(taskViewsSource).toMatch(/SHARED_TASK_VIEW_IDS = Object\.freeze\(\[\s*"board",\s*"list",\s*"calendar",\s*"timeline",\s*"progress",\s*"report",?\s*\]\)/);
    // No Ctrl+Shift+G. The only "gantt" the file may hold is the bare lucide
    // identifier `ChartNoAxesGantt` (and the prose explaining the omission) —
    // never a quoted string, which is what a view id, an i18n key or a label
    // would have to be.
    expect(tasksSource).toMatch(/ChartNoAxesGantt/);
    expect(tasksSource).not.toMatch(/VIEW_SHORTCUTS\s*=\s*\{[^}]*\bg\s*:/);
    expect(tasksSource).not.toMatch(/["'`][^"'`\n]*gantt[^"'`\n]*["'`]/i);
    for (const pill of within(screen.getByRole("group", { name: "Task views" })).getAllByRole("button")) {
      expect(pill.getAttribute("aria-label")).not.toMatch(/gantt/i);
      expect(pill.textContent).not.toMatch(/gantt/i);
    }
  });
});

function progressTask(overrides = {}) {
  return {
    id: "task-progress-1",
    chapterId: "wor",
    taskNumber: 1,
    title: "Progress fixture",
    description: "",
    status: "in_progress",
    priority: "medium",
    workstream: "Chapter",
    assigneeId: null,
    assigneeName: "",
    assigneeNames: [],
    startDate: null,
    dueDate: null,
    progress: 40,
    blocked: false,
    milestone: false,
    orderIndex: 10,
    createdBy: fallbackData.member.id,
    createdAt: "2026-08-01T09:00:00Z",
    updatedAt: "2026-08-01T09:00:00Z",
    ...overrides,
  };
}

function openProgress(tasks) {
  const data = structuredClone(fallbackData);
  data.tasks = tasks;
  renderTasks({ data });
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
}

function assigneeWorkload() {
  const heading = screen.getByRole("heading", { name: "Assignee workload" });
  const section = heading.closest("section");
  return [...section.querySelectorAll(".tasks-breakdown__row--person")].map((row) => ({
    name: row.querySelector("strong").textContent,
    count: Number.parseInt(row.querySelector("b").childNodes[0].textContent, 10),
  }));
}

describe("the Progress assignee workload table", () => {
  it("counts a co-assigned active task for every assignee, including a person whose only work is shared", () => {
    openProgress([
      progressTask({
        id: "shared",
        title: "Shared card",
        assigneeId: "ana",
        assigneeIds: ["ana", "beto"],
        assigneeName: "Ana",
        assigneeNames: ["Ana", "Beto"],
      }),
      progressTask({
        id: "ana-only",
        title: "Ana only",
        taskNumber: 2,
        assigneeId: "ana",
        assigneeIds: ["ana"],
        assigneeName: "Ana",
        assigneeNames: ["Ana"],
      }),
      progressTask({
        id: "nobody",
        title: "Unassigned card",
        taskNumber: 3,
        assigneeId: null,
        assigneeName: "",
        assigneeNames: [],
      }),
    ]);

    expect(assigneeWorkload()).toEqual([
      { name: "Ana", count: 2 },
      { name: "Beto", count: 1 },
      { name: "Unassigned", count: 1 },
    ]);
  });

  it("keeps single-assignee and unassigned counts identical to today's primary-assignee rows", () => {
    openProgress([
      progressTask({
        id: "ana-only",
        title: "Ana only",
        assigneeId: "ana",
        assigneeName: "Ana",
      }),
      progressTask({
        id: "beto-only",
        title: "Beto only",
        taskNumber: 2,
        assigneeId: "beto",
        assigneeName: "Beto",
      }),
      progressTask({
        id: "nobody",
        title: "Unassigned card",
        taskNumber: 3,
        assigneeId: null,
        assigneeName: "",
      }),
    ]);

    expect(assigneeWorkload()).toEqual([
      { name: "Ana", count: 1 },
      { name: "Beto", count: 1 },
      { name: "Unassigned", count: 1 },
    ]);
  });

  it("keeps distinct assignees who share a display name on their own rows", () => {
    openProgress([
      progressTask({
        id: "shared-homonym",
        title: "Shared homonym",
        assigneeId: "alex-1",
        assigneeIds: ["alex-1", "alex-2"],
        assigneeName: "Alex Lee",
        assigneeNames: ["Alex Lee", "Alex Lee"],
      }),
      progressTask({
        id: "alex-1-only",
        title: "Alex 1 only",
        taskNumber: 2,
        assigneeId: "alex-1",
        assigneeIds: ["alex-1"],
        assigneeName: "Alex Lee",
        assigneeNames: ["Alex Lee"],
      }),
    ]);

    expect(assigneeWorkload()).toEqual([
      { name: "Alex Lee", count: 2 },
      { name: "Alex Lee", count: 1 },
    ]);
  });
});

// #9514: the site audit's Board findings (A-28, A-38, B-46).
describe("the Board toolbar and empty columns (#9514)", () => {
  it("names one overflow assignee in the singular, in English and Spanish", () => {
    // Four assignees hold open tasks in the default scope; three circles show.
    const data = structuredClone(fallbackData);
    data.tasks = data.tasks.map((task) => ({ ...task, createdBy: data.member.id }));
    renderTasks({ data });
    expect(screen.getByRole("button", { name: "1 more worker" })).toBeInTheDocument();
    cleanup();
    renderTasks({ data }, "es");
    expect(screen.getByRole("button", { name: "1 persona más" })).toBeInTheDocument();
  });

  it("shows one New task in an empty column and keeps the second under a column's cards", () => {
    const data = structuredClone(fallbackData);
    data.workstreams = [{ id: "ws-empty", name: "Zeta outreach" }];
    renderTasks({ data });
    const columnOf = (name) => document.querySelector(`.kan-col[data-workstream="${name}"]`);
    expect(columnOf("Zeta outreach").querySelector("[data-task-id]")).toBeNull();
    expect(within(columnOf("Zeta outreach")).getAllByRole("button", { name: "New task" })).toHaveLength(1);
    expect(columnOf("Chapter").querySelector("[data-task-id]")).not.toBeNull();
    expect(within(columnOf("Chapter")).getAllByRole("button", { name: "New task" })).toHaveLength(2);
  });

  it("keeps the bottom New task box, its draft and focus when the column's last card leaves", async () => {
    const data = structuredClone(fallbackData);
    const card = { ...data.tasks.find((task) => task.status === "to_do"), workstream: "Solo", createdBy: data.member.id };
    data.tasks = [card];
    const props = renderProps({ data });
    const view = (next) => <LanguageProvider lang="en"><TasksView {...props} data={next} /></LanguageProvider>;
    const { rerender } = render(view(data));
    const column = () => document.querySelector('.kan-col[data-workstream="Solo"]');
    const rows = within(column()).getAllByRole("button", { name: "New task" });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]);
    const box = await within(column()).findByPlaceholderText("Task title…");
    fireEvent.change(box, { target: { value: "Call the stewards" } });
    await waitFor(() => expect(box).toHaveFocus());

    // A colleague deletes the card while the person is typing.
    rerender(view({ ...data, workstreams: [{ id: "ws-solo", name: "Solo" }], tasks: [] }));
    expect(column().querySelector("[data-task-id]")).toBeNull();
    expect(within(column()).getByPlaceholderText("Task title…")).toBe(box);
    expect(box).toHaveValue("Call the stewards");
    expect(box).toHaveFocus();

    // Cleared and closed, the empty column shows one New task.
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(within(column()).getAllByRole("button", { name: "New task" })).toHaveLength(1));
    expect(within(column()).queryByPlaceholderText("Task title…")).toBeNull();
  });

  it("wraps the tablet toolbar instead of scrolling its tools past the right edge (A-38)", () => {
    const stylesCss = readFileSync(join(root, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
    const tablet = stylesCss.match(/@media \(min-width: 721px\) and \(max-width: 1023px\) \{([\s\S]*?)\n\}/u);
    expect(tablet?.[1]).toMatch(/\.tasks-screen:not\(\.tasks-screen--desktop-work\) \.kan-topbar \{[^}]*flex-wrap:\s*wrap;[^}]*overflow-x:\s*visible;/u);
    // The range starts where the compact phone toolbar (720px and under) ends.
    expect(tasksSource).toContain("setCompactToolbar(window.innerWidth <= 720)");
  });
});

describe("the compact mobile toolbar", () => {
  it("keeps views and search primary while secondary tools collapse and expand", () => {
    const priorWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      renderTasks();
      const primary = document.querySelector(".kan-topbar__primary");
      expect(within(primary).getByRole("group", { name: "Task views" })).toBeInTheDocument();
      expect(within(primary).getByRole("textbox", { name: "Search tasks" })).toHaveAttribute("placeholder", "Search tasks");

      const secondary = document.querySelector(".kan-topbar__secondary");
      const toggle = screen.getByRole("button", { name: "Show more tools" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(secondary).toHaveAttribute("data-expanded", "false");
      expect(secondary).toHaveAttribute("inert");

      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: "Hide more tools" })).toHaveAttribute("aria-expanded", "true");
      expect(secondary).toHaveAttribute("data-expanded", "true");
      expect(secondary).not.toHaveAttribute("inert");
      expect(within(secondary).getByRole("button", { name: "Filter tasks" })).toBeInTheDocument();
      expect(within(secondary).getByRole("button", { name: "Board view settings" })).toBeInTheDocument();
      expect(screen.getByText("Scroll horizontally to see every column")).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: priorWidth });
    }
  });
});

describe("the live search", () => {
  it("filters cards as the member types", () => {
    renderTasks();
    expect(screen.getByText("Review chapter newsletter")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search tasks"), { target: { value: "outreach" } });
    expect(screen.getByText("Coworker outreach calls")).toBeInTheDocument();
    expect(screen.queryByText("Review chapter newsletter")).not.toBeInTheDocument();
  });

  // A task key pasted out of a chat message ("wor-3") has to find its card:
  // it matches no title, no description and no name, so without the key branch
  // the search box answers "no tasks match these filters" to the most precise
  // question a member can ask.
  it("resolves a pasted task key before the free-text fields", () => {
    renderTasks();
    fireEvent.change(screen.getByPlaceholderText("Search tasks"), { target: { value: "wor-3" } });
    expect(screen.getByText("Coworker outreach calls")).toBeInTheDocument();
    expect(screen.queryByText("Translate bargaining pulse")).not.toBeInTheDocument();
    // Upper case is the same card — deep links arrive lower-cased, humans type
    // either way.
    fireEvent.change(screen.getByPlaceholderText("Search tasks"), { target: { value: "WOR-3" } });
    expect(screen.getByText("Coworker outreach calls")).toBeInTheDocument();
  });
});

describe("board popover Escape ownership", () => {
  it.each(["Filter tasks", "Board view settings"])(
    "arms %s dismissal in the open commit before passive effects",
    async (name) => {
      const otherSurface = vi.fn();
      const unregister = registerEscapeLayer(otherSurface);
      let handled;
      let unhandled;
      let stayedOpen;
      let trigger;
      try {
        render(<LanguageProvider lang="en">
          <Profiler id="popover-commit" onRender={() => {
            const panel = trigger?.parentElement.querySelector('.kan-popover[data-state="open"]');
            if (handled || !panel) return;
            // Profiler observes the committed DOM in the layout phase. This
            // deterministically exercises input before passive effects run,
            // without racing requestAnimationFrame against waitFor's polling.
            handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
            document.body.dispatchEvent(handled);
            stayedOpen = trigger.getAttribute("aria-expanded");
            unregister();
            unhandled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
            document.body.dispatchEvent(unhandled);
          }}>
            <TasksView {...renderProps()} />
          </Profiler>
        </LanguageProvider>);
        trigger = screen.getByRole("button", { name });
        fireEvent.click(trigger);
        await waitFor(() => expect(unhandled).toBeDefined());
        expect(otherSurface).toHaveBeenCalledTimes(1);
        expect(handled.defaultPrevented).toBe(true);
        expect(stayedOpen).toBe("true");
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(unhandled.defaultPrevented).toBe(true);
      } finally {
        unregister();
      }
    },
  );

  it.each(["Filter tasks", "Board view settings", "1 more worker"])(
    "keeps %s open when another surface already handled Escape",
    async (name) => {
      const otherSurface = vi.fn();
      const unregister = registerEscapeLayer(otherSurface);
      try {
        renderTasks();
        if (name === "1 more worker") {
          fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
          fireEvent.click(screen.getByRole("button", { name: "All work 8" }));
          fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
        }
        const trigger = screen.getByRole("button", { name });
        fireEvent.click(trigger);
        await waitFor(() => expect(document.querySelector('.kan-popover[data-state="open"]')).not.toBeNull());
        const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        fireEvent(document.body, event);
        expect(otherSurface).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        unregister();
        fireEvent.keyDown(document.body, { key: "Escape" });
        expect(trigger).toHaveAttribute("aria-expanded", "false");
      } finally {
        unregister();
      }
    },
  );

  it("keeps a popover open when an inner surface stops Escape propagation", async () => {
    renderTasks();
    const trigger = screen.getByRole("button", { name: "Filter tasks" });
    fireEvent.click(trigger);
    const panel = screen.getByRole("group", { name: "Filter tasks" });
    await waitFor(() => expect(panel).toHaveAttribute("data-state", "open"));
    const stopEscape = (event) => event.stopPropagation();
    panel.addEventListener("keydown", stopEscape);
    try {
      fireEvent.keyDown(within(panel).getByRole("button", { name: "Clear filters" }), { key: "Escape" });
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    } finally {
      panel.removeEventListener("keydown", stopEscape);
    }
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

describe("board popover Escape ownership", () => {
  it.each(["Filter tasks", "Board view settings"])(
    "arms %s dismissal in the open commit before passive effects",
    async (name) => {
      const otherSurface = vi.fn();
      const unregister = registerEscapeLayer(otherSurface);
      let handled;
      let unhandled;
      let stayedOpen;
      let trigger;
      try {
        render(<LanguageProvider lang="en">
          <Profiler id="popover-commit" onRender={() => {
            const panel = trigger?.parentElement.querySelector('.kan-popover[data-state="open"]');
            if (handled || !panel) return;
            // Profiler observes the committed DOM in the layout phase. This
            // deterministically exercises input before passive effects run,
            // without racing requestAnimationFrame against waitFor's polling.
            handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
            document.body.dispatchEvent(handled);
            stayedOpen = trigger.getAttribute("aria-expanded");
            unregister();
            unhandled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
            document.body.dispatchEvent(unhandled);
          }}>
            <TasksView {...renderProps()} />
          </Profiler>
        </LanguageProvider>);
        trigger = screen.getByRole("button", { name });
        fireEvent.click(trigger);
        await waitFor(() => expect(unhandled).toBeDefined());
        expect(otherSurface).toHaveBeenCalledTimes(1);
        expect(handled.defaultPrevented).toBe(true);
        expect(stayedOpen).toBe("true");
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(unhandled.defaultPrevented).toBe(true);
      } finally {
        unregister();
      }
    },
  );

  it.each(["Filter tasks", "Board view settings", "1 more worker"])(
    "keeps %s open when another surface already handled Escape",
    async (name) => {
      const otherSurface = vi.fn();
      const unregister = registerEscapeLayer(otherSurface);
      try {
        renderTasks();
        if (name === "1 more worker") {
          fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
          fireEvent.click(screen.getByRole("button", { name: "All work 8" }));
          fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
        }
        const trigger = screen.getByRole("button", { name });
        fireEvent.click(trigger);
        await waitFor(() => expect(document.querySelector('.kan-popover[data-state="open"]')).not.toBeNull());
        const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        fireEvent(document.body, event);
        expect(otherSurface).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        unregister();
        fireEvent.keyDown(document.body, { key: "Escape" });
        expect(trigger).toHaveAttribute("aria-expanded", "false");
      } finally {
        unregister();
      }
    },
  );

  it("keeps a popover open when an inner surface stops Escape propagation", async () => {
    renderTasks();
    const trigger = screen.getByRole("button", { name: "Filter tasks" });
    fireEvent.click(trigger);
    const panel = screen.getByRole("group", { name: "Filter tasks" });
    await waitFor(() => expect(panel).toHaveAttribute("data-state", "open"));
    const stopEscape = (event) => event.stopPropagation();
    panel.addEventListener("keydown", stopEscape);
    try {
      fireEvent.keyDown(within(panel).getByRole("button", { name: "Clear filters" }), { key: "Escape" });
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    } finally {
      panel.removeEventListener("keydown", stopEscape);
    }
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

describe("the filter popover", () => {
  it("carries the scope chips with counts, priority, workstream and a clear-all", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
    const panel = screen.getByRole("group", { name: "Filter tasks" });

    // The counts are whole-board, so they answer "how much work would this
    // scope show me" before the member commits to the switch.
    const scopes = within(panel).getByRole("group", { name: "Show" });
    expect(within(scopes).getByRole("button", { name: "My work 6" })).toHaveAttribute("aria-pressed", "true");
    expect(within(scopes).getByRole("button", { name: "All work 8" })).toBeInTheDocument();
    expect(within(scopes).getByRole("button", { name: "Owned by me 4" })).toBeInTheDocument();
    expect(within(scopes).getByRole("button", { name: "Assigned to me 2" })).toBeInTheDocument();

    expect(within(panel).getByRole("group", { name: "Priority" })).toBeInTheDocument();
    expect(within(panel).getByRole("group", { name: "Workstream" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("keeps the old scope semantics now that the selects are chips", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
    expect(screen.queryByText("Clear issue intake backlog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All work 8" }));
    expect(screen.getByText("Clear issue intake backlog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Assigned to me 2" }));
    expect(screen.getByText("Prepare August campaign meeting")).toBeInTheDocument();
    expect(screen.queryByText("Translate bargaining pulse")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Owned by me 4" }));
    expect(screen.getByText("Translate bargaining pulse")).toBeInTheDocument();
    expect(screen.queryByText("Prepare August campaign meeting")).not.toBeInTheDocument();
  });

  it("filters by workstream and priority, and clear-all puts every control back", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Communications" }));
    expect(screen.getByText("Translate bargaining pulse")).toBeInTheDocument();
    expect(screen.queryByText("Coworker outreach calls")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(screen.queryByText("Translate bargaining pulse")).not.toBeInTheDocument();
    // A filter that matches nothing empties the COLUMNS and keeps them: the
    // composer lives in the column, so swapping the board for an empty-state
    // panel would take the create surface away with it.
    expect(document.querySelectorAll(".kan-card")).toHaveLength(0);
    expect(document.querySelectorAll(".kan-col").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "My work 6" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All workstreams" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All priorities" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Coworker outreach calls")).toBeInTheDocument();
  });
});

describe("the view-settings popover", () => {
  it("holds the Display-done switch, which collapses the done group behind a count", () => {
    renderTasks();
    expect(screen.getByText("Publish bargaining priorities poll")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
    const done = screen.getByRole("switch", { name: "Display done tasks" });
    expect(done).toHaveAttribute("aria-checked", "true");
    fireEvent.click(done);

    expect(screen.queryByText("Publish bargaining priorities poll")).not.toBeInTheDocument();
    // Hidden, not deleted: the column offers the reveal with its count.
    fireEvent.click(screen.getByRole("button", { name: "1 done hidden" }));
    expect(screen.getByText("Publish bargaining priorities poll")).toBeInTheDocument();
  });

  it("keeps the board light and removes theme choices even with a stale dark preference", () => {
    window.localStorage.setItem("sg-kan-theme", "dark");
    renderTasks();
    expect(document.querySelector(".tasks-screen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
    expect(screen.getByRole("switch", { name: "Display done tasks" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Theme" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dark" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Light" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("sg-kan-theme")).toBe("dark");
  });
});

describe("the create surface", () => {
  // The full create form and the duplicate plane-header action are retired.
  // Creation stays beside its lane; the keyboard shortcut still reaches the
  // first lane when a pointer is not convenient.
  it("opens the first column's inline composer from its lane and from `c`", async () => {
    optInCharacterShortcuts();
    renderTasks();
    // The ghost row IS the button — it has no button descendant — so the reach
    // has to select `button.kan-newtask`, not `.kan-newtask button`.
    expect(document.querySelector(".kan-board button.kan-newtask")).not.toBeNull();
    expect(document.querySelector(".kan-board .kan-newtask button")).toBeNull();

    fireEvent.click(firstLaneComposer());
    await waitFor(() => expect(
      screen.queryByPlaceholderText("Task title…"),
      "the lane New task button must open its composer",
    ).not.toBeNull());

    fireEvent.keyDown(screen.getByPlaceholderText("Task title…"), { key: "Escape" });
    expect(screen.queryByPlaceholderText("Task title…")).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "c" });
    await waitFor(() => expect(
      screen.queryByPlaceholderText("Task title…"),
      "the `c` shortcut must open the first column's composer",
    ).not.toBeNull());
  });

  it("requires only a title and supplies every Standard Task default", async () => {
    const props = renderTasks();
    fireEvent.click(firstLaneComposer());
    const input = await screen.findByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "  Confirm room access  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(props.onCreateTask).toHaveBeenCalledWith({
      title: "Confirm room access",
      description: "",
      status: "to_do",
      priority: "medium",
      taskType: "general",
      workstream: "Bargaining",
      assigneeId: null,
      startDate: null,
      dueDate: null,
      progress: 0,
      blocked: false,
      milestone: false,
      orderIndex: expect.any(Number),
    }));
  });

  it("keeps focused-workstream quick-create in To do", async () => {
    renderTasks();
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
    fireEvent.click(document.querySelector('[data-status="to_do"] button.kan-newtask'));

    const input = await screen.findByPlaceholderText("Task title…");
    expect(input.closest('[data-status="to_do"]')).not.toBeNull();
    expect(input.closest('[data-status="backlog"]')).toBeNull();
  });

  it("creates a Standard Task dated to the clicked calendar day", async () => {
    const props = renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    // Queried by its accessible name rather than [data-cal-date]: that attribute
    // now marks the column's decorative full-height cell, and the day control is
    // the 44 px button in the week's header row.
    fireEvent.click(screen.getByRole("button", { name: "Add calendar item on August 6, 2026" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Calendar item title" }), {
      target: { value: "Contract deadline" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));

    await waitFor(() => expect(props.onCreateTask).toHaveBeenCalledWith({
      title: "Contract deadline",
      description: "",
      status: "to_do",
      priority: "medium",
      taskType: "general",
      workstream: "Bargaining",
      assigneeId: null,
      startDate: "2026-08-06",
      dueDate: "2026-08-06",
      progress: 0,
      blocked: false,
      milestone: false,
      orderIndex: expect.any(Number),
    }));
  });

  it("opens the authoritative desktop Calendar result and writes its task key into the URL", async () => {
    const props = renderTasks({ desktopShell: true });
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
    const dateOpener = screen.getByRole("button", { name: "Add calendar item on August 6, 2026" });
    fireEvent.click(dateOpener);
    const title = screen.getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Desktop contract deadline" } });
    fireEvent.submit(title.closest("form"));

    await waitFor(() => expect(props.onCreateTask).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Task title")).toHaveValue("Desktop contract deadline");
    expect(new URLSearchParams(window.location.search).get("task")).toBe("wor-9");
    expect(screen.getAllByText("Added to Aug 6")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.queryByLabelText("Task title")).not.toBeInTheDocument());
    await waitFor(() => expect(dateOpener).toHaveFocus());
  });

  it("keeps the desktop Calendar draft and parent alert when creation returns null", async () => {
    const onCreateTask = vi.fn(async () => null);
    renderTasks({ desktopShell: true, onCreateTask });
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Add calendar item on August 6, 2026" }));
    const title = screen.getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Retryable desktop draft" } });
    title.focus();
    fireEvent.submit(title.closest("form"));

    await waitFor(() => expect(onCreateTask).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be saved.");
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveValue("Retryable desktop draft");
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveFocus();
    expect(screen.queryByText("Added to Aug 6")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("task")).toBe(false);
  });

  it("keeps the desktop Calendar draft and reports no-workstream creation without calling the writer", async () => {
    const data = structuredClone(fallbackData);
    data.tasks = [];
    data.workstreams = [];
    const onCreateTask = vi.fn();
    renderTasks({ desktopShell: true, data, onCreateTask });
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
    fireEvent.click(document.querySelector(".kan-cal__add-date"));
    const title = screen.getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "No workstream draft" } });
    title.focus();
    fireEvent.submit(title.closest("form"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Add a workstream first: open Board view and add one, then add this item again.");
    expect(onCreateTask).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveValue("No workstream draft");
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveFocus();
  });

  // Record #9469 (W6-6): off the desktop shell too, an item that was not
  // created keeps its title and says so, instead of announcing "Added".
  it("keeps the non-desktop Calendar title and says the item was not saved for a null result", async () => {
    const onCreateTask = vi.fn(async () => null);
    renderTasks({ onCreateTask });
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Add calendar item on August 6, 2026" }));
    const title = screen.getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Purple null result" } });
    fireEvent.submit(title.closest("form"));
    await waitFor(() => expect(onCreateTask).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be saved.");
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveValue("Purple null result");
    expect(screen.queryByText("Added to Aug 6")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("task")).toBe(false);
  });

  it("names the missing workstream off the desktop shell and keeps the title (#9469)", async () => {
    const data = structuredClone(fallbackData);
    data.tasks = [];
    data.workstreams = [];
    const onCreateTask = vi.fn();
    renderTasks({ data, onCreateTask }, "es");
    fireEvent.click(screen.getByRole("button", { name: "Calendario" }));
    fireEvent.click(screen.getByRole("button", { name: "Agregar elemento del calendario el 6 de agosto de 2026" }));
    const title = within(screen.getByRole("dialog")).getByRole("textbox");
    fireEvent.change(title, { target: { value: "Sin frente" } });
    fireEvent.submit(title.closest("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Primero agrega un frente de trabajo");
    expect(onCreateTask).not.toHaveBeenCalled();
    expect(title).toHaveValue("Sin frente");
  });

  it("renders the interactive calendar when the current filters have no items", () => {
    const data = structuredClone(fallbackData);
    data.tasks = [];
    renderTasks({ data });
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(screen.getByRole("region", { name: "Calendar" })).toBeInTheDocument();
    expect(document.querySelector("[data-cal-date]")).not.toBeNull();
  });
});

describe("the ?task deep link", () => {
  it("opens the modal on mount and clears the param on close, keeping the other params", async () => {
    // The share link is a query param on purpose: pathname routing here has no
    // params and navigate() resets scroll, so the modal writes the URL with
    // history.replaceState and has to leave demo/embed alone.
    window.history.replaceState({}, "", "/m/tasks?demo=1&task=wor-3");
    renderTasks();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: "Task title" })).toHaveValue("Coworker outreach calls");
    expect(document.title).toBe("WOR-3 · Union Ground");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(window.location.search).toBe("?demo=1");
    expect(document.title).toBe("Union Ground");
  });

  it("writes the key into the URL when a card is opened from the board", async () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Translate bargaining pulse" }));
    await screen.findByRole("dialog");
    expect(window.location.search).toBe("?task=wor-2");
  });
});

describe("the keyboard map", () => {
  it("sends / to the search box", () => {
    optInCharacterShortcuts();
    renderTasks();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByPlaceholderText("Search tasks")).toHaveFocus();
  });

  it("sends / to the host's find box when the alternate shell's Work page passes one", () => {
    optInCharacterShortcuts();
    const onFocusSearch = vi.fn();
    renderTasks({ onFocusSearch });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onFocusSearch).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText("Search tasks")).not.toHaveFocus();
  });

  it("opens the shortcuts dialog on ? and closes it on Escape", async () => {
    optInCharacterShortcuts();
    renderTasks();
    fireEvent.keyDown(document.body, { key: "?" });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Focus search")).toBeInTheDocument();
    expect(within(dialog).getByText("Focus workstream 1–9")).toBeInTheDocument();
    expect([...dialog.querySelectorAll("kbd")]
      .map((keycap) => keycap.textContent)
      .filter((keycap) => /^[BLTCDFPR]$/.test(keycap)))
      .toEqual(["B", "R"]);
    expect(within(dialog).getByRole("button", { name: "Close task editor" })).toHaveFocus();
    const isolated = outsideBackdropSiblings(dialog.closest(".kan-modal-backdrop"));
    expect(isolated.length).toBeGreaterThan(0);
    expect(isolated.every((node) => node.hasAttribute("inert"))).toBe(true);

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
    for (const node of isolated) {
      expect(node).not.toHaveAttribute("inert");
      expect(node).not.toHaveAttribute("aria-hidden");
    }
  });

  it("closes the shortcuts sheet on scrim mousedown and releases isolation", async () => {
    optInCharacterShortcuts();
    renderTasks();
    fireEvent.keyDown(document.body, { key: "?" });
    const backdrop = screen.getByRole("dialog", { name: "Keyboard shortcuts" }).closest(".kan-modal-backdrop");
    const isolated = outsideBackdropSiblings(backdrop);
    expect(isolated.some((node) => node.hasAttribute("inert"))).toBe(true);

    fireEvent.mouseDown(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
    for (const node of isolated) {
      expect(node).not.toHaveAttribute("inert");
      expect(node).not.toHaveAttribute("aria-hidden");
    }
  });

  // The sheet closes with the
  // prototype modal's 200 ms scrim fade. The file's matchMedia stub reports
  // reduced motion, so these turn it off.
  it("holds the shortcuts sheet through the 200 ms fade with focus and keys inside, then returns focus to its opener", async () => {
    allowMotion();
    optInCharacterShortcuts();
    renderTasks();
    const settings = screen.getByRole("button", { name: "Board view settings" });
    fireEvent.click(settings);
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const backdrop = dialog.closest(".kan-modal-backdrop");
    const close = within(dialog).getByRole("button", { name: "Close task editor" });
    expect(close).toHaveFocus();
    expect(backdrop).not.toHaveAttribute("data-state");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(backdrop).toHaveAttribute("data-state", "closing");
    expect(close).toHaveFocus();
    // Mid-fade the sheet still owns the keyboard: a second Escape, a scrim
    // press and the view chords change nothing.
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.mouseDown(backdrop);
    fireEvent.click(close);
    fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("region", { name: "List" })).not.toBeInTheDocument();
    expect(outsideBackdropSiblings(backdrop).some((node) => node.hasAttribute("inert"))).toBe(true);
    fireEvent.transitionEnd(dialog);
    expect(backdrop.isConnected).toBe(true);

    fireEvent.transitionEnd(backdrop);
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
    expect(settings).toHaveFocus();
  });

  it("closes the shortcuts sheet on the fallback timer when no transition ends", async () => {
    allowMotion();
    optInCharacterShortcuts();
    renderTasks();
    fireEvent.keyDown(document.body, { key: "?" });
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Keyboard shortcuts" }).closest(".kan-modal-backdrop"));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
  });

  it("holds the template picker through the 200 ms fade, then returns focus to its trigger; reduced motion closes it at once", () => {
    allowMotion();
    renderTasks({ staffAccess: true, onCreateTaskFromTemplate: vi.fn() });
    const trigger = screen.getByRole("button", { name: "Use a template" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Use a task template" });
    const backdrop = dialog.closest(".task-template-backdrop");
    const close = within(dialog).getByRole("button", { name: "Close template chooser" });
    close.focus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(backdrop).toHaveAttribute("data-state", "closing");
    expect(close).toHaveFocus();
    fireEvent.mouseDown(backdrop);
    fireEvent.transitionEnd(backdrop);
    expect(screen.queryByRole("dialog", { name: "Use a task template" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    reduceMotionAgain();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Use a task template" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Use a task template" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("switches views on Ctrl+Shift+letter", () => {
    renderTasks();
    fireEvent.keyDown(document.body, { key: "L", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "List" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "C", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: "Calendar" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Calendar" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
  });

  // Ctrl+1..9 focuses the Nth workstream; Escape leaves focus mode, but ONLY
  // because no overlay claimed the press first — every overlay owns its own
  // Escape and preventDefaults it.
  it("enters focus mode on Ctrl+1 and leaves it on Escape", () => {
    renderTasks();
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
    const bar = document.querySelector(".kan-focus-bar");
    expect(bar).not.toBeNull();
    expect(within(bar).getByText("Bargaining")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /Exit focus mode/ })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.querySelector(".kan-focus-bar")).toBeNull();
  });

  it("keeps focus mode when the opening Calendar composer claims Escape", async () => {
    renderTasks();
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
    expect(within(document.querySelector(".kan-focus-bar")).getByText("Bargaining")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    const opener = screen.getByRole("button", { name: "Add calendar item on August 6, 2026" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: /Add calendar item on August 6/ });
    expect(dialog).toHaveAttribute("data-state", "opening");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Add calendar item on August 6/ })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    const focusBar = document.querySelector(".kan-focus-bar");
    expect(focusBar).not.toBeNull();
    expect(within(focusBar).getByText("Bargaining")).toBeInTheDocument();
  });

  it("ignores the map while the member is typing", () => {
    optInCharacterShortcuts();
    renderTasks();
    const search = screen.getByPlaceholderText("Search tasks");
    fireEvent.change(search, { target: { value: "wor" } });
    fireEvent.keyDown(search, { key: "?" });
    // A "?" typed into the search field is a search term, not a shortcut.
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });
});

describe("single-character task shortcuts (A11Y-UG-TASK-CHARACTER-SHORTCUTS-20261013)", () => {
  const copy = {
    en: {
      search: "Search tasks",
      composer: "Task title…",
      settings: "Board view settings",
      toggle: "Single-character shortcuts (/, c, ?)",
      help: "Keyboard shortcuts",
      off: "Single-character shortcuts are off. Turn them on in Board view settings.",
      on: "Single-character shortcuts are on. Turn them off in Board view settings.",
    },
    es: {
      search: "Buscar tareas",
      composer: "Título de la tarea…",
      settings: "Ajustes del tablero",
      toggle: "Atajos de un solo carácter (/, c, ?)",
      help: "Atajos de teclado",
      off: "Los atajos de un solo carácter están desactivados. Actívalos en Ajustes del tablero.",
      on: "Los atajos de un solo carácter están activados. Desactívalos en Ajustes del tablero.",
    },
  };

  function pressCharacterKeys(target) {
    for (const key of ["/", "?", "c"]) fireEvent.keyDown(target, { key });
  }

  function expectCharacterKeysInactive(lang, focused) {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(copy[lang].search)).not.toHaveFocus();
    expect(screen.queryByPlaceholderText(copy[lang].composer)).not.toBeInTheDocument();
    if (focused) expect(focused).toHaveFocus();
  }

  function toggleCharacterShortcuts(lang) {
    fireEvent.click(screen.getByRole("button", { name: copy[lang].settings }));
    const toggle = screen.getByRole("switch", { name: copy[lang].toggle });
    fireEvent.click(toggle);
    const checked = toggle.getAttribute("aria-checked");
    fireEvent.click(screen.getByRole("button", { name: copy[lang].settings }));
    return checked;
  }

  for (const lang of ["en", "es"]) {
    it(`bare c, slash and question mark are inactive by default on body and unrelated toolbar focus [${lang}]`, () => {
      renderTasks({}, lang);
      pressCharacterKeys(document.body);
      expectCharacterKeysInactive(lang);

      const settings = screen.getByRole("button", { name: copy[lang].settings });
      settings.focus();
      pressCharacterKeys(settings);
      expectCharacterKeysInactive(lang, settings);
      expect(window.localStorage.getItem(characterShortcutKey())).toBeNull();
      // The search field does not advertise a key that is switched off.
      expect(screen.getByPlaceholderText(copy[lang].search).parentElement.querySelector("kbd")).toBeNull();
    });

    it(`the visible preference enables character keys and disabling survives reload [${lang}]`, async () => {
      const first = render(<LanguageProvider lang={lang}><TasksView {...renderProps()} /></LanguageProvider>);
      expect(toggleCharacterShortcuts(lang)).toBe("true");
      expect(window.localStorage.getItem(characterShortcutKey())).toBe("true");
      expect(screen.getByPlaceholderText(copy[lang].search).parentElement.querySelector("kbd")).toHaveTextContent("/");

      fireEvent.keyDown(document.body, { key: "/" });
      expect(screen.getByPlaceholderText(copy[lang].search)).toHaveFocus();
      screen.getByPlaceholderText(copy[lang].search).blur();
      fireEvent.keyDown(document.body, { key: "c" });
      expect(await screen.findByPlaceholderText(copy[lang].composer)).toBeInTheDocument();
      fireEvent.keyDown(screen.getByPlaceholderText(copy[lang].composer), { key: "Escape" });
      fireEvent.keyDown(document.body, { key: "?" });
      const dialog = screen.getByRole("dialog", { name: copy[lang].help });
      expect(within(dialog).getByText(copy[lang].on)).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      expect(toggleCharacterShortcuts(lang)).toBe("false");
      expect(window.localStorage.getItem(characterShortcutKey())).toBe("false");
      first.unmount();

      render(<LanguageProvider lang={lang}><TasksView {...renderProps()} /></LanguageProvider>);
      fireEvent.click(screen.getByRole("button", { name: copy[lang].settings }));
      expect(screen.getByRole("switch", { name: copy[lang].toggle })).toHaveAttribute("aria-checked", "false");
      fireEvent.click(screen.getByRole("button", { name: copy[lang].settings }));
      pressCharacterKeys(document.body);
      expectCharacterKeysInactive(lang);
    });

    it(`keyboard shortcuts help remains reachable while character keys are off [${lang}]`, async () => {
      renderTasks({}, lang);
      const settings = screen.getByRole("button", { name: copy[lang].settings });
      settings.focus();
      fireEvent.click(settings);
      const helpButton = within(screen.getByRole("group", { name: copy[lang].settings }))
        .getByRole("button", { name: copy[lang].help });
      helpButton.focus();
      fireEvent.click(helpButton);
      const dialog = screen.getByRole("dialog", { name: copy[lang].help });
      expect(within(dialog).getByText(copy[lang].off)).toBeInTheDocument();
      // The help entrance lives in the popover so the toolbar keeps its width.
      expect(document.querySelector(".kan-topbar > * > button[aria-label='" + copy[lang].help + "']")).toBeNull();

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(settings).toHaveFocus());
    });
  }

  it("demo opt-in survives remounts in session storage and resets for a new session", () => {
    const demoKey = "sg:demo:task-character-shortcuts";
    window.sessionStorage.removeItem(demoKey);
    optInCharacterShortcuts();
    const first = render(<LanguageProvider lang="en"><TasksView {...renderProps({ demo: true })} /></LanguageProvider>);
    pressCharacterKeys(document.body);
    expectCharacterKeysInactive("en");
    expect(toggleCharacterShortcuts("en")).toBe("true");
    expect(window.sessionStorage.getItem(demoKey)).toBe("true");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByPlaceholderText("Search tasks")).toHaveFocus();
    screen.getByPlaceholderText("Search tasks").blur();
    expect(toggleCharacterShortcuts("en")).toBe("false");
    // A demo visitor cannot overwrite a real member's setting.
    expect(window.localStorage.getItem(characterShortcutKey())).toBe("true");
    expect(toggleCharacterShortcuts("en")).toBe("true");
    first.unmount();
    const second = render(<LanguageProvider lang="en"><TasksView {...renderProps({ demo: true })} /></LanguageProvider>);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByPlaceholderText("Search tasks")).toHaveFocus();
    second.unmount();
    // A fresh tab/browser session has no previous demo session-storage key.
    window.sessionStorage.removeItem(demoKey);
    renderTasks({ demo: true });
    pressCharacterKeys(document.body);
    expectCharacterKeysInactive("en");
  });

  it("keeps a failed shortcuts-off write across Tasks remounts without affecting another member", () => {
    optInCharacterShortcuts();
    const write = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (this === window.localStorage && key === characterShortcutKey()) throw new Error("write denied");
      return write.call(this, key, value);
    });
    try {
      const first = render(<LanguageProvider lang="en"><TasksView {...renderProps()} /></LanguageProvider>);
      expect(toggleCharacterShortcuts("en")).toBe("false");
      expect(window.localStorage.getItem(characterShortcutKey())).toBe("true");
      first.unmount();
      const second = render(<LanguageProvider lang="en"><TasksView {...renderProps()} /></LanguageProvider>);
      pressCharacterKeys(document.body);
      expectCharacterKeysInactive("en");
      const otherData = structuredClone(fallbackData);
      otherData.member.id = "33333333-3333-4333-8333-333333333333";
      window.localStorage.setItem(characterShortcutKey(otherData.member.id), "true");
      second.rerender(<LanguageProvider lang="en"><TasksView {...renderProps({ data: otherData })} /></LanguageProvider>);
      fireEvent.keyDown(document.body, { key: "/" });
      expect(screen.getByPlaceholderText("Search tasks")).toHaveFocus();
      screen.getByPlaceholderText("Search tasks").blur();
      second.rerender(<LanguageProvider lang="en"><TasksView {...renderProps()} /></LanguageProvider>);
      pressCharacterKeys(document.body);
      expectCharacterKeysInactive("en");
    } finally {
      setItem.mockRestore();
    }
  });

  it("another member never inherits this member's shortcut preference", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    optInCharacterShortcuts();
    const view = render(<LanguageProvider lang="en"><TasksView {...renderProps()} /></LanguageProvider>);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByPlaceholderText("Search tasks")).toHaveFocus();
    screen.getByPlaceholderText("Search tasks").blur();

    const otherData = structuredClone(fallbackData);
    otherData.member.id = other;
    view.rerender(<LanguageProvider lang="en"><TasksView {...renderProps({ data: otherData })} /></LanguageProvider>);
    pressCharacterKeys(document.body);
    expectCharacterKeysInactive("en");
    expect(window.localStorage.getItem(characterShortcutKey(other))).toBeNull();

    view.rerender(<LanguageProvider lang="en"><TasksView {...renderProps()} /></LanguageProvider>);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByPlaceholderText("Search tasks")).toHaveFocus();
  });

  it("falls back to off when storage is unavailable and still honors the switch for the visit", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      // The member's Keyboard shortcuts choice, made this visit, is unsaved too.
      setKeyboardShortcutsEnabled(true);
      renderTasks();
      pressCharacterKeys(document.body);
      expectCharacterKeysInactive("en");
      expect(toggleCharacterShortcuts("en")).toBe("true");
      fireEvent.keyDown(document.body, { key: "/" });
      expect(screen.getByPlaceholderText("Search tasks")).toHaveFocus();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("typing targets and open modals suppress optional shortcuts; view and focus chords still work", async () => {
    optInCharacterShortcuts();
    renderTasks();
    const search = screen.getByPlaceholderText("Search tasks");
    search.focus();
    pressCharacterKeys(search);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Task title…")).not.toBeInTheDocument();
    search.blur();

    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.keyDown(document.body, { key: "c" });
    expect(screen.queryByPlaceholderText("Task title…")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    window.localStorage.removeItem(characterShortcutKey());
    cleanup();
    renderTasks();
    fireEvent.keyDown(document.body, { key: "L", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("region", { name: "List" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
    expect(document.querySelector(".kan-focus-bar")).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.querySelector(".kan-focus-bar")).toBeNull();
  });
});

describe("the assignee quick-filter strip", () => {
  it("hides when the current view has no open filtered tasks", () => {
    const data = structuredClone(fallbackData);
    data.taskAssignees = [
      ...data.taskAssignees,
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `idle-${index}`,
        fullName: `Idle Member ${index}`,
        initials: "IM",
      })),
    ];
    data.tasks = data.tasks.map((task) => ({ ...task, status: "done" }));
    renderTasks({ data });
    expect(screen.queryByRole("group", { name: "Filter by assignee" })).not.toBeInTheDocument();
    expect(screen.queryByText("+12")).not.toBeInTheDocument();
  });

  it("counts overflow from open people in the current scope, not the idle roster", () => {
    const data = structuredClone(fallbackData);
    data.taskAssignees = [
      ...data.taskAssignees,
      { id: "idle-roster", fullName: "Idle Roster", initials: "IR" },
    ];
    renderTasks({ data });
    fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "All work 8" }));
    const strip = screen.getByRole("group", { name: "Filter by assignee" });
    expect(within(strip).getByLabelText("1 more worker")).toBeInTheDocument();
    expect(within(strip).getByText("+1")).toBeInTheDocument();
    expect(within(strip).queryByText("+2")).not.toBeInTheDocument();
  });

  it("ignores people who only have work outside the current scope and survives an assignee filter", () => {
    renderTasks();
    const strip = screen.getByRole("group", { name: "Filter by assignee" });
    expect(within(strip).queryByLabelText("Jordan Lee")).not.toBeInTheDocument();
    expect(within(strip).queryByText("+1")).not.toBeInTheDocument();
    fireEvent.click(within(strip).getByRole("button", { name: "Darnell Foster" }));
    expect(screen.getByRole("group", { name: "Filter by assignee" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Filter by assignee" })).getByRole("button", { name: "Darnell Foster" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("group", { name: "Filter by assignee" })).getByRole("button", { name: "Maria Santos" })).toBeInTheDocument();
  });
});

describe("the Spanish chrome", () => {
  it("names every popover entrance in the member's language", () => {
    renderTasks({}, "es");
    expect(screen.getByRole("button", { name: "Tablero" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("Buscar tareas")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Filtrar tareas" }));
    expect(screen.getByRole("button", { name: "Mi trabajo 6" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Ajustes del tablero" }));
    expect(screen.getByRole("switch", { name: "Mostrar tareas terminadas" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Tema" })).not.toBeInTheDocument();
  });
});
