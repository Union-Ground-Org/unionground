// REQ-UG-PER-UNIT-SETTINGS-20261109 (#7667): lists that span units
// label every task with the unit it was created for (ruling point 4). A task
// with no unit, or one made while per-unit settings are held on the release
// calendar, shows no label at all, so a held feature leaves no trace.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { TrackerRow } from "../src/components/TrackerRow.jsx";
import { KanbanBoard } from "../src/views/KanbanBoard.jsx";
import { KanbanCalendar } from "../src/views/KanbanCalendar.jsx";
import { TaskDeadlinesView } from "../src/views/TaskDeadlinesView.jsx";
import { TaskDesktopTimeline } from "../src/views/TaskDesktopTimeline.jsx";
import { TaskFieldNotesView } from "../src/views/TaskFieldNotesView.jsx";

const t = (key, vars) => translate("en", key, vars);
const CHAPTER_SETTINGS = translate("en", "unitSettings.chapter");

function task(id, title, overrides = {}) {
  return {
    id, chapterId: "wor", taskNumber: Number(id.replace(/\D/g, "")) || 1, title, status: "to_do", priority: "medium",
    workstream: "Organizing", startDate: "2026-08-10", dueDate: "2026-08-12", progress: 0, blocked: false,
    milestone: false, orderIndex: 1, assigneeName: "", assigneeNames: [], createdAt: "2026-08-01T12:00:00Z",
    ...overrides,
  };
}

const TASKS = [
  task("task-1", "Unit task", { unitName: "Team A", unitId: "unit-a" }),
  task("task-2", "Chapter task", { unitName: null, unitId: null }),
  task("task-3", "Older task"),
];

function WithLang({ children }) {
  return <LanguageProvider lang="en">{children}</LanguageProvider>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 11, 12));
});
afterEach(() => vi.useRealTimers());

describe("unit labels on task lists", () => {
  it("names the unit on a tracker row, and nothing for a task without one", () => {
    const { rerender } = render(<TrackerRow task={TASKS[0]} chapterId="wor" t={t} lang="en" urgency="soon" onOpenTask={vi.fn()} onCycleStatus={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Unit task, Team A/ })).toBeInTheDocument();
    rerender(<TrackerRow task={TASKS[1]} chapterId="wor" t={t} lang="en" urgency="soon" onOpenTask={vi.fn()} onCycleStatus={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Chapter task/ }).getAttribute("aria-label") ?? "").not.toContain(CHAPTER_SETTINGS);
    rerender(<TrackerRow task={TASKS[2]} chapterId="wor" t={t} lang="en" urgency="soon" onOpenTask={vi.fn()} onCycleStatus={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Older task/ }).getAttribute("aria-label") ?? screen.getByRole("button", { name: /^Older task/ }).textContent).not.toContain(CHAPTER_SETTINGS);
  });

  it("labels deadline rows", () => {
    render(<TaskDeadlinesView tasks={TASKS} chapterId="wor" doneVisible lang="en" t={t} today={new Date(2026, 7, 11, 12)} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getAllByText("Team A").length).toBeGreaterThan(0);
    expect(screen.queryByText(CHAPTER_SETTINGS)).toBeNull();
  });

  it("labels timeline rows", () => {
    function Harness(props) {
      const { lang, t: translateLang } = useLang();
      return <TaskDesktopTimeline {...props} lang={lang} t={translateLang} />;
    }
    render(<WithLang><Harness tasks={TASKS} chapterId="wor" onOpenTask={vi.fn()} onUpdateTask={vi.fn(async (_id, patch) => patch)} onCreateDefault={vi.fn()} /></WithLang>);
    const unitRow = document.querySelector('[data-task-id="task-1"]');
    const chapterRow = document.querySelector('[data-task-id="task-2"]');
    expect(within(unitRow).getAllByText("Team A").length).toBeGreaterThan(0);
    expect(within(chapterRow).queryByText(CHAPTER_SETTINGS)).toBeNull();
    expect(within(document.querySelector('[data-task-id="task-3"]')).queryByText(CHAPTER_SETTINGS)).toBeNull();
  });

  it("labels field-note task cards", () => {
    render(<TaskFieldNotesView tasks={TASKS} comments={[]} commentsUnavailable={false} commentsTruncated={false} assignees={[]} memberId="member-1"
      chapterId="wor" doneVisible={false} demo={false} lang="en" t={t} onOpen={vi.fn()} onCreate={vi.fn()} onAddComment={vi.fn(async () => ({ id: "created" }))} />);
    expect(screen.getAllByText("Team A").length).toBeGreaterThan(0);
    expect(screen.queryByText(CHAPTER_SETTINGS)).toBeNull();
  });

  it("labels calendar chips in their accessible name", () => {
    function Harness(props) {
      const { lang, t: translateLang } = useLang();
      return <KanbanCalendar {...props} t={translateLang} lang={lang} />;
    }
    render(<WithLang><Harness tasks={TASKS} chapterId="wor" onOpenTask={vi.fn()} onUpdate={vi.fn(async () => ({}))} onCreateDate={vi.fn(async () => ({ id: "task-date" }))} liveAnnounce={vi.fn()} /></WithLang>);
    const chips = [...document.querySelectorAll(".kan-chip")].map((chip) => chip.getAttribute("aria-label"));
    // The title leads and the key follows it (#9529 B-48): "Unit task, WOR-1, Team A, …".
    expect(chips.some((label) => /^Unit task, \S+, Team A,/.test(label))).toBe(true);
    expect(chips.some((label) => label.includes("Chapter task,") && !label.includes(CHAPTER_SETTINGS))).toBe(true);
    expect(chips.some((label) => label.includes("Older task") && label.includes(CHAPTER_SETTINGS))).toBe(false);
  });

  it("labels board cards", () => {
    render(<WithLang><KanbanBoard tasks={TASKS} workstreamNames={["Organizing"]} chapterId="wor" t={t} lang="en" doneVisible focusWorkstream={null}
      onFocusWorkstream={vi.fn()} onOpenTask={vi.fn()} onCycleStatus={vi.fn()} onDropTask={vi.fn()} onCreateInline={vi.fn(async () => ({ id: "task-new" }))}
      onReorder={vi.fn()} commentCounts={new Map()} attachmentCounts={new Map()} liveAnnounce={vi.fn()} /></WithLang>);
    expect(screen.getAllByText("Team A").length).toBeGreaterThan(0);
    expect(screen.queryByText(CHAPTER_SETTINGS)).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
  });

  it("labels cards in a focused workstream and creates from a status column's bottom composer", async () => {
    const onCreateInline = vi.fn(async () => ({ id: "task-new" }));
    render(<WithLang><KanbanBoard tasks={TASKS} workstreamNames={["Organizing"]} chapterId="wor" t={t} lang="en" doneVisible focusWorkstream="Organizing"
      onFocusWorkstream={vi.fn()} onOpenTask={vi.fn()} onCycleStatus={vi.fn()} onDropTask={vi.fn()} onCreateInline={onCreateInline}
      onReorder={vi.fn()} commentCounts={new Map()} attachmentCounts={new Map()} liveAnnounce={vi.fn()} /></WithLang>);
    expect(screen.getAllByText("Team A").length).toBeGreaterThan(0);
    const composers = screen.getAllByRole("button", { name: t("kanban.addStatusTask", { status: t("tasks.status.to_do") }) });
    fireEvent.click(composers.at(-1));
    const input = screen.getByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "Unit follow-up" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(onCreateInline).toHaveBeenCalledWith("Organizing", "to_do", "Unit follow-up"));
  });
});
