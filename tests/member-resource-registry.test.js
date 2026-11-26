import { afterEach, expect, it, vi } from "vitest";
import { createMemberSessionLoader, memberResourcesForRoute } from "../src/lib/memberSessionLoader.js";
import { captureSanitizedDiagnostic } from "../src/lib/observability.js";

vi.mock("../src/lib/observability.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    captureSanitizedDiagnostic: vi.fn(() => true),
  };
});

// Three tests below install fake timers. Restoring them as a trailing statement
// leaks the fake clock into the rest of the worker whenever an assertion throws
// first, which turns one failure into a cascade of unrelated timeouts; the
// global afterEach in tests/setup.js only cleans up the DOM.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness() {
  let hold = false;
  let failedResource = null;
  const operations = [];
  const pending = [];
  const queries = {};
  const rows = {
    "member_profiles": { id: "member", first_name: "Registry", full_name: "Registry Member" },
    "member_notifications": [{ id: "old", title: "Old", read_at: null }],
  };
  const rpcData = {};
  const execute = resource => {
    operations.push(resource);
    if (resource === failedResource) return Promise.resolve({ data: null, error: { message: "offline" } });
    const data = structuredClone(rows[resource] ?? []);
    if (!hold || !["member_notifications", "chapter_task_messages"].includes(resource)) return Promise.resolve({ data, error: null });
    return new Promise(resolve => pending.push({ resource, resolve }));
  };
  const client = {
    from(resource) {
      // Record the chained builder calls, not just the table: the self-scoping
      // .eq("user_id", ...) on the member reads is a privacy boundary, and a
      // harness that swallows every argument cannot notice it disappearing.
      const calls = [];
      (queries[resource] ??= []).push(calls);
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => execute(resource).then(resolve, reject);
        return (...args) => { if (typeof key === "string") calls.push([key, args]); return query; };
      } });
      return query;
    },
    rpc: async name => { operations.push(name); return { data: rpcData[name] ?? null, error: null }; },
  };
  const loader = createMemberSessionLoader(client, { id: "member" });
  return { loader, pending, rows, rpcData, operations, queries, fail(resource) { failedResource = resource; }, hold() { hold = true; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function hangingClient({ hangTable, hangRpc } = {}) {
  return {
    from(resource) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => {
          if (resource === hangTable) return new Promise(() => {});
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        };
        return () => query;
      } });
      return query;
    },
    rpc: async (name) => {
      if (name === hangRpc) return new Promise(() => {});
      return { data: null, error: null };
    },
  };
}

it("a hung required resource makes stateForRoute error after the overall deadline", async () => {
  vi.useFakeTimers();
  const loader = createMemberSessionLoader(hangingClient({ hangTable: "member_conversations" }), { id: "member" }, { loadDeadlineMs: 40 });
  const pending = loader.loadRoute("messages");
  const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(40);
  await rejection;
  expect(loader.stateForRoute("messages").status).toBe("error");
  loader.dispose();
});

it("a hung additive route resource makes stateForRoute error after the overall deadline", async () => {
  vi.useFakeTimers();
  const loader = createMemberSessionLoader(hangingClient({ hangRpc: "get_my_appointments" }), { id: "member" }, { loadDeadlineMs: 40 });
  const pending = loader.loadRoute("appointments");
  const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(40);
  await rejection;
  expect(loader.inspect().get("rpc:get_my_appointments")?.status).toBe("loading");
  expect(loader.stateForRoute("appointments")).toEqual({
    status: "error",
    error: "Request timed out",
    refreshError: "",
  });
  loader.dispose();
});

it("clears the projection watch when a required route load rejects before the deadline", async () => {
  vi.useFakeTimers();
  const client = {
    from(resource) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => {
          if (resource === "member_conversations") {
            return Promise.resolve({ data: null, error: { message: "offline" } }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        };
        return () => query;
      } });
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const loader = createMemberSessionLoader(client, { id: "member" }, { loadDeadlineMs: 40 });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(loader.loadRoute("messages")).rejects.toThrow();
  const afterReject = loader.revision;
  await vi.advanceTimersByTimeAsync(40);
  expect(loader.revision).toBe(afterReject);
  expect(loader.stateForRoute("messages").status).toBe("error");
  logged.mockRestore();
  loader.dispose();
});

