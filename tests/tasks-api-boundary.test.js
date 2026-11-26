// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  CHAPTER_TASK_DEPENDENCY_LIMIT,
  insertChapterWorkstream,
  loadChapterTaskBoard,
  loadChapterTaskReport,
  loadMemberApp,
  mergeChapterWorkstreams,
  previewChapterWorkstreamMerge,
  renameChapterWorkstream,
  restoreChapterTask,
  softDeleteChapterTask,
  subscribeToChapterTaskBoard,
} from "../src/lib/memberApi.js";

// The server RPCs behind these wrappers do not exist in any test DB yet —
// everything here mocks at the supabase-client boundary, which is exactly the
// seam the neighbouring API suites use.

function recordingClient({ tables = {}, rpcs = {} } = {}) {
  const calls = [];
  function chainable(table, result) {
    const proxy = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
        return (...args) => {
          calls.push([table, prop, args]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  // The realtime seam, recorded the same way as the query chains. The channel
  // fake keeps its broadcast bindings and subscribe callback reachable so a
  // test can both pin the wiring AND drive a payload through a recorded
  // handler — the client library itself is never loaded here.
  const channels = [];
  return {
    calls,
    channels,
    from: (table) => chainable(table, tables[table] ?? { data: [], error: null }),
    rpc: (name, args) => {
      calls.push(["rpc", name, [args]]);
      const handler = rpcs[name];
      const result = typeof handler === "function" ? handler(args) : handler;
      return Promise.resolve(result ?? { data: null, error: { message: `no fake for rpc ${name}` } });
    },
    channel: (topic, opts) => {
      calls.push(["channel", topic, [opts]]);
      const channel = {
        topic,
        opts,
        bindings: [],
        statusCallback: null,
        on(type, filter, handler) {
          channel.bindings.push([type, filter, handler]);
          return channel;
        },
        subscribe(onStatus) {
          channel.statusCallback = onStatus;
          calls.push(["subscribe", topic, []]);
          return channel;
        },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel: (channel) => {
      calls.push(["removeChannel", channel.topic, []]);
    },
  };
}

const PROFILE = {
  id: "user-1", first_name: "D", full_name: "D F", initials: "DF",
  role_line: "Member", member_since: 2023, language: "en",
  notification_prefs: {}, chapter_id: "wor",
};

const MEMBER_RPCS = {
  get_member_rewards_summary: { data: {}, error: null },
  get_workload_stats: { data: {}, error: null },
  list_chapter_task_assignees: { data: [], error: null },
  get_chapter_standing: { data: null, error: null },
  list_chapter_task_dependencies: { data: [], error: null },
};

// The exact select list, pinned as a STRING: task_number joined it for the
// kanban card keys (WOR-42), and the server assigns that column via trigger —
// it is deliberately absent from the insert/update grants, so dropping it from
// the read is the only way the client could lose it, and every card key on the
// board would render blank while the writes stayed green. This member boot
// read uses the common columns; the dedicated task read also queries settings_scope.
const CHAPTER_TASK_COLUMNS =
  "id,chapter_id,task_number,title,description,status,priority,task_type,workstream,assignee_id,assignee_name," +
  "start_date,due_date,progress,blocked,milestone,order_index,created_by,updated_by,done_at,created_at,updated_at";

describe("the bounded board read", () => {
  it("loads persistent comments through one profile-derived chapter keyset", async () => {
    const client = recordingClient({
      tables: {
        member_profiles: { data: PROFILE, error: null },
        chapter_task_comments: { data: [], error: null },
      },
      rpcs: MEMBER_RPCS,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(client.calls.filter(([table, method]) =>
      table === "member_profiles" && method === "select")).toHaveLength(1);
    expect(client.calls.filter(([table]) => table === "chapter_task_comments").map(([, method, args]) => [method, args]))
      .toEqual([
        ["select", [expect.stringContaining("mentioned_user_ids")]],
        ["eq", ["chapter_id", "wor"]],
        ["order", ["created_at", { ascending: false }]],
        ["order", ["id", { ascending: false }]],
        ["limit", [1000]],
      ]);
    expect(out.taskComments).toEqual([]);
    expect(out.taskCommentsUnavailable).toBe(false);
    expect(out.taskCommentsTruncated).toBe(false);
  });

  it("marks a failed persistent-comment read unavailable without claiming truncation", async () => {
    const client = recordingClient({
      tables: {
        member_profiles: { data: PROFILE, error: null },
        chapter_task_comments: { data: null, error: { message: "unavailable" } },
      },
      rpcs: MEMBER_RPCS,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.taskComments).toEqual([]);
    expect(out.taskCommentsUnavailable).toBe(true);
    expect(out.taskCommentsTruncated).toBe(false);
  });

  it("windows chapter_tasks to open-or-recently-done, capped at 500 rows", async () => {
    const client = recordingClient({
      tables: { member_profiles: { data: PROFILE, error: null } },
      rpcs: MEMBER_RPCS,
    });
    await loadMemberApp(client, { id: "user-1", email: "d@example.org" });

    const taskCalls = client.calls.filter(([table]) => table === "chapter_tasks");
    const selectCall = taskCalls.find(([, method]) => method === "select");
    expect(selectCall[2][0]).toBe(CHAPTER_TASK_COLUMNS);
    const orCall = taskCalls.find(([, method]) => method === "or");
    expect(orCall, "chapter_tasks read lost its window").toBeDefined();
    // Open work always loads; done work only inside the 60-day window.
    expect(orCall[2][0]).toMatch(/^status\.neq\.done,done_at\.gte\.\d{4}-\d{2}-\d{2}T/);
    const floor = new Date(orCall[2][0].split("done_at.gte.")[1]);
    const ageDays = (Date.now() - floor.getTime()) / 86400000;
    // Computed per load — a module-scope constant would drift stale in a
    // long-lived tab. 60 days, give or take the test's own runtime.
    expect(ageDays).toBeGreaterThan(59.9);
    expect(ageDays).toBeLessThan(60.1);
    expect(taskCalls.some(([, method, args]) => method === "limit" && args[0] === 500)).toBe(true);
  });

  it("windows chapter_task_messages the same way, capped at 1000 rows", async () => {
    const client = recordingClient({
      tables: { member_profiles: { data: PROFILE, error: null } },
      rpcs: MEMBER_RPCS,
    });
    await loadMemberApp(client, { id: "user-1", email: "d@example.org" });

    const messageCalls = client.calls.filter(([table]) => table === "chapter_task_messages");
    const gte = messageCalls.find(([, method]) => method === "gte");
    expect(gte[2][0]).toBe("created_at");
    expect(gte[2][1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(messageCalls.some(([, method, args]) => method === "limit" && args[0] === 1000)).toBe(true);
  });

  it("exposes the chapter workstream vocabulary, degrading to [] pre-migration", async () => {
    const withRows = recordingClient({
      tables: {
        member_profiles: { data: PROFILE, error: null },
        chapter_workstreams: { data: [{ id: "w1", name: "Chapter" }], error: null },
      },
      rpcs: MEMBER_RPCS,
    });
    const out = await loadMemberApp(withRows, { id: "user-1", email: "d@example.org" });
    expect(out.workstreams).toEqual([{ id: "w1", name: "Chapter" }]);

    const degraded = recordingClient({
      tables: {
        member_profiles: { data: PROFILE, error: null },
        chapter_workstreams: { data: null, error: { message: "relation does not exist" } },
      },
      rpcs: MEMBER_RPCS,
    });
    const fallbackOut = await loadMemberApp(degraded, { id: "user-1", email: "d@example.org" });
    expect(fallbackOut.workstreams).toEqual([]);
  });
});

describe("the realtime refetch (loadChapterTaskBoard)", () => {
  it("re-runs EXACTLY the boot-path board reads: window, orders, cap, vocabulary", async () => {
    // Called when the channel reaches SUBSCRIBED to close the query-to-
    // subscription gap. It must see exactly the window the boot load saw — a
    // board that gained rows on reconnect that a refresh then dropped is worse
    // than no refetch at all — so every clause is pinned to the same shape.
    const client = recordingClient({ rpcs: { list_chapter_task_dependencies: { data: [], error: null } } });
    await loadChapterTaskBoard(client);

    const taskCalls = client.calls.filter(([table]) => table === "chapter_tasks");
    expect(taskCalls.find(([, method]) => method === "select")[2][0]).toBe(`${CHAPTER_TASK_COLUMNS},settings_scope`);
    const orCall = taskCalls.find(([, method]) => method === "or");
    expect(orCall[2][0]).toMatch(/^status\.neq\.done,done_at\.gte\.\d{4}-\d{2}-\d{2}T/);
    const floor = new Date(orCall[2][0].split("done_at.gte.")[1]);
    const ageDays = (Date.now() - floor.getTime()) / 86400000;
    expect(ageDays).toBeGreaterThan(59.9);
    expect(ageDays).toBeLessThan(60.1);
    // status DESCENDING first so cap truncation eats backlog before active
    // columns, then board order, then creation order — same as boot.
    expect(taskCalls.filter(([, method]) => method === "order").map(([, , args]) => args)).toEqual([
      ["status", { ascending: false }],
      ["order_index"],
      ["created_at"],
    ]);
    expect(taskCalls.some(([, method, args]) => method === "limit" && args[0] === 500)).toBe(true);

    const workstreamCalls = client.calls.filter(([table]) => table === "chapter_workstreams");
    expect(workstreamCalls.find(([, method]) => method === "select")[2][0]).toBe("id,name");
    expect(workstreamCalls.some(([, method, args]) => method === "order" && args[0] === "name")).toBe(true);

    const assignmentCalls = client.calls.filter(([table]) => table === "chapter_task_assignments");
    expect(assignmentCalls.find(([, method]) => method === "select")[2][0])
      .toBe("id,task_id,chapter_id,assignee_id,position,assigned_at");
    expect(assignmentCalls.some(([, method, args]) => method === "order" && args[0] === "position")).toBe(true);
    expect(assignmentCalls.some(([, method, args]) => method === "limit" && args[0] === 6000)).toBe(true);

    // Phase 2: the RPC spends the cap only on renderable endpoints and owns
    // newest-first ordering. The client pins the public ceiling explicitly.
    const depCalls = client.calls.filter(([kind, name]) => kind === "rpc" && name === "list_chapter_task_dependencies");
    expect(depCalls).toEqual([["rpc", "list_chapter_task_dependencies", [{ p_limit: CHAPTER_TASK_DEPENDENCY_LIMIT }]]]);
    expect(CHAPTER_TASK_DEPENDENCY_LIMIT).toBe(4000);
  });

  it("degrades per PART to null (keep what you have), never to []", async () => {
    // [] here reads as "this chapter has no tasks" and would blank a board
    // that is merely offline for one request.
    const client = recordingClient({
      tables: {
        chapter_tasks: { data: null, error: { message: "offline" } },
        chapter_workstreams: { data: [{ id: "w1", name: "Chapter" }], error: null },
      },
    });
    const out = await loadChapterTaskBoard(client);
    expect(out.tasks).toBeNull();
    expect(out.workstreams).toEqual([{ id: "w1", name: "Chapter" }]);
  });

  it("degrades the dependency read to null too, never blanking loaded edges", async () => {
    const client = recordingClient({
      rpcs: { list_chapter_task_dependencies: { data: null, error: { message: "offline" } } },
    });
    const out = await loadChapterTaskBoard(client);
    expect(out.taskDependencies).toBeNull();
  });
});

describe("the live board subscription (subscribeToChapterTaskBoard)", () => {
  it("opens the PRIVATE per-chapter broadcast topic with all three operation bindings", () => {
    // NOT postgres_changes: the supabase_realtime publication is INSERT-only
    // by contract (20260728221416), so remote moves — UPDATEs — ride the
    // private broadcast topic the 20260801170000 triggers feed. The private
    // flag is load-bearing: without it the realtime.messages policy never
    // gates delivery and the subscribe is refused.
    const client = recordingClient();
    const onEvent = vi.fn();
    const onSubscribed = vi.fn();
    const unsubscribe = subscribeToChapterTaskBoard(client, "wor", onEvent, onSubscribed);

    expect(client.channels).toHaveLength(1);
    const channel = client.channels[0];
    expect(channel.topic).toBe("chapter-tasks:wor");
    expect(channel.opts).toEqual({ config: { private: true } });
    expect(channel.bindings.map(([type, filter]) => [type, filter])).toEqual([
      ["broadcast", { event: "INSERT" }],
      ["broadcast", { event: "UPDATE" }],
      ["broadcast", { event: "DELETE" }],
    ]);

    // onSubscribed fires on SUBSCRIBED only — it is the caller's cue to close
    // the query-to-subscription gap with loadChapterTaskBoard.
    expect(typeof channel.statusCallback).toBe("function");
    channel.statusCallback("CHANNEL_ERROR");
    expect(onSubscribed).not.toHaveBeenCalled();
    channel.statusCallback("SUBSCRIBED");
    expect(onSubscribed).toHaveBeenCalledTimes(1);

    // The returned unsubscribe tears down through removeChannel — effect
    // cleanup that merely drops the reference would leak the socket binding.
    expect(client.calls.some(([kind]) => kind === "removeChannel")).toBe(false);
    unsubscribe();
    expect(client.calls.filter(([kind]) => kind === "removeChannel")).toEqual([["removeChannel", "chapter-tasks:wor", []]]);
  });

  it("normalises the broadcast payload to one camelCase spelling", () => {
    // realtime.broadcast_changes sends {operation, table, record, old_record};
    // the App reducer must never read two spellings of one field.
    const client = recordingClient();
    const onEvent = vi.fn();
    subscribeToChapterTaskBoard(client, "wor", onEvent);
    const updateHandler = client.channels[0].bindings.find(([, filter]) => filter.event === "UPDATE")[2];
    updateHandler({ payload: { operation: "update", table: "chapter_tasks", record: { id: "t1" }, old_record: { id: "t1", status: "backlog" } } });
    expect(onEvent).toHaveBeenCalledWith({
      operation: "UPDATE",
      table: "chapter_tasks",
      record: { id: "t1" },
      oldRecord: { id: "t1", status: "backlog" },
    });
    // A malformed frame degrades to an inert event, not a throw in the socket
    // callback.
    updateHandler({});
    expect(onEvent).toHaveBeenLastCalledWith({ operation: "", table: "", record: null, oldRecord: null });
  });
});

describe("the RPC wrappers", () => {
  it("calls each server function by name with its p_ arguments", async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const client = { rpc };
    await softDeleteChapterTask(client, "t1");
    await restoreChapterTask(client, "t1");
    await loadChapterTaskReport(client, "2026-01-01", "2026-06-30");
    await loadChapterTaskReport(client);
    await renameChapterWorkstream(client, "w1", "  Events  ");
    await previewChapterWorkstreamMerge(client, "w1", "w2");
    await mergeChapterWorkstreams(client, "w1", "w2", 14);
    await mergeChapterWorkstreams(client, "w1", "w2");
    expect(rpc.mock.calls).toEqual([
      ["soft_delete_chapter_task", { p_task_id: "t1" }],
      ["restore_chapter_task", { p_task_id: "t1" }],
      ["chapter_task_report", { p_from: "2026-01-01", p_to: "2026-06-30" }],
      // A null bound means unbounded on that side; the server names the window.
      ["chapter_task_report", { p_from: null, p_to: null }],
      ["rename_chapter_workstream", { p_workstream_id: "w1", p_name: "Events" }],
      ["preview_chapter_workstream_merge", { p_source_id: "w1", p_target_id: "w2" }],
      ["merge_chapter_workstreams", { p_source_id: "w1", p_target_id: "w2", p_expected_moving: 14 }],
      ["merge_chapter_workstreams", { p_source_id: "w1", p_target_id: "w2", p_expected_moving: null }],
    ]);
  });

  it("sends the caller's own chapter for a new workstream — the one grantable scope column", async () => {
    let inserted;
    const builder = {
      insert(row) { inserted = row; return this; },
      select() { return this; },
      single() { return Promise.resolve({ data: { id: "w9", name: "Outreach" }, error: null }); },
    };
    await insertChapterWorkstream({ from: () => builder }, "wor", "  Outreach  ");
    expect(inserted).toEqual({ chapter_id: "wor", name: "Outreach" });
  });

  it("carries the SQLSTATE through so named error copy can read it", async () => {
    // The designed copy branches on codes (23505 collision -> merge offer,
    // 40001 stale preview -> re-read, 22023 -> named editor errors). Matching
    // English message text instead would break on the first reword.
    const client = { rpc: async () => ({ data: null, error: { message: "that name is already in use in this chapter", code: "23505" } }) };
    const failure = await renameChapterWorkstream(client, "w1", "Events").catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe("23505");
    expect(failure.message).toBe("Rename workstream: that name is already in use in this chapter");
  });
});
