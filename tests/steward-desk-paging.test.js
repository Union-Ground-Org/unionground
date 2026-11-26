// @vitest-environment node
//
// UB-DESK-01 steward desk paging, client half: loadStewardDesk takes its four
// queue pages (and the KPI tiles) from the new steward RPCs, the standalone
// pagers forward filter/search/sort/cursor and mirror the SQL clamps so a
// full page can never masquerade as a short one, and the demo twins in
// stewardDeskPaging.js replay the same filter/search/sort/keyset semantics
// over in-memory rows. Same fake-client style as steward-caseload.test.js:
// a recording Proxy chain per table plus an rpc log.
import { describe, expect, it } from "vitest";
import {
  loadStewardDesk,
  loadStewardRequests,
  loadStewardThreadMessages,
} from "../src/lib/memberApi.js";
import {
  pageStewardBroadcasts,
  pageStewardRequests,
  pageStewardThreadMessages,
} from "../src/lib/stewardDeskPaging.js";

function recordingChain(result, log) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return (...args) => {
        log.push([prop, args]);
        return proxy;
      };
    },
  });
  return proxy;
}

function deskClient({ uid = "steward-1", tables = {}, rpcs = {}, logs = {}, rpcCalls = [] } = {}) {
  return {
    auth: { getSession: async () => ({ data: { session: uid ? { user: { id: uid } } : null } }) },
    from: (table) => {
      logs[table] = logs[table] || [];
      // A table value may be an array of per-call results consumed FIFO —
      // member_cases is queried twice (active window, resolved window).
      const canned = tables[table];
      const result = Array.isArray(canned) ? (canned.length > 1 ? canned.shift() : canned[0]) : canned;
      return recordingChain(result ?? { data: [], error: null }, logs[table]);
    },
    rpc: (name, args) => {
      rpcCalls.push([name, args]);
      return Promise.resolve(rpcs[name] ?? { data: [], error: null });
    },
  };
}

// Wire rows exactly as the RPCs return them: snake_case, profile name and the
// TRUE filtered total riding every row.
function requestRow(i, extra = {}) {
  return {
    id: `r${i}`,
    user_id: "member-1",
    lesson_id: "lesson-1",
    status: "requested",
    created_at: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
    member_name: "Ada Union",
    member_initials: "AU",
    total_count: 240,
    ...extra,
  };
}

const threadRows = [
  {
    id: "t1", user_id: "member-1", title: "Overtime question", updated_at: "2026-08-06T12:00:00Z",
    member_name: "Renata Cole", member_initials: "RC", last_body: "Can they force a double?",
    last_sender_kind: "member", last_created_at: "2026-08-06T12:00:00Z", message_count: 6, total_count: 2,
  },
  {
    id: "t2", user_id: "member-2", title: "Thanks", updated_at: "2026-08-05T09:00:00Z",
    member_name: "Devon Pratt", member_initials: "DP", last_body: "All set, thank you.",
    last_sender_kind: "steward", last_created_at: "2026-08-05T09:00:00Z", message_count: 2, total_count: 2,
  },
];

const broadcastRows = [
  { id: "b1", sender: "Chapter Stewards", title: "Meeting moved", body: "Now Thursday.", published_at: "2026-08-04T18:00:00Z", retracted_at: null, locale: "en", total_count: 2 },
  { id: "b2", sender: "Chapter Stewards", title: "Old notice", body: "Superseded.", published_at: "2026-07-20T18:00:00Z", retracted_at: "2026-07-22T10:00:00Z", locale: "en", total_count: 2 },
];

const formRows = [
  {
    id: "f1", user_id: "member-1", template_key: "grievance", template_version: 2, status: "submitted",
    answers: { summary: "Missed differential" }, step: 3, submitted_at: "2026-08-03T10:00:00Z",
    member_name: "Ada Union", member_initials: "AU", total_count: 1,
  },
];

