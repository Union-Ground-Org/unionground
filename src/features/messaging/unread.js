// The canonical unread contract for every inbox content type.
//
// TEST-UG-SHARED-UNREAD-CONTRACT-20260904: responsive web and the Expo app
// each wrote their own unread comparisons — `sender_kind === "steward" && !read_at`
// in src/lib/memberApi.js, a near-identical copy in apps/mobile, a
// `postedAt > lastRead` cursor comparison in the native channel store, and a
// `Number(item.unreadCount || item.unread) || 0` coalesce in the web inbox view.
// Nothing kept them equal, so badges could disagree between a member's phone and
// their browser as messaging types and timestamp rules evolved.
//
// This module is the only place those predicates live. It changes no
// authorization: it decides what "unread" means for rows the caller is already
// allowed to see, nothing more.
//
// THE RULES, stated once:
//   direct        an inbound (steward-sent) message with no read_at
//   channel       a post strictly newer than the space read cursor, written
//                 by someone other than the viewer
//   task          an inbound task message with no read_at
//   announcement  a broadcast with no receipt — binary, not a count
//   saved         never unread; saving is a bookmark, not a delivery
//   reminder      never unread; a due reminder produces its own notification
//
// TIE-BREAKS, chosen deliberately and covered by the fixture matrix:
//   * A timestamp exactly equal to the read cursor is READ. Cursors are stamped
//     at the moment of reading, so `>=` would re-flag the message that caused
//     the stamp on every reconnect.
//   * An unparseable or missing timestamp is READ, never unread. A badge that
//     cannot be cleared is worse than one that never appears.
//   * A redacted message stays unread if it was unread: removal of content is
//     not the recipient having seen it.

export const INBOX_TYPES = Object.freeze([
  "direct",
  "channel",
  "task",
  "announcement",
  "saved",
  "reminder",
]);

export const INBOX_TYPES_WITH_COUNTS = Object.freeze(["direct", "channel", "task"]);

export function messageTimestamp(value) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// A cursor that cannot be parsed means "nothing has been read yet"; a null
// cursor means the same. Both must behave identically or a client that stores
// the cursor as an empty string diverges from one that stores null.
export function readCursor(value) {
  const parsed = messageTimestamp(value);
  return parsed == null ? Number.NEGATIVE_INFINITY : parsed;
}

export function isDirectMessageUnread(message) {
  if (!message) return false;
  return message.sender_kind === "steward" && !message.read_at;
}

export function isTaskMessageUnread(message, viewerId) {
  if (!message) return false;
  if (viewerId != null && message.sender_id === viewerId) return false;
  return !message.read_at;
}

// BUG-UG-OWN-POSTS-COUNT-AS-UNREAD-20261111: a person's own post is
// never unread for them. The cursor only moves when a space is opened, so a
// reply written after it was otherwise counted against its own author and put
// the thread under "Needs you". A row says it is the viewer's either by its
// author column (database rows) or by `mine` (the native message projection).
/**
 * @param {any} post
 * @param {string | null} [viewerId]
 * @returns {boolean}
 */
export function isOwnChannelPost(post, viewerId) {
  if (!post) return false;
  if (post.mine === true) return true;
  const author = post.author_id ?? post.authorId;
  return viewerId != null && author != null && author === viewerId;
}

/**
 * @param {any} post
 * @param {any} lastReadAt
 * @param {string | null} [viewerId]
 * @returns {boolean}
 */
export function isChannelPostUnread(post, lastReadAt, viewerId = null) {
  if (isOwnChannelPost(post, viewerId)) return false;
  const posted = messageTimestamp(post && (post.created_at ?? post.createdAt));
  if (posted == null) return false;
  return posted > readCursor(lastReadAt);
}

export function isAnnouncementUnread(broadcast, readIds) {
  if (!broadcast) return false;
  const ids = readIds instanceof Set ? readIds : new Set(readIds || []);
  return !ids.has(broadcast.id);
}

export function directUnreadCount(messages) {
  return (Array.isArray(messages) ? messages : []).filter(isDirectMessageUnread).length;
}

export function taskUnreadCount(messages, viewerId) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => isTaskMessageUnread(message, viewerId)).length;
}

/**
 * @param {any} posts
 * @param {any} lastReadAt
 * @param {string | null} [viewerId]
 * @returns {number}
 */
export function channelUnreadCount(posts, lastReadAt, viewerId = null) {
  const cursor = readCursor(lastReadAt);
  return (Array.isArray(posts) ? posts : [])
    .filter((post) => isChannelPostUnread(post, cursor, viewerId)).length;
}

// The single normalizer every inbox row goes through, on both clients. Saved
// and reminder rows are pinned to zero here rather than at each call site so a
// client cannot quietly start counting them.
export function inboxUnreadCount(type, value) {
  if (type === "saved" || type === "reminder") return 0;
  if (type === "announcement") return value ? 1 : 0;
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

export function isInboxItemUnread(item) {
  return inboxUnreadCount(item && item.type, item && item.unread) > 0;
}

export function countUnreadInboxItems(items) {
  return (Array.isArray(items) ? items : []).filter(isInboxItemUnread).length;
}
