import { describe, expect, it, vi } from "vitest";
import {
  applyTombstonesToLanded,
  isPermissionRefusal,
  isSourceGone,
  loadChannelThreadLanding,
  loadPrivateMessageLanding,
  loadTaskConversationLanding,
  mergeLandedMessage,
  mergeLandedRows,
} from "../src/features/connectedWorkflows/landing.js";

// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928. A link can name a private
// message the loaded list never carried. loadPrivateMessageLanding re-asks the
// connected-workflow context, then reads exactly that conversation and message
// under the caller's own row security, and hands back only what a view shows.

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STEWARD = "33333333-3333-4333-8333-333333333333";
const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV_OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOREIGN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SECRET = "PRIVATE grievance detail 509";

function rows() {
  return {
    member_conversations: [
      { id: CONV, user_id: ME, title: "Chapter steward", initials: "CS", steward_user_id: STEWARD, updated_at: "2026-07-12T11:00:00.000Z" },
      { id: CONV_OTHER, user_id: OTHER, title: "Chapter steward", initials: "CS", steward_user_id: STEWARD, updated_at: "2026-07-11T11:00:00.000Z" },
    ],
    member_messages: [
      { id: OLD, conversation_id: CONV, user_id: ME, sender_kind: "member", sender_name: "Member", body: SECRET, created_at: "2026-01-02T09:00:00.000Z", read_at: null, redacted_at: null },
      { id: NEW, conversation_id: CONV, user_id: ME, sender_kind: "steward", sender_name: "Sam Okafor", body: "Newest reply", created_at: "2026-07-12T11:00:00.000Z", read_at: null, redacted_at: null },
      { id: FOREIGN, conversation_id: CONV_OTHER, user_id: OTHER, sender_kind: "member", sender_name: "Other", body: "Not yours", created_at: "2026-07-11T09:00:00.000Z" },
    ],
    member_profiles: [{ id: ME, full_name: "Renata Cole", initials: "RC" }],
    member_message_reactions: [{ id: "r1", actor_id: STEWARD, source_kind: "private", private_message_id: OLD, reaction: "support", created_at: "2026-01-03T09:00:00.000Z" }],
  };
}

// A chainable stand-in that filters the arrays it is given, so a missing
// `.eq("user_id", …)` pin genuinely returns a row it should not.
function fakeClient({ data = rows(), context = { available: true, state: "available" }, contextError = null, fail = {} } = {}) {
  const log = { rpc: [], reads: [] };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.checks = []; this.sort = null; this.max = null; }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    // `.is(column, null)` keeps rows whose column is null; recorded as "is:<column>".
    is(column, value) { this.checks.push([`is:${column}`, (row) => (value === null ? row[column] == null : row[column] === value)]); return this; }
    // `.or("a.eq.X,b.eq.Y")` keeps rows matching any clause; recorded as "or".
    or(expression) {
      const clauses = String(expression).split(",").map((clause) => clause.split(".eq."));
      this.checks.push(["or", (row) => clauses.some(([column, value]) => row[column] === value)]);
      return this;
    }
    order(column, options) { this.sort = [column, options]; return this; }
    limit(count) { this.max = count; return this; }
    result() {
      log.reads.push({ table: this.table, filters: [...this.filters.map(([column]) => column), ...this.checks.map(([name]) => name)], max: this.max });
      if (fail[this.table]) return { data: null, error: fail[this.table] };
      let found = (data[this.table] || [])
        .filter((row) => this.filters.every(([column, value]) => row[column] === value))
        .filter((row) => this.checks.every(([, test]) => test(row)));
      if (this.sort) {
        const [column, options] = this.sort;
        found = [...found].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (options?.ascending === false ? -1 : 1));
      }
      if (this.max != null) found = found.slice(0, this.max);
      return { data: found, error: null };
    }
    maybeSingle() { const out = this.result(); return Promise.resolve(out.error ? out : { data: out.data[0] ?? null, error: null }); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
  }
  return {
    log,
    rpc: vi.fn(async (name, args) => {
      log.rpc.push([name, args]);
      return contextError ? { data: null, error: contextError } : { data: context, error: null };
    }),
    from: vi.fn((table) => new Query(table)),
  };
}

