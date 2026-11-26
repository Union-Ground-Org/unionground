import { describe, expect, it } from "vitest";
import { channelHistoryApi, loadEarlierChannelPosts } from "../src/features/messaging/channelHistory.js";
import { MARK_PAGE } from "../src/features/messaging/earlierMarks.js";
import { loadEarlierPrivateMessages } from "../src/features/messaging/privateHistory.js";
import { postgrestPage } from "./helpers/silentTruncation.js";

// An earlier page of a channel thread or a private
// conversation showed every row unsaved, with no reminder and no shared
// document. It now carries the marks the member load gives the newest page.
// Fictional Tamarack rows only.

const at = (minute) => new Date(Date.UTC(2026, 8, 1, 12) + minute * 60_000).toISOString();
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const before = { createdAt: at(100), id: "" };

// Reads apply eq, is, in, gt, the (created_at, id) cursor, every order, the
// limit and the 1,000-row ceiling, as PostgREST does; `refuse` names tables
// whose reads fail.
function tableClient(tables, refuse = []) {
  const reads = [];
  const from = (table) => {
    const filters = []; const orders = []; let limit = Infinity;
    const self = {
      select: () => self,
      eq: (column, value) => { filters.push((row) => row[column] === value); return self; },
      is: (column, value) => { filters.push((row) => (value === null ? row[column] == null : row[column] === value)); return self; },
      in: (column, values) => { filters.push((row) => values.includes(row[column])); return self; },
      gt: (column, value) => { filters.push((row) => row[column] > value); return self; },
      or: (filter) => {
        const [, stamp, , id] = /^created_at\.lt\.(".*?"),and\(created_at\.eq\.(".*?"),id\.lt\.(".*?")\)$/.exec(filter);
        const [createdAt, cursor] = [JSON.parse(stamp), JSON.parse(id)];
        filters.push((row) => row.created_at < createdAt || (row.created_at === createdAt && row.id < cursor));
        return self;
      },
      order: (column, options = {}) => { orders.push([column, options.ascending === false ? -1 : 1]); return self; },
      limit: (value) => { limit = value; return self; },
      then: (resolve) => {
        if (refuse.includes(table)) return resolve({ data: null, error: { message: `refused ${table}` } });
        const sorted = (tables[table] || []).filter((row) => filters.every((keep) => keep(row)))
          .sort((left, right) => orders.reduce((found, [column, way]) => found || way * compare(left[column], right[column]), 0));
        const data = postgrestPage(sorted, limit);
        reads.push({ table, limit, count: data.length });
        return resolve({ data, error: null });
      },
    };
    return self;
  };
  return { client: { from }, reads };
}

const privateMessage = (id, minute) => ({ id, conversation_id: "conversation-1", user_id: "user-1", sender_kind: "steward", body: `Tamarack ${id}`, created_at: at(minute) });
const post = (id, minute) => ({ id, thread_id: "thread-1", author_id: "user-2", body: `Tamarack ${id}`, created_at: at(minute), deleted_at: null });
const saved = (id, owner, kind, messageId) => ({ id, owner_id: owner, source_kind: kind, [kind === "private" ? "private_message_id" : "channel_post_id"]: messageId, saved_at: at(50) });
const reminder = (id, owner, kind, messageId, minute, status = "pending") => ({ id, owner_id: owner, source_kind: kind, [kind === "private" ? "private_message_id" : "channel_post_id"]: messageId, note: "", remind_at: at(minute), status });

