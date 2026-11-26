// Authorized exact-source hydration for links that name one message
// (REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928).
//
// A link (`?conversation=<id>&message=<id>` in Messages, `?thread=<id>&message=<id>`
// on the steward desk, `?taskThread=<id>&message=<id>` for a task conversation,
// `?thread=<id>&post=<id>` for a channel post) can name a conversation, thread or
// task the loaded lists do not carry, or a message older than the window a view
// loaded (the boot snapshot holds the newest 500 tasks, 200 channel threads and a
// bounded slice of messages, so absence from it proves nothing). The views used to
// leave that case where it was; this module reads exactly that source instead,
// under the caller's own row security, and returns only what a view needs to
// show it. Nothing here writes, and nothing here grants access: a row the caller
// may not read comes back as "unavailable", the same answer as one that never
// existed. No title or preview is ever built from message text.
import { t as translate } from "../../lib/i18n.js";
import { earlierPageMarks } from "../messaging/earlierMarks.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A conversation-only link has no message to anchor on, so the member inbox gets
// a bounded newest window to make the landed thread readable. The steward dialog
// pages its own history and needs only the thread row.
const CONVERSATION_WINDOW = 30;
// Every landing read is bounded: a caller may ask for a smaller window (0 for the
// exact row alone), never a larger one.
const WINDOW_CEILING = 50;

const PERMISSION_CODES = new Set(["42501", "not_authorized"]);
const GONE_CODES = new Set(["source_unavailable", "scope_changed", "task_unavailable", "not_found", "PGRST116"]);

/** The caller lost the role or the session that authorized the action (Postgres 42501, a facade `not_authorized`, or HTTP 403). */
export function isPermissionRefusal(error) {
  return PERMISSION_CODES.has(error?.code) || error?.status === 403;
}

/** The record is gone or out of the caller's scope (a facade `source_unavailable`/`scope_changed`, or HTTP 404). */
export function isSourceGone(error) {
  return GONE_CODES.has(error?.code) || error?.status === 404;
}

/**
 * Puts hydrated rows into a thread's visible history, in chronological position
 * (`timeKey` names the timestamp: `created_at` for private messages and channel
 * posts, `createdAt` for task messages), without touching anything that paged in.
 * Returns the SAME array when nothing new is added, so a memo keyed on the result
 * stays stable and a later page that carries the same row dedupes without a flash.
 */
export function mergeLandedRows(rows, extras, { timeKey = "created_at" } = {}) {
  const base = rows || [];
  const known = new Set(base.map((row) => row.id));
  const additions = [];
  for (const row of extras || []) {
    if (!row?.id || known.has(row.id)) continue;
    known.add(row.id);
    additions.push(row);
  }
  if (!additions.length) return base;
  return [...base, ...additions].sort((a, b) => String(a[timeKey] ?? "").localeCompare(String(b[timeKey] ?? "")) || String(a.id).localeCompare(String(b.id)));
}

/** One hydrated message into a thread's history; see mergeLandedRows. */
export function mergeLandedMessage(messages, message) {
  return mergeLandedRows(messages, message ? [message] : []);
}

/**
 * A hydrated copy is a snapshot the loader's own tombstone pass never sees, so a
 * confirmed removal has to be applied to it here. Without this a re-merge (any
 * refresh of the surrounding data) would put the original text of a message the
 * member just removed back on screen; the body of a removed message exists
 * nowhere (SEC-UG-MESSAGE-BODY-LIFECYCLE), and a projection must not
 * restore it. Mirrors what applyMessageTombstone does to a loaded row.
 *
 * @param {{ message?: object|null, conversation?: {messages?: object[]}|null }} landed
 * @param {Array<{ id: string, redacted_at?: string|null }>} tombstones
 */
export function applyTombstonesToLanded(landed, tombstones) {
  const removed = new Map((tombstones || []).filter((row) => row?.id && row.redacted_at).map((row) => [row.id, row]));
  if (!landed || !removed.size) return landed;
  const redact = (row) => (row && removed.has(row.id) ? { ...row, ...removed.get(row.id), body: "" } : row);
  return {
    ...landed,
    message: redact(landed.message ?? null),
    conversation: landed.conversation ? { ...landed.conversation, messages: (landed.conversation.messages || []).map(redact) } : null,
  };
}

function idOf(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return UUID.test(text) ? text : null;
}

