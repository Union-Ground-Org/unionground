import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { TOUCH_HOLD_MS } from "../src/views/KanbanBoard.jsx";
import {
  KanbanCalendar,
  assignCalendarLanes,
  calendarPopoverPosition,
  monthWeeks,
  shiftTaskDates,
  weekDates,
  weekStart,
} from "../src/views/KanbanCalendar.jsx";

// The rebuilt calendar (REQ-UG-KANBAN-PHASE2-20260801). The layout
// contract lives in the pure helpers — Monday-first weeks, span clamping,
// lane packing — and the component pins are about WRITES: a chip click opens
// the modal and never writes; a reschedule (Alt+arrows here; the pointer path
// shares commitShift) writes BOTH dates moved by the same delta, so the span
// survives and the due>=start guard cannot trip.
//
// Date is faked to the fixture era (only Date — the event loop stays real):
// the fixtures pin their dates in late July 2026, and "today" assertions
// would otherwise rot the month this suite outlives the summer.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-01T12:00:00"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("week and month geometry", () => {
  it("weeks start Monday in every case", () => {
    expect(weekStart("2026-08-01")).toBe("2026-07-27"); // Saturday -> its Monday
    expect(weekStart("2026-07-27")).toBe("2026-07-27"); // Monday -> itself
    expect(weekStart("2026-08-02")).toBe("2026-07-27"); // Sunday belongs to the ending week
    expect(weekDates("2026-08-01")).toEqual([
      "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02",
    ]);
  });

  it("covers the month in exactly the weeks it touches", () => {
    const august = monthWeeks(2026, 7);
    expect(august[0][0]).toBe("2026-07-27");
    expect(august[august.length - 1][6]).toBe("2026-09-06");
    expect(august).toHaveLength(6);
    // February 2027 starts on a Monday and spans exactly four weeks — the
    // dynamic grid must not pad to 42 cells.
    expect(monthWeeks(2027, 1)).toHaveLength(4);
  });
});

describe("lane assignment", () => {
  const week = weekDates("2026-07-27");

  it("clamps spans to the week and marks the cut sides", () => {
    const long = { id: "a", startDate: "2026-07-20", dueDate: "2026-08-05" };
    const { segments } = assignCalendarLanes([long], week);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ start: 0, end: 6, clipStart: true, clipEnd: true, lane: 0 });
  });

  it("packs overlapping spans into separate lanes and reuses freed ones", () => {
    const tasks = [
      { id: "a", startDate: "2026-07-27", dueDate: "2026-07-29", createdAt: "1" },
      { id: "b", startDate: "2026-07-28", dueDate: "2026-07-30", createdAt: "2" },
      { id: "c", startDate: "2026-07-31", dueDate: "2026-07-31", createdAt: "3" },
    ];
    const { segments, laneCount } = assignCalendarLanes(tasks, week);
    const byId = Object.fromEntries(segments.map((segment) => [segment.task.id, segment]));
    expect(byId.a.lane).toBe(0);
    expect(byId.b.lane).toBe(1); // overlaps a
    expect(byId.c.lane).toBe(0); // a ended Wednesday; Friday reuses its lane
    expect(laneCount).toBe(2);
  });

  it("drops tasks that never touch the week", () => {
    const { segments } = assignCalendarLanes(
      [{ id: "x", startDate: "2026-08-10", dueDate: "2026-08-12" }],
      week,
    );
    expect(segments).toEqual([]);
  });
});

describe("shiftTaskDates", () => {
  it("moves both dates by the same delta, span preserved", () => {
    const task = { startDate: "2026-07-28", dueDate: "2026-08-01" };
    expect(shiftTaskDates(task, 3)).toEqual({ startDate: "2026-07-31", dueDate: "2026-08-04" });
    expect(shiftTaskDates(task, -7)).toEqual({ startDate: "2026-07-21", dueDate: "2026-07-25" });
  });

  it("treats a half-dated task as a single day", () => {
    expect(shiftTaskDates({ startDate: null, dueDate: "2026-08-01" }, 1))
      .toEqual({ startDate: "2026-08-02", dueDate: "2026-08-02" });
  });
});

