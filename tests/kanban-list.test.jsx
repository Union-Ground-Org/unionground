import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { applyDeviceParityState } from "../src/lib/deviceParity.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { groupListTasks, KanbanList } from "../src/views/KanbanList.jsx";

function Harness(props) {
  const { lang, t } = useLang();
  return <KanbanList {...props} lang={lang} t={t} />;
}

function taskRowName(title) {
  return (name) => typeof name === "string" && (name === title || name.startsWith(`${title}, `));
}

function renderList(overrides = {}, lang = "en") {
  const props = {
    tasks: structuredClone(fallbackData.tasks),
    workstreamNames: ["Bargaining", "Chapter", "Communications", "Grievances", "Organizing", "Safety"],
    chapterId: "wor",
    doneVisible: true,
    onOpenTask: vi.fn(),
    onCycleStatus: vi.fn(),
    onCreateInline: vi.fn(async () => ({ id: "new" })),
    depCounts: new Map([["task-demo-1", 2]]),
    subtaskCounts: new Map([["task-demo-1", { done: 0, total: 2 }]]),
    ...overrides,
  };
  render(<LanguageProvider lang={lang}><Harness {...props} /></LanguageProvider>);
  return props;
}

describe("List view", () => {
  it("groups by workstream and keeps status order inside each group", () => {
    const groups = groupListTasks(fallbackData.tasks, "workstream", ["Communications"], "Unassigned");
    const communications = groups.find((group) => group.name === "Communications");
    expect(communications.tasks.map((task) => task.status)).toEqual(["to_do", "needs_review"]);
    expect(groups.some((group) => group.name === "Communications")).toBe(true);
  });

  it("groups by assignee and includes Unassigned", () => {
    const rows = [...fallbackData.tasks, { ...fallbackData.tasks[0], id: "unassigned", assigneeName: "" }];
    const groups = groupListTasks(rows, "assignee", [], "Unassigned");
    expect(groups.some((group) => group.name === "Unassigned")).toBe(true);
  });

  it("renders key, title, status, assignee, due date and progress signals", () => {
    renderList();
    const list = screen.getByRole("region", { name: "List" });
    expect(within(list).getByText("WOR-1")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: taskRowName("Prepare August campaign meeting") })).toBeInTheDocument();
    expect(within(list).getAllByText("Backlog").length).toBeGreaterThan(0);
    expect(within(list).getAllByText("Darnell Foster").length).toBeGreaterThan(0);
    expect(within(list).getByText("0/2 subtasks")).toBeInTheDocument();
    expect(within(list).getByText("2 dependencies")).toBeInTheDocument();
  });

  it("opens a row and cycles status through separate controls", () => {
    const props = renderList();
    fireEvent.click(screen.getByRole("button", { name: taskRowName("Prepare August campaign meeting") }));
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-1" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Chapter" })).getByRole("button", { name: "Advance to To do" }));
    expect(props.onCycleStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-1" }));
  });

  it("hides done rows behind a counted reveal", () => {
    renderList({ doneVisible: false });
    expect(screen.queryByRole("button", { name: taskRowName("Publish bargaining priorities poll") })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "Bargaining" })).getByRole("button", { name: "Show done tasks (1)" }));
    expect(screen.getByRole("button", { name: taskRowName("Publish bargaining priorities poll") })).toBeInTheDocument();
  });

  // The reveal always passed { count } to kanban.showDone, but the catalogue
  // string carried no {count} slot, so the interpolation was dead and every
  // group's control read the same "Show done tasks". Pin the rendered count,
  // per group and in both languages, so the argument cannot go dead again.
  it("names how many done rows each group is hiding on its reveal control", () => {
    const tasks = structuredClone(fallbackData.tasks);
    const bargainingDone = tasks.find((task) => task.workstream === "Bargaining" && task.status === "done");
    tasks.push({ ...bargainingDone, id: "task-bargaining-done-2", key: "WOR-901", title: "Archive bargaining survey" });
    renderList({ tasks, doneVisible: false });
    expect(
      within(screen.getByRole("region", { name: "Bargaining" })).getByRole("button", { name: "Show done tasks (2)" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Chapter" })).getByRole("button", { name: "Show done tasks (1)" }),
    ).toBeInTheDocument();
  });

  it("names the hidden done count in Spanish too", () => {
    renderList({ doneVisible: false }, "es");
    expect(
      within(screen.getByRole("region", { name: "Bargaining" })).getByRole("button", { name: "Mostrar las terminadas (1)" }),
    ).toBeInTheDocument();
  });

  it("switches to assignee grouping and does not invent a workstream composer there", () => {
    renderList();
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "assignee" } });
    expect(screen.getByRole("region", { name: "Darnell Foster" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });

  it("gives each compact group a distinct panel even when names slug alike", () => {
    renderList({ workstreamNames: ["Health & Safety", "Health Safety"], tasks: [] });
    const first = screen.getByRole("button", { name: /Health & Safety/ });
    const second = screen.getByRole("button", { name: /Health Safety/ });
    const firstPanel = first.getAttribute("aria-controls");
    const secondPanel = second.getAttribute("aria-controls");
    expect(firstPanel).not.toBe(secondPanel);
    expect(document.getElementById(firstPanel)).toBe(first.closest("section").querySelector(":scope > div"));
    expect(document.getElementById(secondPanel)).toBe(second.closest("section").querySelector(":scope > div"));
    expect(screen.getByRole("region", { name: "Health & Safety" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Health Safety" })).toBeInTheDocument();
  });

  it("keeps groups named only in non-Latin script apart", () => {
    // The old ASCII slug reduced both names to the same bare "-".
    renderList({ workstreamNames: ["安全", "Здоровье"], tasks: [] });
    const first = screen.getByRole("button", { name: /安全/ });
    const second = screen.getByRole("button", { name: /Здоровье/ });
    expect(first.getAttribute("aria-controls")).not.toBe(second.getAttribute("aria-controls"));
    expect(screen.getByRole("region", { name: "安全" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Здоровье" })).toBeInTheDocument();
  });

  it("renders Spanish chrome", () => {
    renderList({}, "es");
    expect(screen.getByRole("region", { name: "Lista" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Agrupar por" })).toBeInTheDocument();
  });

  it("exposes priority as accessible text and names the row from its signals", () => {
    renderList();
    const openButton = screen.getByRole("button", { name: taskRowName("Prepare August campaign meeting") });
    const row = openButton.closest(".kan-listrow");
    const priority = row.querySelector(".kan-pri");
    expect(within(priority).getByText("High")).toBeInTheDocument();
    expect(priority.querySelector("[aria-hidden='true']")).toBeTruthy();
    expect(openButton).toHaveAccessibleName(
      "Prepare August campaign meeting, 40% (Milestone progress), 2 dependencies, 0/2 subtasks",
    );
    expect(within(openButton).getByText("Milestone progress")).toBeInTheDocument();
    expect(within(openButton).getByText("40%")).toBeInTheDocument();
  });

  it("returns keyboard focus to the add control after submitting the composer", async () => {
    const onCreateInline = vi.fn(async () => ({ id: "new" }));
    renderList({ onCreateInline });
    const chapter = screen.getByRole("region", { name: "Chapter" });
    fireEvent.click(within(chapter).getByRole("button", { name: "New task" }));
    const input = within(chapter).getByPlaceholderText("Task title");
    fireEvent.change(input, { target: { value: "Focus stays put" } });
    fireEvent.submit(input.closest("form"));
    await waitFor(() => {
      expect(onCreateInline).toHaveBeenCalledWith("Chapter", "to_do", "Focus stays put");
    });
    await waitFor(() => {
      expect(within(chapter).getByRole("button", { name: "New task" })).toHaveFocus();
    });
  });

  it("returns keyboard focus to the add control after cancelling the composer", async () => {
    renderList();
    const chapter = screen.getByRole("region", { name: "Chapter" });
    fireEvent.click(within(chapter).getByRole("button", { name: "New task" }));
    fireEvent.click(within(chapter).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(within(chapter).getByRole("button", { name: "New task" })).toHaveFocus();
    });
  });

  it("does not steal focus when a composer is restored already open", () => {
    applyDeviceParityState(`tasks.list.composer.${encodeURIComponent("Chapter")}.open`, true);
    renderList();
    expect(screen.getByPlaceholderText("Task title")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Task title")).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it.each(["America/New_York", "America/Los_Angeles"])(
    "keeps due-today responsive work non-overdue at 23:30 in %s",
    (timeZone) => {
      const priorTz = process.env.TZ;
      process.env.TZ = timeZone;
      try {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 6, 27, 23, 30));
        const title = `Due today in ${timeZone}`;
        renderList({
          tasks: [{
            ...fallbackData.tasks[0],
            id: `due-today-${timeZone}`,
            title,
            status: "to_do",
            workstream: "Chapter",
            dueDate: "2026-07-27",
          }],
          depCounts: new Map(),
          subtaskCounts: new Map(),
        });

        const row = screen.getByRole("button", { name: taskRowName(title) }).closest(".kan-listrow");
        const dueCell = row.querySelector(".kan-listrow__due");
        expect(dueCell).toHaveAttribute("data-urgency", "today");
        expect(dueCell).not.toHaveClass("kan-listrow__due--overdue");
      } finally {
        vi.useRealTimers();
        if (priorTz === undefined) delete process.env.TZ;
        else process.env.TZ = priorTz;
      }
    },
  );

  it("marks yesterday overdue just after midnight in a positive-offset timezone", () => {
    const priorTz = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 28, 0, 30));
      const title = "Due yesterday in Berlin";
      renderList({
        tasks: [{
          ...fallbackData.tasks[0],
          id: "due-yesterday-berlin",
          title,
          status: "to_do",
          workstream: "Chapter",
          dueDate: "2026-07-27",
        }],
        depCounts: new Map(),
        subtaskCounts: new Map(),
      });

      const dueCell = screen.getByRole("button", { name: taskRowName(title) })
        .closest(".kan-listrow")
        .querySelector(".kan-listrow__due");
      expect(dueCell).toHaveAttribute("data-urgency", "overdue");
      expect(dueCell).toHaveClass("kan-listrow__due--overdue");
    } finally {
      vi.useRealTimers();
      if (priorTz === undefined) delete process.env.TZ;
      else process.env.TZ = priorTz;
    }
  });
});
