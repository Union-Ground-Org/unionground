// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createChapterTaskDependency,
  createChapterTaskSubtask,
  deleteChapterTaskDependency,
  deleteChapterTaskSubtask,
  unwatchChapterTask,
  watchChapterTask,
} from "../src/lib/memberApi.js";

// REQ-UG-LEARNING-PERIOD-TASKS-20261103: subtask links, dependencies
// and watches go through journalled RPCs; the server derives the chapter and
// the caller, so the client still sends only the endpoint ids.
function clientFor(result) {
  const calls = [];
  return {
    calls,
    client: {
      rpc: (name, args) => { calls.push([name, args]); return Promise.resolve(result); },
      from: (table) => { throw new Error(`direct table write to ${table}`); },
    },
  };
}

describe("Phase 3 task API boundaries", () => {
  it("creates immutable subtask links with endpoint ids only", async () => {
    const { client, calls } = clientFor({ data: [{
      id: "edge-1", chapter_id: "wor", parent_task_id: "p1", subtask_id: "c1", created_at: "now",
    }], error: null });
    await expect(createChapterTaskSubtask(client, "p1", "c1")).resolves.toMatchObject({
      id: "edge-1", parentTaskId: "p1", subtaskId: "c1",
    });
    expect(calls).toEqual([["add_chapter_task_subtask", { p_parent_task_id: "p1", p_subtask_id: "c1" }]]);
  });

  it("deletes a subtask link by immutable edge id", async () => {
    const data = { id: "edge-1" };
    const { client, calls } = clientFor({ data, error: null });
    expect(await deleteChapterTaskSubtask(client, "edge-1")).toBe(data);
    expect(calls).toEqual([["remove_chapter_task_subtask", { p_subtask_link_id: "edge-1" }]]);
  });

  it("adds and removes a dependency by its endpoint and edge ids", async () => {
    const added = clientFor({ data: [{ id: "dep-1", chapter_id: "wor", task_id: "t1", depends_on_id: "t2", created_at: "now" }], error: null });
    await expect(createChapterTaskDependency(added.client, "t1", "t2")).resolves.toMatchObject({ id: "dep-1" });
    expect(added.calls).toEqual([["add_chapter_task_dependency", { p_task_id: "t1", p_depends_on_id: "t2" }]]);
    const removed = clientFor({ data: null, error: null });
    expect(await deleteChapterTaskDependency(removed.client, "dep-1")).toBeNull();
    expect(removed.calls).toEqual([["remove_chapter_task_dependency", { p_dependency_id: "dep-1" }]]);
  });

  it("watches by task id without sending user or chapter identity", async () => {
    const watched = clientFor({ data: { task_id: "t1" }, error: null });
    await expect(watchChapterTask(watched.client, "t1")).resolves.toEqual({ taskId: "t1" });
    expect(watched.calls).toEqual([["watch_chapter_task", { p_task_id: "t1" }]]);
  });

  it("deletes a watch by task id without sending user or chapter identity", async () => {
    const data = { task_id: "t1" };
    const { client, calls } = clientFor({ data, error: null });
    expect(await unwatchChapterTask(client, "t1")).toBe(data);
    expect(calls).toEqual([["unwatch_chapter_task", { p_task_id: "t1" }]]);
  });

  it.each([
    ["subtask removal", deleteChapterTaskSubtask, "edge-1", "Remove subtask"],
    ["unwatch", unwatchChapterTask, "t1", "Unwatch task"],
  ])("propagates a refused %s with its operation label and error code", async (_kind, remove, id, label) => {
    const { client } = clientFor({ data: null, error: { code: "42501", message: "removal refused" } });
    await expect(remove(client, id)).rejects.toMatchObject({
      code: "42501", message: `${label}: removal refused`,
    });
  });
});