describe("a member landing on an older message", () => {
  it("re-asks the context first, then reads exactly that message and conversation under the member's own user id", async () => {
    const client = fakeClient();
    const landing = await loadPrivateMessageLanding(client, { messageId: OLD, conversationId: CONV }, { userId: ME });
    expect(client.log.rpc).toEqual([["get_connected_workflow_context", { p_kind: "private_message", p_id: OLD, p_chapter_id: null, p_organization_id: null }]]);
    const message = client.log.reads.find((read) => read.table === "member_messages");
    const conversation = client.log.reads.find((read) => read.table === "member_conversations");
    expect(message.filters).toEqual(["id", "conversation_id", "user_id"]);
    expect(conversation.filters).toEqual(["id", "user_id"]);
    expect(landing.thread).toBeNull();
    expect(landing.message).toMatchObject({ id: OLD, conversation_id: CONV, sender_kind: "member", body: SECRET, created_at: "2026-01-02T09:00:00.000Z" });
    expect(landing.conversation).toMatchObject({ id: CONV, counterpartRole: "steward", stewardUserId: STEWARD, sender: "Campaign committee member", initials: "CS", unread: 0, scheduled: [] });
    expect(landing.conversation.messages).toEqual([landing.message]);
  });

  it("returns a bounded projection: no user id, and the reactions the row already carries", async () => {
    const landing = await loadPrivateMessageLanding(fakeClient(), { messageId: OLD }, { userId: ME });
    expect(landing.message).not.toHaveProperty("user_id");
    expect(Object.keys(landing.message).sort()).toEqual([
      "body", "conversation_id", "created_at", "edited_at", "id", "reactions", "read_at", "reminder",
      "redacted_at", "redaction_reason", "resource", "saved", "sender_kind", "sender_name",
    ].sort());
    expect(landing.message.reactions).toEqual([expect.objectContaining({ id: "r1", actor_id: STEWARD, reaction: "support" })]);
  });

  it("never copies any message text into a title, name or preview", async () => {
    const landing = await loadPrivateMessageLanding(fakeClient(), { messageId: OLD, conversationId: CONV }, { userId: ME });
    const { messages, ...frame } = landing.conversation;
    expect(JSON.stringify(frame)).not.toContain("PRIVATE");
    expect(landing.conversation.preview).toBe("");
    expect(messages[0].body).toBe(SECRET);
  });

  it("localizes only the default thread title", async () => {
    const data = rows();
    data.member_conversations[0].title = "Chapter steward";
    const spanish = await loadPrivateMessageLanding(fakeClient({ data }), { messageId: OLD }, { userId: ME, lang: "es" });
    expect(spanish.conversation.sender).toBe("Miembro del comité de la campaña");
    data.member_conversations[0].title = "Sam Okafor";
    const named = await loadPrivateMessageLanding(fakeClient({ data }), { messageId: OLD }, { userId: ME, lang: "es" });
    expect(named.conversation.sender).toBe("Sam Okafor");
  });

  it("keeps a removed message a tombstone, with its reason and no restored text", async () => {
    const data = rows();
    Object.assign(data.member_messages[0], { body: "", redacted_at: "2026-02-01T00:00:00.000Z", redaction_reason: "sender_removed" });
    const landing = await loadPrivateMessageLanding(fakeClient({ data, context: { available: true, state: "removed" } }), { messageId: OLD }, { userId: ME });
    expect(landing.message).toMatchObject({ body: "", redacted_at: "2026-02-01T00:00:00.000Z", redaction_reason: "sender_removed" });
  });

  it("uses the shared facade's context when one is supplied instead of calling the RPC", async () => {
    const client = fakeClient();
    const context = vi.fn().mockResolvedValue({ available: true });
    const landing = await loadPrivateMessageLanding(client, { messageId: OLD }, { userId: ME, context });
    expect(context).toHaveBeenCalledWith({ kind: "private_message", id: OLD });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(landing.message.id).toBe(OLD);
  });
});

describe("a conversation-only link", () => {
  it("gives a member the newest bounded window, oldest first, without asking a message context", async () => {
    const client = fakeClient();
    const landing = await loadPrivateMessageLanding(client, { conversationId: CONV }, { userId: ME });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(landing.message).toBeNull();
    expect(landing.conversation.messages.map((message) => message.id)).toEqual([OLD, NEW]);
    expect(client.log.reads.find((read) => read.table === "member_messages")).toMatchObject({ filters: ["conversation_id", "user_id"], max: 30 });
  });

  it("gives staff only the thread row; the dialog pages its own history", async () => {
    const client = fakeClient();
    const landing = await loadPrivateMessageLanding(client, { conversationId: CONV }, { staff: true });
    expect(landing.conversation).toBeNull();
    expect(landing.message).toBeNull();
    expect(landing.thread).toMatchObject({ id: CONV, memberName: "Renata Cole", memberInitials: "RC", preview: "" });
    expect(client.log.reads.some((read) => read.table === "member_messages")).toBe(false);
  });
});

