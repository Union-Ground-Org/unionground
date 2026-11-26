import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyBoardEvent } from "../src/App.jsx";
import { chapterTaskFromRow } from "../src/lib/memberApi.js";
import { createBoardRefetchQueue } from "../src/lib/boardSync.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T16:05:00.000Z"));
});
afterEach(() => vi.useRealTimers());

const row = (updated_at, extra = {}) => ({
  id: "restored-task", chapter_id: "chapter", task_number: 7,
  title: "Restored work", status: "in_progress", workstream: "Organizing",
  created_at: "2026-07-01T12:00:00.000Z", updated_at, ...extra,
});
const update = (record) => ({ table: "chapter_tasks", operation: "UPDATE", record });
const currentBoard = () => ({ tasks: [chapterTaskFromRow(row("2026-10-20T16:02:00.000Z"))] });
const staleRemovals = [
  ["soft-delete", row("2026-10-20T16:01:00.000Z", { deleted_at: "2026-10-20T16:01:00.000Z" })],
  ["expired done", row("2026-08-01T16:01:00.000Z", { status: "done", done_at: "2026-08-01T16:01:00.000Z" })],
];

it.each(staleRemovals)("keeps a newer restored or reopened task over a stale %s update", (_kind, incoming) => {
  const current = currentBoard();
  expect(applyBoardEvent(current, update(incoming))).toBe(current);
});

it.each(["2026-10-20T16:02:00.000Z", "2026-10-20T16:03:00.000Z"])("applies an equal or newer soft-delete update (%s)", (version) => {
  const incoming = row(version, { deleted_at: version });
  expect(applyBoardEvent(currentBoard(), update(incoming)).tasks).toEqual([]);
});

it("applies a newer expired-done update", () => {
  const incoming = row("2026-10-20T16:03:00.000Z", { status: "done", done_at: "2026-08-01T16:01:00.000Z" });
  expect(applyBoardEvent(currentBoard(), update(incoming)).tasks).toEqual([]);
});

it("applies a physical DELETE whose old record has no update timestamp", () => {
  const deletion = { table: "chapter_tasks", operation: "DELETE", oldRecord: { id: "restored-task" } };
  expect(applyBoardEvent(currentBoard(), deletion).tasks).toEqual([]);
});

it.each(staleRemovals)("keeps the restored snapshot when refetch replays an older %s update", async (_kind, incoming) => {
  const snapshot = currentBoard();
  let resolveLoad;
  const loaded = new Promise((resolve) => { resolveLoad = resolve; });
  let committed;
  const queue = createBoardRefetchQueue({
    load: () => loaded,
    commit: (board, events) => {
      committed = events.reduce(applyBoardEvent, board);
    },
  });
  try {
    const refetch = queue.refetch();
    await Promise.resolve();
    queue.note(update(incoming));
    resolveLoad(snapshot);
    await refetch;
    expect(committed).toBe(snapshot);
  } finally {
    queue.close();
  }
});
