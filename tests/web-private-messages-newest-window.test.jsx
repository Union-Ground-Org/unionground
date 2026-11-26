import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OLDER_PROBE_CONCURRENCY, OLDER_PROBE_DEADLINE_MS, PRIVATE_MESSAGE_WINDOW, conversationsWithOlderMessages, privateMessageWindow } from "../src/features/messaging/privateHistory.js";
import { conversationDateLabel, loadMemberApp } from "../src/lib/memberApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { expectNoSilentTruncation, postgrestPage } from "./helpers/silentTruncation.js";

// #9526: past 1,000 private messages the member load kept the oldest and
// dropped the newest. Fictional Tamarack messages only.

const BASE = Date.UTC(2026, 8, 1, 12);
const at = (minute) => new Date(BASE + minute * 60_000).toISOString();
const message = (index, extra = {}) => ({ id: `m-${String(index).padStart(5, "0")}`, conversation_id: "conversation-1", user_id: "user-1", sender_kind: "steward", body: `Tamarack message ${index}`, created_at: at(index), ...extra });
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const range = (count) => Array.from({ length: count }, (_unused, index) => message(index));

// Reads apply eq, the (created_at, id) cursor, every order, the limit and
// the 1,000-row ceiling.
const conversation = (id, updatedAt) => ({ id, user_id: "user-1", title: "Chapter steward", initials: "CS", updated_at: updatedAt });
function memberClient(messages, { failRead = false, failProbe = false, hangProbe = false, conversations = [conversation("conversation-1", at(5_000))] } = {}) {
  const reads = [];
  const tables = {
    member_profiles: { id: "user-1", full_name: "Darnell Foster", language: "en", chapter_id: "wor" },
    member_conversations: conversations,
    member_messages: messages,
  };
  const from = (table) => {
    const filters = []; const orders = []; let limit = Infinity; let probe = false;
    const self = new Proxy({}, { get: (_target, prop) => {
      if (prop === "eq") return (column, value) => { filters.push((row) => row[column] === value); return self; };
      if (prop === "order") return (column, options = {}) => { orders.push([column, options.ascending === false ? -1 : 1]); return self; };
      if (prop === "limit") return (value) => { limit = value; return self; };
      if (prop === "or") return (filter) => {
        const match = /^created_at\.lt\.(".*?"),and\(created_at\.eq\.(".*?"),id\.lt\.(".*?")\)$/.exec(filter);
        if (!match) return self;
        const [createdAt, id] = [JSON.parse(match[1]), JSON.parse(match[3])];
        probe = true;
        filters.push((row) => row.created_at < createdAt || (row.created_at === createdAt && row.id < id));
        return self;
      };
      if (prop !== "then") return () => self;
      const source = tables[table];
      if (source && !Array.isArray(source)) return (resolve) => resolve({ data: source, error: null });
      if (table === "member_messages") reads.push(probe ? "probe" : "window");
      if (table === "member_messages" && (probe ? failProbe : failRead)) return (resolve) => resolve({ data: null, error: { message: "refused" } });
      if (table === "member_messages" && probe && hangProbe) return () => {};
      const sorted = (source || []).filter((row) => filters.every((keep) => keep(row)))
        .sort((left, right) => orders.reduce((found, [column, way]) => found || way * compare(left[column], right[column]), 0));
      return (resolve) => resolve({ data: postgrestPage(sorted, limit), error: null });
    } });
    return self;
  };
  return { client: { from, rpc: () => Promise.resolve({ data: null, error: null }) }, reads };
}
async function load(rows, options) {
  const { client, reads } = memberClient(rows, options);
  const app = await loadMemberApp(client, { id: "user-1", email: "proof@example.invalid" });
  return { thread: app.conversations[0], threads: app.conversations, reads };
}