const assignedCase = {
  id: "case-1", user_id: "member-1", reference: "GRV-1", title: "T", case_type: "Grievance",
  articles: "", step: "Step 1", status: "active", deadline: "2026-08-15",
  updated_at: "2026-08-05T12:00:00Z", assigned_at: "2026-08-01T09:00:00Z", coordinator_name: null,
};

function deskFixtures({ requests = [requestRow(1)], kpis = { open_requests: 42, awaiting_reply: 7, broadcasts_30d: 3 } } = {}) {
  return {
    tables: {
      member_rights_lessons: { data: [{ id: "lesson-1", label: "Know your Weingarten rights" }], error: null },
      member_profiles: { data: [{ id: "member-1", full_name: "Renata Cole", initials: "RC" }], error: null, count: 12 },
      member_cases: [{ data: [assignedCase], error: null }, { data: [], error: null }],
      member_form_cosigners: { data: [], error: null },
      form_templates: { data: [], error: null },
    },
    rpcs: {
      list_steward_requests: { data: requests, error: null },
      list_steward_conversations: { data: threadRows, error: null },
      list_steward_broadcasts: { data: broadcastRows, error: null },
      list_steward_forms: { data: formRows, error: null },
      get_steward_desk_kpis: { data: [kpis], error: null },
      get_steward_chapter_member_count: { data: 31, error: null },
      // sol F7: counts come page-scoped from get_broadcast_read_counts_for.
      get_broadcast_read_counts_for: { data: [{ broadcastId: "b1", readCount: 4 }], error: null },
      list_case_latest_updates: { data: [], error: null },
    },
  };
}

describe("loadStewardDesk paged queues", () => {
  it("lands the RPC pages in the desk with camelCase shaping", async () => {
    const desk = await loadStewardDesk(deskClient(deskFixtures()));
    // member_name → memberName, lesson id → label through the catalogue.
    expect(desk.queue[0].memberName).toBe("Ada Union");
    expect(desk.queue[0].memberInitials).toBe("AU");
    expect(desk.queue[0].lessonLabel).toBe("Know your Weingarten rights");
    // last_body → preview; awaitingReply is TRUE exactly when the latest
    // message is the member's.
    expect(desk.threads[0].preview).toBe("Can they force a double?");
    expect(desk.threads[0].awaitingReply).toBe(true);
    expect(desk.threads[1].awaitingReply).toBe(false);
    // retracted_at → boolean; read counts resolve per broadcast id.
    expect(desk.broadcasts[0].retracted).toBe(false);
    expect(desk.broadcasts[0].readCount).toBe(4);
    expect(desk.broadcasts[1].retracted).toBe(true);
    expect(desk.formsInbox[0].memberName).toBe("Ada Union");
    expect(desk.formsInbox[0].templateVersion).toBe(2);
  });

  it("takes the KPI tiles from get_steward_desk_kpis, never from the loaded slice counts", async () => {
    const desk = await loadStewardDesk(deskClient(deskFixtures()));
    // One request row on screen, 42 open in the chapter: the tile must say
    // 42 — counting the slice is the exact defect UB-DESK-01 names.
    expect(desk.queue).toHaveLength(1);
    expect(desk.kpis.openRequests).toBe(42);
    expect(desk.kpis.awaitingReply).toBe(7);
    expect(desk.kpis.broadcasts30d).toBe(3);
    // Members covered comes from the steward-gated exact count, not the
    // planner estimate.
    expect(desk.kpis.membersCovered).toBe(31);
  });

  it("reports totals from total_count and drops the cursor on a short first page", async () => {
    const desk = await loadStewardDesk(deskClient(deskFixtures()));
    expect(desk.queueTotal).toBe(240);
    expect(desk.threadsTotal).toBe(2);
    expect(desk.broadcastsTotal).toBe(2);
    expect(desk.formsTotal).toBe(1);
    // Every first page is short of its page size: the chapter is fully
    // loaded, no cursor.
    expect(desk.queueCursor).toBeNull();
    expect(desk.threadsCursor).toBeNull();
    expect(desk.broadcastsCursor).toBeNull();
    expect(desk.formsCursor).toBeNull();
  });

  it("hands back the last RAW row's keyset position when the first page is FULL", async () => {
    // Exactly 100 rows = the request page size: more may exist, so the
    // cursor is the (created_at, id) of the last wire row.
    const fullPage = Array.from({ length: 100 }, (_, i) => requestRow(i));
    const desk = await loadStewardDesk(deskClient(deskFixtures({ requests: fullPage })));
    expect(desk.queue).toHaveLength(100);
    expect(desk.queueCursor).toEqual({ createdAt: fullPage[99].created_at, id: "r99" });
    expect(desk.queueTotal).toBe(240);
  });

  it("still reads the two member_cases windows and the per-case timeline RPC", async () => {
    const logs = {};
    const rpcCalls = [];
    await loadStewardDesk(deskClient({ ...deskFixtures(), logs, rpcCalls }));
    // The caseload (UB-CASE-05) is untouched by the paging wave: both
    // assignee-scoped windows still run, and the timelines still come from
    // list_case_latest_updates.
    expect(logs.member_cases.filter((c) => c[0] === "eq" && c[1][0] === "steward_user_id")).toHaveLength(2);
    expect(rpcCalls).toContainEqual(["list_case_latest_updates", { p_case_ids: ["case-1"], p_per_case: 20 }]);
  });
});