it("records a sanitized diagnostic instead of the driver message", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  captureSanitizedDiagnostic.mockClear();
  const client = {
    from(resource) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => {
          if (resource === "member_conversations") {
            return Promise.resolve({ data: null, error: { message: "offline", code: "57014", name: "Error" } }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        };
        return () => query;
      } });
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const loader = createMemberSessionLoader(client, { id: "member" }, { loadDeadlineMs: 40 });
  await expect(loader.loadRoute("messages")).rejects.toThrow();
  expect(logged.mock.calls.flat().map(String).join(" ")).not.toContain("offline");
  expect(captureSanitizedDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
    kind: "member_session_resource_failure",
    resource: "table:member_conversations",
    code: "57014",
    name: "Error",
  }));
  expect(JSON.stringify(captureSanitizedDiagnostic.mock.calls)).not.toContain("offline");
  logged.mockRestore();
  loader.dispose();
});

it("issues the shell notification and conversation reads scoped to the signed-in member", async () => {
  const h = harness();
  h.rows.member_conversations = [{ id: "conv", title: "Steward" }];
  await h.loader.loadRoute("messages");
  // Pin the whole chain, not just the table name: RLS also scopes these reads,
  // but steward and coordinator accounts hold permissive cross-member policies
  // on both tables, so the member surface must keep filtering by itself.
  // Union Ground also bounds both newest-first reads explicitly, so a
  // PostgREST max-rows cap can never silently decide which rows arrive.
  expect(h.queries.member_notifications).toEqual([[
    ["select", ["*"]],
    ["eq", ["user_id", "member"]],
    ["order", ["created_at", { ascending: false }]],
    ["limit", [200]],
  ]]);
  expect(h.queries.member_conversations).toEqual([[
    ["select", ["*"]],
    ["eq", ["user_id", "member"]],
    ["order", ["updated_at", { ascending: false }]],
    ["limit", [100]],
  ]]);
});

it("keeps the plain-member Messages loading gate independent of task-board resources", async () => {
  const declared = memberResourcesForRoute("messages");
  expect(declared).toContain("table:member_conversations");
  expect(declared).toContain("rpc:list_member_message_activity");
  expect(declared).not.toContain("table:chapter_tasks");
  expect(declared).not.toContain("rpc:list_chapter_task_dependencies");

  const h = harness();
  await h.loader.loadShell();
  h.operations.length = 0;
  await h.loader.loadRoute("messages");
  expect(h.operations).toContain("member_conversations");
  expect(h.operations).not.toContain("chapter_tasks");
  expect(h.operations).not.toContain("list_chapter_task_dependencies");
});

it("retains task conversations on Messages for an authorized staff identity", async () => {
  const h = harness();
  h.rows.member_roles = [{ role: "steward" }];
  await h.loader.loadShell();
  h.operations.length = 0;
  await h.loader.loadRoute("messages");
  expect(h.operations).toContain("chapter_tasks");
  expect(h.operations).toContain("list_chapter_task_dependencies");
});

it.each(["messages", "search", "hub", "tasks", "steward", "coordinator"])("%s loads and refreshes the shared server unread sources", async route => {
  const h = harness();
  h.rows.member_conversations = [{ id: "conv", title: "Steward" }];
  h.rows.member_conversation_summaries = [{ conversation_id: "conv", unread_count: 7 }];
  h.rows.chapter_spaces = [{ id: "space", name: "General" }];
  h.rows.chapter_threads = [{ id: "thread", space_id: "space", title: "Discussion" }];
  h.rows.chapter_thread_posts = [{ id: "post", thread_id: "thread", body: "New post", author_id: "peer", created_at: "2026-09-07T12:00:00Z" }];
  h.rows.chapter_space_reads = [{ space_id: "space", last_read_at: "2026-09-07T11:00:00Z" }];
  const first = await h.loader.loadRoute(route);
  expect(h.operations).toContain("member_conversation_summaries");
  expect(h.operations).toContain("chapter_space_reads");
  expect(first.conversations[0].unread).toBe(7);
  expect(first.product.spaces[0].threads[0].unreadCount).toBe(1);
  h.rows.member_conversation_summaries[0].unread_count = 0;
  h.rows.chapter_space_reads[0].last_read_at = "2026-09-07T12:00:00Z";
  const fresh = await h.loader.loadRoute(route, { force: true });
  expect(fresh.conversations[0].unread).toBe(0);
  expect(fresh.product.spaces[0].threads[0].unreadCount).toBe(0);
});

