import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DONE_WINDOW_MS,
  confirmedTaskProjection,
  createBoardRefetchQueue,
  localTaskRowWins,
  mergeExistingRows,
  nextDoneTaskExpiryDelay,
  pruneExpiredDoneTasks,
  scheduleDoneTaskExpiry,
} from "../src/lib/boardSync.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

describe("board refetch arbitration", () => {
  it("chains overlapping SUBSCRIBED refetches and gives each its own replay buffer", async () => {
    const first = deferred();
    const second = deferred();
    const loads = [first, second];
    const committed = [];
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const queue = createBoardRefetchQueue({
      load: vi.fn(async () => {
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        const next = loads.shift();
        try { return await next.promise; } finally { activeLoads -= 1; }
      }),
      commit: (snapshot, events) => committed.push({ snapshot, events: [...events] }),
    });

    const run1 = queue.refetch();
    const run2 = queue.refetch();
    queue.note("during-first");
    await Promise.resolve();
    expect(maxActiveLoads).toBe(1);

    first.resolve("one");
    await run1;
    await Promise.resolve();
    queue.note("during-second");
    second.resolve("two");
    await run2;

    expect(maxActiveLoads).toBe(1);
    expect(committed).toEqual([
      { snapshot: "one", events: ["during-first"] },
      { snapshot: "two", events: ["during-first", "during-second"] },
    ]);
  });
});

describe("mutation response arbitration", () => {
  it("never resurrects a row that a delete broadcast removed mid-flight", () => {
    const current = [{ id: "still-here", value: "live" }];
    const response = [{ id: "deleted", value: "stale response" }, { id: "still-here", value: "server" }];
    expect(mergeExistingRows(current, response)).toEqual([{ id: "still-here", value: "server" }]);
  });

  // The shared last-write-wins rule (moved here for TasksView, #8211): only a
  // strictly newer local row stays, and a row or stamp that is missing never wins.
  it("keeps a local row only when it is strictly newer than the incoming one", () => {
    const at = (updatedAt) => ({ id: "t1", updatedAt });
    expect(localTaskRowWins(at("2026-08-01T12:05:00Z"), at("2026-08-01T12:00:00Z"))).toBe(true);
    expect(localTaskRowWins(at("2026-08-01T12:05:00Z"), at("2026-08-01T12:05:00Z"))).toBe(false);
    expect(localTaskRowWins(at("2026-08-01T12:00:00Z"), at("2026-08-01T12:05:00Z"))).toBe(false);
    expect(localTaskRowWins(undefined, at("2026-08-01T12:00:00Z"))).toBe(false);
    expect(localTaskRowWins({ id: "t1" }, at("2026-08-01T12:00:00Z"))).toBe(false);
    expect(localTaskRowWins(at("2026-08-01T12:00:00Z"), { id: "t1" })).toBe(true);
    expect(localTaskRowWins(at("2026-08-01T12:00:00Z"), null)).toBe(true);
    const current = [{ ...at("2026-08-01T12:09:00Z"), status: "done" }, { id: "t2", updatedAt: "2026-08-01T12:00:00Z", status: "to_do" }];
    const receipts = [{ ...at("2026-08-01T12:05:00Z"), status: "to_do" }, { id: "t2", updatedAt: "2026-08-01T12:05:00Z", status: "in_progress" }];
    expect(mergeExistingRows(current, receipts, localTaskRowWins).map((row) => row.status)).toEqual(["done", "in_progress"]);
  });

  // A task write's confirmation (#8211, gate round 3 r3s1): replayed on every
  // projection, decorated from that projection's assignments each time.
  it("confirms a task write over a projection: decorated, never stale, an insert only when asked, a deletion always", () => {
    const projection = (tasks, extra = {}) => ({ tasks, taskAssignments: [
      { id: "x1", taskId: "t1", assigneeId: "a", position: 0 }, { id: "x2", taskId: "t1", assigneeId: "b", position: 1 }],
    taskAssignees: [{ id: "a", fullName: "Ana" }, { id: "b", fullName: "Ben" }], ...extra });
    const row = { id: "t1", assigneeId: "a", assigneeName: "", status: "to_do", updatedAt: "2026-11-11T12:05:00Z" };
    const shown = { id: "t1", assigneeIds: ["a", "b"], status: "to_do", updatedAt: "2026-11-11T12:00:00Z" };
    expect(confirmedTaskProjection(projection([shown]), [row]).tasks).toEqual([{ ...row, assigneeIds: ["a", "b"], assigneeNames: ["Ana", "Ben"], assigneeId: "a", assigneeName: "Ana" }]);
    const newer = { ...shown, status: "done", updatedAt: "2026-11-11T12:09:00Z" };
    expect(confirmedTaskProjection(projection([newer]), [row]).tasks).toEqual([newer]);
    expect(confirmedTaskProjection(projection([]), [row]).tasks).toEqual([]);
    expect(confirmedTaskProjection(projection([]), [row], { insert: true }).tasks[0].assigneeIds).toEqual(["a", "b"]);
    expect(confirmedTaskProjection({ tasks: [] }, [{ ...row, id: "t9" }], { insert: true }).tasks[0].assigneeIds).toEqual(["a"]);
    expect(confirmedTaskProjection(projection([shown]), [], { deletedId: "t1" }).tasks).toEqual([]);
    expect(confirmedTaskProjection({}, []).tasks).toEqual([]);
  });
});

