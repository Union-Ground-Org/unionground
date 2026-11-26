import { describe, expect, it, vi } from "vitest";
import {
  MemberApiError, createChapterTask, updateChapterTask, moveChapterTask,
  setChapterTaskAssignees, softDeleteChapterTask, restoreChapterTask,
} from "../src/lib/memberApi.js";

function clientFor(result) {
  const query = {};
  for (const name of ["insert", "update", "select", "eq"]) query[name] = vi.fn(() => query);
  query.single = vi.fn().mockResolvedValue(result);
  return { from: vi.fn(() => query), rpc: vi.fn().mockResolvedValue(result), query };
}

const operations = [
  // REQ-UG-LEARNING-PERIOD-TASKS-20261103: every task-row write is an RPC.
  ["create", client => createChapterTask(client, { title: "Chapter follow-up" }), "rpc"],
  ["rename", client => updateChapterTask(client, "task-1", { title: "Revised" }, "version-1"), "rpc"],
  ["date", client => updateChapterTask(client, "task-1", { dueDate: "2026-12-01" }), "rpc"],
  ["single assignment", client => updateChapterTask(client, "task-1", { assigneeId: "member-2" }), "rpc"],
  ["multiple assignments", client => setChapterTaskAssignees(client, "task-1", ["member-2"]), "rpc"],
  ["move", client => moveChapterTask(client, "task-1", { workstream: "Chapter", status: "done" }), "rpc"],
  ["delete", client => softDeleteChapterTask(client, "task-1"), "rpc"],
  ["restore", client => restoreChapterTask(client, "task-1"), "rpc"],
];

describe("task write outcomes at the PostgREST boundary", () => {
  it.each(operations)("%s preserves the timeout code without retrying", async (_name, write, transport) => {
    const error = { code: "57014", message: "canceling statement due to statement timeout", details: null, hint: null };
    const client = clientFor({ data: null, error });
    const caught = await write(client).catch(cause => cause);
    expect(caught).toBeInstanceOf(MemberApiError);
    expect(caught).toMatchObject({ code: error.code, details: error.details, hint: error.hint });
    expect(transport === "rpc" ? client.rpc : client.query.single).toHaveBeenCalledTimes(1);
  });

  it("keeps the content concurrency token and maps the confirmed row", async () => {
    const row = { id: "task-1", title: "Confirmed title", description: "Notes", updated_at: "version-2", due_date: "2026-12-01" };
    const client = clientFor({ data: [row], error: null });
    const result = await updateChapterTask(client, "task-1", { title: "Confirmed title" }, "version-1");
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("update_chapter_task_content", {
      p_task_id: "task-1", p_expected_updated_at: "version-1", p_title: "Confirmed title", p_description: null,
    });
    expect(result).toMatchObject({ id: "task-1", title: "Confirmed title", updatedAt: "version-2", dueDate: "2026-12-01" });
  });

  it("writes the date and assignment once and returns the server values", async () => {
    const client = clientFor({ data: [{ id: "task-1", due_date: "2026-12-01", assignee_id: "member-2" }], error: null });
    const result = await updateChapterTask(client, "task-1", { dueDate: "2026-12-01", assigneeId: "member-2" }, "version-1");
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("update_chapter_task_fields", {
      p_task_id: "task-1", p_fields: { due_date: "2026-12-01", assignee_id: "member-2" }, p_expected_updated_at: "version-1",
    });
    expect(client.from).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "task-1", dueDate: "2026-12-01", assigneeId: "member-2" });
  });

  it("creates through the RPC and refuses an empty answer", async () => {
    const client = clientFor({ data: [{ id: "task-9", title: "Chapter follow-up" }], error: null });
    await expect(createChapterTask(client, { title: "Chapter follow-up", assigneeId: "" })).resolves.toMatchObject({ id: "task-9" });
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("create_chapter_task", { p_fields: { title: "Chapter follow-up", assignee_id: null } });
    expect(client.from).not.toHaveBeenCalled();
    await expect(createChapterTask(clientFor({ data: [], error: null }), { title: "x" })).rejects.toThrow("Create task: no row returned");
    await expect(updateChapterTask(clientFor({ data: null, error: null }), "task-1", { progress: 5 })).rejects.toThrow("Update task: no row returned");
  });

  it("deduplicates assignees while retaining their order and the RPC result", async () => {
    const confirmed = { task_id: "task-1", assignee_ids: ["member-2", "member-3"] };
    const client = clientFor({ data: confirmed, error: null });
    await expect(setChapterTaskAssignees(client, "task-1", ["member-2", null, "member-2", "member-3"])).resolves.toBe(confirmed);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("set_chapter_task_assignees", {
      p_task_id: "task-1", p_assignee_ids: ["member-2", "member-3"],
    });
  });
});