it("newer reconciliation epoch wins over an older completion and failure", async () => {
  const h = harness();
  await h.loader.loadShell(); h.hold();
  const older = h.loader.reconcileRealtime(); await tick();
  const newer = h.loader.reconcileRealtime(); await tick();
  const oldRequests = h.pending.splice(0, 2);
  const fresh = [{ id: "old", title: "Fresh", read_at: "2026-09-06T12:00:00Z" }];
  for (const request of h.pending.splice(0)) request.resolve({ data: request.resource === "member_notifications" ? fresh : [], error: null });
  expect((await newer).notifications).toEqual(fresh);
  for (const request of oldRequests) request.resolve({ data: [{ id: "old", title: "Stale" }], error: { message: "old failure" } });
  expect((await older).notifications).toEqual(fresh);
  expect((await h.loader.loadShell()).notifications).toEqual(fresh);
  expect(h.loader.inspect().get("table:member_notifications").status).toBe("loaded");
});

it("authoritative deletion removes pre-request live rows but retains concurrent inserts and updates", async () => {
  const h = harness();
  await h.loader.loadShell();
  h.loader.noteLive("table:member_notifications", { id: "deleted", title: "Deleted before reconnect" });
  h.hold();
  const gap = h.loader.reconcileRealtime(); await tick();
  const concurrent = { id: "concurrent", title: "Live insert" };
  h.loader.noteLive("table:member_notifications", concurrent);
  h.loader.noteLive("table:member_notifications", { id: "old", title: "Latest", read_at: "2026-09-06T13:00:00Z", updated_at: "2026-09-06T13:00:00Z" });
  // Reject an out-of-order live update as well as old request epochs.
  expect(h.loader.noteLive("table:member_notifications", { id: "old", title: "Older", updated_at: "2026-09-06T12:00:00Z" })).toBe(false);
  const notification = h.pending.find(request => request.resource === "member_notifications");
  notification.resolve({ data: [{ id: "old", title: "Read snapshot", read_at: null }], error: null });
  await tick();
  const afterNotification = { id: "later", title: "Arrived while task read pending" };
  h.loader.noteLive("table:member_notifications", afterNotification);
  h.pending.find(request => request.resource === "chapter_task_messages").resolve({ data: [], error: null });
  const result = await gap;
  expect(result.notifications.map(row => row.id)).toEqual(["old", "concurrent", "later"]);
  expect(result.notifications[0].title).toBe("Latest");
});

it("a failed reconciliation retains the previous snapshot and never retries without invalidation", async () => {
  const h = harness();
  const original = await h.loader.loadShell(); h.hold();
  const gap = h.loader.reconcileRealtime(); await tick();
  for (const request of h.pending.splice(0)) request.resolve({ data: null, error: { message: "offline" } });
  expect((await gap).notifications).toEqual(original.notifications);
  expect((await h.loader.loadShell()).notifications).toEqual(original.notifications);
  expect((await h.loader.loadShell()).notifications).toEqual(original.notifications);
  expect(h.pending).toHaveLength(0);
  expect(h.loader.inspect().get("table:member_notifications").status).toBe("error");
  expect(h.loader.failuresForResources(["table:member_notifications"])).toEqual([
    { resource: "table:member_notifications", failure: { message: "offline" } },
  ]);
  h.loader.retryFailedResources(["table:member_notifications"]);
  expect(h.loader.failuresForResources(["table:member_notifications"])).toEqual([]);
  expect(h.loader.inspect().get("table:member_notifications").snapshot.size).toBe(1);
});

