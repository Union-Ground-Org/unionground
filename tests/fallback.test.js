import { describe, expect, it } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

describe("fallback demo data", () => {
  it("keeps the Product Hub demonstrable with a durable nested topic", () => {
    expect(fallbackData.product.spaces).not.toHaveLength(0);
    expect(fallbackData.product.spaces[0].threads).not.toHaveLength(0);
    expect(fallbackData.product.spaces[0].threads[0].posts).not.toHaveLength(0);
    expect(fallbackData.product.documents).not.toHaveLength(0);
    expect(fallbackData.product.records).not.toHaveLength(0);
  });

  it("keeps the source dashboard totals internally consistent", () => {
    expect(fallbackData.weekly).toEqual({ done: 3, goal: null, streakDays: 0 });
    expect(fallbackData.recognitionCatalog.rules).toHaveLength(5);
    expect(fallbackData).not.toHaveProperty("rewards");
    expect(fallbackData.cases.filter((item) => item.status === "active")).toHaveLength(1);
    expect(fallbackData.broadcasts).toHaveLength(20);
    // "Voted" is the closed results-bearing ballot (UB-VOTE-02 demo).
    expect(fallbackData.planItems.map((item) => item.action)).toEqual(["Vote", "Voted", "Answer", "Start"]);
    // Demo mode reads this fixture directly, so it must carry the same metrics
    // shape the live loader produces or the Numbers chart renders undefined.
    expect(fallbackData.metrics.weeks).toHaveLength(12);
    expect(fallbackData.metrics.weeksPeak).toBe(Math.max(...fallbackData.metrics.weeks));
    // SEIU Local 509 is a real organization; no demo venue may name it.
    expect(JSON.stringify(fallbackData)).not.toMatch(/Local 509/);
    expect(JSON.stringify(fallbackData)).not.toMatch(/Weingarten/);
    expect(JSON.stringify(fallbackData)).not.toMatch(/Chapter steward/);
    expect(JSON.stringify(fallbackData)).not.toMatch(/Grievance report/);
  });

  it("demonstrates every coordination state with valid schedules", () => {
    expect(new Set(fallbackData.tasks.map((task) => task.status))).toEqual(new Set(["backlog", "to_do", "in_progress", "needs_review", "done"]));
    expect(fallbackData.tasks.some((task) => task.blocked)).toBe(true);
    expect(fallbackData.tasks.some((task) => task.milestone)).toBe(true);
    for (const task of fallbackData.tasks) {
      expect(fallbackData.taskAssignees.some((person) => person.id === task.assigneeId), task.title).toBe(true);
      if (task.startDate && task.dueDate) expect(task.dueDate >= task.startDate, task.title).toBe(true);
      expect(task.progress).toBeGreaterThanOrEqual(0);
      expect(task.progress).toBeLessThanOrEqual(100);
      if (task.status === "done") expect(task.progress).toBe(100);
    }
    const memberId = fallbackData.member.id;
    expect(fallbackData.tasks.some((task) => task.createdBy === memberId)).toBe(true);
    expect(fallbackData.tasks.some((task) => task.assigneeId === memberId)).toBe(true);
    expect(fallbackData.tasks.some((task) => task.createdBy !== memberId && task.assigneeId !== memberId)).toBe(true);
  });

  it("seeds a private task thread between the demo member and assigned person", () => {
    expect(fallbackData.taskMessages).toHaveLength(2);
    for (const message of fallbackData.taskMessages) {
      const task = fallbackData.tasks.find((item) => item.id === message.taskId);
      expect(task).toBeTruthy();
      expect(new Set([message.senderId, message.recipientId])).toEqual(
        new Set([fallbackData.member.id, task.assigneeId]),
      );
    }
  });

  it("seeds board-inherited comments, authorized links, and audit history without copied sensitive content", () => {
    expect(fallbackData.taskComments.length).toBeGreaterThan(0);
    expect(fallbackData.taskAttachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordUrl: expect.stringMatching(/^\/m\//) }),
    ]));
    expect(fallbackData.taskActivity.map((entry) => entry.action)).toEqual(expect.arrayContaining(["created", "assignee_changed", "attachment_added"]));
  });
});

// The fixture is the one place these invariants can break. loadMemberApp gets
// each of them for free by deriving from a single row set; the demo path builds
// the same shape by hand, so only it can produce a self-inconsistent member.
describe("fallback demo data holds the invariants the live loader gets for free", () => {
  const { rights } = fallbackData;

  it("advertises exactly the lessons it can render", () => {
    // memberApi.js maps `lessons` and `lessonRecords` from the same rows, so
    // they are parallel by construction there. Here they must be asserted.
    expect(rights.lessons).toEqual(rights.lessonRecords.map((item) => item.label));
  });

  it("resolves every advertised tab to its OWN record, never the [0] fallback", () => {
    // The exact expression RightsView.jsx uses. Before this was fixed, four of
    // the five tabs missed and fell through to lessonRecords[0],
    // rendering that lesson's title, checklist and script under the clicked
    // label — the eyebrow comes from the label, not from the resolved record.
    for (const label of rights.lessons) {
      const resolved = rights.lessonRecords.find((item) => item.label === label) || rights.lessonRecords[0];
      expect(resolved.label, `tab "${label}" falls through to "${rights.lessonRecords[0].label}"`).toBe(label);
      expect(resolved.steps.length, `tab "${label}" has no checklist`).toBeGreaterThan(0);
      expect(resolved.script, `tab "${label}" has no script`).toBeTruthy();
    }
  });

  it("keeps every organizing-rights lesson free of existing-union doctrine", () => {
    // Union Ground pins these records to its member_rights_lessons seed. That
    // seed teaches Weingarten, Loudermill and steward representation, which
    // only exist once a union and a contract do, so Union Ground's demo
    // carries its own five organizing lessons instead. Until the database wave
    // seeds them, this pins the set itself: the exact topics, complete
    // records, and none of the grievance-era vocabulary.
    expect(rights.lessonRecords.map((record) => record.id)).toEqual([
      "section-7", "supervisor-questions", "cards-majority", "captive-meeting", "retaliation",
    ]);
    expect(rights.lessons).toEqual(["Section 7", "Supervisor questions", "Cards & majority", "Captive meeting", "Retaliation"]);
    for (const record of rights.lessonRecords) {
      for (const field of ["label", "title", "description", "script"]) {
        expect(record[field], `lesson ${record.id}: ${field}`).toBeTruthy();
      }
      const text = JSON.stringify(record);
      expect(text, `lesson ${record.id}`).not.toMatch(/Weingarten|Loudermill|steward|grievance|union representation|contract article/i);
    }
    // The walkthrough header is the selected lesson's own copy.
    expect(rights.title).toBe(rights.lessonRecords[0].title);
    expect(rights.steps).toEqual(rights.lessonRecords[0].steps);
    expect(rights.script).toBe(rights.lessonRecords[0].script);
  });

  it("gives every case a deadlineValue its rendered label agrees with", () => {
    // loadMemberApp derives deadlineValue from the raw column and the label
    // from the same value, so they always agree. CasesView binds deadlineValue
    // to <input type="date">, which silently ignores a non-ISO string — so a
    // wrong value here is invisible until someone opens the edit dialog.
    const label = (iso) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(`${iso}T12:00:00`));
    for (const item of fallbackData.cases) {
      expect(item.deadlineValue, `case ${item.reference} has no deadlineValue`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(label(item.deadlineValue), `case ${item.reference} label disagrees with its date`).toBe(item.deadline);
    }
  });
});
