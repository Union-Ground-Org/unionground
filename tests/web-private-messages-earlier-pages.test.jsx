import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_HISTORY_PAGE, REACTION_PAGE, loadEarlierPrivateMessages, privateHistoryApi } from "../src/features/messaging/privateHistory.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { expectNoSilentTruncation, postgrestPage } from "./helpers/silentTruncation.js";

// #9526: a conversation the newest 1,000 messages cut pages back to its
// earlier messages, as a channel thread does. Fictional Tamarack messages only.

const BASE = Date.UTC(2026, 8, 1, 12);
const at = (minute) => new Date(BASE + minute * 60_000).toISOString();
const message = (index, extra = {}) => ({ id: `m-${String(index).padStart(5, "0")}`, conversation_id: "conversation-1", user_id: "user-1", sender_kind: "steward", body: `Tamarack message ${index}`, created_at: at(index), ...extra });
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Reads apply eq, in, the (created_at, id) cursor, every order, the limit and
// the 1,000-row ceiling, as PostgREST does.
function tableClient(tables) {
  const reads = [];
  const from = (table) => {
    const filters = []; const orders = []; let limit = Infinity;
    const self = {
      select: () => self,
      eq: (column, value) => { filters.push((row) => row[column] === value); return self; },
      in: (column, values) => { filters.push((row) => values.includes(row[column])); return self; },
      gt: (column, value) => { filters.push((row) => row[column] > value); return self; },
      or: (filter) => {
        const [, at, , id] = /^created_at\.lt\.(".*?"),and\(created_at\.eq\.(".*?"),id\.lt\.(".*?")\)$/.exec(filter);
        const [createdAt, before] = [JSON.parse(at), JSON.parse(id)];
        filters.push((row) => row.created_at < createdAt || (row.created_at === createdAt && row.id < before));
        return self;
      },
      order: (column, options = {}) => { orders.push([column, options.ascending === false ? -1 : 1]); return self; },
      limit: (value) => { limit = value; return self; },
      then: (resolve) => {
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

describe("earlier private messages", () => {
  it("pages one conversation back to its first message, own rows only, across equal times", async () => {
    const own = [
      ...Array.from({ length: 101 }, (_unused, index) => message(10, { id: `q-a-${String(index).padStart(3, "0")}` })),
      ...Array.from({ length: 249 }, (_unused, index) => message(11 + index, { id: `q-b-${String(index).padStart(3, "0")}` })),
    ];
    const rows = [...own, message(300, { id: "other-conversation", conversation_id: "conversation-2" }), message(301, { id: "other-member", user_id: "user-2" })];
    const { client, reads } = tableClient({
      member_messages: rows,
      member_message_reactions: [{ id: "r1", actor_id: "user-1", source_kind: "private", private_message_id: "q-b-000", reaction: "like", created_at: at(500) }],
    });
    const read = [];
    let cursor = { createdAt: at(1_000), id: "" };
    while (cursor) {
      const page = await loadEarlierPrivateMessages(client, { userId: "user-1", conversationId: "conversation-1", before: cursor });
      read.unshift(...page.messages.map((row) => row.id));
      const liked = page.messages.find((row) => row.id === "q-b-000");
      if (liked) expect(liked).toMatchObject({ reactions: [expect.objectContaining({ reaction: "like" })], saved: false, reminder: null, resource: null });
      cursor = page.earlierCursor;
    }
    expect(read).toEqual([...own].sort((left, right) => compare(left.created_at, right.created_at) || compare(left.id, right.id)).map((row) => row.id));
    expect(reads.filter((entry) => entry.table === "member_messages").map((entry) => [entry.limit, entry.count])).toEqual([[201, 201], [201, 150]]);
    await expectNoSilentTruncation({ cap: PRIVATE_HISTORY_PAGE, read: async (total) => {
      const { client: reader } = tableClient({ member_messages: Array.from({ length: total }, (_unused, index) => message(index)) });
      const page = await loadEarlierPrivateMessages(reader, { userId: "user-1", conversationId: "conversation-1", before: { createdAt: at(100_000), id: "" } });
      return { shown: page.messages.length, more: page.earlierCursor !== null };
    } });
  });

  it("runs through the messaging api like its other reads, as the signed-in member", async () => {
    const { client } = tableClient({ member_messages: [message(1), message(2, { user_id: "user-2" })] });
    const operation = { run: vi.fn((work) => work()), wait: vi.fn((promise) => promise) };
    const page = await privateHistoryApi(client, operation, "user-1").loadEarlierPrivateMessages({ conversationId: "conversation-1", before: { createdAt: at(5), id: "" } });
    expect(page.messages.map((row) => row.id)).toEqual(["m-00001"]);
    expect(operation.run).toHaveBeenCalledTimes(1);
    expect(operation.wait).toHaveBeenCalledTimes(1);
  });

  it("fails on a refused page or reactions read; an empty conversation reads nothing", async () => {
    const refused = new Proxy({}, { get: (_target, prop) => (prop === "then" ? (resolve) => resolve({ data: null, error: { message: "refused" } }) : () => refused) });
    const refusing = (table) => {
      const { client } = tableClient({ member_messages: [message(1)] });
      return { from: (name) => (name === table ? refused : client.from(name)) };
    };
    const ref = { userId: "user-1", conversationId: "conversation-1", before: { createdAt: at(5), id: "" } };
    await expect(loadEarlierPrivateMessages(refusing("member_messages"), ref)).rejects.toMatchObject({ message: "refused" });
    await expect(loadEarlierPrivateMessages(refusing("member_message_reactions"), ref)).rejects.toMatchObject({ message: "refused" });
    expect(await loadEarlierPrivateMessages(tableClient({}).client, ref)).toEqual({ messages: [], earlierCursor: null });
    const unread = tableClient({ member_messages: [message(1)] });
    expect(await loadEarlierPrivateMessages(unread.client, { ...ref, userId: undefined })).toEqual({ messages: [], earlierCursor: null });
    expect(unread.reads).toEqual([]);
  });

  it("reads every reaction when a page's messages hold more than one answer of them", async () => {
    const total = 2 * REACTION_PAGE + 3;
    const reactions = Array.from({ length: total }, (_unused, index) => ({ id: `r-${String(index).padStart(5, "0")}`, actor_id: `user-${index}`, source_kind: "private", private_message_id: index % 2 ? "m-00001" : "m-00002", reaction: "like", created_at: at(500) }));
    const { client, reads } = tableClient({ member_messages: [message(1), message(2)], member_message_reactions: reactions });
    const page = await loadEarlierPrivateMessages(client, { userId: "user-1", conversationId: "conversation-1", before: { createdAt: at(5), id: "" } });
    expect(page.messages.reduce((sum, row) => sum + row.reactions.length, 0)).toBe(total);
    expect(reads.filter((entry) => entry.table === "member_message_reactions").map((entry) => [entry.limit, entry.count])).toEqual([[REACTION_PAGE + 1, REACTION_PAGE + 1], [REACTION_PAGE + 1, REACTION_PAGE + 1], [REACTION_PAGE + 1, 3]]);
  });
});

// Messages with one steward conversation (`thread` fills it) and the earlier read.
const show = (lang, thread, loadEarlierPrivateMessages) => render(
  <LanguageProvider lang={lang}>
    <MessagesView data={{ member: { id: "user-1" }, conversations: [{ id: "conversation-1", sender: "Chapter Steward", initials: "CS", unread: 0, ...thread }], broadcasts: [], product: { spaces: [], documents: [] } }}
      desktop messagingApi={{ loadEarlierPrivateMessages }} onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />
  </LanguageProvider>,
);

describe.each(["en", "es"])("a conversation the window cut, in %s", (lang) => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/m/messages?conversation=conversation-1");
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("opens earlier messages above the loaded ones and says when it reaches the start", async () => {
    const loadEarlierPrivateMessages = vi.fn().mockResolvedValue({ messages: [message(1, { body: "Tamarack first message" })], earlierCursor: null });
    show(lang, { messages: [message(2, { body: "Tamarack newest message" })], earlierCursor: { createdAt: at(2), id: "m-00002" } }, loadEarlierPrivateMessages);
    await screen.findByText("Tamarack newest message");
    expect(screen.queryByText("Tamarack first message")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t(lang, "threadHistory.showEarlier") }));
    await screen.findByText("Tamarack first message");
    expect(loadEarlierPrivateMessages).toHaveBeenCalledWith({ conversationId: "conversation-1", before: { createdAt: at(2), id: "m-00002" } });
    await waitFor(() => expect(screen.getByText(t(lang, "threadHistory.start"))).toBeInTheDocument());
    const bodies = [...document.querySelectorAll(".inbox-thread .inbox-msg")].map((node) => node.textContent);
    expect(bodies.findIndex((text) => text.includes("first message"))).toBeLessThan(bodies.findIndex((text) => text.includes("newest message")));
    // The control replaces the notice.
    expect(screen.queryByText(t(lang, "inbox.olderNotShown"))).toBeNull();
  });

  it("opens the earlier messages of a conversation the window left with none", async () => {
    const loadEarlierPrivateMessages = vi.fn().mockResolvedValue({ messages: [message(0, { body: "Tamarack only message" })], earlierCursor: null });
    show(lang, { messages: [], earlierCursor: { createdAt: at(1), id: "m-00001" } }, loadEarlierPrivateMessages);
    fireEvent.click(await screen.findByRole("button", { name: t(lang, "threadHistory.showEarlier") }));
    await screen.findByText("Tamarack only message");
    expect(loadEarlierPrivateMessages).toHaveBeenCalledWith({ conversationId: "conversation-1", before: { createdAt: at(1), id: "m-00001" } });
  });
});