async function readContext(client, id, kind = "private_message") {
  const { data, error } = await client.rpc("get_connected_workflow_context", {
    p_kind: kind,
    p_id: id,
    p_chapter_id: null,
    p_organization_id: null,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

// The shared connected-workflow facade's `context({ kind, id })` may be supplied;
// the default asks the RPC directly. Either way the answer is the server's.
function askContext(client, context, kind, id) {
  return typeof context === "function" ? context({ kind, id }) : readContext(client, id, kind);
}

function windowOf(value) {
  const size = value == null ? CONVERSATION_WINDOW : Math.trunc(Number(value));
  return Number.isFinite(size) ? Math.max(0, Math.min(WINDOW_CEILING, size)) : CONVERSATION_WINDOW;
}

// Additive: a failed reactions read leaves the message readable with none shown.
async function readReactions(client, id) {
  try {
    const { data, error } = await client
      .from("member_message_reactions")
      .select("id,actor_id,source_kind,private_message_id,reaction,created_at")
      .eq("private_message_id", id);
    return error ? [] : (data || []);
  } catch {
    return [];
  }
}

// Ledger 780: a linked message or post shows the viewer's own saved mark,
// pending reminder and (private) shared document, read as an earlier page reads
// them (messaging/earlierMarks.js). That read never rejects: a failed one
// leaves the marks absent, as before.
async function withMarks(client, sourceKind, userId, rows) {
  const marksFor = await earlierPageMarks(client, { sourceKind, userId, ids: rows.map((row) => row.id) });
  return rows.map((row) => ({ ...row, ...marksFor(row.id) }));
}

// The wire shape both message renderers already read (snake_case), plus the
// tombstone fields. `user_id` and every other column stay behind.
function messageProjection(row, reactions = []) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_kind: row.sender_kind,
    sender_name: row.sender_name,
    body: row.body,
    created_at: row.created_at,
    read_at: row.read_at ?? null,
    redacted_at: row.redacted_at ?? null,
    redaction_reason: row.redaction_reason ?? null,
    edited_at: row.edited_at ?? null,
    reactions,
    saved: false,
    reminder: null,
    resource: null,
  };
}

/**
 * Reads one private message (and its conversation) a link names.
 *
 * Order matters: the connected-workflow context is re-asked first, so a removed,
 * out-of-scope or never-existing message is refused with the same answer before
 * any row is read; the exact rows are then read under row security. A member
 * reader is additionally pinned to their own `user_id` on both reads (a steward
 * account has permissive read policies the member surface must never inherit);
 * a staff reader relies on the staff read scope RLS already applies.
 *
 * @param {object} client a Supabase client for the signed-in reader
 * @param {{ messageId?: string|null, conversationId?: string|null }} ref
 * @param {{ userId?: string|null, staff?: boolean, lang?: string,
 *           context?: (ref: {kind: string, id: string}) => Promise<{available?: boolean}> }} [options]
 *   `context` may be the shared connected-workflow facade's `context`; the
 *   default asks `get_connected_workflow_context` directly.
 * @returns {Promise<null | { conversation: object|null, thread: object|null, message: object|null }>}
 *   null means unavailable (removed, unauthorized, malformed link, or wrong
 *   conversation); a transport failure rejects so the caller can offer a retry.
 *   A member reader gets `conversation`, a staff reader gets `thread`; the other
 *   projection is null. No title or preview carries any message text.
 */
export async function loadPrivateMessageLanding(client, ref = {}, options = {}) {
  const { userId = null, staff = false, context = null, lang = "en" } = options;
  const messageId = ref.messageId ? idOf(ref.messageId) : null;
  const conversationId = ref.conversationId ? idOf(ref.conversationId) : null;
  if ((ref.messageId && !messageId) || (ref.conversationId && !conversationId) || (!messageId && !conversationId)) return null;
  const reader = staff ? null : idOf(userId);
  // A member landing is pinned to the reader's own rows; without an identity to
  // pin to there is nothing safe to read.
  if (!staff && !reader) return null;

  let row = null;
  if (messageId) {
    const known = await askContext(client, context, "private_message", messageId);
    if (!known?.available) return null;

    let query = client.from("member_messages").select("*").eq("id", messageId);
    if (conversationId) query = query.eq("conversation_id", conversationId);
    if (!staff) query = query.eq("user_id", reader);
    const read = await query.maybeSingle();
    if (read.error) throw read.error;
    row = read.data;
    if (!row) return null;
    if (!staff && String(row.user_id).toLowerCase() !== reader) return null;
  }

  const targetConversation = row ? row.conversation_id : conversationId;
  let conversationQuery = client.from("member_conversations").select("*").eq("id", targetConversation);
  if (!staff) conversationQuery = conversationQuery.eq("user_id", reader);
  const conversationRead = await conversationQuery.maybeSingle();
  if (conversationRead.error) throw conversationRead.error;
  const record = conversationRead.data;
  if (!record) return null;

  const viewer = idOf(userId);
  const [message = null] = row ? await withMarks(client, "private", viewer, [messageProjection(row, await readReactions(client, row.id))]) : [];

  if (staff) {
    // The steward desk names a member by their profile; a failed or empty read
    // falls back to the desk's own placeholder rather than leaving the thread unopenable.
    let profile = null;
    try {
      const read = await client.from("member_profiles").select("id,full_name,initials").eq("id", record.user_id).maybeSingle();
      if (!read.error) profile = read.data;
    } catch {
      // A failed profile read keeps the placeholder name below.
    }
    return {
      conversation: null,
      thread: {
        id: record.id,
        memberName: profile?.full_name || "Member",
        memberInitials: profile?.initials || record.initials || "M",
        preview: "",
        updatedAt: record.updated_at,
        awaitingReply: false,
        messageCount: 0,
      },
      message,
    };
  }

  let messages = message ? [message] : [];
  if (!message) {
    const window = await client
      .from("member_messages")
      .select("*")
      .eq("conversation_id", record.id)
      .eq("user_id", reader)
      .order("created_at", { ascending: false })
      .limit(CONVERSATION_WINDOW);
    if (window.error) throw window.error;
    messages = await withMarks(client, "private", viewer, [...(window.data || [])].reverse().map((item) => messageProjection(item)));
  }
  return {
    conversation: {
      id: record.id,
      counterpartRole: "steward",
      stewardUserId: record.steward_user_id ?? null,
      // The default thread title is the one string the member loader localizes.
      sender: record.title === "Chapter steward" ? translate(lang, "inbox.chapterSteward") : record.title,
      initials: record.initials || "CS",
      preview: "",
      dateLabel: "",
      unread: 0,
      messages,
      scheduled: [],
    },
    thread: null,
    message,
  };
}

// ---------------------------------------------------------------------------
// Task conversations
// ---------------------------------------------------------------------------

const TASK_MESSAGE_COLUMNS = "id,task_id,chapter_id,sender_id,recipient_id,body,created_at";

// The projection MessagesView already reads for task messages (camelCase).
function taskMessageProjection(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    chapterId: row.chapter_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * Reads one task conversation, and the task message a link names, for a
 * participant. The board's initial window (the newest 500 tasks, and a bounded
 * slice of task messages) proves nothing about a task or message outside it, so a
 * link is not judged absent from that snapshot: this asks the server.
 *
 * Task messages are participant-only, so every read is pinned to messages the
 * reader sent or received (row security decides too); without a reader identity
 * there is nothing safe to pin to and the answer is unavailable. The
 * connected-workflow context is re-asked first (`task_message` for a named
 * message, `task` otherwise). The task comes back as a minimal projection (its
 * own title, never text drawn from a message).
 *
 * @param {object} client a Supabase client for the signed-in reader
 * @param {{ taskId: string, messageId?: string|null, window?: number }} ref
 *   `window` is how many of the newest messages to include (default 30, at most
 *   50; 0 returns only the named message).
 * @param {{ userId: string, context?: (ref: {kind: string, id: string}) => Promise<{available?: boolean}> }} options
 * @returns {Promise<null | { task: { id: string, chapterId: string, taskNumber: number|null, title: string, status: string },
 *                            messages: Array<{ id: string, taskId: string, chapterId: string, senderId: string, recipientId: string, body: string, createdAt: string }> }>}
 *   null means unavailable (removed, unauthorized, not a participant, malformed
 *   link); a transport failure rejects so the caller can offer a retry.
 */
export async function loadTaskConversationLanding(client, ref = {}, options = {}) {
  const { userId = null, context = null } = options;
  const taskId = idOf(ref.taskId);
  const messageId = ref.messageId ? idOf(ref.messageId) : null;
  if (!taskId || (ref.messageId && !messageId)) return null;
  const reader = idOf(userId);
  if (!reader) return null;

  const known = await askContext(client, context, messageId ? "task_message" : "task", messageId ?? taskId);
  if (!known?.available) return null;

  // `reader` is a validated uuid, so it can sit in the filter string.
  const participant = `sender_id.eq.${reader},recipient_id.eq.${reader}`;
  let exact = null;
  if (messageId) {
    const read = await client.from("chapter_task_messages").select(TASK_MESSAGE_COLUMNS)
      .eq("id", messageId).eq("task_id", taskId).or(participant).maybeSingle();
    if (read.error) throw read.error;
    exact = read.data;
    if (!exact) return null;
  }

  const taskRead = await client.from("chapter_tasks").select("id,chapter_id,task_number,title,status").eq("id", taskId).maybeSingle();
  if (taskRead.error) throw taskRead.error;
  const task = taskRead.data;
  if (!task) return null;

  const size = windowOf(ref.window);
  let recent = [];
  if (size > 0) {
    const page = await client.from("chapter_task_messages").select(TASK_MESSAGE_COLUMNS)
      .eq("task_id", taskId).or(participant).order("created_at", { ascending: false }).limit(size);
    if (page.error) throw page.error;
    recent = [...(page.data || [])].reverse();
  }
  return {
    task: { id: task.id, chapterId: task.chapter_id, taskNumber: task.task_number ?? null, title: task.title, status: task.status },
    messages: mergeLandedRows(recent.map(taskMessageProjection), exact ? [taskMessageProjection(exact)] : [], { timeKey: "createdAt" }),
  };
}

// ---------------------------------------------------------------------------
// Channel threads
// ---------------------------------------------------------------------------

// Additive, like the private reactions read.
async function readChannelReactions(client, id) {
  try {
    const { data, error } = await client
      .from("member_message_reactions")
      .select("id,actor_id,source_kind,channel_post_id,reaction,created_at")
      .eq("channel_post_id", id);
    return error ? [] : (data || []);
  } catch {
    return [];
  }
}

// The row shape the hub's thread dialog reads, plus the fields its message
// actions expect. Channel posts are immutable, so there is no tombstone here.
export function postProjection(row, reactions = []) {
  return {
    id: row.id,
    thread_id: row.thread_id,
    author_id: row.author_id,
    body: row.body,
    // The post's Spanish version, shown to Spanish readers (bilingualContent.js).
    body_es: row.body_es ?? null,
    parent_post_id: row.parent_post_id ?? null,
    created_at: row.created_at,
    edited_at: row.edited_at ?? null,
    deleted_at: null,
    reactions,
    saved: false,
    reminder: null,
  };
}

/**
 * Reads one channel thread, and the post a link names, under the caller's own row
 * security. The hub's snapshot holds the newest 200 threads and the newest 999
 * posts overall, so a thread or post outside it is not absent, only unloaded.
 *
 * A named post is re-authorized first (`channel_post` context), then read with
 * its thread; a post that was deleted, or that does not belong to a named thread,
 * is unavailable. A thread-only link reads the thread and its newest window
 * (channel space membership is what row security enforces; there is no per-user
 * pin because a channel is shared).
 *
 * @param {object} client a Supabase client for the signed-in reader
 * @param {{ threadId?: string|null, postId?: string|null, window?: number }} ref
 *   `window` is how many of the newest posts to include in `thread.posts`
 *   (default 30, at most 50; 0 when the caller already holds the thread and needs
 *   only the named post).
 * @param {{ context?: (ref: {kind: string, id: string}) => Promise<{available?: boolean}> }} [options]
 * @returns {Promise<null | { thread: { id: string, space_id: string, title: string, kind: string, status: string,
 *                                       created_at: string, updated_at: string, unreadCount: number, posts: object[] },
 *                            post: object|null }>}
 *   null means unavailable; a transport failure rejects. Titles come from the
 *   thread's own row; no post text is used for any title or preview.
 */
export async function loadChannelThreadLanding(client, ref = {}, options = {}) {
  const { context = null, userId = null } = options;
  const threadId = ref.threadId ? idOf(ref.threadId) : null;
  const postId = ref.postId ? idOf(ref.postId) : null;
  if ((ref.threadId && !threadId) || (ref.postId && !postId) || (!threadId && !postId)) return null;

  let row = null;
  if (postId) {
    const known = await askContext(client, context, "channel_post", postId);
    if (!known?.available) return null;
    let query = client.from("chapter_thread_posts").select("*").eq("id", postId).is("deleted_at", null);
    if (threadId) query = query.eq("thread_id", threadId);
    const read = await query.maybeSingle();
    if (read.error) throw read.error;
    row = read.data;
    if (!row) return null;
  }

  const threadRead = await client.from("chapter_threads").select("*").eq("id", row ? row.thread_id : threadId).maybeSingle();
  if (threadRead.error) throw threadRead.error;
  const thread = threadRead.data;
  if (!thread) return null;

  const size = windowOf(ref.window);
  let recent = [];
  if (size > 0) {
    const page = await client.from("chapter_thread_posts").select("*")
      .eq("thread_id", thread.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(size);
    if (page.error) throw page.error;
    recent = [...(page.data || [])].reverse();
  }
  const reader = idOf(userId);
  const [post = null] = row ? await withMarks(client, "channel", reader, [postProjection(row, await readChannelReactions(client, row.id))]) : [];
  const recentPosts = await withMarks(client, "channel", reader, recent.map((item) => postProjection(item)));
  return {
    thread: {
      id: thread.id,
      space_id: thread.space_id,
      title: thread.title,
      kind: thread.kind,
      status: thread.status,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      unreadCount: 0,
      posts: mergeLandedRows(recentPosts, post ? [post] : []),
    },
    post,
  };
}