// Standalone pager fakes: rpc log plus a benign builder for the lesson
// catalogue lookup that rides along with the request pager.
function pagerClient(results = {}) {
  const calls = [];
  const client = {
    from: () => recordingChain({ data: [], error: null }, []),
    rpc: async (name, args) => {
      calls.push([name, args]);
      return results[name] ?? { data: [], error: null };
    },
  };
  return { client, calls };
}

describe("loadStewardRequests", () => {
  it("forwards filter, trimmed search, sort, keyset cursor, and limit to the RPC", async () => {
    const { client, calls } = pagerClient();
    await loadStewardRequests(client, {
      status: "open",
      search: "  Jordan  ",
      sort: "oldest",
      cursor: { createdAt: "2026-08-01T00:00:00Z", id: "r9" },
      limit: 40,
    });
    expect(calls[0]).toEqual(["list_steward_requests", {
      p_status: "open",
      p_search: "Jordan",
      p_sort: "oldest",
      p_after_created: "2026-08-01T00:00:00Z",
      p_after_id: "r9",
      p_limit: 40,
    }]);
  });

  it("sends null search — not an empty string — when the box is blank", async () => {
    const { client, calls } = pagerClient();
    await loadStewardRequests(client, { search: "   " });
    expect(calls[0][1].p_search).toBeNull();
    expect(calls[0][1].p_after_created).toBeNull();
    expect(calls[0][1].p_after_id).toBeNull();
  });

  it("clamps a caller limit above the SQL cap so the cursor contract holds", async () => {
    // SQL clamps p_limit to 100; if the loader asked for more and compared
    // the returned length against the unclamped number, a full 100-row page
    // would look short, drop the cursor, and strand the rest of the chapter.
    const { client, calls } = pagerClient();
    await loadStewardRequests(client, { limit: 999 });
    expect(calls[0][1].p_limit).toBe(100);
  });

  it("returns shaped rows, the last row's cursor on a full page, and the true total", async () => {
    const rows = [requestRow(1), requestRow(2)];
    const { client } = pagerClient({ list_steward_requests: { data: rows, error: null } });
    const page = await loadStewardRequests(client, { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0].memberName).toBe("Ada Union");
    expect(page.nextCursor).toEqual({ createdAt: rows[1].created_at, id: "r2" });
    expect(page.total).toBe(240);
  });

  it("reports total 0 on an empty first page but null on an empty cursored page", async () => {
    const { client } = pagerClient();
    // No cursor: zero rows honestly means zero matches.
    const first = await loadStewardRequests(client, {});
    expect(first.total).toBe(0);
    expect(first.nextCursor).toBeNull();
    // Cursored: the previous page ended exactly on the boundary — the caller
    // already knows the total, so null means "keep yours".
    const later = await loadStewardRequests(client, { cursor: { createdAt: "2026-08-01T00:00:00Z", id: "r9" } });
    expect(later.total).toBeNull();
  });
});