describe("done-card window clock", () => {
  const now = Date.parse("2026-08-03T12:00:00Z");

  it("ages a card out at the exact 60-day boundary without needing an event", () => {
    const expired = { id: "old", status: "done", doneAt: new Date(now - DONE_WINDOW_MS - 1).toISOString() };
    const boundary = { id: "edge", status: "done", doneAt: new Date(now - DONE_WINDOW_MS).toISOString() };
    const open = { id: "open", status: "in_progress", doneAt: null };
    expect(pruneExpiredDoneTasks([expired, boundary, open], now).map((task) => task.id)).toEqual(["edge", "open"]);
    expect(nextDoneTaskExpiryDelay([boundary], now)).toBe(0);
  });

  it("schedules the nearest future expiry and ignores open cards", () => {
    const soon = { status: "done", doneAt: new Date(now - DONE_WINDOW_MS + 2500).toISOString() };
    const later = { status: "done", doneAt: new Date(now - DONE_WINDOW_MS + 9000).toISOString() };
    expect(nextDoneTaskExpiryDelay([later, { status: "to_do" }, soon], now)).toBe(2500);
    expect(nextDoneTaskExpiryDelay([{ status: "to_do" }], now)).toBeNull();
  });
});

describe("done-card expiry scheduling", () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("re-arms early capped wakes and expires an idle board after the full sixty days", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-20T12:00:00-04:00");
    vi.setSystemTime(now);
    let tasks = [{ id: "completed", status: "done", doneAt: new Date(now).toISOString() }];
    const expiry = vi.fn(() => { tasks = pruneExpiredDoneTasks(tasks); });
    const stop = scheduleDoneTaskExpiry(tasks, expiry);
    await vi.advanceTimersByTimeAsync(2147483647);
    expect(tasks).toHaveLength(1);
    expect(expiry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DONE_WINDOW_MS - 2147483647);
    expect(tasks).toHaveLength(1);
    expect(expiry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(tasks).toEqual([]);
    expect(expiry).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("keeps the inclusive expiry boundary for a near-term card", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-20T12:00:00-04:00");
    vi.setSystemTime(now);
    const expiry = vi.fn();
    scheduleDoneTaskExpiry([{ status: "done", doneAt: new Date(now - DONE_WINDOW_MS + 2500).toISOString() }], expiry);
    await vi.advanceTimersByTimeAsync(2500);
    expect(expiry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(expiry).toHaveBeenCalledTimes(1);
  });

  it("cancels the re-armed timer when its task list is retired", async () => {
    vi.useFakeTimers();
    const expiry = vi.fn();
    const stop = scheduleDoneTaskExpiry([{ status: "done", doneAt: new Date().toISOString() }], expiry);
    await vi.advanceTimersByTimeAsync(2147483647);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DONE_WINDOW_MS);
    expect(expiry).not.toHaveBeenCalled();
  });

  it.each([undefined, [], [{ status: "in_progress" }]])("schedules no timer without a dated completed task (%j)", (tasks) => {
    vi.useFakeTimers();
    const stop = scheduleDoneTaskExpiry(tasks, vi.fn());
    expect(vi.getTimerCount()).toBe(0);
    expect(stop).toBeTypeOf("function");
    stop();
  });
});