describe("calendarPopoverPosition", () => {
  it("keeps a right-edge panel inside the calendar instead of under the phone preview", () => {
    const position = calendarPopoverPosition(
      { left: 1630, top: 210, bottom: 254 },
      { width: 304, height: 274 },
      { left: 248, right: 1675 },
      { width: 2179, height: 1027 },
    );
    expect(position.left).toBe(1359);
    expect(position.left + 304).toBeLessThanOrEqual(1663);
    expect(position.top).toBe(260);
  });
});

function Harness(props) {
  const { lang, t } = useLang();
  return <KanbanCalendar {...props} t={t} lang={lang} />;
}

function renderCalendar(overrides = {}) {
  const data = structuredClone(fallbackData);
  const props = {
    tasks: data.tasks,
    chapterId: data.member.chapterId,
    onOpenTask: vi.fn(),
    onUpdate: vi.fn(async () => ({})),
    onCreateDate: vi.fn(async () => ({ id: "task-date" })),
    liveAnnounce: vi.fn(),
    ...overrides,
  };
  render(<LanguageProvider lang="en"><Harness {...props} /></LanguageProvider>);
  return props;
}

function calendarTask(overrides = {}) {
  return {
    id: "task-week-shift",
    chapterId: "wor",
    taskNumber: 41,
    title: "Keyboard week shift",
    status: "to_do",
    priority: "medium",
    startDate: "2026-08-03",
    dueDate: "2026-08-03",
    progress: 0,
    blocked: false,
    milestone: false,
    orderIndex: 1,
    createdAt: "2026-08-01T12:00:00Z",
    ...overrides,
  };
}

function renderStatefulCalendar(overrides = {}) {
  const data = structuredClone(fallbackData);
  const initialTasks = overrides.tasks ?? data.tasks;
  let applyPatch = () => {};
  const props = {
    chapterId: data.member.chapterId,
    onOpenTask: vi.fn(),
    onCreateDate: vi.fn(async () => ({ id: "task-date" })),
    liveAnnounce: vi.fn(),
    ...overrides,
    onUpdate: overrides.onUpdate ?? vi.fn(async (id, patch) => {
      applyPatch(id, patch);
    }),
  };

  function StatefulHarness() {
    const { lang, t } = useLang();
    const [tasks, setTasks] = useState(initialTasks);
    applyPatch = (id, patch) => {
      setTasks((current) => current.map((task) => (task.id === id ? { ...task, ...patch } : task)));
    };
    return <KanbanCalendar {...props} tasks={tasks} t={t} lang={lang} />;
  }

  render(<LanguageProvider lang="en"><StatefulHarness /></LanguageProvider>);
  return props;
}

function installCalendarRects() {
  const cells = [...document.querySelectorAll("[data-cal-date]")];
  cells.forEach((cell, index) => {
    const column = index % 7;
    const row = Math.floor(index / 7);
    cell.getBoundingClientRect = () => ({
      left: column * 100,
      right: (column + 1) * 100,
      top: row * 100,
      bottom: (row + 1) * 100,
      width: 100,
      height: 100,
      x: column * 100,
      y: row * 100,
      toJSON: () => ({}),
    });
  });
}

function pointerDown(target, { x, y, pointerType = "mouse" }) {
  fireEvent.pointerDown(target, {
    button: 0,
    pointerId: 1,
    pointerType,
    clientX: x,
    clientY: y,
  });
}