describe("staff landing on an older message", () => {
  it("reads under the staff scope with no user pin, and returns the desk's thread shape", async () => {
    const client = fakeClient();
    const landing = await loadPrivateMessageLanding(client, { messageId: OLD, conversationId: CONV }, { staff: true });
    expect(client.log.reads.find((read) => read.table === "member_messages").filters).toEqual(["id", "conversation_id"]);
    expect(client.log.reads.find((read) => read.table === "member_conversations").filters).toEqual(["id"]);
    expect(landing.conversation).toBeNull();
    expect(landing.thread).toEqual({
      id: CONV, memberName: "Renata Cole", memberInitials: "RC", preview: "", updatedAt: "2026-07-12T11:00:00.000Z", awaitingReply: false, messageCount: 0,
    });
    expect(landing.message.id).toBe(OLD);
    expect(JSON.stringify(landing.thread)).not.toContain("PRIVATE");
  });

  it("falls back to the desk's placeholder name when the profile cannot be read", async () => {
    const landing = await loadPrivateMessageLanding(fakeClient({ fail: { member_profiles: { code: "42501" } } }), { messageId: OLD }, { staff: true });
    expect(landing.thread.memberName).toBe("Member");
    expect(landing.thread.memberInitials).toBe("CS");
  });
});

describe("unavailable sources answer null, with nothing read that should not be", () => {
  it("refuses when the context says the message is unavailable, before reading any row", async () => {
    const client = fakeClient({ context: { available: false, reason: "source_unavailable" } });
    expect(await loadPrivateMessageLanding(client, { messageId: OLD }, { userId: ME })).toBeNull();
    expect(client.log.reads).toEqual([]);
  });

  it("does not let a member reach another member's message, even with its exact id", async () => {
    expect(await loadPrivateMessageLanding(fakeClient(), { messageId: FOREIGN }, { userId: ME })).toBeNull();
    expect(await loadPrivateMessageLanding(fakeClient(), { conversationId: CONV_OTHER }, { userId: ME })).toBeNull();
  });

  it("refuses a message named under the wrong conversation", async () => {
    expect(await loadPrivateMessageLanding(fakeClient(), { messageId: OLD, conversationId: CONV_OTHER }, { userId: ME })).toBeNull();
  });

  it("refuses when the conversation row is not readable", async () => {
    const data = rows();
    data.member_conversations = [];
    expect(await loadPrivateMessageLanding(fakeClient({ data }), { messageId: OLD }, { userId: ME })).toBeNull();
  });

  it("refuses a member landing with no identity to pin the read to", async () => {
    const client = fakeClient();
    expect(await loadPrivateMessageLanding(client, { messageId: OLD }, {})).toBeNull();
    expect(await loadPrivateMessageLanding(client, { messageId: OLD }, { userId: "not-a-uuid" })).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed message id", { messageId: "m-old", conversationId: CONV }],
    ["a malformed conversation id", { messageId: OLD, conversationId: "conv-1" }],
    ["no id at all", {}],
    ["an id with a filter injected into it", { messageId: `${OLD},user_id.neq.x` }],
  ])("touches nothing for %s", async (_label, ref) => {
    const client = fakeClient();
    expect(await loadPrivateMessageLanding(client, ref, { userId: ME })).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("accepts an upper-case id and reads it normalized", async () => {
    const landing = await loadPrivateMessageLanding(fakeClient(), { messageId: OLD.toUpperCase() }, { userId: ME.toUpperCase() });
    expect(landing.message.id).toBe(OLD);
  });
});

describe("failures reject so the view can tell them from unavailable", () => {
  it("rethrows a context failure, which the refusal helpers classify", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: "42501" });
    await expect(loadPrivateMessageLanding(fakeClient({ contextError: denied }), { messageId: OLD }, { userId: ME })).rejects.toBe(denied);
    expect(isPermissionRefusal(denied)).toBe(true);
  });

  it("rethrows a failed row read", async () => {
    const outage = Object.assign(new Error("connection reset"), { code: "08006" });
    await expect(loadPrivateMessageLanding(fakeClient({ fail: { member_messages: outage } }), { messageId: OLD }, { userId: ME })).rejects.toBe(outage);
    await expect(loadPrivateMessageLanding(fakeClient({ fail: { member_conversations: outage } }), { messageId: OLD }, { userId: ME })).rejects.toBe(outage);
    expect(isPermissionRefusal(outage) || isSourceGone(outage)).toBe(false);
  });

  it("shows the message even when the additive reactions read fails", async () => {
    const landing = await loadPrivateMessageLanding(fakeClient({ fail: { member_message_reactions: { code: "42501" } } }), { messageId: OLD }, { userId: ME });
    expect(landing.message.reactions).toEqual([]);
  });
});

