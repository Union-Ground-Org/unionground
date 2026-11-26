import { describe, expect, it } from "vitest";
import { loadChannelThreadLanding, loadPrivateMessageLanding } from "../src/features/connectedWorkflows/landing.js";
import { postgrestPage } from "./helpers/silentTruncation.js";

// A single linked message or post, opened by itself, showed
// without the viewer's saved mark, pending reminder and shared document. It
// now carries them, read as an earlier page reads them (#9652). Fictional
// Tamarack rows only.

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [member, other, conversation, thread, doc] = [id(1), id(2), id(3), id(4), id(5)];
const at = (minute) => new Date(Date.UTC(2026, 8, 1, 12) + minute * 60_000).toISOString();
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const available = async () => ({ available: true });

// Reads apply eq, is, in, gt, every order, the limit and the 1,000-row
// ceiling; `refuse` names tables whose reads fail.
function tableClient(tables, refuse = []) {
  const reads = [];
  const from = (table) => {
    reads.push(table);
    const filters = []; const orders = []; let limit = Infinity;
    const answer = () => {
      if (refuse.includes(table)) return { data: null, error: { message: `refused ${table}` } };
      const rows = (tables[table] || []).filter((row) => filters.every((keep) => keep(row)))
        .sort((left, right) => orders.reduce((found, [column, way]) => found || way * compare(left[column], right[column]), 0));
      return { data: postgrestPage(rows, limit), error: null };
    };
    const self = {
      select: () => self,
      eq: (column, value) => { filters.push((row) => row[column] === value); return self; },
      is: (column, value) => { filters.push((row) => (value === null ? row[column] == null : row[column] === value)); return self; },
      in: (column, values) => { filters.push((row) => values.includes(row[column])); return self; },
      gt: (column, value) => { filters.push((row) => row[column] > value); return self; },
      order: (column, options = {}) => { orders.push([column, options.ascending === false ? -1 : 1]); return self; },
      limit: (value) => { limit = value; return self; },
      maybeSingle: async () => { const { data, error } = answer(); return { data: data ? data[0] ?? null : null, error }; },
      then: (resolve) => resolve(answer()),
    };
    return self;
  };
  return { from, reads };
}

const message = (n, minute) => ({ id: id(100 + n), conversation_id: conversation, user_id: member, sender_kind: "steward", sender_name: "Chapter Steward", body: `Tamarack message ${n}`, created_at: at(minute) });
const post = (n, minute) => ({ id: id(200 + n), thread_id: thread, author_id: other, body: `Tamarack post ${n}`, created_at: at(minute), deleted_at: null });
const marksFor = (kind, n, field) => ({
  member_saved_messages: [{ id: id(300 + n), owner_id: member, source_kind: kind, [field]: id((kind === "private" ? 100 : 200) + n), saved_at: at(50) }, { id: id(390), owner_id: other, source_kind: kind, [field]: id((kind === "private" ? 100 : 200) + n + 1), saved_at: at(50) }],
  member_message_reminders: [{ id: id(400 + n), owner_id: member, source_kind: kind, [field]: id((kind === "private" ? 100 : 200) + n), note: "", remind_at: at(90), status: "pending" }],
});
const privateTables = (extra = {}) => ({
  member_messages: [message(1, 1), message(2, 2)],
  member_conversations: [{ id: conversation, user_id: member, title: "Chapter steward", initials: "CS", updated_at: at(5) }],
  ...marksFor("private", 1, "private_message_id"),
  member_message_resources: [{ id: id(500), message_id: id(101), document_id: doc, created_at: at(3) }],
  chapter_documents: [{ id: doc, title: "Tamarack overtime guide", document_type: "guide" }],
  ...extra,
});
const marks = (row) => [row.id, row.saved, row.reminder?.id ?? null, row.resource?.title ?? null];

describe("a linked private message carries the viewer's marks", () => {
  it("on the message a link names, and on a conversation opened without one", async () => {
    const landed = await loadPrivateMessageLanding(tableClient(privateTables()), { messageId: id(101) }, { userId: member, context: available });
    expect(marks(landed.message)).toEqual([id(101), true, id(401), "Tamarack overtime guide"]);
    expect(landed.conversation.messages.map(marks)).toEqual([[id(101), true, id(401), "Tamarack overtime guide"]]);
    const opened = await loadPrivateMessageLanding(tableClient(privateTables()), { conversationId: conversation }, { userId: member, context: available });
    expect(opened.conversation.messages.map(marks)).toEqual([[id(101), true, id(401), "Tamarack overtime guide"], [id(102), false, null, null]]);
  });

  it("stays readable, unmarked, when a mark read is refused", async () => {
    const refused = tableClient(privateTables(), ["member_saved_messages", "member_message_reminders", "member_message_resources"]);
    const landed = await loadPrivateMessageLanding(refused, { messageId: id(101) }, { userId: member, context: available });
    expect([landed.message.body, ...marks(landed.message).slice(1)]).toEqual(["Tamarack message 1", false, null, null]);
  });
});

describe("a linked channel post carries the reader's marks", () => {
  const channelTables = () => ({
    chapter_threads: [{ id: thread, space_id: id(6), title: "Tamarack general", kind: "discussion", status: "open", created_at: at(0), updated_at: at(9) }],
    chapter_thread_posts: [post(1, 1), post(2, 2)],
    ...marksFor("channel", 1, "channel_post_id"),
  });

  it("on the post a link names and the posts shown with it, the reader's own only", async () => {
    const landed = await loadChannelThreadLanding(tableClient(channelTables()), { postId: id(201), window: 5 }, { userId: member, context: available });
    expect([landed.post.saved, landed.post.reminder?.id]).toEqual([true, id(401)]);
    expect(landed.thread.posts.map((row) => [row.id, row.saved, row.reminder?.id ?? null])).toEqual([[id(201), true, id(401)], [id(202), false, null]]);
  });

  it("reads no marks without a reader", async () => {
    const client = tableClient(channelTables());
    const landed = await loadChannelThreadLanding(client, { postId: id(201) }, { context: available });
    expect([landed.post.saved, landed.post.reminder]).toEqual([false, null]);
    // No query at all for a mark: only the post, its thread, its reactions and the window.
    const markTables = ["member_saved_messages", "member_message_reminders", "member_message_resources", "chapter_documents"];
    expect(client.reads.filter((table) => markTables.includes(table))).toEqual([]);
    expect(client.reads).toContain("chapter_thread_posts");
  });
});
