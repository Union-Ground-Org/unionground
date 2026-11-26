// BUG-UG-STAFF-BOOT-LOAD-SLOW-RECORDS-AND-REACTIONS-READS-20261106 (#7210)
// The web boot read every reaction the caller could see (no filter, cut at
// PostgREST's 1,000 rows); at 1,000 accounts that one read took 5-6 s. It now
// asks public.list_member_message_reactions for the reactions on exactly the
// member messages, channel posts and task messages the same load read.
import { describe, expect, it } from "vitest";
import { loadMemberApp } from "../src/lib/memberApi.js";

const PROFILE = {
  id: "member-1",
  first_name: "Darnell",
  full_name: "Darnell Foster",
  initials: "DF",
  role_line: "Member",
  member_since: 2023,
  language: "en",
  chapter_id: "chapter-1",
};

function client(tables = {}, reactions = []) {
  const reads = [];
  const rpcs = [];
  const respond = (resource) => resource === "table:member_profiles" ? { data: PROFILE, error: null }
    : resource === "rpc:get_member_rewards_summary" ? { data: {}, error: null }
      : resource === "rpc:list_member_message_reactions" ? { data: reactions, error: null }
        : { data: resource.startsWith("rpc:") ? null : structuredClone(tables[resource.slice(6)] ?? []), error: null };
  return {
    reads,
    rpcs,
    from(table) {
      let proxy;
      proxy = new Proxy(function query() {}, {
        get(_target, property) {
          if (property === "then") {
            reads.push(table);
            const promise = Promise.resolve(respond(`table:${table}`));
            return promise.then.bind(promise);
          }
          return () => proxy;
        },
      });
      return proxy;
    },
    rpc(name, args) {
      rpcs.push({ name, args });
      return Promise.resolve(respond(`rpc:${name}`));
    },
  };
}

const NOW_MS = Date.UTC(2026, 10, 6, 18);
const MEMBER = { id: "member-1", email: "member@example.test" };
const at = new Date(NOW_MS - 3_600_000).toISOString();

describe("member boot reactions read (#7210)", () => {
  it("reads only the reactions on the messages, posts and task messages the load shows", async () => {
    const reaction = {
      id: "reaction-1", actor_id: "member-2", source_kind: "private", private_message_id: "message-1",
      channel_post_id: null, task_message_id: null, reaction: "support", created_at: at,
    };
    const backend = client({
      member_conversations: [{ id: "conversation-1", user_id: "member-1", title: "Chapter steward", updated_at: at }],
      member_messages: [
        { id: "message-1", conversation_id: "conversation-1", user_id: "member-1", sender_kind: "member", sender_name: "Darnell", body: "Hello", created_at: at },
        { id: "message-2", conversation_id: "conversation-1", user_id: "member-1", sender_kind: "steward", sender_name: "Steward", body: "Hi", created_at: at },
      ],
      chapter_thread_posts: [{ id: "post-1", thread_id: "thread-1", chapter_id: "chapter-1", body: "Post", created_at: at }],
      chapter_task_messages: [{ id: "task-message-1", task_id: "task-1", chapter_id: "chapter-1", sender_id: "member-1", recipient_id: "member-2", body: "Note", created_at: at }],
    }, [reaction]);
    const projection = await loadMemberApp(backend, MEMBER, { nowMs: NOW_MS });
    expect(backend.reads).not.toContain("member_message_reactions");
    expect(backend.rpcs.filter((call) => call.name === "list_member_message_reactions")).toEqual([{
      name: "list_member_message_reactions",
      args: {
        p_private_message_ids: ["message-1", "message-2"],
        p_channel_post_ids: ["post-1"],
        p_task_message_ids: ["task-message-1"],
      },
    }]);
    const messages = projection.conversations.flatMap((conversation) => conversation.messages ?? []);
    expect(messages.find((message) => message.id === "message-1").reactions).toEqual([reaction]);
    expect(messages.find((message) => message.id === "message-2").reactions).toEqual([]);
  });

  it("makes no reactions request when the load shows no messages", async () => {
    const backend = client();
    await loadMemberApp(backend, MEMBER, { nowMs: NOW_MS });
    expect(backend.reads).not.toContain("member_message_reactions");
    expect(backend.rpcs.map((call) => call.name)).not.toContain("list_member_message_reactions");
  });
});