describe("refusal classification", () => {
  it("knows a revoked role by SQLSTATE, facade code or HTTP status", () => {
    for (const cause of [{ code: "42501" }, { code: "not_authorized" }, { status: 403 }]) expect(isPermissionRefusal(cause)).toBe(true);
    for (const cause of [{ code: "source_unavailable" }, { code: "scope_changed" }, { code: "PGRST116" }, { status: 404 }]) expect(isSourceGone(cause)).toBe(true);
    for (const cause of [null, undefined, {}, { code: "23505" }, new Error("x")]) {
      expect(isPermissionRefusal(cause)).toBe(false);
      expect(isSourceGone(cause)).toBe(false);
    }
  });
});

describe("mergeLandedMessage", () => {
  const a = { id: "a", created_at: "2026-07-01T00:00:00.000Z" };
  const c = { id: "c", created_at: "2026-07-03T00:00:00.000Z" };
  const b = { id: "b", created_at: "2026-07-02T00:00:00.000Z" };

  it("places the message chronologically without touching the rest", () => {
    const merged = mergeLandedMessage([a, c], b);
    expect(merged.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(merged[0]).toBe(a);
  });

  it("returns the very same array when the message is absent or already there", () => {
    const rowsIn = [a, c];
    expect(mergeLandedMessage(rowsIn, null)).toBe(rowsIn);
    expect(mergeLandedMessage(rowsIn, undefined)).toBe(rowsIn);
    expect(mergeLandedMessage(rowsIn, { ...c })).toBe(rowsIn);
    expect(mergeLandedMessage(undefined, null)).toEqual([]);
  });

  it("orders a same-instant pair by id", () => {
    const merged = mergeLandedMessage([{ id: "z", created_at: "2026-07-01T00:00:00.000Z" }], { id: "y", created_at: "2026-07-01T00:00:00.000Z" });
    expect(merged.map((row) => row.id)).toEqual(["y", "z"]);
  });
});

describe("applyTombstonesToLanded", () => {
  const removal = { id: "m1", redacted_at: "2026-09-29T00:00:00.000Z", redaction_reason: "sender_removed" };
  const landed = () => ({
    conversationId: "c1",
    message: { id: "m1", body: "the removed text", created_at: "2026-01-01T00:00:00.000Z" },
    conversation: { id: "c1", messages: [{ id: "m1", body: "the removed text" }, { id: "m2", body: "kept" }] },
  });

  it("returns the very same snapshot when nothing was removed", () => {
    const snapshot = landed();
    expect(applyTombstonesToLanded(snapshot, [])).toBe(snapshot);
    expect(applyTombstonesToLanded(snapshot, undefined)).toBe(snapshot);
    expect(applyTombstonesToLanded(snapshot, [{ id: "m1" }])).toBe(snapshot);
    expect(applyTombstonesToLanded(null, [removal])).toBeNull();
  });

  it("empties the removed body wherever the snapshot holds it, and keeps every other row", () => {
    const result = applyTombstonesToLanded(landed(), [removal]);
    expect(result.message).toMatchObject({ id: "m1", body: "", redacted_at: "2026-09-29T00:00:00.000Z", redaction_reason: "sender_removed" });
    expect(result.conversation.messages[0]).toMatchObject({ id: "m1", body: "", redacted_at: "2026-09-29T00:00:00.000Z" });
    expect(result.conversation.messages[1]).toEqual({ id: "m2", body: "kept" });
    expect(JSON.stringify(result)).not.toContain("the removed text");
  });

  it("does not touch a snapshot that never held the removed message", () => {
    const result = applyTombstonesToLanded(landed(), [{ id: "other", redacted_at: "2026-09-29T00:00:00.000Z" }]);
    expect(result.message.body).toBe("the removed text");
    expect(result.conversation.messages.map((row) => row.body)).toEqual(["the removed text", "kept"]);
  });
});

// ---------------------------------------------------------------------------
// Task conversations
// ---------------------------------------------------------------------------

const TASK_A = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
const TASK_B = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
const TM_OLD = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TM_MID = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const TM_NEW = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
const TM_HIDDEN = "a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4";
const TM_ELSEWHERE = "a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5";
const TASK_SECRET = "PRIVATE task note 509";

function taskRows() {
  const message = (id, task, from, to, body, created) => ({ id, task_id: task, chapter_id: "chapter-1", sender_id: from, recipient_id: to, body, created_at: created });
  return {
    chapter_tasks: [
      { id: TASK_A, chapter_id: "chapter-1", task_number: 7, title: "Follow up on member message", status: "in_progress", description: "never projected" },
      { id: TASK_B, chapter_id: "chapter-1", task_number: 8, title: "Second task", status: "to_do" },
    ],
    chapter_task_messages: [
      message(TM_OLD, TASK_A, ME, STEWARD, TASK_SECRET, "2026-01-02T09:00:00.000Z"),
      message(TM_MID, TASK_A, STEWARD, ME, "Reviewed, thanks", "2026-07-01T09:00:00.000Z"),
      message(TM_NEW, TASK_A, ME, STEWARD, "Newest note", "2026-07-12T09:00:00.000Z"),
      message(TM_HIDDEN, TASK_A, OTHER, STEWARD, "Between two other people", "2026-07-05T09:00:00.000Z"),
      message(TM_ELSEWHERE, TASK_B, ME, STEWARD, "On another task", "2026-07-06T09:00:00.000Z"),
    ],
  };
}

const taskClient = (extra = {}) => fakeClient({ data: { ...rows(), ...taskRows() }, ...extra });

describe("loadTaskConversationLanding", () => {
  it("lands on a task message older than the loaded window: context first, then reads pinned to the participant, merged chronologically", async () => {
    const client = taskClient();
    const landing = await loadTaskConversationLanding(client, { taskId: TASK_A, messageId: TM_OLD, window: 2 }, { userId: ME });
    expect(client.log.rpc).toEqual([["get_connected_workflow_context", { p_kind: "task_message", p_id: TM_OLD, p_chapter_id: null, p_organization_id: null }]]);
    const reads = client.log.reads.filter((read) => read.table === "chapter_task_messages");
    expect(reads[0].filters).toEqual(["id", "task_id", "or"]);
    expect(reads[1]).toMatchObject({ filters: ["task_id", "or"], max: 2 });
    expect(landing.messages.map((row) => row.id)).toEqual([TM_OLD, TM_MID, TM_NEW]);
    expect(landing.messages[0]).toEqual({ id: TM_OLD, taskId: TASK_A, chapterId: "chapter-1", senderId: ME, recipientId: STEWARD, body: TASK_SECRET, createdAt: "2026-01-02T09:00:00.000Z" });
  });

  it("returns a minimal task projection whose title is the task's own, with no message text anywhere in it", async () => {
    const landing = await loadTaskConversationLanding(taskClient(), { taskId: TASK_A, messageId: TM_OLD }, { userId: ME });
    expect(landing.task).toEqual({ id: TASK_A, chapterId: "chapter-1", taskNumber: 7, title: "Follow up on member message", status: "in_progress" });
    expect(JSON.stringify(landing.task)).not.toMatch(/PRIVATE|never projected/);
  });

  it("never returns a message the reader neither sent nor received", async () => {
    const landing = await loadTaskConversationLanding(taskClient(), { taskId: TASK_A, messageId: TM_OLD }, { userId: ME });
    expect(landing.messages.map((row) => row.id)).not.toContain(TM_HIDDEN);
    expect(landing.messages.map((row) => row.id)).not.toContain(TM_ELSEWHERE);
    expect(await loadTaskConversationLanding(taskClient(), { taskId: TASK_A, messageId: TM_HIDDEN }, { userId: ME })).toBeNull();
    expect(await loadTaskConversationLanding(taskClient(), { taskId: TASK_A, messageId: TM_OLD }, { userId: OTHER })).toBeNull();
  });

  it("refuses a message named under the wrong task", async () => {
    expect(await loadTaskConversationLanding(taskClient(), { taskId: TASK_A, messageId: TM_ELSEWHERE }, { userId: ME })).toBeNull();
  });

  it("with window 0 returns only the named message and reads no page", async () => {
    const client = taskClient();
    const landing = await loadTaskConversationLanding(client, { taskId: TASK_A, messageId: TM_OLD, window: 0 }, { userId: ME });
    expect(landing.messages.map((row) => row.id)).toEqual([TM_OLD]);
    expect(client.log.reads.filter((read) => read.table === "chapter_task_messages")).toHaveLength(1);
  });

  it("bounds the window: a larger ask is clamped and a nonsense one falls back to the default", async () => {
    const big = taskClient();
    await loadTaskConversationLanding(big, { taskId: TASK_A, window: 5000 }, { userId: ME });
    expect(big.log.reads.find((read) => read.max != null).max).toBe(50);
    const negative = taskClient();
    await loadTaskConversationLanding(negative, { taskId: TASK_A, window: -4 }, { userId: ME });
    expect(negative.log.reads.some((read) => read.table === "chapter_task_messages")).toBe(false);
    const junk = taskClient();
    await loadTaskConversationLanding(junk, { taskId: TASK_A, window: "many" }, { userId: ME });
    expect(junk.log.reads.find((read) => read.max != null).max).toBe(30);
  });

  it("a task-only link asks the task context and returns the reader's newest window", async () => {
    const client = taskClient();
    const landing = await loadTaskConversationLanding(client, { taskId: TASK_A }, { userId: ME });
    expect(client.log.rpc[0][1]).toMatchObject({ p_kind: "task", p_id: TASK_A });
    expect(landing.messages.map((row) => row.id)).toEqual([TM_OLD, TM_MID, TM_NEW]);
  });

  it("asks the shared facade's context instead of the RPC when one is supplied", async () => {
    const client = taskClient();
    const context = vi.fn().mockResolvedValue({ available: true });
    await loadTaskConversationLanding(client, { taskId: TASK_A, messageId: TM_OLD }, { userId: ME, context });
    expect(context).toHaveBeenCalledWith({ kind: "task_message", id: TM_OLD });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("is unavailable, before any row is read, when the context says so", async () => {
    const client = taskClient({ context: { available: false, reason: "source_unavailable" } });
    expect(await loadTaskConversationLanding(client, { taskId: TASK_A, messageId: TM_OLD }, { userId: ME })).toBeNull();
    expect(client.log.reads).toEqual([]);
  });

  it("is unavailable when the task row itself is unreadable", async () => {
    const data = { ...rows(), ...taskRows(), chapter_tasks: [] };
    expect(await loadTaskConversationLanding(fakeClient({ data }), { taskId: TASK_A, messageId: TM_OLD }, { userId: ME })).toBeNull();
  });

  it.each([
    ["no reader identity", { taskId: TASK_A, messageId: TM_OLD }, {}],
    ["a malformed reader identity", { taskId: TASK_A, messageId: TM_OLD }, { userId: "someone" }],
    ["a malformed task id", { taskId: "task-1", messageId: TM_OLD }, { userId: ME }],
    ["a malformed message id", { taskId: TASK_A, messageId: "m-1" }, { userId: ME }],
    ["no task id", { messageId: TM_OLD }, { userId: ME }],
    ["a filter injected into the message id", { taskId: TASK_A, messageId: `${TM_OLD},sender_id.neq.x` }, { userId: ME }],
  ])("touches nothing for %s", async (_label, ref, options) => {
    const client = taskClient();
    expect(await loadTaskConversationLanding(client, ref, options)).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("rejects on every failed step so the view can offer a retry", async () => {
    const outage = Object.assign(new Error("connection reset"), { code: "08006" });
    await expect(loadTaskConversationLanding(taskClient({ contextError: outage }), { taskId: TASK_A, messageId: TM_OLD }, { userId: ME })).rejects.toBe(outage);
    for (const table of ["chapter_task_messages", "chapter_tasks"]) {
      await expect(loadTaskConversationLanding(taskClient({ fail: { [table]: outage } }), { taskId: TASK_A, messageId: TM_OLD }, { userId: ME })).rejects.toBe(outage);
    }
    expect(isPermissionRefusal(outage) || isSourceGone(outage)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Channel threads
// ---------------------------------------------------------------------------

const THREAD_1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const THREAD_2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const P_OLD = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const P_MID = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const P_NEW = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const P_DELETED = "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4";
const P_OTHER = "c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5";
const CHANNEL_SECRET = "PRIVATE channel post 509";

function channelRows() {
  const post = (id, thread, body, created, extra = {}) => ({ id, thread_id: thread, chapter_id: "chapter-1", author_id: STEWARD, body, parent_post_id: null, created_at: created, edited_at: null, deleted_at: null, ...extra });
  return {
    chapter_threads: [
      { id: THREAD_1, space_id: "space-1", chapter_id: "chapter-1", title: "Overtime scheduling", kind: "issue", status: "open", created_by: STEWARD, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-07-12T00:00:00.000Z" },
      { id: THREAD_2, space_id: "space-2", chapter_id: "chapter-1", title: "Parking", kind: "topic", status: "open", created_by: STEWARD, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" },
    ],
    chapter_thread_posts: [
      post(P_OLD, THREAD_1, CHANNEL_SECRET, "2026-01-02T09:00:00.000Z"),
      post(P_MID, THREAD_1, "Middle", "2026-07-01T09:00:00.000Z", { parent_post_id: P_OLD, body_es: "Medio" }),
      post(P_NEW, THREAD_1, "Newest", "2026-07-12T09:00:00.000Z"),
      post(P_DELETED, THREAD_1, "Gone", "2026-07-05T09:00:00.000Z", { deleted_at: "2026-07-06T00:00:00.000Z" }),
      post(P_OTHER, THREAD_2, "Elsewhere", "2026-07-06T09:00:00.000Z"),
    ],
    member_message_reactions: [{ id: "cr1", actor_id: ME, source_kind: "channel", channel_post_id: P_OLD, reaction: "support", created_at: "2026-01-03T09:00:00.000Z" }],
  };
}

const channelClient = (extra = {}) => fakeClient({ data: { ...rows(), ...channelRows() }, ...extra });

describe("loadChannelThreadLanding", () => {
  it("lands on a post older than the loaded posts of a thread the hub already holds, reading only the post when window is 0", async () => {
    const client = channelClient();
    const landing = await loadChannelThreadLanding(client, { threadId: THREAD_1, postId: P_OLD, window: 0 });
    expect(client.log.rpc).toEqual([["get_connected_workflow_context", { p_kind: "channel_post", p_id: P_OLD, p_chapter_id: null, p_organization_id: null }]]);
    expect(client.log.reads.find((read) => read.table === "chapter_thread_posts").filters).toEqual(["id", "thread_id", "is:deleted_at"]);
    expect(client.log.reads.filter((read) => read.table === "chapter_thread_posts")).toHaveLength(1);
    expect(landing.post).toMatchObject({ id: P_OLD, thread_id: THREAD_1, author_id: STEWARD, body: CHANNEL_SECRET, parent_post_id: null, deleted_at: null, saved: false, reminder: null });
    expect(landing.post.reactions).toEqual([expect.objectContaining({ actor_id: ME, reaction: "support", channel_post_id: P_OLD })]);
    expect(landing.thread.posts).toEqual([landing.post]);
  });

  it("returns an unknown thread with its newest bounded window and the named post merged in place", async () => {
    const client = channelClient();
    const landing = await loadChannelThreadLanding(client, { threadId: THREAD_1, postId: P_OLD, window: 2 });
    expect(client.log.reads.filter((read) => read.table === "chapter_thread_posts")[1]).toMatchObject({ filters: ["thread_id", "is:deleted_at"], max: 2 });
    expect(landing.thread.posts.map((row) => row.id)).toEqual([P_OLD, P_MID, P_NEW]);
    expect(landing.thread).toMatchObject({ id: THREAD_1, space_id: "space-1", title: "Overtime scheduling", kind: "issue", status: "open", unreadCount: 0 });
    expect(landing.thread.posts).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: P_DELETED })]));
  });

  it("never builds a thread title or field from post text, and exposes no other columns", async () => {
    const landing = await loadChannelThreadLanding(channelClient(), { threadId: THREAD_1, postId: P_OLD, window: 0 });
    const { posts, ...frame } = landing.thread;
    expect(JSON.stringify(frame)).not.toContain("PRIVATE");
    expect(landing.post).not.toHaveProperty("chapter_id");
    expect(Object.keys(frame).sort()).toEqual(["created_at", "id", "kind", "space_id", "status", "title", "unreadCount", "updated_at"]);
    expect(posts).toHaveLength(1);
  });

  // REQ-UG-SPANISH-SPACES-AND-POSTS-20261030: the Spanish version
  // survives the projection, for the named post and the recent window.
  it("keeps each post's Spanish version, or null when it has none", async () => {
    const named = await loadChannelThreadLanding(channelClient(), { threadId: THREAD_1, postId: P_MID, window: 0 });
    expect(named.post).toMatchObject({ id: P_MID, body: "Middle", body_es: "Medio" });
    const windowed = await loadChannelThreadLanding(channelClient(), { threadId: THREAD_1, postId: P_OLD, window: 2 });
    expect(windowed.thread.posts.map((row) => [row.id, row.body_es])).toEqual([[P_OLD, null], [P_MID, "Medio"], [P_NEW, null]]);
  });

  it("resolves the thread from a post named without one", async () => {
    const landing = await loadChannelThreadLanding(channelClient(), { postId: P_OTHER, window: 0 });
    expect(landing.thread.id).toBe(THREAD_2);
    expect(landing.post.id).toBe(P_OTHER);
  });

  it("reads a thread named without a post from its newest window, and asks no post context", async () => {
    const client = channelClient();
    const landing = await loadChannelThreadLanding(client, { threadId: THREAD_1 });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(landing.post).toBeNull();
    expect(landing.thread.posts.map((row) => row.id)).toEqual([P_OLD, P_MID, P_NEW]);
  });

  it("is unavailable for a post that was deleted, one under another thread, or one the context refuses", async () => {
    expect(await loadChannelThreadLanding(channelClient(), { threadId: THREAD_1, postId: P_DELETED })).toBeNull();
    expect(await loadChannelThreadLanding(channelClient(), { threadId: THREAD_1, postId: P_OTHER })).toBeNull();
    const refused = channelClient({ context: { available: false, reason: "source_unavailable" } });
    expect(await loadChannelThreadLanding(refused, { threadId: THREAD_1, postId: P_OLD })).toBeNull();
    expect(refused.log.reads).toEqual([]);
  });

  it("is unavailable when the thread row is not readable", async () => {
    const data = { ...rows(), ...channelRows(), chapter_threads: [] };
    expect(await loadChannelThreadLanding(fakeClient({ data }), { threadId: THREAD_1, postId: P_OLD })).toBeNull();
  });

  it("bounds the window and uses the shared context when given", async () => {
    const client = channelClient();
    const context = vi.fn().mockResolvedValue({ available: true });
    await loadChannelThreadLanding(client, { threadId: THREAD_1, postId: P_OLD, window: 900 }, { context });
    expect(context).toHaveBeenCalledWith({ kind: "channel_post", id: P_OLD });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.log.reads.find((read) => read.max != null).max).toBe(50);
  });

  it.each([
    ["a malformed thread id", { threadId: "thread-1", postId: P_OLD }],
    ["a malformed post id", { threadId: THREAD_1, postId: "post-1" }],
    ["no id at all", {}],
    ["a filter injected into the post id", { postId: `${P_OLD},deleted_at.is.null` }],
  ])("touches nothing for %s", async (_label, ref) => {
    const client = channelClient();
    expect(await loadChannelThreadLanding(client, ref)).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("rejects on a failed read and still shows the post when only the additive reactions read fails", async () => {
    const outage = Object.assign(new Error("connection reset"), { code: "08006" });
    await expect(loadChannelThreadLanding(channelClient({ contextError: outage }), { threadId: THREAD_1, postId: P_OLD })).rejects.toBe(outage);
    for (const table of ["chapter_thread_posts", "chapter_threads"]) {
      await expect(loadChannelThreadLanding(channelClient({ fail: { [table]: outage } }), { threadId: THREAD_1, postId: P_OLD })).rejects.toBe(outage);
    }
    const soft = await loadChannelThreadLanding(channelClient({ fail: { member_message_reactions: { code: "42501" } } }), { threadId: THREAD_1, postId: P_OLD, window: 0 });
    expect(soft.post.reactions).toEqual([]);
  });
});

describe("mergeLandedRows", () => {
  it("orders by the named timestamp, dedupes, and returns the same array when nothing is new", () => {
    const rowsIn = [{ id: "a", createdAt: "2026-07-01T00:00:00.000Z" }, { id: "c", createdAt: "2026-07-03T00:00:00.000Z" }];
    const merged = mergeLandedRows(rowsIn, [{ id: "b", createdAt: "2026-07-02T00:00:00.000Z" }, { id: "b", createdAt: "2026-07-02T00:00:00.000Z" }, { id: "a", createdAt: "x" }], { timeKey: "createdAt" });
    expect(merged.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(mergeLandedRows(rowsIn, [{ id: "a" }, { id: "c" }, null, {}], { timeKey: "createdAt" })).toBe(rowsIn);
    expect(mergeLandedRows(undefined, undefined)).toEqual([]);
  });
});
