import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import {
  applyDeviceParityState,
  deviceParitySnapshot,
} from "../src/lib/deviceParity.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  desktopWorkViewLabelsFit,
  desktopWorkViewWidth,
  TasksView,
} from "../src/views/TasksView.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(join(root, "src/App.jsx"), "utf8");

const EN_DESKTOP_VIEWS = [
  "Board",
  "List",
  "Timeline",
  "Calendar",
  "Deadlines",
  "Field notes",
  "Progress",
  "Report",
];
const EN_COMPANION_VIEWS = ["Board", "List", "Calendar", "Timeline", "Progress", "Report"];

const realMatchMedia = window.matchMedia;
const realStartViewTransition = document.startViewTransition;

function setMedia({ wide = true, reduced = false } = {}) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query.includes("prefers-reduced-motion") ? reduced : wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

beforeEach(() => {
  setMedia();
  window.history.replaceState({}, "", "/m/tasks");
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  document.startViewTransition = realStartViewTransition;
  window.history.replaceState({}, "", "/m/tasks");
  document.title = "Union Ground";
});

function taskProps(overrides = {}) {
  return {
    data: structuredClone(fallbackData),
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onCreateTask: vi.fn(async (fields) => ({
      ...fields,
      id: "new-task",
      taskNumber: 9,
      createdAt: "2026-08-15T09:00:00Z",
      updatedAt: "2026-08-15T09:00:00Z",
    })),
    onUpdateTask: vi.fn(async (_id, fields) => fields),
    onDeleteTask: vi.fn(async () => ({ deleted: true })),
    onSendTaskMessage: vi.fn(async () => null),
    onAddTaskComment: vi.fn(async () => ({ id: "task-comment-new" })),
    ...overrides,
  };
}

function renderTasks({ desktopShell = false, lang = "en", ...overrides } = {}) {
  const props = taskProps({ desktopShell, ...overrides });
  const rendered = render(
    <LanguageProvider lang={lang}>
      <TasksView {...props} />
    </LanguageProvider>,
  );
  return { ...rendered, props };
}