describe("loadStewardThreadMessages", () => {
  // The RPC walks backward: newest first on the wire.
  const wire = [
    { id: "m3", sender_kind: "steward", sender_name: "Sam Ortiz", body: "third", created_at: "2026-08-06T12:00:00Z", total_count: 10 },
    { id: "m2", sender_kind: "member", sender_name: "Renata Cole", body: "second", created_at: "2026-08-06T11:00:00Z", total_count: 10 },
    { id: "m1", sender_kind: "member", sender_name: "Renata Cole", body: "first", created_at: "2026-08-06T10:00:00Z", total_count: 10 },
  ];

  it("reverses the newest-first wire order to chronological and cursors from the RAW last row", async () => {
    const { client, calls } = pagerClient({ list_steward_thread_messages: { data: wire, error: null } });
    const page = await loadStewardThreadMessages(client, "t1", { limit: 3 });
    expect(calls[0]).toEqual(["list_steward_thread_messages", {
      p_conversation_id: "t1",
      p_before_created: null,
      p_before_id: null,
      p_limit: 3,
    }]);
    // Chronological for the dialog, snake_case kept for the bubble renderer.
    expect(page.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(page.messages[0].sender_kind).toBe("member");
    // The earlier-cursor is the RAW last wire row — the OLDEST in the
    // window — so the next walk continues into history, not back over it.
    expect(page.earlierCursor).toEqual({ createdAt: "2026-08-06T10:00:00Z", id: "m1" });
    expect(page.total).toBe(10);
  });

  it("forwards the cursor as p_before_* and clamps the limit to the 200 SQL cap", async () => {
    const { client, calls } = pagerClient();
    const page = await loadStewardThreadMessages(client, "t1", {
      cursor: { createdAt: "2026-08-06T10:00:00Z", id: "m1" },
      limit: 999,
    });
    expect(calls[0][1].p_before_created).toBe("2026-08-06T10:00:00Z");
    expect(calls[0][1].p_before_id).toBe("m1");
    expect(calls[0][1].p_limit).toBe(200);
    // Empty cursored page: keep the caller's running total.
    expect(page.total).toBeNull();
    const first = await loadStewardThreadMessages(client, "t1");
    expect(first.total).toBe(0);
  });
});

describe("stewardDeskPaging demo twins", () => {
  const requestSeed = [
    { id: "q5", memberName: "Jordan Ellis", status: "requested", createdAt: "2026-08-05T10:00:00Z" },
    { id: "q4", memberName: "Ada Union", status: "acknowledged", createdAt: "2026-08-04T10:00:00Z" },
    { id: "q3", memberName: "Renata Cole", status: "requested", createdAt: "2026-08-03T10:00:00Z" },
    { id: "q2", memberName: "Devon Pratt", status: "closed", createdAt: "2026-08-02T10:00:00Z" },
    { id: "q1", memberName: "Priya Nair", status: "acknowledged", createdAt: "2026-08-01T10:00:00Z" },
    { id: "q0", memberName: "Sam Okafor", status: "requested", createdAt: "2026-07-31T10:00:00Z" },
  ];

  it("filters open to exclude exactly the closed rows", () => {
    const page = pageStewardRequests(requestSeed, { status: "open" });
    expect(page.rows.map((r) => r.id)).not.toContain("q2");
    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(5);
  });

  it("matches search as a case-insensitive substring of the member name", () => {
    const page = pageStewardRequests(requestSeed, { search: "jorDAN el" });
    expect(page.rows.map((r) => r.memberName)).toEqual(["Jordan Ellis"]);
    expect(page.total).toBe(1);
  });

  it("sorts oldest ascending", () => {
    const page = pageStewardRequests(requestSeed, { sort: "oldest" });
    expect(page.rows[0].id).toBe("q0");
    expect(page.rows[page.rows.length - 1].id).toBe("q5");
  });

  it("walks the whole filtered set through the cursor with no duplicates, even when the cursor row is deleted mid-walk", () => {
    // The cursor is a POSITION, not a row identity — deleting the row it
    // points at must not break or repeat the walk (the SQL row-comparison
    // property, mirrored).
    const rows = requestSeed.map((row) => ({ ...row }));
    const page1 = pageStewardRequests(rows, { status: "open", limit: 2 });
    expect(page1.rows.map((r) => r.id)).toEqual(["q5", "q4"]);
    expect(page1.nextCursor).toEqual({ createdAt: "2026-08-04T10:00:00Z", id: "q4" });
    expect(page1.total).toBe(5);
    // The cursor row vanishes between calls.
    const afterDelete = rows.filter((row) => row.id !== "q4");
    const page2 = pageStewardRequests(afterDelete, { status: "open", limit: 2, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.id)).toEqual(["q3", "q1"]);
    const page3 = pageStewardRequests(afterDelete, { status: "open", limit: 2, cursor: page2.nextCursor });
    expect(page3.rows.map((r) => r.id)).toEqual(["q0"]);
    expect(page3.nextCursor).toBeNull();
    const walked = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual(["q0", "q1", "q3", "q4", "q5"]);
  });

  it("reports the filtered total regardless of the cursor position", () => {
    const page1 = pageStewardRequests(requestSeed, { status: "open", limit: 2 });
    const page2 = pageStewardRequests(requestSeed, { status: "open", limit: 2, cursor: page1.nextCursor });
    // total answers "how many match", not "how many remain".
    expect(page2.total).toBe(5);
  });

  it("pageStewardBroadcasts filter retracted matches only retracted rows", () => {
    const rows = [
      { id: "b2", title: "Live", body: "x", retracted: false, publishedAt: "2026-08-04T10:00:00Z" },
      { id: "b1", title: "Pulled", body: "y", retracted: true, publishedAt: "2026-08-01T10:00:00Z" },
    ];
    const retracted = pageStewardBroadcasts(rows, { filter: "retracted" });
    expect(retracted.rows.map((r) => r.id)).toEqual(["b1"]);
    expect(retracted.total).toBe(1);
    const active = pageStewardBroadcasts(rows, { filter: "active" });
    expect(active.rows.map((r) => r.id)).toEqual(["b2"]);
  });

  it("pageStewardThreadMessages serves chronological windows and walks backward through earlierCursor", () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i + 1}`,
      body: `msg ${i + 1}`,
      created_at: new Date(Date.UTC(2026, 7, 1, i)).toISOString(),
    }));
    const page1 = pageStewardThreadMessages(messages, { limit: 2 });
    // Newest window, handed back chronological.
    expect(page1.messages.map((m) => m.id)).toEqual(["m4", "m5"]);
    expect(page1.earlierCursor).toEqual({ createdAt: messages[3].created_at, id: "m4" });
    expect(page1.total).toBe(5);
    const page2 = pageStewardThreadMessages(messages, { limit: 2, cursor: page1.earlierCursor });
    expect(page2.messages.map((m) => m.id)).toEqual(["m2", "m3"]);
    const page3 = pageStewardThreadMessages(messages, { limit: 2, cursor: page2.earlierCursor });
    expect(page3.messages.map((m) => m.id)).toEqual(["m1"]);
    // A short page ends the walk.
    expect(page3.earlierCursor).toBeNull();
  });
});
