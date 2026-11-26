// UX-UG-WHAT-MATTERS-NOW-SAYS-CAUGHT-UP-WITH-AN-ASSIGNED-TASK-20261112:
// "What matters for you now" ranks an open chapter task assigned to the
// person when it is overdue or due within the seven-day lookahead, instead of
// saying caught up; a person with nothing still reads caught up.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WhatMattersNowCard, whatMattersInputs } from "../src/features/memberHome/WhatMattersNowCard.jsx";
import { TASK_LOOKAHEAD_DAYS, assignedTasksOf, rankWhatMattersNow } from "../src/features/memberHome/whatMattersNow.js";

const SWITCH = "features.home.what_matters_now";
// 2:12 AM Eastern on November 12, 2026.
const NOW = new Date("2026-11-12T07:12:00Z");
const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const overdue = { id: "t1", title: "Order the flyers", status: "in_progress", dueDate: "2026-11-10", assigneeId: ME, assigneeIds: [ME] };

describe("assignedTasksOf", () => {
  it("keeps open tasks where the person is the primary or a co-assignee", () => {
    const tasks = [
      overdue,
      { id: "t2", title: "Co-assigned", status: "to_do", dueDate: null, assigneeId: OTHER, assigneeIds: [OTHER, ME] },
      { id: "t3", title: "Legacy single assignee", status: "to_do", dueDate: "2026-11-13", assigneeId: ME },
      { id: "t4", title: "Done", status: "done", dueDate: "2026-11-01", assigneeId: ME, assigneeIds: [ME] },
      { id: "t5", title: "Someone else's", status: "to_do", dueDate: "2026-11-01", assigneeId: OTHER, assigneeIds: [OTHER] },
      null,
    ];
    expect(assignedTasksOf(tasks, ME)).toEqual([
      { id: "t1", title: "Order the flyers", dueDate: "2026-11-10" },
      { id: "t2", title: "Co-assigned", dueDate: null },
      { id: "t3", title: "Legacy single assignee", dueDate: "2026-11-13" },
    ]);
    expect(assignedTasksOf(tasks, null)).toEqual([]);
    expect(assignedTasksOf("bad", ME)).toEqual([]);
  });
});

describe("rankWhatMattersNow with an assigned task", () => {
  const base = { cases: [], ballots: [], events: [], surveys: [], notices: [], now: NOW };

  it("ranks a person's only overdue assigned task instead of caught up", () => {
    expect(rankWhatMattersNow({ ...base, tasks: [{ id: "t1", title: "Order the flyers", dueDate: "2026-11-10" }] })).toEqual({
      kind: "assigned_task", urgency: "warning",
      task: { id: "t1", title: "Order the flyers" }, days: -2, deadline: "2026-11-10",
      action: { kind: "open_task", taskId: "t1" },
    });
  });

  it("ranks a task due within the lookahead, soonest first, and calm until it is overdue", () => {
    const item = rankWhatMattersNow({ ...base, tasks: [
      { id: "late", title: "Later", dueDate: "2026-11-19" },
      { id: "soon", title: "Sooner", dueDate: "2026-11-13" },
    ] });
    expect(item).toMatchObject({ kind: "assigned_task", urgency: "info", task: { id: "soon" }, days: 1 });
    expect(TASK_LOOKAHEAD_DAYS).toBe(7);
    expect(rankWhatMattersNow({ ...base, tasks: [{ id: "edge", title: "Edge", dueDate: "2026-11-19" }] })).toMatchObject({ kind: "assigned_task", days: 7 });
  });

  it("is caught up when nothing is assigned, nothing is due soon, or the task is done", () => {
    expect(rankWhatMattersNow(base).kind).toBe("caught_up");
    expect(rankWhatMattersNow({ ...base, tasks: [
      { id: "far", title: "Far", dueDate: "2026-11-20" },
      { id: "undated", title: "Undated", dueDate: null },
      { id: "done", title: "Done", dueDate: "2026-11-10", done: true },
      { title: "No id", dueDate: "2026-11-10" },
      null,
    ] }).kind).toBe("caught_up");
    expect(rankWhatMattersNow({ ...base, tasks: "bad" }).kind).toBe("caught_up");
  });

  it("sits below a case in progress and above an open vote", () => {
    const tasks = [{ id: "t1", title: "Order the flyers", dueDate: "2026-11-10" }];
    const ballot = { id: "b1", title: "Ratify", closed: false, voted: false, closesAt: "2026-11-14T00:00:00Z" };
    expect(rankWhatMattersNow({ ...base, tasks, ballots: [ballot] }).kind).toBe("assigned_task");
    expect(rankWhatMattersNow({ ...base, tasks, cases: [{ id: "c1", status: "active", title: "Overtime" }] }).kind).toBe("case_in_progress");
  });
});

function data(overrides = {}) {
  return {
    organizationConfiguration: { switches: { [SWITCH]: true } },
    member: { id: ME, chapterId: "ch-1" },
    cases: [],
    planItems: [],
    events: [],
    tasks: [],
    ...overrides,
  };
}

function card(props, lang = "en") {
  return render(<LanguageProvider lang={lang}><WhatMattersNowCard {...props} /></LanguageProvider>);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("web Home card with an assigned task", () => {
  it("reads the person's own open tasks from the snapshot", () => {
    expect(whatMattersInputs(data({ tasks: [overdue, { ...overdue, id: "t9", assigneeId: OTHER, assigneeIds: [OTHER] }] }), NOW).tasks).toEqual([
      { id: "t1", title: "Order the flyers", dueDate: "2026-11-10" },
    ]);
    expect(whatMattersInputs(data({ tasks: undefined }), NOW).tasks).toEqual([]);
  });

  it("names an overdue assigned task instead of caught up and opens the task list", () => {
    const onOpenTasks = vi.fn();
    card({ data: data({ tasks: [overdue] }), onOpenTasks });
    expect(screen.queryByText("You're caught up")).toBeNull();
    expect(screen.queryByText("Nothing needs your attention right now.")).toBeNull();
    expect(screen.getByText("A task assigned to you is overdue")).toBeTruthy();
    expect(screen.getByText("Order the flyers is 2 days overdue.")).toBeTruthy();
    expect(screen.getByText(/^Due Nov 10/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "What matters for you now" }).getAttribute("data-kind")).toBe("assigned_task");
    fireEvent.click(screen.getByRole("button", { name: "See your tasks" }));
    expect(onOpenTasks).toHaveBeenCalledWith("t1");
  });


  it("still says caught up for a person with nothing at all", () => {
    card({ data: data() });
    expect(screen.getByText("You're caught up")).toBeTruthy();
    expect(screen.getByText("Nothing needs your attention right now.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "What matters for you now" }).getAttribute("data-kind")).toBe("caught_up");
  });
});
