import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskDeadlinesView } from "../src/views/TaskDeadlinesView.jsx";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date(2026, 6, 27, 12);

const copy = {
  "tasks.view.deadlines": "Deadlines",
  "tasks.deadlinesTitle": "Task deadlines",
  "tasks.deadlinesSubtitle": "Due work from the same task model used by Board, List and Calendar.",
  "tasks.datedTaskOne": "1 dated task",
  "tasks.datedTaskCount": "{count} dated tasks",
  "tasks.openNamedTask": "Open {task}",
  "tasks.openTask": "Open task",
  "tasks.deadlinesEmpty": "No dated tasks match these filters.",
  "tasks.new": "New task",
  "tasks.unassigned": "Unassigned",
  "tasks.deadline.overdue": "Overdue",
  "tasks.deadline.today": "Due today",
  "tasks.deadline.nextSeven": "Next 7 days",
  "tasks.deadline.later": "Later",
  "tasks.deadline.completed": "Completed",
  "tasks.status.backlog": "Backlog",
  "tasks.status.to_do": "To do",
  "tasks.status.in_progress": "In progress",
  "tasks.status.needs_review": "Review",
  "tasks.status.done": "Done",
};

function t(key, vars = {}) {
  return String(copy[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

function task(overrides = {}) {
  return {
    id: "task-a",
    taskNumber: 1,
    title: "A task",
    workstream: "General",
    status: "to_do",
    dueDate: "2026-07-27",
    progress: 0,
    assigneeName: "",
    assigneeNames: [],
    ...overrides,
  };
}

function renderDocket(overrides = {}) {
  const props = {
    tasks: [],
    chapterId: "chapter-509",
    doneVisible: true,
    lang: "en",
    t,
    today: TODAY,
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  };
  return { ...render(<TaskDeadlinesView {...props} />), props };
}

function bucket(container, name) {
  return within(container).getByRole("group", { name });
}

function rowTitles(group) {
  return within(group).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
}

function escapeSelector(selector) {
  return String(selector).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

function stripComments(styles) {
  return String(styles).replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleBlock(styles, selector) {
  const active = stripComments(styles);
  const found = [];
  const pattern = new RegExp(`${escapeSelector(selector)}(?![\\w-])`, "g");
  let match;
  while ((match = pattern.exec(active)) !== null) {
    const after = active.slice(match.index + match[0].length);
    if (/^\s*:[a-z]/i.test(after)) continue;
    const block = after.match(/^[^{]*\{([^}]*)\}/);
    if (block) found.push(block[1]);
  }
  return found;
}

describe("Green desktop deadline docket", () => {
  it("renders only strict actual due dates and fails malformed Done rows closed", () => {
    const tasks = [
      task({ id: "valid", title: "Valid", dueDate: "2026-07-27" }),
      task({ id: "missing", title: "Missing", dueDate: "" }),
      task({ id: "impossible", title: "Impossible", dueDate: "2026-02-30" }),
      task({ id: "datetime", title: "Datetime", dueDate: "2026-07-27T09:00:00Z" }),
      task({ id: "bad-done", title: "Bad done", dueDate: "2026-13-10", status: "done" }),
    ];
    const { container } = renderDocket({ tasks });

    expect(within(container).getByText("Valid")).toBeInTheDocument();
    expect(within(container).queryByText("Missing")).not.toBeInTheDocument();
    expect(within(container).queryByText("Impossible")).not.toBeInTheDocument();
    expect(within(container).queryByText("Datetime")).not.toBeInTheDocument();
    expect(within(container).queryByText("Bad done")).not.toBeInTheDocument();
    expect(within(container).getByText("1 dated task")).toBeInTheDocument();
  });

  it("uses the fixed bucket order and deterministic due-date, task-number, then ID ordering", () => {
    const tasks = [
      task({ id: "later", title: "Later", dueDate: "2026-08-04", taskNumber: 1 }),
      task({ id: "done", title: "Done", dueDate: "2026-07-21", status: "done", taskNumber: 1 }),
      task({ id: "today", title: "Today", dueDate: "2026-07-27", taskNumber: 1 }),
      task({ id: "next", title: "Next", dueDate: "2026-07-29", taskNumber: 1 }),
      task({ id: "z-id", title: "Title A", dueDate: "2026-07-25", taskNumber: 2 }),
      task({ id: "a-id", title: "Title Z", dueDate: "2026-07-25", taskNumber: 2 }),
      task({ id: "no-number", title: "No number", dueDate: "2026-07-25", taskNumber: null }),
      task({ id: "number-one", title: "Number one", dueDate: "2026-07-25", taskNumber: 1 }),
    ];
    const { container } = renderDocket({ tasks });

    expect([...container.querySelectorAll(".tasks-deadline-bucket__title")].map((node) => node.textContent)).toEqual([
      "Overdue",
      "Due today",
      "Next 7 days",
      "Later",
      "Completed",
    ]);
    expect(rowTitles(bucket(container, "Overdue"))).toEqual([
      "Open Number one",
      "Open Title Z",
      "Open Title A",
      "Open No number",
    ]);
  });

  it("classifies tomorrow and day seven as Next 7, day eight as Later, and 100 percent by status", () => {
    const tasks = [
      task({ id: "tomorrow", title: "Tomorrow", dueDate: "2026-07-28" }),
      task({ id: "day-seven", title: "Day seven", dueDate: "2026-08-03" }),
      task({ id: "day-eight", title: "Day eight", dueDate: "2026-08-04" }),
      task({ id: "hundred", title: "Hundred", dueDate: "2026-07-25", progress: 100, status: "in_progress" }),
      task({ id: "done-past", title: "Done past", dueDate: "2026-07-20", status: "done" }),
    ];
    const { container } = renderDocket({ tasks });

    expect(within(bucket(container, "Next 7 days")).getByText("Tomorrow")).toBeInTheDocument();
    expect(within(bucket(container, "Next 7 days")).getByText("Day seven")).toBeInTheDocument();
    expect(within(bucket(container, "Later")).getByText("Day eight")).toBeInTheDocument();
    expect(within(bucket(container, "Overdue")).getByText("Hundred")).toBeInTheDocument();
    const completed = within(bucket(container, "Completed")).getByText("Done past").closest("article");
    expect(completed).toHaveAttribute("data-urgency", "completed");
    expect(within(completed).getByText("Completed")).toBeInTheDocument();
    expect(within(completed).queryByText("Overdue")).not.toBeInTheDocument();
  });

  it("keeps the global Done toggle and supplied filtered task model authoritative", () => {
    const allTasks = [
      task({ id: "open", title: "Open row" }),
      task({ id: "done", title: "Done row", status: "done", dueDate: "2026-07-22" }),
    ];
    const rendered = renderDocket({ tasks: allTasks, doneVisible: false });
    expect(within(rendered.container).getByText("Open row")).toBeInTheDocument();
    expect(within(rendered.container).queryByText("Done row")).not.toBeInTheDocument();

    rendered.rerender(<TaskDeadlinesView {...rendered.props} tasks={[allTasks[1]]} doneVisible />);
    expect(within(rendered.container).queryByText("Open row")).not.toBeInTheDocument();
    expect(within(rendered.container).getByText("Done row")).toBeInTheDocument();
  });

  it("exposes semantic date, key, workstream, status, every assignee, and urgency text", () => {
    const { container } = renderDocket({
      tasks: [task({
        id: "metadata",
        taskNumber: 42,
        title: "Metadata row",
        workstream: "Member outreach",
        status: "needs_review",
        dueDate: "2026-07-25",
        assigneeName: "Fallback ignored",
        assigneeNames: ["Maria Santos", "Jordan Lee"],
      })],
    });
    const article = within(container).getByText("Metadata row").closest("article");

    expect(within(article).getByText("CHAPTER-509-42 · Member outreach · Review")).toBeInTheDocument();
    expect(within(article).getByText("Maria Santos, Jordan Lee")).toBeInTheDocument();
    expect(within(article).getByText("Overdue")).toBeInTheDocument();
    expect(within(article).getByText("Jul 25").closest("time")).toHaveAttribute("datetime", "2026-07-25");

    const fallback = renderDocket({ tasks: [task({ id: "fallback", title: "Fallback", assigneeName: "Solo Name" })] });
    expect(within(fallback.container).getByText("Solo Name")).toBeInTheDocument();
    fallback.unmount();
    const unassigned = renderDocket({ tasks: [task({ id: "none", title: "Nobody" })] });
    expect(within(unassigned.container).getByText("Unassigned")).toBeInTheDocument();
  });

  it("opens with zero write, reflects due-date rerenders, and preserves the honest empty create path", () => {
    const onOpen = vi.fn();
    const onCreate = vi.fn();
    const first = task({ id: "changing", title: "Changing", dueDate: "2026-07-27" });
    const rendered = renderDocket({ tasks: [first], onOpen, onCreate });
    const open = within(rendered.container).getByRole("button", { name: "Open Changing" });
    open.focus();
    fireEvent.keyDown(open, { key: "Enter" });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(first);

    rendered.rerender(<TaskDeadlinesView {...rendered.props} tasks={[{ ...first, dueDate: "2026-08-04" }]} />);
    expect(within(bucket(rendered.container, "Later")).getByText("Changing")).toBeInTheDocument();

    rendered.rerender(<TaskDeadlinesView {...rendered.props} tasks={[]} />);
    expect(within(rendered.container).getByText("No dated tasks match these filters.")).toBeInTheDocument();
    fireEvent.click(within(rendered.container).getByRole("button", { name: "New task" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("has no guide clocks or private store and declares audited urgency tokens plus 44px actions", () => {
    const source = readFileSync(join(root, "src/views/TaskDeadlinesView.jsx"), "utf8");
    const styles = readFileSync(join(root, "src/styles.css"), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|guide|2026-07-27/);
    expect(styles).toMatch(/tasks-deadline-bucket/);
    expect(styles).toMatch(/--kan-danger-soft/);
    expect(styles).toMatch(/--kan-danger/);
    expect(styles).toMatch(/--kan-card-2/);
    expect(styles).toMatch(/--kan-muted/);
    const blocks = ruleBlock(styles, ".tasks-work-row > button");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join("\n")).toMatch(/min-height:\s*44px\b/);
  });

  it("bounds the work-row button 44px check to the enclosing rule, not a later unrelated declaration", () => {
    const bridged = [
      ".tasks-work-row > button:focus-visible { outline: 2px }",
      ".other { min-height: 44px }",
    ].join("\n");
    expect(bridged).toMatch(/\.tasks-work-row\s*>\s*button[\s\S]*min-height:\s*44px/);
    const blocks = ruleBlock(bridged, ".tasks-work-row > button");
    expect(blocks.join("\n")).not.toMatch(/min-height:\s*44px/);
  });

  it("fails when the work-row button min-height is weakened below 44px", () => {
    const weakened = ".tasks-work-row > button { min-height: 40px; border: 0; }";
    const blocks = ruleBlock(weakened, ".tasks-work-row > button");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join("\n")).not.toMatch(/min-height:\s*44px\b/);
  });

  it("fails when the only 44px declaration left in the work-row button rule is commented out", () => {
    const commented = ".tasks-work-row > button { min-height: 40px; /* min-height: 44px; */ }";
    const blocks = ruleBlock(commented, ".tasks-work-row > button");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join("\n")).not.toMatch(/min-height:\s*44px\b/);
  });

  it("ignores a work-row button rule that only exists inside a comment", () => {
    const commentedRule = "/* .tasks-work-row > button { min-height: 44px; } */";
    expect(ruleBlock(commentedRule, ".tasks-work-row > button")).toHaveLength(0);
  });
});