it("live normalized task messages survive subsequent route projection without losing identifiers", async () => {
  const h = harness();
  await h.loader.reconcileRealtime();
  const message = { id: "task-message", taskId: "task", chapterId: "chapter", senderId: "sender", recipientId: "member", body: "Live message", createdAt: "2026-09-06T12:00:00Z" };
  h.loader.noteLive("table:chapter_task_messages", message);
  expect((await h.loader.loadShell()).taskMessages).toEqual([expect.objectContaining(message)]);
});

it("does not let a delayed duplicate INSERT revert an authoritative notification read timestamp", async () => {
  const h = harness();
  await h.loader.loadShell(); h.hold();
  const gap = h.loader.reconcileRealtime(); await tick();
  h.loader.noteLive("table:member_notifications", { id: "old", title: "Old", read_at: null, created_at: "2026-09-06T12:00:00Z" });
  const authoritative = { id: "old", title: "Old", read_at: "2026-09-06T13:00:00Z", created_at: "2026-09-06T12:00:00Z" };
  for (const request of h.pending.splice(0)) request.resolve({ data: request.resource === "member_notifications" ? [authoritative] : [], error: null });
  expect((await gap).notifications).toEqual([authoritative]);
  expect(h.loader.noteLive("table:member_notifications", { ...authoritative, read_at: null })).toBe(false);
  expect((await h.loader.loadShell()).notifications).toEqual([authoritative]);
});

it("board live updates and deletes survive subsequent projections through the registry", async () => {
  const h = harness();
  await h.loader.loadRoute("tasks");
  const row = { id: "task", title: "Broadcast task", status: "in_progress", updated_at: "2026-09-06T13:00:00Z" };
  h.loader.noteLive("table:chapter_tasks", row, { authoritative: true });
  expect((await h.loader.loadRoute("tasks")).tasks).toEqual([expect.objectContaining({ id: row.id, title: row.title })]);
  h.loader.noteLive("table:chapter_tasks", row, { deleted: true, authoritative: true });
  expect((await h.loader.loadRoute("tasks")).tasks).toEqual([]);
});


it("confirmed rows supersede an in-flight pre-write response and expose retained refresh failure", async () => {
  const h = harness();
  await h.loader.loadShell(); h.hold();
  const old = h.loader.loadRoute("today", { force: true }); await tick();
  const oldRequests = h.pending.splice(0);
  h.loader.confirmRows("table:member_notifications", rows => [...rows, { id: "confirmed", title: "Confirmed write" }]);
  const refresh = h.loader.loadShell(); await tick();
  for (const request of h.pending.splice(0)) request.resolve({ data: null, error: { message: "post-write failure" } });
  expect((await refresh).notifications.some(row => row.id === "confirmed")).toBe(true);
  for (const request of oldRequests) request.resolve({ data: [], error: null });
  const result = await old;
  expect(result.notifications.some(row => row.id === "confirmed")).toBe(true);
  expect(result.resourceRefreshFailures).toContainEqual({ resource: "table:member_notifications", retained: true, message: "post-write failure" });
  const fresh = h.loader.loadRoute("today", { force: true }); await tick();
  for (const request of h.pending.splice(0)) request.resolve({ data: [], error: null });
  expect((await fresh).notifications).toEqual([]);
});

