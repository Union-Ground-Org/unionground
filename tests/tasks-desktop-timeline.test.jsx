import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { TaskDesktopTimeline } from "../src/views/TaskDesktopTimeline.jsx";
import { labelInNameMismatches } from "./helpers/labelInName.js";

const FIXTURE = [
  { id: "span", taskNumber: 101, title: "Prepare bargaining brief", status: "in_progress", startDate: "2026-08-10", dueDate: "2026-08-12", progress: 40, assigneeName: "Jordan Lee" },
  { id: "left", taskNumber: 102, title: "Carry July outreach forward", status: "to_do", startDate: "2026-07-29", dueDate: "2026-08-03", progress: 20 },
  { id: "start", taskNumber: 103, title: "Start-only member follow-up", status: "to_do", startDate: "2026-08-15", dueDate: null, progress: 0 },
  { id: "due", taskNumber: 104, title: "Due-only records request", status: "needs_review", startDate: null, dueDate: "2026-08-20", progress: 80 },
  { id: "milestone", taskNumber: 105, title: "Ratification milestone", status: "in_progress", startDate: "2026-08-22", dueDate: "2026-08-22", progress: 50, milestone: true },
  { id: "right", taskNumber: 106, title: "Carry September launch forward", status: "backlog", startDate: "2026-08-29", dueDate: "2026-09-02", progress: 10 },
  { id: "outside", taskNumber: 107, title: "July-only archival task", status: "backlog", startDate: "2026-07-01", dueDate: "2026-07-03", progress: 0 },
  { id: "undated", taskNumber: 108, title: "Unscheduled listening session", status: "to_do", startDate: null, dueDate: null, progress: 0 },
  { id: "done", taskNumber: 109, title: "Completed notice", status: "done", startDate: "2026-08-04", dueDate: "2026-08-05", progress: 100 },
  { id: "overdue", taskNumber: 110, title: "Overdue response", status: "in_progress", startDate: "2026-08-05", dueDate: "2026-08-06", progress: 30 },
];

function Harness(props) {
  const { lang, t } = useLang();
  return <TaskDesktopTimeline {...props} lang={lang} t={t} />;
}

function renderTimeline(overrides = {}, lang = "en") {
  const props = {
    tasks: structuredClone(FIXTURE),
    chapterId: "wor",
    onOpenTask: vi.fn(),
    onUpdateTask: vi.fn(async (_id, patch) => patch),
    onCreateDefault: vi.fn(),
    ...overrides,
  };
  const view = render(<LanguageProvider lang={lang}><Harness {...props} /></LanguageProvider>);
  return { props, view };
}

function row(id) {
  return document.querySelector(`[data-task-id="${id}"]`);
}

const priorTz = process.env.TZ;

beforeEach(() => {
  process.env.TZ = "America/New_York";
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 16, 12));
});

afterEach(() => {
  vi.useRealTimers();
  if (priorTz === undefined) delete process.env.TZ;
  else process.env.TZ = priorTz;
});

