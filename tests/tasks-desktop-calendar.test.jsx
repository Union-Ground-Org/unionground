import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { applyDeviceParityState } from "../src/lib/deviceParity.js";
import { KanbanCalendar } from "../src/views/KanbanCalendar.jsx";
import { expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const TASKS = [
  {
    id: "span",
    taskNumber: 201,
    title: "Prepare bargaining calendar",
    status: "in_progress",
    priority: "high",
    startDate: "2026-08-01",
    dueDate: "2026-08-10",
    assigneeName: "Jordan Lee",
    createdAt: "2026-08-01T09:00:00Z",
  },
  {
    id: "milestone",
    taskNumber: 202,
    title: "Ratification milestone",
    status: "to_do",
    priority: "medium",
    startDate: "2026-08-18",
    dueDate: "2026-08-18",
    milestone: true,
    createdAt: "2026-08-02T09:00:00Z",
  },
  {
    id: "half",
    taskNumber: 203,
    title: "Due-only records request",
    status: "backlog",
    priority: "low",
    startDate: null,
    dueDate: "2026-08-20",
    createdAt: "2026-08-03T09:00:00Z",
  },
];

function Harness(props) {
  const { lang, t } = useLang();
  return <KanbanCalendar {...props} t={t} lang={lang} />;
}

function renderCalendar(overrides = {}, lang = "en") {
  const props = {
    tasks: structuredClone(TASKS),
    chapterId: "wor",
    desktopWork: true,
    onOpenTask: vi.fn(),
    onUpdate: vi.fn(async (_id, patch) => patch),
    onCreateDate: vi.fn(async (date, title) => ({
      id: "created-date-task",
      taskNumber: 204,
      title,
      status: "to_do",
      startDate: date,
      dueDate: date,
    })),
    liveAnnounce: vi.fn(),
    ...overrides,
  };
  const view = render(<LanguageProvider lang={lang}><Harness {...props} /></LanguageProvider>);
  return { props, view };
}

function openComposer(date = "2026-08-06") {
  fireEvent.click(screen.getByRole("button", { name: `Add calendar item on August ${Number(date.slice(-2))}, 2026` }));
  return screen.getByRole("dialog", { name: `Add calendar item on August ${Number(date.slice(-2))}, 2026` });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 1, 12));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Green desktop Calendar geometry", () => {
  it("uses a Monday-first fixed 42-cell month and a Monday-first seven-cell week", () => {
    renderCalendar();
    const calendar = screen.getByRole("region", { name: "Calendar" });
    expect(calendar).toHaveClass("kan-cal--desktop-work");
    expect(calendar.querySelectorAll(".kan-cal__day")).toHaveLength(42);
    expect(document.querySelectorAll(".kan-cal__week")).toHaveLength(6);
    expect(document.querySelector('.kan-cal__week[data-week-start="2026-07-27"]')).not.toBeNull();
    expect(document.querySelector('.kan-cal__day[data-cal-date="2026-09-06"]')).not.toBeNull();
    expect([...document.querySelectorAll(".kan-cal__dow span")].map((node) => node.textContent)).toEqual([
      "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
    ]);

    fireEvent.click(within(screen.getByRole("group", { name: "Calendar scale" })).getByRole("button", { name: "Week" }));
    expect(calendar.querySelectorAll(".kan-cal__day")).toHaveLength(7);
    expect(document.querySelectorAll(".kan-cal__week")).toHaveLength(1);
    expect(screen.getByText("Jul 27 – Aug 2")).toBeInTheDocument();
  });

  it("fails closed to today when a synchronized calendar anchor is malformed", () => {
    applyDeviceParityState("tasks.calendar.anchor", "not-a-date");
    renderCalendar();

    expect(screen.getByText("August 2026")).toBeInTheDocument();
    expect(document.querySelectorAll(".kan-cal__day")).toHaveLength(42);
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("July 2026")).toBeInTheDocument();
  });

  it("composes batched week navigation from the latest synchronized anchor", () => {
    renderCalendar();
    fireEvent.click(within(screen.getByRole("group", { name: "Calendar scale" })).getByRole("button", { name: "Week" }));
    const later = screen.getByRole("button", { name: "Show later dates" });

    act(() => {
      later.click();
      later.click();
    });

    expect(screen.getByText("Aug 10 – Aug 16")).toBeInTheDocument();
  });

  it("keeps the frozen non-desktop Calendar Monday-first and dynamically sized", () => {
    renderCalendar({ desktopWork: false });
    const calendar = screen.getByRole("region", { name: "Calendar" });
    expect(calendar).not.toHaveClass("kan-cal--desktop-work");
    expect(calendar.querySelectorAll("button.kan-cal__day")).toHaveLength(42);
    expect([...calendar.querySelectorAll(".kan-cal__dow span")].map((node) => node.textContent)).toEqual([
      "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("February 2026")).toBeInTheDocument();
    expect(document.querySelectorAll(".kan-cal__week")).toHaveLength(5);
  });

  it("places a dated task in the same weekday column on phone and desktop", () => {
    const weekdayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const columnOf = (date) => {
      const cell = document.querySelector(`[data-cal-date="${date}"]`);
      const week = cell?.closest(".kan-cal__week");
      return [...week.querySelectorAll("[data-cal-date]")].findIndex((node) => node.getAttribute("data-cal-date") === date);
    };

    const phone = renderCalendar({ desktopWork: false });
    expect([...document.querySelectorAll(".kan-cal__dow span")].map((node) => node.textContent)).toEqual(weekdayOrder);
    const phoneColumn = columnOf("2026-08-06");
    phone.view.unmount();

    renderCalendar({ desktopWork: true });
    expect([...document.querySelectorAll(".kan-cal__dow span")].map((node) => node.textContent)).toEqual(weekdayOrder);
    expect(columnOf("2026-08-06")).toBe(phoneColumn);
    expect(phoneColumn).toBe(3);
  });

  it("aligns localized desktop weekday headers to the same Monday-first date array", () => {
    renderCalendar({}, "es");
    const labels = [...document.querySelectorAll(".kan-cal__dow span")].map((node) => node.textContent.toLocaleLowerCase("es"));
    expect(labels[0]).toMatch(/^lun/);
    expect(labels[1]).toMatch(/^mar/);
    expect(labels[6]).toMatch(/^dom/);
    expect(screen.getByRole("button", { name: "Mes anterior" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hoy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mes siguiente" })).toBeInTheDocument();
  });

  it("uses non-interactive gridcells with separate add-date buttons", () => {
    renderCalendar();
    const cell = document.querySelector('.kan-cal__day[data-cal-date="2026-08-06"]');
    expect(cell).not.toBeNull();
    expect(cell.tagName).not.toBe("BUTTON");
    // The cell is now paint and drop target only, and says so: it is the
    // column's full-height decoration, aria-hidden, and carries no control. The
    // add-date button moved to the sibling header bar, because absolutely
    // positioning it inside this full-height box is what the acceptance audit
    // reported as an element-collision at 768x1024 and 1440x900.
    expect(cell).toHaveAttribute("aria-hidden", "true");
    expect(within(cell).queryAllByRole("button", { hidden: true })).toHaveLength(0);
    const bar = cell.nextElementSibling;
    expect(bar).toHaveClass("kan-cal__daybar");
    const add = within(bar).getByRole("button", { name: "Add calendar item on August 6, 2026" });
    expect(add).toHaveClass("kan-cal__add-date");
    expect(add.closest("button button")).toBeNull();
  });

  it("renders one lane-packed segment per touched Monday-first week and clips its edges", () => {
    renderCalendar();
    const chips = screen.getAllByRole("button", { name: /Prepare bargaining calendar, WOR-201/ });
    expect(chips).toHaveLength(3);
    expect(chips[0].closest(".kan-cal__week")).toHaveAttribute("data-week-start", "2026-07-27");
    expect(chips[0]).toHaveClass("kan-chip--clip-r");
    expect(chips[1]).toHaveClass("kan-chip--clip-l", "kan-chip--clip-r");
    expect(chips[2]).toHaveClass("kan-chip--clip-l");
  });

  it("fails closed for malformed, impossible, and inverted task spans", () => {
    const invalid = [
      { ...TASKS[0], id: "bad-shape", title: "Malformed date", startDate: "August 4", dueDate: "2026-08-06" },
      { ...TASKS[0], id: "bad-day", title: "Impossible date", startDate: "2026-08-40", dueDate: "2026-08-41" },
      { ...TASKS[0], id: "inverted", title: "Inverted span", startDate: "2026-08-10", dueDate: "2026-08-05" },
    ];
    const { props } = renderCalendar({ tasks: [...structuredClone(TASKS), ...invalid] });
    expect(screen.queryByRole("button", { name: /Malformed date/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Impossible date/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Inverted span/ })).not.toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("opens real tasks without writing and shifts valid half-dated tasks through one canonical patch", async () => {
    const { props } = renderCalendar();
    const chip = screen.getByRole("button", { name: /Due-only records request, WOR-203/ });
    fireEvent.click(chip);
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "half" }));
    expect(props.onUpdate).not.toHaveBeenCalled();

    fireEvent.keyDown(chip, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("half", {
      startDate: "2026-08-21",
      dueDate: "2026-08-21",
    }));
    expect(props.liveAnnounce).toHaveBeenCalledWith(expect.stringContaining("Rescheduled"));
  });

  it("reuses settings, details, and filters in the desktop anatomy", () => {
    renderCalendar();
    fireEvent.click(screen.getByRole("button", { name: "Calendar view settings" }));
    const settings = screen.getByRole("dialog", { name: "Calendar view settings" });
    fireEvent.click(within(settings).getByRole("button", { name: "Milestones only" }));
    expect(screen.getByRole("button", { name: /Ratification milestone, WOR-202/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Prepare bargaining calendar, WOR-201/ })).not.toBeInTheDocument();
    const details = within(settings).getByRole("button", { name: "Show meeting details" });
    fireEvent.click(details);
    expect(screen.getByRole("button", { name: /Ratification milestone, WOR-202/ })).toHaveClass("kan-chip--compact");
  });
});

describe("Green desktop Calendar creation boundary", () => {
  it("opens the authoritative created task exactly once after successful creation", async () => {
    const { props } = renderCalendar();
    const composer = openComposer();
    const title = within(composer).getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "  Safety walk  " } });
    fireEvent.submit(title.closest("form"));

    await waitFor(() => expect(props.onCreateDate).toHaveBeenCalledWith("2026-08-06", "Safety walk"));
    await waitFor(() => expect(props.onOpenTask).toHaveBeenCalledTimes(1));
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "created-date-task" }));
    expect(props.liveAnnounce).toHaveBeenCalledWith("Added to Aug 6");
    expect(screen.queryByRole("dialog", { name: /Add calendar item on August 6/ })).not.toBeInTheDocument();
  });

  it("retains the title and focus with no success or open for a null authoritative result", async () => {
    const { props } = renderCalendar({ onCreateDate: vi.fn(async () => null) });
    const composer = openComposer();
    const title = within(composer).getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Records follow-up" } });
    title.focus();
    fireEvent.submit(title.closest("form"));

    await waitFor(() => expect(props.onCreateDate).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("textbox", { name: "Calendar item title" })).toHaveValue("Records follow-up");
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveFocus();
    expect(props.liveAnnounce).not.toHaveBeenCalled();
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });

  it("locks the submitted composer against Escape, outside dismissal, and another date while pending", async () => {
    let resolveCreate;
    const deferred = new Promise((resolve) => { resolveCreate = resolve; });
    const onCreateDate = vi.fn(() => deferred);
    const { props } = renderCalendar({ onCreateDate });
    const composer = openComposer();
    const title = within(composer).getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Submitted title" } });
    fireEvent.submit(title.closest("form"));
    await waitFor(() => expect(onCreateDate).toHaveBeenCalledTimes(1));
    expect(title).toHaveAttribute("aria-disabled", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Add calendar item on August 7, 2026" }));
    expect(screen.getByRole("dialog", { name: "Add calendar item on August 6, 2026" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveValue("Submitted title");

    await act(async () => resolveCreate({ id: "created-date-task", title: "Submitted title", startDate: "2026-08-06", dueDate: "2026-08-06" }));
    expect(props.liveAnnounce).toHaveBeenCalledWith("Added to Aug 6");
    expect(props.onOpenTask).toHaveBeenCalledTimes(1);
  });

  // Record 8435: the composer's create is locked synchronously, so a second
  // submit in the same tick creates nothing more (focus stays on the title).
  const readyComposer = (onCreateDate) => {
    renderCalendar({ onCreateDate });
    const composer = openComposer();
    fireEvent.change(within(composer).getByRole("textbox", { name: "Calendar item title" }), { target: { value: "Held title" } });
    return within(composer).getByRole("button", { name: "Add item" });
  };

  it("creates nothing for a blank title, even on a direct submit", () => {
    const onCreateDate = vi.fn();
    renderCalendar({ onCreateDate });
    const composer = openComposer();
    const title = within(composer).getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.submit(title.closest("form"));
    expect(onCreateDate).not.toHaveBeenCalled();
  });

  it("creates one item when Add item is activated twice in one tick", async () => {
    const onCreateDate = vi.fn(async () => ({ id: "once", title: "Held title", startDate: "2026-08-06", dueDate: "2026-08-06" }));
    const add = readyComposer(onCreateDate);
    await expectOneWriteFromOneTick(onCreateDate, [() => fireEvent.click(add), () => fireEvent.click(add)]);
  });

  it("keeps a failed draft focused and retries to one successful open", async () => {
    const onCreateDate = vi.fn()
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce({ id: "retry-created", title: "Retry me", startDate: "2026-08-06", dueDate: "2026-08-06" });
    const { props } = renderCalendar({ onCreateDate });
    const composer = openComposer();
    const title = within(composer).getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Retry me" } });
    fireEvent.submit(title.closest("form"));

    await waitFor(() => expect(onCreateDate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveValue("Retry me");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveFocus());
    expect(props.liveAnnounce).not.toHaveBeenCalled();
    expect(props.onOpenTask).not.toHaveBeenCalled();

    fireEvent.submit(title.closest("form"));
    await waitFor(() => expect(onCreateDate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(props.onOpenTask).toHaveBeenCalledTimes(1));
    expect(props.liveAnnounce).toHaveBeenCalledTimes(1);
  });

  // Record #9469 (W6-6): a null result is a failure off the desktop shell too:
  // the title stays and nothing announces "Added" (it used to clear and announce).
  it("keeps the Purple draft for a null result, with no announcement and no open", async () => {
    const { props } = renderCalendar({ desktopWork: false, onCreateDate: vi.fn(async () => null) });
    const composer = openComposer();
    const title = within(composer).getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Purple draft" } });
    fireEvent.submit(title.closest("form"));

    await waitFor(() => expect(props.onCreateDate).toHaveBeenCalledTimes(1));
    expect(within(screen.getByRole("dialog", { name: /Add calendar item on August 6/ })).getByRole("textbox", { name: "Calendar item title" })).toHaveValue("Purple draft");
    expect(props.liveAnnounce).not.toHaveBeenCalledWith("Added to Aug 6");
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });

  it("returns focus to the kept title after a null result off the desktop shell (#9469)", async () => {
    renderCalendar({ desktopWork: false, onCreateDate: vi.fn(async () => null) });
    const title = within(openComposer()).getByRole("textbox", { name: "Calendar item title" });
    fireEvent.change(title, { target: { value: "Purple draft" } });
    const add = screen.getByRole("button", { name: "Add item" });
    add.focus();
    fireEvent.click(add);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Calendar item title" })).toHaveFocus());
  });
});
