// The conformance matrix both clients run.
//
// TEST-UG-SHARED-UNREAD-CONTRACT-20260904 asks for one fixture matrix that
// responsive web and the Expo app both pass. Rather than duplicating cases in
// two test files that can drift, the cases live here as data and a single
// runner evaluates them; the web suite and the mobile suite each import the
// runner. A case added here is immediately binding on both clients.

import {
  channelUnreadCount,
  countUnreadInboxItems,
  directUnreadCount,
  inboxUnreadCount,
  isAnnouncementUnread,
  isChannelPostUnread,
  isDirectMessageUnread,
  isTaskMessageUnread,
  taskUnreadCount,
} from "./unread.js";

const CURSOR = "2026-09-01T12:00:00.000Z";

export const UNREAD_CONFORMANCE_CASES = Object.freeze([
  // --- direct -------------------------------------------------------------
  { name: "direct: inbound with no read_at is unread", op: "direct",
    input: { sender_kind: "steward", read_at: null }, expected: true },
  { name: "direct: inbound already read is read", op: "direct",
    input: { sender_kind: "steward", read_at: CURSOR }, expected: false },
  { name: "direct: the member's own message is never unread to the member", op: "direct",
    input: { sender_kind: "member", read_at: null }, expected: false },
  { name: "direct: a redacted inbound message stays unread", op: "direct",
    input: { sender_kind: "steward", read_at: null, redacted_at: CURSOR, body: "" }, expected: true },
  { name: "direct: a redacted message already read stays read", op: "direct",
    input: { sender_kind: "steward", read_at: CURSOR, redacted_at: CURSOR, body: "" }, expected: false },

  // --- channel ------------------------------------------------------------
  { name: "channel: a post after the cursor is unread", op: "channel",
    input: { post: { created_at: "2026-09-01T12:00:01.000Z" }, cursor: CURSOR }, expected: true },
  { name: "channel: a post exactly at the cursor is read", op: "channel",
    input: { post: { created_at: CURSOR }, cursor: CURSOR }, expected: false },
  { name: "channel: a post before the cursor is read", op: "channel",
    input: { post: { created_at: "2026-09-01T11:59:59.000Z" }, cursor: CURSOR }, expected: false },
  { name: "channel: a null cursor leaves every post unread", op: "channel",
    input: { post: { created_at: "2020-01-01T00:00:00.000Z" }, cursor: null }, expected: true },
  { name: "channel: an empty-string cursor behaves exactly like null", op: "channel",
    input: { post: { created_at: "2020-01-01T00:00:00.000Z" }, cursor: "" }, expected: true },
  { name: "channel: a camelCase createdAt is honoured", op: "channel",
    input: { post: { createdAt: "2026-09-01T12:00:01.000Z" }, cursor: CURSOR }, expected: true },
  { name: "channel: an unparseable post timestamp is read, never a stuck badge", op: "channel",
    input: { post: { created_at: "not-a-date" }, cursor: CURSOR }, expected: false },
  { name: "channel: a missing post timestamp is read", op: "channel",
    input: { post: {}, cursor: CURSOR }, expected: false },
  { name: "channel: an unparseable cursor is treated as nothing read", op: "channel",
    input: { post: { created_at: "2026-09-01T12:00:01.000Z" }, cursor: "not-a-date" }, expected: true },
  // BUG-UG-OWN-POSTS-COUNT-AS-UNREAD-20261111
  { name: "channel: the viewer's own post after the cursor is read", op: "channel",
    input: { post: { created_at: "2026-09-01T12:00:01.000Z", author_id: "me" }, cursor: CURSOR, viewerId: "me" }, expected: false },
  { name: "channel: the viewer's own post with no cursor is read", op: "channel",
    input: { post: { created_at: "2020-01-01T00:00:00.000Z", author_id: "me" }, cursor: null, viewerId: "me" }, expected: false },
  { name: "channel: a projected message marked mine is read", op: "channel",
    input: { post: { createdAt: "2026-09-01T12:00:01.000Z", mine: true }, cursor: CURSOR }, expected: false },
  { name: "channel: another person's post after the cursor stays unread", op: "channel",
    input: { post: { created_at: "2026-09-01T12:00:01.000Z", author_id: "peer" }, cursor: CURSOR, viewerId: "me" }, expected: true },
  { name: "channel: a camelCase authorId of the viewer is read", op: "channel",
    input: { post: { createdAt: "2026-09-01T12:00:01.000Z", authorId: "me" }, cursor: CURSOR, viewerId: "me" }, expected: false },
  { name: "channel: a post with no author keeps the cursor rule for a viewer", op: "channel",
    input: { post: { created_at: "2026-09-01T12:00:01.000Z" }, cursor: CURSOR, viewerId: "me" }, expected: true },
  { name: "channel: with no viewer an authored post keeps the cursor rule", op: "channel",
    input: { post: { created_at: "2026-09-01T12:00:01.000Z", author_id: "me" }, cursor: CURSOR }, expected: true },

  // --- task ---------------------------------------------------------------
  { name: "task: an unread inbound task message is unread", op: "task",
    input: { message: { sender_id: "other", read_at: null }, viewer: "me" }, expected: true },
  { name: "task: the viewer's own task message is never unread", op: "task",
    input: { message: { sender_id: "me", read_at: null }, viewer: "me" }, expected: false },
  { name: "task: a read task message is read", op: "task",
    input: { message: { sender_id: "other", read_at: CURSOR }, viewer: "me" }, expected: false },

  // --- announcement -------------------------------------------------------
  { name: "announcement: no receipt means unread", op: "announcement",
    input: { broadcast: { id: "b1" }, readIds: [] }, expected: true },
  { name: "announcement: a receipt means read", op: "announcement",
    input: { broadcast: { id: "b1" }, readIds: ["b1"] }, expected: false },

  // --- normalization ------------------------------------------------------
  { name: "normalize: saved rows never count, whatever the source says", op: "normalize",
    input: { type: "saved", value: 7 }, expected: 0 },
  { name: "normalize: reminder rows never count", op: "normalize",
    input: { type: "reminder", value: 3 }, expected: 0 },
  { name: "normalize: announcements are binary, not counted", op: "normalize",
    input: { type: "announcement", value: true }, expected: 1 },
  { name: "normalize: a negative count clamps to zero", op: "normalize",
    input: { type: "direct", value: -4 }, expected: 0 },
  { name: "normalize: a fractional count truncates", op: "normalize",
    input: { type: "channel", value: 2.9 }, expected: 2 },
  { name: "normalize: a non-numeric count is zero", op: "normalize",
    input: { type: "direct", value: "many" }, expected: 0 },
  { name: "normalize: undefined is zero", op: "normalize",
    input: { type: "task", value: undefined }, expected: 0 },

  // --- aggregation --------------------------------------------------------
  { name: "count: direct thread with two inbound unread and one own message", op: "directCount",
    input: [
      { sender_kind: "steward", read_at: null },
      { sender_kind: "member", read_at: null },
      { sender_kind: "steward", read_at: null },
      { sender_kind: "steward", read_at: CURSOR },
    ], expected: 2 },
  { name: "count: channel posts around the cursor", op: "channelCount",
    input: { posts: [
      { created_at: "2026-09-01T11:00:00.000Z" },
      { created_at: CURSOR },
      { created_at: "2026-09-01T13:00:00.000Z" },
      { created_at: "2026-09-01T14:00:00.000Z" },
    ], cursor: CURSOR }, expected: 2 },
  { name: "count: a reply after reading counts only other people's newer posts", op: "channelCount",
    input: { posts: [
      { created_at: "2026-09-01T11:00:00.000Z", author_id: "peer" },
      { created_at: "2026-09-01T13:00:00.000Z", author_id: "me" },
      { created_at: "2026-09-01T14:00:00.000Z", author_id: "peer" },
    ], cursor: CURSOR, viewerId: "me" }, expected: 1 },
  { name: "count: task messages exclude the viewer's own", op: "taskCount",
    input: { messages: [
      { sender_id: "other", read_at: null },
      { sender_id: "me", read_at: null },
    ], viewer: "me" }, expected: 1 },
  { name: "inbox: only rows whose normalized count is positive are unread", op: "inbox",
    input: [
      { type: "direct", unread: 2 },
      { type: "saved", unread: 5 },
      { type: "reminder", unread: 1 },
      { type: "announcement", unread: true },
      { type: "channel", unread: 0 },
    ], expected: 2 },

  // --- reconnect reconciliation ------------------------------------------
  // A reconnect replays posts the client already had. With a `>` comparison the
  // count is the same before and after; with `>=` it would grow every time.
  { name: "reconnect: replaying the same page does not inflate the count", op: "channelCount",
    input: { posts: [
      { created_at: "2026-09-01T13:00:00.000Z" },
      { created_at: "2026-09-01T13:00:00.000Z" },
    ], cursor: "2026-09-01T13:00:00.000Z" }, expected: 0 },
]);