describe("Green desktop task Timeline", () => {
  it.each(["en", "es"])("names every %s timeline opener, bar and nudge with the words it shows (WCAG 2.5.3)", (lang) => {
    renderTimeline({}, lang);
    const controls = document.querySelectorAll(".kan-timeline__open, .kan-timeline__bar, .kan-timeline__shift button");
    expect(controls.length).toBeGreaterThan(0);
    expect(labelInNameMismatches(controls)).toEqual([]);
  });

  it("renders a locale-aware real August grid with Today only in the current month", () => {
    renderTimeline();
    expect(screen.getByRole("region", { name: "Task timeline" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
    expect(screen.queryByText(/Contract clocks/i)).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^timeline-day-/)).toHaveLength(31);
    expect(screen.getByTestId("timeline-day-2026-08-01")).toHaveAttribute("data-weekend", "true");
    expect(screen.getByTestId("timeline-day-2026-08-03")).toHaveAttribute("data-weekend", "false");
    expect(screen.getByTestId("timeline-day-2026-08-16")).toHaveAttribute("data-today", "true");

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^timeline-day-/)).toHaveLength(30);
    expect(document.querySelector('[data-today="true"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
    expect(screen.getByTestId("timeline-day-2026-08-16")).toHaveAttribute("data-today", "true");
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { name: "July 2026" })).toBeInTheDocument();
  });

  it("clips spans at both month edges and treats half-dated tasks as one-day milestones", () => {
    renderTimeline();
    expect(within(row("left")).getByText("Continues from previous month")).toBeInTheDocument();
    expect(within(row("left")).getByRole("button", { name: /Carry July outreach forward.*continues from previous month/i }))
      .toHaveAttribute("data-visible-days", "3");
    expect(within(row("right")).getByText("Continues into next month")).toBeInTheDocument();
    expect(within(row("right")).getByRole("button", { name: /Carry September launch forward.*continues into next month/i }))
      .toHaveAttribute("data-visible-days", "3");

    for (const id of ["start", "due"]) {
      const bar = within(row(id)).getByRole("button", { name: /Open .* on /i });
      expect(bar).toHaveAttribute("data-visible-days", "1");
      expect(bar).toHaveAttribute("data-half-dated", "true");
    }
    expect(row("milestone").querySelector(".kan-timeline__bar"))
      .toHaveAttribute("data-milestone", "true");
    expect(screen.queryByText("July-only archival task")).not.toBeInTheDocument();
    expect(screen.queryByText("Unscheduled listening session")).not.toBeInTheDocument();
  });

  // BUG-UG-ACCESSIBLE-NAMES-CONTAIN-VISIBLE-LABELS-20261102: a task
  // with no key (no task number) shows its title on the bar, and every name
  // still starts from the words the controls show.
  it("names keyless span and one-day tasks by their title (WCAG 2.5.3)", () => {
    const keyless = [
      { id: "plain-span", title: "Plan the steward training", status: "to_do", startDate: "2026-08-10", dueDate: "2026-08-12", progress: 0 },
      { id: "plain-day", title: "File the safety report", status: "to_do", startDate: null, dueDate: "2026-08-20", progress: 0 },
    ];
    renderTimeline({ tasks: keyless });
    const spanBar = row("plain-span").querySelector(".kan-timeline__bar");
    expect(spanBar).toHaveTextContent("Plan the steward training");
    expect(spanBar.getAttribute("aria-label")).toMatch(/^Open Plan the steward training from /);
    expect(within(row("plain-span")).getByRole("button", { name: /^Open task: Plan the steward training, .+ – .+$/ })).toBeInTheDocument();
    const dayBar = row("plain-day").querySelector(".kan-timeline__bar");
    expect(dayBar).toHaveTextContent("File the safety report");
    expect(dayBar.getAttribute("aria-label")).toMatch(/^Open File the safety report on /);
    expect(within(row("plain-day")).getByRole("button", { name: /^Open task: File the safety report, [^–]+$/ })).toBeInTheDocument();
    const controls = document.querySelectorAll(".kan-timeline__open, .kan-timeline__bar, .kan-timeline__shift button");
    expect(labelInNameMismatches(controls)).toEqual([]);
  });

  it("opens from both semantic buttons without writing", () => {
    const { props } = renderTimeline();
    const task = FIXTURE[0];
    const taskRow = row(task.id);
    const label = within(taskRow).getByRole("button", { name: new RegExp(`^Open task: \\S+ ${task.title}, `) });
    const bar = taskRow.querySelector(".kan-timeline__bar");
    expect(label.tagName).toBe("BUTTON");
    expect(bar.tagName).toBe("BUTTON");
    fireEvent.click(label);
    fireEvent.click(bar);
    expect(props.onOpenTask).toHaveBeenCalledTimes(2);
    expect(props.onOpenTask).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: task.id }));
    expect(props.onOpenTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: task.id }));
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  it("shifts exactly one row and expands half-dated tasks to equal start/due pairs", async () => {
    let release;
    const onUpdateTask = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    renderTimeline({ onUpdateTask });
    const target = row("start");
    fireEvent.click(within(target).getByRole("button", { name: "Move Start-only member follow-up 1 day later" }));
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
    expect(onUpdateTask).toHaveBeenCalledWith("start", { startDate: "2026-08-16", dueDate: "2026-08-16" });
    expect(within(target).getByRole("button", { name: /1 day earlier/ })).toHaveAttribute("aria-disabled", "true");
    // The pressed control stays focusable while its move runs (#8435).
    expect(within(target).getByRole("button", { name: /1 day later/ })).toHaveAttribute("aria-disabled", "true");
    expect(within(target).getByRole("button", { name: /1 day later/ })).toBeEnabled();
    expect(within(row("span")).getByRole("button", { name: /1 day later/ })).toBeEnabled();
    await act(async () => { release({ id: "start" }); });
    expect(within(target).getByRole("button", { name: /1 day later/ })).toBeEnabled();
  });

  it("catches a rejected parent update, preserves source dates, and emits no unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const onUpdateTask = vi.fn(async () => { throw new Error("rejected by parent"); });
    try {
      renderTimeline({ onUpdateTask });
      const target = row("due");
      const bar = target.querySelector(".kan-timeline__bar");
      expect(bar).toHaveAttribute("data-start-date", "2026-08-20");
      expect(bar).toHaveAttribute("data-end-date", "2026-08-20");
      await act(async () => {
        fireEvent.click(within(target).getByRole("button", { name: /1 day earlier/ }));
      });
      expect(within(target).getByRole("button", { name: /1 day earlier/ })).toBeEnabled();
      expect(bar).toHaveAttribute("data-start-date", "2026-08-20");
      expect(bar).toHaveAttribute("data-end-date", "2026-08-20");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("labels local urgency without treating Done as overdue", () => {
    renderTimeline();
    expect(row("done")).toHaveAttribute("data-urgency", "completed");
    expect(within(row("done")).getByText("Completed")).toBeInTheDocument();
    expect(within(row("done")).queryByText("Overdue")).not.toBeInTheDocument();
    expect(row("overdue")).toHaveAttribute("data-urgency", "overdue");
    expect(within(row("overdue")).getByText("Overdue")).toBeInTheDocument();
  });

  it("gives empty, outside-month, and undated-only inputs honest actions", () => {
    const empty = renderTimeline({ tasks: [] });
    expect(screen.getByText("No tasks to show. Adjust filters or create a task.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(empty.props.onCreateDefault).toHaveBeenCalledTimes(1);
    empty.view.unmount();

    const outside = renderTimeline({ tasks: [structuredClone(FIXTURE.find((task) => task.id === "outside"))] });
    expect(screen.getByText("No tasks fall in this month.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New task" })).toBeVisible();
    outside.view.unmount();

    renderTimeline({ tasks: [structuredClone(FIXTURE.find((task) => task.id === "undated"))] });
    expect(screen.getByText("No dated tasks this month.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New task" })).toBeVisible();
  });

  it("renders the complete control and state vocabulary in Spanish", () => {
    renderTimeline({}, "es");
    expect(screen.getByRole("region", { name: "Cronograma de tareas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /agosto.*2026/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mes anterior" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hoy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mes siguiente" })).toBeInTheDocument();
    expect(within(row("left")).getByText("Continúa desde el mes anterior")).toBeInTheDocument();
    expect(within(row("right")).getByText("Continúa en el mes siguiente")).toBeInTheDocument();
    expect(within(row("overdue")).getByText("Vencida")).toBeInTheDocument();
    expect(within(row("done")).getByText("Completada")).toBeInTheDocument();
  });
});

describe("timeline moves refuse a second move of the same task (#8435)", () => {
  it("sends one move when two clicks on the same row land before the first one commits", async () => {
    let release;
    const onUpdateTask = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    renderTimeline({ onUpdateTask });
    const later = within(row("start")).getByRole("button", { name: "Move Start-only member follow-up 1 day later" });
    // Both clicks arrive in one React batch, before the row's pending state
    // commits, so only the per-task lock can refuse the second.
    act(() => {
      later.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      later.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
    await act(async () => { release({ id: "start" }); });
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });
});