it("session confirmations survive failed authoritative reads and are cleared on successful reads and disposal", async () => {
  const h = harness();
  await h.loader.loadShell(); h.hold();
  const apply = data => ({ ...data, notifications: [{ id: "confirmed", title: "Confirmed projection" }] });
  h.loader.confirmProjection("write", ["table:member_notifications"], apply);
  const failed = h.loader.loadShell(); await tick();
  for (const request of h.pending.splice(0)) request.resolve({ data: null, error: { message: "offline" } });
  expect((await failed).notifications[0].title).toBe("Confirmed projection");
  expect((await h.loader.loadRoute("rights")).notifications[0].title).toBe("Confirmed projection");
  const fresh = h.loader.loadRoute("rights", { force: true }); await tick();
  for (const request of h.pending.splice(0)) request.resolve({ data: [], error: null });
  expect((await fresh).notifications).toEqual([]);
  h.loader.confirmProjection("retired", ["table:member_notifications"], apply);
  h.loader.dispose();
  h.loader.confirmRows("table:member_notifications", () => [{ id: "late" }]);
  h.loader.confirmProjection("late", ["table:member_notifications"], apply);
  expect(await h.loader.loadShell()).toBeNull();
  expect(h.loader.inspect().size).toBe(0);
});


it.each([false, true])("retains confirmed rows without a prior snapshot (initial failure: %s) until authoritative deletion", async initialFailure => {
  const h = harness();
  h.fail("member_notifications");
  if (initialFailure) await expect(h.loader.loadShell()).rejects.toThrow();
  h.loader.confirmRows("table:member_notifications", () => [{ id: "first-write", title: "First confirmation" }]);
  expect((await h.loader.loadShell()).notifications).toEqual([expect.objectContaining({ id: "first-write" })]);
  expect(h.loader.inspect().get("table:member_notifications").snapshot.size).toBe(0);
  expect((await h.loader.loadRoute("rights")).notifications[0].title).toBe("First confirmation");
  expect(h.loader.stateForRoute("rights").refreshError).toBe("offline");
  h.fail(null); h.rows.member_notifications = [{ id: "first-write", title: "Authority" }];
  expect((await h.loader.loadRoute("rights", { force: true })).notifications[0].title).toBe("Authority");
  h.rows.member_notifications = [];
  expect((await h.loader.loadRoute("rights", { force: true })).notifications).toEqual([]);
});

it("preserves skipped readiness on invalidation and still reads after role authority changes", async () => {
  const h = harness();
  await h.loader.loadRoute("messages");
  expect(h.operations).not.toContain("get_steward_badge_counts");
  h.hold();
  h.rows.member_roles = [{ role: "steward" }];
  h.loader.invalidateAll();
  expect(h.loader.stateForRoute("messages").status).toBe("loaded");
  const refresh = h.loader.loadRoute("messages"); await tick();
  expect(h.loader.stateForRoute("messages").status).toBe("loaded");
  for (const request of h.pending.splice(0)) request.resolve({ data: [], error: null });
  await refresh;
  expect(h.operations).toContain("get_steward_badge_counts");
  expect(h.loader.stateForRoute("messages").status).toBe("loaded");
});

it("successive row confirmations retain latest rows and removals before the first successful read", async () => {
  const h = harness();
  h.fail("member_notifications");
  for (const title of ["First saved row", "Latest saved row"]) {
    h.loader.confirmRows("table:member_notifications", rows => [...rows.filter(row => row.id !== "saved"), { id: "saved", title }]);
    expect((await h.loader.loadShell()).notifications).toEqual([{ id: "saved", title }]);
  }
  h.loader.confirmRows("table:member_notifications", rows => rows.filter(row => row.id !== "saved"));
  expect((await h.loader.loadShell()).notifications).toEqual([]);
});

it("a successful reconciliation retires an insertion before another write on its key", async () => {
  const h = harness();
  await h.loader.loadShell();
  h.loader.confirmProjection("saved", ["table:member_notifications"], data => ({ ...data, notifications: [...data.notifications, { id: "saved", title: "Inserted" }] }));
  h.rows.member_notifications = [];
  await h.loader.reconcileRealtime();
  h.loader.confirmProjection("saved", ["table:member_notifications"], data => ({ ...data, notifications: data.notifications.map(row => row.id === "saved" ? { ...row, title: "Updated" } : row) }));
  h.fail("member_notifications");
  expect((await h.loader.loadShell()).notifications).toEqual([]);
});