const OPERATIONS = Object.freeze({
  direct: (input) => isDirectMessageUnread(input),
  channel: (input) => isChannelPostUnread(input.post, input.cursor, input.viewerId ?? null),
  task: (input) => isTaskMessageUnread(input.message, input.viewer),
  announcement: (input) => isAnnouncementUnread(input.broadcast, input.readIds),
  normalize: (input) => inboxUnreadCount(input.type, input.value),
  directCount: (input) => directUnreadCount(input),
  channelCount: (input) => channelUnreadCount(input.posts, input.cursor, input.viewerId ?? null),
  taskCount: (input) => taskUnreadCount(input.messages, input.viewer),
  inbox: (input) => countUnreadInboxItems(input),
});

// Returns [] when the implementation conforms. Both client suites assert on
// exactly this, so a divergence is reported the same way in either place.
export function runUnreadConformance(cases = UNREAD_CONFORMANCE_CASES) {
  const failures = [];
  for (const entry of cases) {
    const operation = OPERATIONS[entry.op];
    if (!operation) {
      failures.push(`${entry.name}: unknown operation ${entry.op}`);
      continue;
    }
    const actual = operation(entry.input);
    if (actual !== entry.expected) {
      failures.push(`${entry.name}: expected ${JSON.stringify(entry.expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  return failures;
}