describe("the member load's private messages", () => {
  afterEach(() => { vi.restoreAllMocks(); cleanup(); });

  it("shows the newest 1,000 of 1,001 with a marker, and exactly 1,000 with none", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const over = await load(range(1_001));
    expect(over.thread.messages.at(-1).id).toBe("m-01000");
    expect(over.thread.messages.map((row) => row.id)).toEqual(range(1_001).slice(1).map((row) => row.id));
    expect(over.thread.earlierCursor).toEqual({ createdAt: at(1), id: "m-00001" });
    const all = await load(range(1_000));
    expect(all.thread.messages.map((row) => row.id)).toEqual(range(1_000).map((row) => row.id));
    expect(all.thread.earlierCursor).toBeNull();
    expect(all.reads).toEqual(["window", "probe"]);
  });

  it("probes only a full answer; a failed probe shows the line; a failed read stays a load error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const short = await load(range(999));
    expect([short.thread.messages.length, short.thread.earlierCursor, short.reads]).toEqual([999, null, ["window"]]);
    const empty = await load([]);
    expect([empty.thread.messages, empty.thread.earlierCursor, empty.reads]).toEqual([[], null, ["window"]]);
    const unsure = await load(range(1_000), { failProbe: true });
    expect([unsure.thread.messages.length, unsure.thread.earlierCursor]).toEqual([1_000, { createdAt: at(0), id: "m-00000" }]);
    const thrown = await conversationsWithOlderMessages({ from: () => { throw new Error("offline"); } }, "user-1", ["conversation-1"], unsure.thread.earlierCursor);
    expect([...thrown]).toEqual(["conversation-1"]);
    await expect(load(range(5), { failRead: true })).rejects.toThrow();
  });

  it("shows a full window without waiting on a probe that never answers, and says older may exist", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    const hung = await load(range(1_000), { hangProbe: true });
    expect(hung.thread.messages.map((row) => row.id)).toEqual(range(1_000).map((row) => row.id));
    expect([hung.thread.earlierCursor, hung.reads]).toEqual([{ createdAt: at(0), id: "m-00000" }, ["window", "probe"]]);
    expect(Date.now() - started).toBeLessThan(OLDER_PROBE_DEADLINE_MS + 3_000);
    const { client } = memberClient(range(1_000), { hangProbe: true });
    const quick = await conversationsWithOlderMessages(client, "user-1", ["conversation-1"], { createdAt: at(0), id: "m-00000" }, { deadlineMs: 5 });
    expect([...quick]).toEqual(["conversation-1"]);
  });

  it("says more only past 1,000, keeps an appended reply newest, orders equal times", async () => {
    await expectNoSilentTruncation({ cap: PRIVATE_MESSAGE_WINDOW, read: async (total) => {
      const window = privateMessageWindow({ data: postgrestPage(range(total).reverse(), PRIVATE_MESSAGE_WINDOW), error: null });
      return { shown: window.data.length, more: window.earlierBefore !== null };
    }, exactAtCap: false }); // The window knows only that its answer was full; the probes decide.
    const appended = privateMessageWindow({ data: [...range(10).reverse(), message(2_000, { id: "m-reply" })], error: null });
    expect(appended.data.at(-1).id).toBe("m-reply");
    const z = "2026-09-01T12:00:00.000Z";
    const row = (id, created_at) => message(0, { id, created_at });
    const same = privateMessageWindow({ data: [row("b", z), row("a", "2026-09-01T12:00:00+00:00"), row("c", z), row("c", z)], error: null });
    expect(same.data.map((row) => row.id)).toEqual(["a", "b", "c", "c"]);
    expect(privateMessageWindow({ data: null, error: { message: "offline" } })).toMatchObject({ error: { message: "offline" }, earlierBefore: null });
    expect(privateMessageWindow(undefined)).toEqual({ earlierBefore: null });
  });

  it("marks only the conversations that lost rows, and dates an emptied one from its own row", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The oldest message is the only one in conversation-2; conversation-1 holds the newest 1,000.
    const rows = range(1_001).map((row, index) => (index === 0 ? { ...row, conversation_id: "conversation-2" } : row));
    const conversations = [conversation("conversation-1", at(5_000)), conversation("conversation-2", "2026-08-15T12:00:00.000Z")];
    const { threads, reads } = await load(rows, { conversations });
    const [kept, emptied] = ["conversation-1", "conversation-2"].map((id) => threads.find((thread) => thread.id === id));
    expect([kept.messages.length, kept.earlierCursor]).toEqual([1_000, null]);
    expect([emptied.messages.length, emptied.earlierCursor]).toEqual([0, { createdAt: at(1), id: "m-00001" }]);
    expect(emptied.dateLabel).toBe(conversationDateLabel("2026-08-15T12:00:00.000Z", "en"));
    expect(emptied.dateLabel).not.toBe(t("en", "data.now"));
    expect(reads).toEqual(["window", "probe", "probe"]);
  });

  it("checks at most six conversations at a time, and keeps the notice on any it did not finish by the deadline", async () => {
    // Each probe answers "no older message" after `delayMs`; the client counts probes in flight.
    const probing = (delayMs) => {
      const state = { inFlight: 0, most: 0, started: [], answered: [] };
      const from = () => {
        let conversationId;
        const self = new Proxy({}, { get: (_target, prop) => {
          if (prop === "eq") return (column, value) => { if (column === "conversation_id") conversationId = value; return self; };
          if (prop !== "then") return () => self;
          return (resolve) => {
            state.started.push(conversationId); state.inFlight += 1; state.most = Math.max(state.most, state.inFlight);
            setTimeout(() => { state.inFlight -= 1; state.answered.push(conversationId); resolve({ data: [], error: null }); }, delayMs);
          };
        } });
        return self;
      };
      return { client: { from }, state };
    };
    const ids = Array.from({ length: 40 }, (_unused, index) => `conversation-${index}`);
    const before = { createdAt: at(0), id: "m-00000" };
    const all = probing(2);
    expect(await conversationsWithOlderMessages(all.client, "user-1", ids, before)).toEqual(new Set());
    expect([all.state.started.length, all.state.most]).toEqual([40, OLDER_PROBE_CONCURRENCY]);
    const slow = probing(30);
    const flagged = await conversationsWithOlderMessages(slow.client, "user-1", ids, before, { deadlineMs: 70 });
    const answered = new Set(slow.state.answered);
    expect(slow.state.most).toBeLessThanOrEqual(OLDER_PROBE_CONCURRENCY);
    expect(slow.state.started.length).toBeLessThan(ids.length);
    expect([...flagged]).toEqual(ids.filter((id) => !answered.has(id)));
    expect(ids.filter((id) => !slow.state.started.includes(id)).every((id) => flagged.has(id))).toBe(true);
  });

  it.each(["en", "es"])("says in %s that older messages may not show, only when they may", (lang) => {
    window.history.replaceState({}, "", "/m/messages?conversation=conversation-1");
    const show = (earlierCursor) => render(
      <LanguageProvider lang={lang}>
        <MessagesView data={{ member: { id: "user-1" }, conversations: [{ id: "conversation-1", sender: "Chapter Steward", initials: "CS", unread: 0, messages: [message(2)], earlierCursor }], broadcasts: [], product: { spaces: [], documents: [] } }}
          desktop onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />
      </LanguageProvider>,
    );
    show({ createdAt: at(2), id: "m-00002" });
    expect(screen.getByText(t(lang, "inbox.olderNotShown"))).toBeInTheDocument();
    cleanup();
    show(null);
    expect(screen.queryByText(t(lang, "inbox.olderNotShown"))).toBeNull();
    window.history.replaceState({}, "", "/");
  });
});
