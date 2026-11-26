// REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001.
//
// The old member home's override slot (de7df4b57c^:components/home/lib/
// load-member-home.ts loadConditionalGateOverrides): the newest unread steward
// direct message and the newest unread chapter broadcast sit at the top of
// Home until the member reads them. The live path reads
// public.get_member_home_takeover(), which enforces the organization switch.
// The fixture/preview path derives the same two items from data the member
// already holds. Pure functions only; native imports this module too.

export const HOME_TAKEOVER_SWITCH = "features.home.unread_message_takeover";
export const HOME_TAKEOVER_RPC = "get_member_home_takeover";
// Server preview bound (the RPC truncates at the same length).
export const HOME_TAKEOVER_PREVIEW_CHARS = 600;

const EMPTY = Object.freeze({ enabled: false, message: null, broadcast: null });

function text(value) {
  return typeof value === "string" ? value : "";
}

function preview(body) {
  const value = text(body);
  return value.length > HOME_TAKEOVER_PREVIEW_CHARS
    ? { body: value.slice(0, HOME_TAKEOVER_PREVIEW_CHARS), truncated: true }
    : { body: value, truncated: false };
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// Server payload -> the shape the cards render. Anything malformed is dropped
// rather than rendered half-way: a takeover is never better than no takeover.
export function normalizeHomeTakeover(payload) {
  if (!payload || typeof payload !== "object" || payload.enabled !== true) return EMPTY;
  const rawMessage = payload.message;
  const rawBroadcast = payload.broadcast;
  const message = rawMessage && typeof rawMessage === "object"
    && typeof rawMessage.id === "string" && typeof rawMessage.conversationId === "string"
    && text(rawMessage.body).trim() && isTimestamp(rawMessage.createdAt)
    ? {
        id: rawMessage.id,
        conversationId: rawMessage.conversationId,
        senderName: text(rawMessage.senderName).trim() || null,
        body: text(rawMessage.body),
        truncated: rawMessage.truncated === true,
        createdAt: rawMessage.createdAt,
      }
    : null;
  const broadcast = rawBroadcast && typeof rawBroadcast === "object"
    && typeof rawBroadcast.id === "string" && text(rawBroadcast.title).trim()
    && isTimestamp(rawBroadcast.publishedAt)
    ? {
        id: rawBroadcast.id,
        sender: text(rawBroadcast.sender).trim() || null,
        title: text(rawBroadcast.title),
        body: text(rawBroadcast.body),
        truncated: rawBroadcast.truncated === true,
        publishedAt: rawBroadcast.publishedAt,
        audience: rawBroadcast.audience === "chapter" || rawBroadcast.audience === "organization" ? rawBroadcast.audience : null,
      }
    : null;
  return { enabled: true, message, broadcast };
}

// Fixture/preview derivation over the member snapshot shape
// (src/lib/memberApi.js: conversations[].messages[], broadcasts[].unread).
export function homeTakeoverFromSnapshot(data) {
  let message = null;
  for (const conversation of data?.conversations ?? []) {
    for (const row of conversation?.messages ?? []) {
      if (row?.sender_kind !== "steward" || row.read_at || row.redacted_at || !text(row.body).trim()) continue;
      if (!isTimestamp(row.created_at)) continue;
      if (!message || Date.parse(row.created_at) > Date.parse(message.createdAt)) {
        message = {
          id: String(row.id),
          conversationId: String(conversation.id),
          senderName: text(row.sender_name).trim() || null,
          ...preview(row.body),
          createdAt: row.created_at,
        };
      }
    }
  }
  let broadcast = null;
  for (const row of data?.broadcasts ?? []) {
    if (!row?.unread || !text(row.title).trim() || !isTimestamp(row.publishedAt)) continue;
    if (Date.parse(row.publishedAt) > Date.now()) continue;
    if (!broadcast || Date.parse(row.publishedAt) > Date.parse(broadcast.publishedAt)) {
      broadcast = {
        id: String(row.id),
        sender: text(row.sender).trim() || null,
        title: text(row.title),
        ...preview(row.body),
        publishedAt: row.publishedAt,
        audience: row.audience === "chapter" || row.audience === "organization" ? row.audience : null,
      };
    }
  }
  return { enabled: true, message, broadcast };
}

// The member snapshot already knows when an item was read on this device
// (App's read handlers patch it before the server round trip returns), so a
// card hides immediately instead of waiting for the next RPC.
export function hideReadTakeoverItems(takeover, data) {
  if (!takeover?.enabled) return EMPTY;
  let { message, broadcast } = takeover;
  if (message) {
    const conversation = (data?.conversations ?? []).find((item) => String(item?.id) === message.conversationId);
    const row = conversation?.messages?.find((item) => String(item?.id) === message.id);
    // Only the exact row proves a read: a message newer than the snapshot is
    // absent from it and must stay visible.
    if (row?.read_at) message = null;
  }
  if (broadcast) {
    const row = (data?.broadcasts ?? []).find((item) => String(item?.id) === broadcast.id);
    if (row && row.unread === false) broadcast = null;
  }
  return { enabled: true, message, broadcast };
}

// Changes whenever the snapshot gains or loses an unread steward message or
// broadcast, which is exactly when the live takeover must be re-read.
export function homeTakeoverSignature(data) {
  const parts = [];
  for (const conversation of data?.conversations ?? []) parts.push(`c:${conversation?.id}:${Number(conversation?.unread) || 0}`);
  for (const row of data?.broadcasts ?? []) if (row?.unread) parts.push(`b:${row.id}`);
  return parts.sort().join("|");
}