function labels(group) {
  return [...group.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
}

describe("desktop Work view contract", () => {
  it("clamps all eight tab widths from the rendered toolbar content box", () => {
    expect(desktopWorkViewWidth(Number.NaN)).toBe(44);
    expect(desktopWorkViewWidth(440)).toBe(44);
    expect(desktopWorkViewWidth(592)).toBe(63);
    expect(desktopWorkViewWidth(1016)).toBe(116);
    expect(desktopWorkViewWidth(1336)).toBe(156);
    expect(desktopWorkViewWidth(1920)).toBe(156);
  });

  // #9514: at 1680px the secondary tools (assignees, Filter tasks, Use a
  // template) were drawn over the tab strip, which overflowed a 680px primary
  // box that shared its row.
  it("gives the tab strip a row no toolbar box can share", () => {
    // The strip is the whole bar less 88px, too narrow a gap for any tool box.
    for (const content of [904, 1322]) expect(desktopWorkViewWidth(content) * 8).toBe(content - 88);
    const stylesCss = readFileSync(join(root, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
    const rules = (selector) => [...stylesCss.matchAll(/([^{}]+)\{([^}]*)\}/gu)]
      .filter(([, selectors]) => selectors.split(",").some((item) => item.trim() === selector))
      .map(([, , body]) => body);
    const primary = rules(".tasks-screen--desktop-work .kan-topbar__primary");
    expect(primary.join(";")).toMatch(/display:\s*contents/u);
    expect(primary.join(";")).not.toMatch(/\bflex(?:-basis)?:/u);
    expect(rules(".tasks-screen--desktop-work .kan-views").join(";")).toMatch(/flex:\s*0 0 auto/u);
  });

  it("shows desktop labels only when every rendered localized label fits its measured tab", () => {
    const english = Array.from(
      { length: 8 },
      () => ({ allocatedWidth: 114, labelWidth: 67, chromeWidth: 47 }),
    );
    const spanish = [
      ...english.slice(0, -1),
      { allocatedWidth: 140, labelWidth: 93.75, chromeWidth: 47 },
    ];
    expect(desktopWorkViewLabelsFit([], 8)).toBe(false);
    expect(desktopWorkViewLabelsFit(english.slice(0, -1), 8)).toBe(false);
    expect(desktopWorkViewLabelsFit([...english, undefined], 9)).toBe(false);
    expect(desktopWorkViewLabelsFit(english, 8)).toBe(true);
    expect(desktopWorkViewLabelsFit(spanish, 8)).toBe(false);
    expect(desktopWorkViewLabelsFit(
      spanish.map((measurement) => ({ ...measurement, allocatedWidth: 140.75 })),
      8,
    )).toBe(true);
    expect(desktopWorkViewLabelsFit(
      spanish.map((measurement) => ({ ...measurement, allocatedWidth: 156 })),
      8,
    )).toBe(true);
  });

  it("renders the exact eight direct desktop controls while the companion keeps its exact six", () => {
    const desktop = renderTasks({ desktopShell: true });
    const desktopGroup = within(desktop.container).getByRole("tablist", { name: "Task views" });
    expect(labels(desktopGroup)).toEqual(EN_DESKTOP_VIEWS);
    expect(within(desktopGroup).getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
    expect(within(desktop.container).getByRole("heading", { level: 1 })).toHaveTextContent("Work");
    expect(within(desktop.container).getByText("Board, lists, task schedules, deadlines, field notes, progress and reports"))
      .toBeInTheDocument();
    expect(within(desktop.container).getAllByRole("tab")).toHaveLength(8);
    expect(within(desktop.container).getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tasks-tab-board");
    expect(desktopGroup.querySelectorAll(".kan-views__indicator")).toHaveLength(1);
    expect(desktopGroup.querySelectorAll('.kan-pill__measure[aria-hidden="true"]')).toHaveLength(8);

    desktop.unmount();
    const companion = renderTasks();
    const companionGroup = within(companion.container).getByRole("group", { name: "Task views" });
    expect(labels(companionGroup)).toEqual(EN_COMPANION_VIEWS);
    expect(within(companion.container).getByRole("heading", { level: 1 }))
      .toHaveTextContent("Move the work together");
    expect(within(companion.container).queryByRole("button", { name: "Deadlines" })).not.toBeInTheDocument();
    expect(within(companion.container).queryByRole("button", { name: "Field notes" })).not.toBeInTheDocument();
  });

  it("keeps Purple roving focus, pressed semantics, moving indicator, and ViewTransition motion", async () => {
    const transition = vi.fn((update) => {
      update();
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: Promise.resolve(),
      };
    });
    document.startViewTransition = transition;
    const { container } = renderTasks({ desktopShell: true });
    const group = within(container).getByRole("tablist", { name: "Task views" });
    const board = within(group).getByRole("tab", { name: "Board" });
    const list = within(group).getByRole("tab", { name: "List" });
    const report = within(group).getByRole("tab", { name: "Report" });

    expect(board).toHaveAttribute("tabindex", "0");
    expect(list).toHaveAttribute("tabindex", "-1");
    board.focus();
    fireEvent.keyDown(board, { key: "ArrowRight" });
    expect(list).toHaveFocus();
    expect(list).toHaveAttribute("tabindex", "0");
    expect(board).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(list, { key: "End" });
    expect(report).toHaveFocus();
    fireEvent.keyDown(report, { key: "Enter" });
    await waitFor(() => expect(report).toHaveAttribute("aria-selected", "true"));
    expect(transition).toHaveBeenCalledTimes(1);
    expect(group).toHaveStyle({ "--kan-view-index": "7" });
  });

  it("adds D/F desktop shortcuts and honors reduced motion", async () => {
    const transition = vi.fn((update) => {
      update();
      return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: Promise.resolve() };
    });
    document.startViewTransition = transition;
    const desktop = renderTasks({ desktopShell: true });

    fireEvent.click(within(desktop.container).getByRole("button", { name: "Board view settings" }));
    fireEvent.click(within(desktop.container).getByRole("button", { name: "Keyboard shortcuts" }));
    const shortcutDialog = within(desktop.container).getByRole("dialog", { name: "Keyboard shortcuts" });
    expect([...shortcutDialog.querySelectorAll("kbd")]
      .map((keycap) => keycap.textContent)
      .filter((keycap) => /^[BLTCDFPR]$/.test(keycap)))
      .toEqual(["B", "L", "T", "C", "D", "F", "P", "R"]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    // The sheet keeps the keyboard through its 200 ms close fade.
    fireEvent.transitionEnd(shortcutDialog.parentElement);
    expect(within(desktop.container).queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();

    fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });
    expect(await within(desktop.container).findByRole("region", { name: "Deadlines" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });
    expect(await within(desktop.container).findByRole("region", { name: "Field notes" })).toBeInTheDocument();
    expect(transition).toHaveBeenCalledTimes(2);

    desktop.unmount();
    setMedia({ reduced: true });
    const reduced = renderTasks({ desktopShell: true });
    fireEvent.click(within(reduced.container).getByRole("tab", { name: "Deadlines" }));
    expect(within(reduced.container).getByRole("region", { name: "Deadlines" })).toBeInTheDocument();
    expect(transition).toHaveBeenCalledTimes(2);
  });

  it("isolates desktop-only view/focus state and mirrors only common IDs", async () => {
    const desktop = renderTasks({ desktopShell: true });
    const companion = renderTasks();
    const desktopGroup = within(desktop.container).getByRole("tablist", { name: "Task views" });
    const companionGroup = within(companion.container).getByRole("group", { name: "Task views" });

    fireEvent.click(within(desktopGroup).getByRole("tab", { name: "Field notes" }));
    expect(within(desktopGroup).getByRole("tab", { name: "Field notes" })).toHaveAttribute("aria-selected", "true");
    expect(within(companionGroup).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(deviceParitySnapshot()).not.toContainEqual({ key: "tasks.view", value: "field_notes" });

    fireEvent.click(within(desktopGroup).getByRole("tab", { name: "List" }));
    await waitFor(() => expect(within(companionGroup).getByRole("button", { name: "List" }))
      .toHaveAttribute("aria-pressed", "true"));
    expect(deviceParitySnapshot()).toContainEqual({ key: "tasks.view", value: "list" });

    fireEvent.click(within(companionGroup).getByRole("button", { name: "Calendar" }));
    await waitFor(() => expect(within(desktopGroup).getByRole("tab", { name: "Calendar" }))
      .toHaveAttribute("aria-selected", "true"));
  });

  it("falls back to Board instead of blanking when a stale desktop-only ID reaches non-desktop", () => {
    applyDeviceParityState("tasks.view", "deadlines");
    applyDeviceParityState("tasks.focusedView", "field_notes");
    const { container } = renderTasks();
    const group = within(container).getByRole("group", { name: "Task views" });
    expect(within(group).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Board" })).toHaveAttribute("tabindex", "0");
    expect(within(container).getByRole("button", { name: "Prepare August campaign meeting" })).toBeInTheDocument();
  });

  it("shows an unavailable warning instead of a false empty comment history on non-desktop", () => {
    const data = structuredClone(fallbackData);
    data.taskComments = [];
    data.taskCommentsUnavailable = true;
    const { container } = renderTasks({ data });

    fireEvent.click(within(container).getByRole("button", { name: "Prepare August campaign meeting" }));
    fireEvent.click(within(container).getByRole("button", { name: "Comments" }));
    expect(within(container).getByRole("alert")).toHaveTextContent(
      "Task updates are unavailable. Retry before treating this history as complete.",
    );
    expect(within(container).queryByText("No task updates yet.")).not.toBeInTheDocument();
  });

  it("preserves a private desktop selection across a temporary non-desktop resize", () => {
    const props = taskProps({ desktopShell: true });
    const rendered = render(
      <LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>,
    );
    fireEvent.click(within(rendered.container).getByRole("tab", { name: "Field notes" }));
    expect(within(rendered.container).getByRole("region", { name: "Field notes" })).toBeInTheDocument();

    rendered.rerender(
      <LanguageProvider lang="en"><TasksView {...props} desktopShell={false} /></LanguageProvider>,
    );
    expect(within(rendered.container).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(within(rendered.container).getByRole("region", { name: "Board" })).toBeInTheDocument();

    rendered.rerender(
      <LanguageProvider lang="en"><TasksView {...props} desktopShell /></LanguageProvider>,
    );
    expect(within(rendered.container).getByRole("tab", { name: "Field notes" })).toHaveAttribute("aria-selected", "true");
    expect(within(rendered.container).getByRole("region", { name: "Field notes" })).toBeInTheDocument();
  });

  it("wires App's actual desktop-shell decision into TasksView", () => {
    expect(appSource).toMatch(/<TasksView[\s\S]*?desktopShell=\{desktopShell\}/);
  });

  it("lets desktop List and Timeline own their empty states without suppressing non-desktop generics", () => {
    const emptyData = structuredClone(fallbackData);
    emptyData.tasks = [];

    const desktop = renderTasks({ desktopShell: true, data: emptyData });
    fireEvent.click(within(desktop.container).getByRole("tab", { name: "List" }));
    expect(desktop.container.querySelectorAll(".kan-list__empty")).toHaveLength(1);
    expect(desktop.container.querySelector(".tasks-empty")).toBeNull();
    expect(within(desktop.container).getByRole("button", { name: "New task" })).toBeVisible();

    fireEvent.click(within(desktop.container).getByRole("tab", { name: "Timeline" }));
    expect(desktop.container.querySelectorAll(".kan-timeline__empty")).toHaveLength(1);
    expect(desktop.container.querySelector(".tasks-empty")).toBeNull();
    expect(within(desktop.container).getByRole("region", { name: "Task timeline" })).toBeInTheDocument();
    expect(within(desktop.container).getByRole("button", { name: "New task" })).toBeVisible();

    desktop.unmount();
    const companion = renderTasks({ data: emptyData });
    fireEvent.click(within(companion.container).getByRole("button", { name: "List" }));
    expect(companion.container.querySelectorAll(".tasks-empty")).toHaveLength(1);
    expect(companion.container.querySelector(".kan-list__empty")).toBeNull();
    expect(within(companion.container).getByRole("button", { name: "New task" })).toBeVisible();

    fireEvent.click(within(companion.container).getByRole("button", { name: "Timeline" }));
    expect(companion.container.querySelectorAll(".tasks-empty")).toHaveLength(1);
    expect(companion.container.querySelector(".kan-timeline__empty")).toBeNull();
    expect(within(companion.container).queryByRole("region", { name: "Task timeline" })).not.toBeInTheDocument();
  });
});

describe("smallest honest backed desktop-only views", () => {
  it("derives Deadlines from filtered tasks and opens the existing task modal", () => {
    const { container } = renderTasks({ desktopShell: true });
    fireEvent.click(within(container).getByRole("tab", { name: "Deadlines" }));
    const deadlines = within(container).getByRole("region", { name: "Deadlines" });
    expect(within(deadlines).getByText("Prepare August campaign meeting")).toBeInTheDocument();
    expect(within(deadlines).getByText("Aug 31")).toBeInTheDocument();

    fireEvent.click(within(deadlines).getByRole("button", { name: "Open task: Prepare August campaign meeting" }));
    expect(screen.getByLabelText("Task title")).toHaveValue("Prepare August campaign meeting");
  });

  it("keeps current filters live in Deadlines and provides a real create path for an empty result", () => {
    const { container } = renderTasks({ desktopShell: true });
    fireEvent.click(within(container).getByRole("tab", { name: "Deadlines" }));
    fireEvent.change(within(container).getByPlaceholderText("Search tasks"), {
      target: { value: "no task can match this" },
    });
    const deadlines = within(container).getByRole("region", { name: "Deadlines" });
    expect(within(deadlines).getByText("No dated tasks match these filters.")).toBeInTheDocument();
    fireEvent.click(within(deadlines).getByRole("button", { name: "New task" }));
    expect(within(container).getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
  });

  it("indexes existing authorized task comments as text and reaches the existing append path", async () => {
    const onAddTaskComment = vi.fn(async () => ({ id: "task-comment-new" }));
    const { container } = renderTasks({ desktopShell: true, onAddTaskComment });
    fireEvent.click(within(container).getByRole("tab", { name: "Field notes" }));
    const notes = within(container).getByRole("region", { name: "Field notes" });
    const noteBody = within(notes).getByText("Room confirmation is complete. Agenda review is next.");
    expect(noteBody).toBeInTheDocument();
    expect(noteBody.closest("button")).toBeNull();
    expect(within(notes).getByText("Everyone authorized for a task can read its field notes. Corrections are added as new notes.")).toBeInTheDocument();

    fireEvent.click(within(notes).getAllByRole("button", { name: "Open task with field notes for Prepare August campaign meeting" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    fireEvent.change(screen.getByPlaceholderText("Add a task-specific update…"), {
      target: { value: "Confirming the field-note path." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add comment/ }));
    await waitFor(() => expect(onAddTaskComment).toHaveBeenCalledWith(
      "task-demo-1",
      "Confirming the field-note path.",
      [],
    ));
  });

  it("labels trusted demo field-note content as SAMPLE and session-only", () => {
    const { container } = renderTasks({ desktopShell: true, demo: true });
    fireEvent.click(within(container).getByRole("tab", { name: "Field notes" }));
    expect(within(container).getByText("PREVIEW · session-only")).toBeInTheDocument();
  });

  it("localizes the complete desktop view order in Spanish", () => {
    const { container } = renderTasks({ desktopShell: true, lang: "es" });
    const group = within(container).getByRole("tablist", { name: "Vistas de tareas" });
    expect(labels(group)).toEqual([
      "Tablero",
      "Lista",
      "Cronograma",
      "Calendario",
      "Fechas límite",
      "Notas de campo",
      "Progreso",
      "Informe",
    ]);
    expect(within(container).getByRole("heading", { level: 1 })).toHaveTextContent("Trabajo");
    expect(within(container).getByText("Tablero, listas, cronogramas de tareas, fechas límite, notas de campo, progreso e informes"))
      .toBeInTheDocument();
  });
});