describe("an earlier page carries the reader's marks", () => {
  it("on a private conversation: saved, the soonest pending reminder and the shared document, the member's own only", async () => {
    const { client } = tableClient({
      member_messages: [privateMessage("m-1", 1), privateMessage("m-2", 2), privateMessage("m-3", 3)],
      member_saved_messages: [saved("s-1", "user-1", "private", "m-1"), saved("s-2", "user-2", "private", "m-2")],
      // r-5 is earliest in time (12:15 UTC) but last as text (+02:00), as the server's order("remind_at") would rank it.
      member_message_reminders: [reminder("r-1", "user-1", "private", "m-2", 90), reminder("r-2", "user-1", "private", "m-2", 80), { ...reminder("r-5", "user-1", "private", "m-2", 0), remind_at: "2026-09-01T14:15:00+02:00" }, reminder("r-3", "user-1", "private", "m-3", 70, "delivered"), reminder("r-4", "user-2", "private", "m-3", 60)],
      member_message_resources: [{ id: "link-1", message_id: "m-3", document_id: "doc-1", created_at: at(3) }],
      chapter_documents: [{ id: "doc-1", title: "Tamarack overtime guide", document_type: "guide" }],
    });
    const page = await loadEarlierPrivateMessages(client, { userId: "user-1", conversationId: "conversation-1", before });
    const marks = Object.fromEntries(page.messages.map((row) => [row.id, [row.saved, row.reminder?.id ?? null, row.resource]]));
    expect(marks).toEqual({
      "m-1": [true, null, null],
      "m-2": [false, "r-5", null],
      "m-3": [false, null, { id: "link-1", documentId: "doc-1", title: "Tamarack overtime guide", documentType: "guide" }],
    });
  });

  it("on a channel thread: saved and the soonest pending reminder, the reader's own only", async () => {
    const { client } = tableClient({
      chapter_thread_posts: [post("p-1", 1), post("p-2", 2)],
      member_saved_messages: [saved("s-1", "user-1", "channel", "p-1"), saved("s-2", "user-1", "private", "p-2")],
      member_message_reminders: [reminder("r-1", "user-1", "channel", "p-2", 80), reminder("r-2", "user-3", "channel", "p-1", 70)],
    });
    const operation = { run: (work) => work(), wait: (promise) => promise };
    const page = await channelHistoryApi(client, operation, "user-1").loadEarlierChannelPosts({ threadId: "thread-1", before });
    expect(page.posts.map((row) => [row.id, row.saved, row.reminder?.id ?? null])).toEqual([["p-1", true, null], ["p-2", false, "r-1"]]);
  });

  it("reads every mark when they outrun one answer, and reads none with no reader", async () => {
    const many = Array.from({ length: 2 * MARK_PAGE + 3 }, (_unused, index) => reminder(`r-${String(index).padStart(5, "0")}`, "user-1", "channel", "p-1", 2_000 - index));
    const { client, reads } = tableClient({ chapter_thread_posts: [post("p-1", 1)], member_message_reminders: many });
    const page = await loadEarlierChannelPosts(client, { threadId: "thread-1", before, userId: "user-1" });
    // The soonest is the last of the rows, so a cut read would name another one.
    expect(page.posts[0].reminder.id).toBe(`r-${String(2 * MARK_PAGE + 2).padStart(5, "0")}`);
    expect(reads.filter((read) => read.table === "member_message_reminders").map((read) => read.count)).toEqual([MARK_PAGE + 1, MARK_PAGE + 1, 3]);
    const anonymous = tableClient({ chapter_thread_posts: [post("p-1", 1)], member_message_reminders: many });
    const unread = await loadEarlierChannelPosts(anonymous.client, { threadId: "thread-1", before });
    expect([unread.posts[0].saved, unread.posts[0].reminder]).toEqual([false, null]);
    expect(anonymous.reads.map((read) => read.table)).toEqual(["chapter_thread_posts", "member_message_reactions"]);
  });

  it("still shows the page, unmarked as on Main, when a mark read is refused", async () => {
    const marks = { member_saved_messages: [saved("s-1", "user-1", "private", "m-1"), saved("s-2", "user-1", "channel", "p-1")], member_message_reminders: [reminder("r-1", "user-1", "private", "m-1", 80), reminder("r-2", "user-1", "channel", "p-1", 80)], member_message_resources: [{ id: "link-1", message_id: "m-1", document_id: "doc-1", created_at: at(3) }], chapter_documents: [{ id: "doc-1", title: "Tamarack guide", document_type: "guide" }] };
    const refusable = ["member_saved_messages", "member_message_reminders", "member_message_resources", "chapter_documents"];
    const ref = { userId: "user-1", conversationId: "conversation-1", before };
    const all = await loadEarlierPrivateMessages(tableClient({ member_messages: [privateMessage("m-1", 1)], ...marks }, refusable).client, ref);
    expect(all.messages.map((row) => [row.id, row.body, row.reactions, row.saved, row.reminder, row.resource])).toEqual([["m-1", "Tamarack m-1", [], false, null, null]]);
    const posts = await loadEarlierChannelPosts(tableClient({ chapter_thread_posts: [post("p-1", 1)], ...marks }, refusable).client, { threadId: "thread-1", before, userId: "user-1" });
    expect(posts.posts.map((row) => [row.id, row.saved, row.reminder])).toEqual([["p-1", false, null]]);
    // One refused read takes only its own mark away.
    const one = await loadEarlierPrivateMessages(tableClient({ member_messages: [privateMessage("m-1", 1)], ...marks }, ["member_saved_messages"]).client, ref);
    expect([one.messages[0].saved, one.messages[0].reminder?.id, one.messages[0].resource?.title]).toEqual([false, "r-1", "Tamarack guide"]);
    const noDocument = await loadEarlierPrivateMessages(tableClient({ member_messages: [privateMessage("m-1", 1)], ...marks }, ["chapter_documents"]).client, ref);
    expect([noDocument.messages[0].saved, noDocument.messages[0].resource]).toEqual([true, null]);
  });
});
