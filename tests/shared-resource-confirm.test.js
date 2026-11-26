// @vitest-environment node
// BUG-UG-WEB-SHARED-RESOURCE-VANISHES-FROM-THREAD-20261003: a shared
// resource never reached app data or the member loader, so leaving the thread
// and coming back (or any projection) lost it until a reload.
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { confirmSharedResource, shareAndConfirmResource, sharedResourceRows } from "../src/features/messaging/sharedResourceConfirm.js";

let loader = null;
afterEach(() => { loader?.dispose(); loader = null; });

function harness() {
  const tables = {
    member_conversations: [{ id: "conv-1", title: "Chapter steward", initials: "CS", counterpart_role: "steward", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-12T10:00:00Z" }],
    member_messages: [{ id: "m1", conversation_id: "conv-1", sender_kind: "steward", sender_name: "Chapter steward", body: "Hello", created_at: "2026-07-12T10:00:00Z", read_at: null }],
    chapter_documents: [{ id: "doc-1", title: "Overtime policy", document_type: "policy", status: "published" }],
  };
  const client = {
    from(table) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => Promise.resolve({ data: structuredClone(tables[table] ?? []), error: null }).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  loader = createMemberSessionLoader(client, { id: "member-1" });
  return tables;
}

const conversation = (projection) => projection.conversations.find((item) => item.id === "conv-1");

it("a later projection still carries the shared message and its resource once the share is confirmed", async () => {
  const tables = harness();
  expect(conversation(await loader.loadRoute("messages")).messages.map((message) => message.id)).toEqual(["m1"]);
  const rows = sharedResourceRows({ messageId: "shared-1", conversationId: "conv-1", userId: "member-1", senderName: "Member", body: "", documentId: "doc-1", createdAt: "2026-07-12T11:00:00Z" });
  expect(rows.message.body).toBe("Shared resource");
  // send_member_resource wrote both rows.
  tables.member_messages.push(rows.message);
  tables.member_message_resources = [{ id: "link-1", message_id: "shared-1", document_id: "doc-1", created_at: "2026-07-12T11:00:00Z" }];
  // Unconfirmed, the loader keeps serving the thread from before the share.
  expect(conversation(await loader.loadRoute("messages")).messages.map((message) => message.id)).toEqual(["m1"]);
  confirmSharedResource(loader, rows);
  const shared = conversation(await loader.loadRoute("messages")).messages.find((message) => message.id === "shared-1");
  expect(shared).toMatchObject({ body: "Shared resource", resource: { documentId: "doc-1", title: "Overtime policy", documentType: "policy" } });
});

it("the App's share sends, patches the open conversation and survives a later projection (behaviour)", async () => {
  const tables = harness();
  let appData = { conversations: [{ id: "conv-1", preview: "Hello", messages: [{ id: "m1", body: "Hello" }] }, { id: "conv-2", messages: [] }] };
  const patchConversation = (id, fn) => { appData = { ...appData, conversations: appData.conversations.map((item) => item.id === id ? fn(item) : item) }; };
  await loader.loadRoute("messages");
  const send = async (conversationId, documentId) => {
    // The server writes both rows, as send_member_resource does.
    tables.member_messages.push({ id: "shared-9", conversation_id: conversationId, sender_kind: "member", sender_name: "Member", body: "Shared resource", created_at: "2026-07-12T11:00:00Z", read_at: null });
    tables.member_message_resources = [{ id: "link-9", message_id: "shared-9", document_id: documentId, created_at: "2026-07-12T11:00:00Z" }];
    return { messageId: "shared-9", documentId };
  };
  const result = await shareAndConfirmResource({
    send, loader, patchConversation, userId: "member-1", senderName: "Member Voice",
    documents: [{ id: "doc-1", title: "Overtime policy", document_type: "policy" }], formatDate: () => "Jul 12",
  }, "conv-1", "doc-1", "");
  expect(result).toEqual({ messageId: "shared-9", documentId: "doc-1" });
  // The open conversation (and only it) carries the share at once.
  const open = appData.conversations.find((item) => item.id === "conv-1");
  expect(open.messages.map((message) => message.id)).toEqual(["m1", "shared-9"]);
  expect(open.messages[1].resource).toMatchObject({ documentId: "doc-1", title: "Overtime policy", documentType: "policy" });
  expect(open).toMatchObject({ preview: "Shared resource", dateLabel: "Jul 12" });
  expect(appData.conversations.find((item) => item.id === "conv-2").messages).toEqual([]);
  // Leaving and coming back reads a fresh projection, which still carries it.
  const shared = conversation(await loader.loadRoute("messages")).messages.find((message) => message.id === "shared-9");
  expect(shared).toMatchObject({ resource: { documentId: "doc-1", title: "Overtime policy" } });
});

it("changes nothing when the share returns no message", async () => {
  harness();
  let patched = false;
  const result = await shareAndConfirmResource({ send: async () => null, loader, patchConversation: () => { patched = true; }, userId: "member-1", senderName: "", documents: [], formatDate: String }, "conv-1", "doc-1", "");
  expect(result).toBeNull();
  expect(patched).toBe(false);
});

it("the App's member messaging api routes sendResource through that share (source check)", () => {
  const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const api = source.slice(source.indexOf("const sessionMessagingApi = {"));
  expect(api.slice(0, api.indexOf("loadTaskLanding:"))).toMatch(/sendResource: \(conversationId, documentId, body\) => memberOperation\.run\(\(\) => shareAndConfirmResource\(\{/);
});

it("builds rows with the member's own text and a fallback sender, and does nothing without a loader", () => {
  const rows = sharedResourceRows({ messageId: "shared-2", conversationId: "conv-1", userId: "member-1", senderName: "", body: "  Please read section 4  ", documentId: "doc-1", createdAt: "2026-07-12T12:00:00Z" });
  expect(rows.message).toMatchObject({ body: "Please read section 4", sender_name: "Member", sender_kind: "member", read_at: null });
  expect(rows.link).toEqual({ id: "confirmed-resource-shared-2", message_id: "shared-2", document_id: "doc-1", created_at: "2026-07-12T12:00:00Z" });
  expect(() => confirmSharedResource(null, rows)).not.toThrow();
  const calls = [];
  confirmSharedResource({ confirmRows: (resource, apply) => calls.push([resource, apply([{ id: "shared-2" }, { id: "other", message_id: "x" }])]) }, rows);
  expect(calls.map(([resource]) => resource)).toEqual(["table:member_messages", "table:member_message_resources"]);
  expect(calls[0][1].filter((row) => row.id === "shared-2")).toHaveLength(1);
});