it("invalidates ballot tallies when an open ballot's closing time elapses", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
  const h = harness();
  h.rows.member_ballots = [{
    id: "ballot-open",
    title: "Open ballot",
    closes_at: "2026-09-21T12:00:05.000Z",
    active: true,
    campaign_state: "open",
    order_index: 1,
    quorum_target: 2,
    member_ballot_options: [
      { id: "opt-a", ballot_id: "ballot-open", label: "Yes", label_es: "Sí", order_index: 0 },
      { id: "opt-b", ballot_id: "ballot-open", label: "No", label_es: "No", order_index: 1 },
    ],
  }];
  try {
    const projection = await h.loader.loadRoute("voting");
    expect(projection.planItems.some((item) => item.id === "ballot-open" && item.closed === false)).toBe(true);
    expect(h.operations).toContain("get_ballot_tally");
    const tallyEpoch = h.loader.inspect().get("rpc:get_ballot_tally")?.epoch ?? 0;
    await vi.advanceTimersByTimeAsync(5100);
    expect(h.loader.inspect().get("rpc:get_ballot_tally")?.epoch).toBeGreaterThan(tallyEpoch);
  } finally {
    h.loader.dispose();
    vi.useRealTimers();
  }
});

it("keeps retrying a locally closed ballot until the server publishes its tally", async () => {
  vi.useFakeTimers();
  // The device clock runs a minute ahead of the database: the item reads closed
  // while get_ballot_tally still withholds its options.
  vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
  const h = harness();
  const options = [
    { id: "opt-a", ballot_id: "ballot-elapsed", label: "Yes", label_es: "Sí", order_index: 0 },
    { id: "opt-b", ballot_id: "ballot-elapsed", label: "No", label_es: "No", order_index: 1 },
  ];
  h.rows.member_ballots = [{
    id: "ballot-elapsed",
    title: "Elapsed ballot",
    closes_at: "2026-09-21T11:59:00.000Z",
    active: true,
    campaign_state: "open",
    order_index: 1,
    quorum_target: 2,
    member_ballot_options: options,
  }];
  try {
    const withheld = await h.loader.loadRoute("voting");
    const item = withheld.planItems.find((entry) => entry.id === "ballot-elapsed");
    expect(item.closed).toBe(true);
    expect(item.results).toBeNull();
    const withheldEpoch = h.loader.inspect().get("rpc:get_ballot_tally")?.epoch ?? 0;
    await vi.advanceTimersByTimeAsync(30_100);
    expect(h.loader.inspect().get("rpc:get_ballot_tally")?.epoch).toBeGreaterThan(withheldEpoch);

    h.rpcData.get_ballot_tally = {
      ballotId: "ballot-elapsed",
      totalVotes: 2,
      quorumTarget: 2,
      options: options.map((option) => ({ id: option.id, label: option.label, labelEs: option.label_es, votes: 1 })),
    };
    const published = await h.loader.loadRoute("voting", { force: true });
    expect(published.planItems.find((entry) => entry.id === "ballot-elapsed").results).toHaveLength(2);
    const publishedEpoch = h.loader.inspect().get("rpc:get_ballot_tally")?.epoch ?? 0;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.loader.inspect().get("rpc:get_ballot_tally")?.epoch).toBe(publishedEpoch);
  } finally {
    h.loader.dispose();
    vi.useRealTimers();
  }
});

it("invalidates ballot tallies when a votes notification arrives live", async () => {
  const h = harness();
  await h.loader.loadRoute("voting");
  const before = h.loader.inspect().get("rpc:get_ballot_tally")?.epoch ?? 0;
  expect(h.loader.noteLive("table:member_notifications", {
    id: "vote-results",
    title: "Ballot results are in",
    kind: "votes",
  })).toBe(true);
  const afterVotes = h.loader.inspect().get("rpc:get_ballot_tally")?.epoch ?? 0;
  expect(afterVotes).toBeGreaterThan(before);
  h.loader.noteLive("table:member_notifications", {
    id: "case-note",
    title: "Case update",
    kind: "cases",
  });
  expect(h.loader.inspect().get("rpc:get_ballot_tally")?.epoch).toBe(afterVotes);
  h.loader.dispose();
});
