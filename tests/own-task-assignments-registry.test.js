import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { POSTGREST_MAX_ROWS } from "../src/lib/boundedPage.js";

// Web Home's own-assignment read runs
// only when the chapter-wide assignment read is cut short. #9125: the server
// cuts it at max_rows (1,000), whatever its 6,000-row limit asks, so the fake
// server here answers at most POSTGREST_MAX_ROWS rows as the real one does. If
// it fails, the chapter-wide rows still apply, so the session registry must
// not mark the assignment resource failed and raise the "reload failed" alert
// on Home or the board.
vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => ({
  ...await importOriginal(),
  captureSanitizedDiagnostic: vi.fn(),
}));

const loaders = [];
afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
});

const task = { id: "task-1", chapter_id: "chapter-a", title: "Fictional task", status: "todo", assignee_id: "member-b", order_index: 0, created_at: "2026-11-01T00:00:00Z" };
// A chapter with 1,500 assignment rows; the first is task-1's main assignee.
const chapterRows = Array.from({ length: 1500 }, (_, index) => ({
  id: `a${index}`, task_id: index ? `task-other-${index}` : "task-1", chapter_id: "chapter-a",
  assignee_id: "member-b", position: 0, assigned_at: "2026-11-01T00:00:00Z",
}));
// #9125: member-a co-assigned to task-1, by position past the first 1,000 rows.
const lateOwnRow = { id: "a-late-own", task_id: "task-1", chapter_id: "chapter-a", assignee_id: "member-a", position: 1, assigned_at: "2026-11-02T00:00:00Z" };

function harness({ ownFails, ownRows = null, chapter = chapterRows, cap = POSTGREST_MAX_ROWS, counts = true }) {
  const ownReads = [];
  // Mutable, so a later refresh can fail after an earlier read succeeded.
  const state = { ownFails };
  const answer = (table, calls) => {
    if (table === "member_profiles") return { data: { id: "member-a", first_name: "Member", full_name: "Member A", chapter_id: "chapter-a" }, error: null };
    if (table === "chapter_tasks") return { data: [task], error: null };
    if (table === "chapter_task_assignments") {
      const own = calls.some(([method, args]) => method === "eq" && args[0] === "assignee_id");
      if (!own) {
        // The real server: at most its row cap, whatever .limit() asks, and
        // the exact count when the select asks for one (Content-Range).
        const limit = calls.find(([method]) => method === "limit")?.[1][0] ?? chapter.length;
        const exact = calls.some(([method, args]) => method === "select" && args[1]?.count === "exact");
        return { data: chapter.slice(0, Math.min(limit, cap)), error: null, ...(counts && exact ? { count: chapter.length } : {}) };
      }
      ownReads.push(calls);
      if (ownRows) {
        // A small server: it orders and bounds the member's rows as asked.
        const order = calls.find(([method, args]) => method === "order" && args[0] === "assigned_at");
        const ascending = order?.[1][1]?.ascending !== false;
        const limit = calls.find(([method]) => method === "limit")?.[1][0] ?? ownRows.length;
        const sorted = [...ownRows].sort((a, b) => (ascending ? a.assigned_at.localeCompare(b.assigned_at) : b.assigned_at.localeCompare(a.assigned_at)));
        return { data: sorted.slice(0, limit), error: null };
      }
      return state.ownFails
        ? { data: null, error: { code: "PGRST000", message: "own read failed" }, status: 400 }
        : { data: [{ ...chapterRows[1], id: "own-1", task_id: "task-1", assignee_id: "member-a", chapter_tasks: { status: "todo" } }], error: null };
    }
    return { data: [], error: null };
  };
  const client = {
    from(table) {
      const calls = [];
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => Promise.resolve(answer(table, calls)).then(resolve, reject);
        return (...args) => { calls.push([key, args]); return query; };
      } });
      return query;
    },
    async rpc() { return { data: null, error: null }; },
  };
  const loader = createMemberSessionLoader(client, { id: "member-a" });
  loaders.push(loader);
  return { loader, ownReads, state };
}