describe("KanbanCalendar", () => {
  it("opens on today's month with the accent today pill", () => {
    renderCalendar();
    expect(screen.getByText("August 2026")).toBeInTheDocument();
    const todayNum = document.querySelector(".kan-cal__num--today");
    expect(todayNum).not.toBeNull();
    expect(todayNum.textContent).toContain("Aug 1");
  });

  it("renders a multi-day task as ONE spanning chip per week, cut at the week edge", () => {
    renderCalendar();
    // task-demo-1 runs Jul 27 – Aug 31: one segment per intersecting week,
    // never a copy per day.
    const chips = screen.getAllByRole("button", { name: /Prepare August campaign meeting, WOR-1/ });
    expect(chips).toHaveLength(6);
    expect(chips[0].className).toContain("kan-chip--clip-r");
    expect(chips.at(-1).className).toContain("kan-chip--clip-l");
    // Status tint travels with the chip.
    expect(chips[0].className).toContain("kan-chip--backlog");
  });

  // UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122 (B-48): every
  // bar started with its machine key ("TV-TRANSPORT-FACILITIES-151 Member spotlight…").
  it("leads each bar with the task's title, the key after it, in sight and in its name", () => {
    renderCalendar();
    const chip = screen.getAllByRole("button", { name: /^Coworker outreach calls, WOR-3,/ })[0];
    const body = chip.querySelector(".kan-chip__body");
    expect(body.firstElementChild).toHaveClass("kan-chip__title");
    expect(body.firstElementChild).toHaveTextContent("Coworker outreach calls");
    expect(body.querySelector(".kan-chip__meta .kan-card__key")).toHaveTextContent("WOR-3");
    expect(body.textContent.trim()).toMatch(/^Coworker outreach calls/);
  });

  it("opens the task modal from a chip click and writes nothing", () => {
    const props = renderCalendar();
    fireEvent.click(screen.getAllByRole("button", { name: /Coworker outreach calls, WOR-3/ })[0]);
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-3" }));
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("Alt+Arrow shifts start and due together and announces the new span", async () => {
    const props = renderCalendar();
    const chip = screen.getAllByRole("button", { name: /Coworker outreach calls, WOR-3/ })[0];
    fireEvent.keyDown(chip, { key: "ArrowRight", altKey: true });
    // task-demo-3: Aug 17 – Aug 28, +1 day each side.
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("task-demo-3", {
      startDate: "2026-08-18",
      dueDate: "2026-08-29",
    }));
    await waitFor(() => expect(props.liveAnnounce).toHaveBeenCalledWith(expect.stringContaining("Rescheduled")));
  });

  it("navigates months and returns with Today", () => {
    renderCalendar();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("July 2026")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText("August 2026")).toBeInTheDocument();
  });

  it("switches to the week scale showing today's week only", () => {
    renderCalendar();
    const scale = screen.getByRole("group", { name: "Calendar scale" });
    fireEvent.click(within(scale).getByRole("button", { name: "Week" }));
    expect(within(scale).getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    // One week row: Jul 27 – Aug 2 holds today.
    expect(document.querySelectorAll(".kan-cal__week")).toHaveLength(1);
    expect(screen.getByText(/Jul 27 – Aug 2/)).toBeInTheDocument();
  });

  it("reserves a protected date band above every event lane", () => {
    renderCalendar();
    const week = document.querySelector(".kan-cal__week");
    const event = week.querySelector(".kan-chip");
    // 48px, up from 40px: the day control moved out of the full-height cell and
    // into this header row, where it has to clear the 44px touch floor without
    // reaching into a lane. The 2026-09-12 acceptance audit read the old
    // full-height button.kan-cal__day as clipped-interactive at 390x844.
    expect(week.style.gridTemplateRows).toMatch(/^48px /);
    expect(Number(event.style.gridRow)).toBeGreaterThanOrEqual(2);
  });

  it("opens a date-bound quick composer and creates a one-day calendar item", async () => {
    const props = renderCalendar();
    fireEvent.click(screen.getByRole("button", { name: "Add calendar item on August 6, 2026" }));

    const composer = screen.getByRole("dialog", { name: "Add calendar item on August 6, 2026" });
    const title = within(composer).getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "  Safety walk  " } });
    fireEvent.click(within(composer).getByRole("button", { name: "Add item" }));

    await waitFor(() => expect(props.onCreateDate).toHaveBeenCalledWith("2026-08-06", "Safety walk"));
    await waitFor(() => expect(props.liveAnnounce).toHaveBeenCalledWith("Added to Aug 6"));
    expect(screen.queryByRole("dialog", { name: "Add calendar item on August 6, 2026" })).not.toBeInTheDocument();
  });

  // BUG-UG-CALENDAR-ITEM-TITLE-LONGER-THAN-TASK-TITLE-LIMIT-20261112
  // (#8526): the box took 180 characters while the task title check allows
  // 160, so a 161-180 character item was refused as breaking a rule.
  it("stops the quick composer title at the task title limit the database checks", () => {
    const props = renderCalendar();
    fireEvent.click(screen.getByRole("button", { name: "Add calendar item on August 6, 2026" }));
    const composer = screen.getByRole("dialog", { name: "Add calendar item on August 6, 2026" });
    const title = within(composer).getByRole("textbox", { name: "Calendar item title" });

    const migration = readFileSync(resolve("supabase/migrations/20260727002423_native_work_coordination.sql"), "utf8");
    const limit = Number(migration.match(/chapter_tasks_title_bounded\s+check \(char_length\(btrim\(title\)\) between 1 and (\d+)\)/)?.[1]);
    expect(limit).toBe(160);
    // #9042: the check counts code points after trimming spaces,
    // so padding and emoji within the limit are kept, and only more is cut.
    const padded = `  ${"\u{1F525}".repeat(limit)}  `;
    fireEvent.change(title, { target: { value: padded } });
    expect(title.value).toBe(padded);
    // Past the limit only the fitting start of the new text goes in, as
    // maxLength keeps it (gate review P1-1 and its re-check P2).
    fireEvent.change(title, { target: { value: `${"a".repeat(limit)}b` } });
    expect(title.value).toBe("a".repeat(limit));

    // Cancel closes the composer without creating anything.
    fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Add calendar item on August 6, 2026" })).not.toBeInTheDocument();
    expect(props.onCreateDate).not.toHaveBeenCalled();
  });

  // DEBT-UG-CALENDAR-DUPLICATE-SHORT-DATE-FORMATTER-20260920: the view once
  // built two identical { month: "short", day: "numeric" } formatters and split
  // its consumers between them, so a later change to one silently drifted the
  // day numbers away from the announcements. One formatter, one shape.
  it("builds exactly one short-date formatter", () => {
    const source = readFileSync(resolve(process.cwd(), "src/views/KanbanCalendar.jsx"), "utf8");
    const shortDateFormatters = source.match(
      /new Intl\.DateTimeFormat\([^;]*?month:\s*"short",\s*day:\s*"numeric"/g,
    ) || [];
    expect(shortDateFormatters).toHaveLength(1);
  });

  it("announces an added item in the same short shape the day number renders", async () => {
    const props = renderCalendar();
    const dayNumber = document.querySelector(".kan-cal__num--today").textContent.trim();
    expect(dayNumber).toBe("Aug 1");

    fireEvent.click(screen.getByRole("button", { name: "Add calendar item on August 1, 2026" }));
    const composer = screen.getByRole("dialog", { name: "Add calendar item on August 1, 2026" });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Calendar item title" }), {
      target: { value: "Chapter walk" },
    });
    fireEvent.click(within(composer).getByRole("button", { name: "Add item" }));

    await waitFor(() => expect(props.liveAnnounce).toHaveBeenCalledWith(`Added to ${dayNumber}`));
  });

  it("keeps an empty calendar actionable", () => {
    renderCalendar({ tasks: [] });
    expect(screen.getByRole("button", { name: "Add calendar item on August 6, 2026" })).toBeInTheDocument();
    expect(document.querySelectorAll(".kan-chip")).toHaveLength(0);
  });

  it("quick-filters calendar items and switches event density", () => {
    const tasks = structuredClone(fallbackData).tasks;
    tasks.push({
      ...tasks[0],
      id: "done-calendar-item",
      taskNumber: 99,
      title: "Finished calendar item",
      status: "done",
      startDate: "2026-08-08",
      dueDate: "2026-08-08",
    });
    renderCalendar({ tasks });
    expect(document.querySelectorAll(".kan-chip--done").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Calendar view settings" }));
    const settings = screen.getByRole("dialog", { name: "Calendar view settings" });
    fireEvent.click(within(settings).getByRole("button", { name: "Open only" }));
    expect(document.querySelectorAll(".kan-chip--done")).toHaveLength(0);

    const details = within(settings).getByRole("button", { name: "Show meeting details" });
    expect(details).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelectorAll(".kan-chip:not(.kan-chip--compact)")).toHaveLength(0);

    fireEvent.click(within(settings).getByRole("button", { name: "Milestones only" }));
    expect(within(settings).getByRole("button", { name: "Milestones only" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps sub-threshold mouse movement as an open-without-write click", () => {
    const props = renderCalendar();
    installCalendarRects();
    const chip = screen.getAllByRole("button", { name: /Coworker outreach calls, WOR-3/ })[0];
    pointerDown(chip, { x: 150, y: 50 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 153, clientY: 50 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 153, clientY: 50 });
    fireEvent.click(chip);
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-3" }));
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("moves a lifted mouse drag exactly once relative to the grabbed cell and suppresses open", async () => {
    const props = renderCalendar();
    installCalendarRects();
    const chip = screen.getAllByRole("button", { name: /Coworker outreach calls, WOR-3/ })[0];
    chip.setPointerCapture = vi.fn();
    chip.releasePointerCapture = vi.fn();
    pointerDown(chip, { x: 150, y: 50 }); // grabbed Tuesday Jul 28
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 350, clientY: 50 }); // drop Thursday Jul 30
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 350, clientY: 50 });
    fireEvent.click(chip);

    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("task-demo-3", {
      startDate: "2026-08-19",
      dueDate: "2026-08-30",
    }));
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });

  it("leaves pre-hold touch movement as a pan with no open or write", () => {
    const props = renderCalendar();
    installCalendarRects();
    const chip = screen.getAllByRole("button", { name: /Coworker outreach calls, WOR-3/ })[0];
    pointerDown(chip, { x: 150, y: 50, pointerType: "touch" });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 170, clientY: 50 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 170, clientY: 50 });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("lifts a held touch drag and commits exactly one date-relative write", async () => {
    const props = renderCalendar();
    installCalendarRects();
    const chip = screen.getAllByRole("button", { name: /Coworker outreach calls, WOR-3/ })[0];
    chip.setPointerCapture = vi.fn();
    chip.releasePointerCapture = vi.fn();
    pointerDown(chip, { x: 150, y: 50, pointerType: "touch" });
    await new Promise((resolve) => window.setTimeout(resolve, TOUCH_HOLD_MS + 20));
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 250, clientY: 50 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 250, clientY: 50 });
    fireEvent.click(chip);

    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("task-demo-3", {
      startDate: "2026-08-18",
      dueDate: "2026-08-29",
    }));
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });

  it("cancels a lifted drag on Escape and makes no write or false open", () => {
    const props = renderCalendar();
    installCalendarRects();
    const chip = screen.getAllByRole("button", { name: /Coworker outreach calls, WOR-3/ })[0];
    chip.setPointerCapture = vi.fn();
    chip.releasePointerCapture = vi.fn();
    pointerDown(chip, { x: 150, y: 50 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 350, clientY: 50 });
    expect(document.querySelector(".kan-cal__day--drop")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 350, clientY: 50 });
    fireEvent.click(chip);

    expect(document.querySelector(".kan-cal__day--drop")).toBeNull();
    expect(props.liveAnnounce).toHaveBeenCalledWith("Move cancelled");
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });

  it("makes no false success announcement after a rejected reschedule", async () => {
    const props = renderCalendar({ onUpdate: vi.fn(async () => { throw new Error("rejected"); }) });
    const chip = screen.getAllByRole("button", { name: /Coworker outreach calls, WOR-3/ })[0];
    fireEvent.keyDown(chip, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledTimes(1));
    expect(props.liveAnnounce).not.toHaveBeenCalled();
  });

  it("closes the add composer on Escape while the popover is still opening", async () => {
    renderCalendar();
    const opener = screen.getByRole("button", { name: "Add calendar item on August 6, 2026" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: /Add calendar item on August 6/ });
    expect(dialog).toHaveAttribute("data-state", "opening");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Add calendar item on August 6/ })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps a failed Purple date draft focused and restores the opener after Escape", async () => {
    const props = renderCalendar({ onCreateDate: vi.fn(async () => { throw new Error("rejected"); }) });
    const opener = screen.getByRole("button", { name: "Add calendar item on August 6, 2026" });
    fireEvent.click(opener);
    const title = screen.getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Keep this draft" } });
    title.focus();
    fireEvent.submit(title.closest("form"));
    await waitFor(() => expect(props.onCreateDate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveValue("Keep this draft");
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveFocus();

    await waitFor(() => expect(screen.getByRole("dialog", { name: /Add calendar item on August 6/ })).toHaveAttribute("data-state", "open"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Add calendar item on August 6/ })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps keyboard focus on the moved chip after an Alt+Arrow week shift", async () => {
    const neighbor = calendarTask({
      id: "task-stays",
      taskNumber: 42,
      title: "Unmoved neighbor",
      startDate: "2026-08-04",
      dueDate: "2026-08-04",
    });
    const props = renderStatefulCalendar({ tasks: [calendarTask(), neighbor] });
    const chip = screen.getByRole("button", { name: /Keyboard week shift/ });
    const weeks = [...document.querySelectorAll(".kan-cal__week")];
    expect(weeks[1].contains(chip)).toBe(true);
    chip.focus();
    expect(chip).toHaveFocus();

    fireEvent.keyDown(chip, { key: "ArrowDown", altKey: true });

    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("task-week-shift", {
      startDate: "2026-08-10",
      dueDate: "2026-08-10",
    }));
    const moved = document.querySelector('[data-task-id="task-week-shift"]');
    expect(moved).not.toBeNull();
    expect(document.activeElement).toBe(moved);
    expect([...document.querySelectorAll(".kan-cal__week")][2].contains(moved)).toBe(true);
  });

  it("completes a keyboard week shift off the visible range without throwing or moving focus to an unrelated control", async () => {
    const neighbor = calendarTask({
      id: "task-stays",
      taskNumber: 42,
      title: "Unmoved neighbor",
      startDate: "2026-07-28",
      dueDate: "2026-07-28",
    });
    const props = renderStatefulCalendar({
      tasks: [calendarTask({ startDate: "2026-08-01", dueDate: "2026-08-01" }), neighbor],
    });
    const scale = screen.getByRole("group", { name: "Calendar scale" });
    fireEvent.click(within(scale).getByRole("button", { name: "Week" }));
    expect(document.querySelectorAll(".kan-cal__week")).toHaveLength(1);

    const chip = screen.getByRole("button", { name: /Keyboard week shift/ });
    chip.focus();
    expect(chip).toHaveFocus();

    expect(() => fireEvent.keyDown(chip, { key: "ArrowDown", altKey: true })).not.toThrow();

    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("task-week-shift", {
      startDate: "2026-08-08",
      dueDate: "2026-08-08",
    }));
    expect(document.querySelector('[data-task-id="task-week-shift"]')).toBeNull();
    const active = document.activeElement;
    expect(active?.getAttribute?.("data-task-id")).not.toBe("task-stays");
    expect(active).not.toBe(screen.getByRole("button", { name: "Today" }));
    expect(active).not.toBe(within(scale).getByRole("button", { name: "Week" }));
  });

  it("applies a pointer-drag week shift without stealing focus onto another chip or control", async () => {
    const neighbor = calendarTask({
      id: "task-stays",
      taskNumber: 42,
      title: "Unmoved neighbor",
      startDate: "2026-08-04",
      dueDate: "2026-08-04",
    });
    const props = renderStatefulCalendar({ tasks: [calendarTask(), neighbor] });
    installCalendarRects();
    const chip = screen.getByRole("button", { name: /Keyboard week shift/ });
    chip.setPointerCapture = vi.fn();
    chip.releasePointerCapture = vi.fn();
    const today = screen.getByRole("button", { name: "Today" });
    today.focus();
    expect(today).toHaveFocus();

    pointerDown(chip, { x: 50, y: 150 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 250 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 50, clientY: 250 });

    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("task-week-shift", {
      startDate: "2026-08-10",
      dueDate: "2026-08-10",
    }));
    expect(document.activeElement).not.toBe(document.querySelector('[data-task-id="task-stays"]'));
    expect(document.activeElement?.getAttribute?.("data-task-id")).not.toBe("task-week-shift");
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: /Unmoved neighbor/ }));
  });
});