describe("the member's own task assignments read at the chapter-wide bound", () => {
  // #9125: before, the own read waited for 6,000 rows the server never sends,
  // so a co-assignee past the first 1,000 rows lost the task.
  it("keeps a co-assignee whose row falls past the server's 1,000-row cap", async () => {
    const own = { ...lateOwnRow, chapter_tasks: { status: "todo" } };
    const h = harness({ ownFails: false, ownRows: [own], chapter: [chapterRows[0], ...chapterRows.slice(1, 1200), lateOwnRow, ...chapterRows.slice(1200)] });
    const projection = await h.loader.loadRoute("today");
    expect(projection.taskAssignments.length).toBeLessThanOrEqual(POSTGREST_MAX_ROWS + 1);
    expect(h.ownReads).toHaveLength(1);
    expect(projection.tasks.find((row) => row.id === "task-1").assigneeIds).toEqual(["member-b", "member-a"]);
  });

  // #9125 follow-up: the cut is read from the server's own count, so a server
  // capping at 500 (or any other number) still triggers the own read.
  it("keeps a co-assignee past a 500-row server cap, from the exact count", async () => {
    const own = { ...lateOwnRow, chapter_tasks: { status: "todo" } };
    const h = harness({ ownFails: false, ownRows: [own], cap: 500, chapter: [chapterRows[0], ...chapterRows.slice(1, 700), lateOwnRow, ...chapterRows.slice(700)] });
    const projection = await h.loader.loadRoute("today");
    expect(h.ownReads).toHaveLength(1);
    expect(projection.tasks.find((row) => row.id === "task-1").assigneeIds).toEqual(["member-b", "member-a"]);
  });

  it("falls back to the 1,000-row cap when the server sends no count", async () => {
    const own = { ...lateOwnRow, chapter_tasks: { status: "todo" } };
    const h = harness({ ownFails: false, ownRows: [own], counts: false, chapter: [chapterRows[0], ...chapterRows.slice(1, 1200), lateOwnRow, ...chapterRows.slice(1200)] });
    const projection = await h.loader.loadRoute("today");
    expect(h.ownReads).toHaveLength(1);
    expect(projection.tasks.find((row) => row.id === "task-1").assigneeIds).toEqual(["member-b", "member-a"]);
  });

  it("does not read the member's own rows when the chapter-wide read was not cut short", async () => {
    const h = harness({ ownFails: false, chapter: [chapterRows[0], lateOwnRow, ...chapterRows.slice(1, 500)] });
    const projection = await h.loader.loadRoute("today");
    expect(h.ownReads).toHaveLength(0);
    expect(projection.tasks.find((row) => row.id === "task-1").assigneeIds).toEqual(["member-b", "member-a"]);
  });

  it("keeps the chapter-wide rows and raises no reload-failed state when it fails", async () => {
    const h = harness({ ownFails: true });
    const projection = await h.loader.loadRoute("today");
    expect(h.ownReads.length).toBeGreaterThan(0);
    expect(projection.taskAssignments).toHaveLength(POSTGREST_MAX_ROWS);
    expect(h.loader.inspect().get("table:chapter_task_assignments").failure).toBeNull();
    expect(h.loader.stateForRoute("today").refreshError).toBe("");
  });

  // A member with more than 500 open assignments
  // keeps the oldest assigned, not the newest 500.
  it("keeps the member's oldest open assignment past the own read's 500-row bound", async () => {
    const newer = Array.from({ length: 600 }, (_, index) => ({
      id: `own-new-${index}`, task_id: `task-elsewhere-${index}`, chapter_id: "chapter-a", assignee_id: "member-a",
      position: 1, assigned_at: `2026-11-${String(10 + (index % 5)).padStart(2, "0")}T12:00:00Z`, chapter_tasks: { status: "todo" },
    }));
    const oldest = { id: "own-oldest", task_id: "task-1", chapter_id: "chapter-a", assignee_id: "member-a", position: 1, assigned_at: "2026-09-01T12:00:00Z", chapter_tasks: { status: "todo" } };
    const h = harness({ ownFails: false, ownRows: [...newer, oldest] });
    const projection = await h.loader.loadRoute("today");
    expect(projection.tasks.find((row) => row.id === "task-1").assigneeIds).toEqual(["member-b", "member-a"]);
  });

  // After an earlier own read succeeded, a failed refresh
  // keeps those rows and is withdrawn as well, so no reload-failed alert.
  it("raises no reload-failed state when a refresh of an earlier good own read fails", async () => {
    const h = harness({ ownFails: false });
    await h.loader.loadRoute("today");
    h.state.ownFails = true;
    h.loader.invalidateResources(["table:chapter_task_assignments"]);
    const projection = await h.loader.loadRoute("today");
    expect(h.ownReads.length).toBeGreaterThan(1);
    expect(projection.tasks.find((row) => row.id === "task-1").assigneeIds).toEqual(["member-b", "member-a"]);
    expect(h.loader.inspect().get("table:chapter_task_assignments").failure).toBeNull();
    expect(h.loader.stateForRoute("today").refreshError).toBe("");
  });

  it("adds the member's own row when it succeeds", async () => {
    const h = harness({ ownFails: false });
    const projection = await h.loader.loadRoute("today");
    expect(projection.tasks.find((row) => row.id === "task-1").assigneeIds).toEqual(["member-b", "member-a"]);
    expect(h.loader.stateForRoute("today").refreshError).toBe("");
  });
});
