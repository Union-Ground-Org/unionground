const MAX_BRIDGE_BYTES = 1_000_000;
const MAX_REQUESTS = 20;
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 100;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Union Ground peer-contact codes: "PSG-" and twenty hex digits. The
// database still mints and checks the sibling prefix until the database group
// moves it (supabase/migrations/*peer_contact*); see the W7 report.
const CONTACT_CODE = /^PSG-[0-9A-F]{20}$/;
const REQUEST_STATUSES = new Set(["pending", "accepted", "declined", "expired"]);
// #9189: whether the viewer may still write. Absent (an older server) means open.
const CONVERSATION_STATES = new Set(["open", "closed", "blocked_by_viewer"]);

export const PEER_CONTACT_DOWN = "sg-peer-contact-data";
export const PEER_CONTACT_UP = "sg-peer-contact-data-up";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, max, { empty = false } = {}) {
  return typeof value === "string" && value.length <= max && (empty || value.length > 0) ? value : null;
}

function opaqueId(value) {
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : null;
}

function timestamp(value) {
  return boundedString(value, 64);
}

function sanitizeIncoming(value) {
  if (!isRecord(value)) return null;
  const id = opaqueId(value.id);
  const requesterName = boundedString(value.requesterName, 120);
  const requesterInitials = boundedString(value.requesterInitials, 12, { empty: true });
  const createdAt = timestamp(value.createdAt);
  if (!id || !requesterName || requesterInitials === null || !createdAt) return null;
  const next = { id, requesterName, requesterInitials, createdAt };
  if (value.expiresAt !== undefined) {
    const expiresAt = timestamp(value.expiresAt);
    if (!expiresAt) return null;
    next.expiresAt = expiresAt;
  }
  return next;
}

function sanitizeOutgoing(value) {
  if (!isRecord(value)) return null;
  const id = opaqueId(value.id);
  const createdAt = timestamp(value.createdAt);
  if (!id || !createdAt || !REQUEST_STATUSES.has(value.status)) return null;
  return { id, status: value.status, createdAt };
}

function sanitizeMessage(value) {
  if (!isRecord(value)) return null;
  const id = opaqueId(value.id);
  const body = boundedString(value.body, 4000);
  const createdAt = timestamp(value.createdAt);
  if (!id || !body || !createdAt || typeof value.sentByMe !== "boolean") return null;
  return { id, sentByMe: value.sentByMe, body, createdAt };
}

function sanitizeConversation(value) {
  if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) return null;
  const id = opaqueId(value.id);
  const peerName = boundedString(value.peerName, 120);
  const peerInitials = boundedString(value.peerInitials, 12, { empty: true });
  const updatedAt = timestamp(value.updatedAt);
  const messages = value.messages.map(sanitizeMessage);
  if (!id || !peerName || peerInitials === null || !updatedAt || messages.some((item) => item === null)) return null;
  if (value.state !== undefined && !CONVERSATION_STATES.has(value.state)) return null;
  return { id, peerName, peerInitials, updatedAt, ...(value.state !== undefined ? { state: value.state } : {}), messages };
}

function sanitizeArray(value, max, sanitizer) {
  if (!Array.isArray(value) || value.length > max) return null;
  const next = value.map(sanitizer);
  return next.some((item) => item === null) ? null : next;
}

// The phone preview is a second App/document, so peer mutations need a small
// data bridge rather than the generic ephemeral UI-parity channel. Rebuild the
// projection from an explicit allow-list: an injected email/profile field is
// discarded, and a malformed or oversized contact graph is rejected whole.
export function sanitizePeerContactProjection(value) {
  if (!isRecord(value) || typeof value.available !== "boolean" || typeof value.canRequest !== "boolean") return null;
  try {
    if (JSON.stringify(value).length > MAX_BRIDGE_BYTES) return null;
  } catch {
    return null;
  }
  const code = boundedString(value.code, 24, { empty: true });
  if (code === null || (code !== "" && !CONTACT_CODE.test(code))) return null;
  const incoming = sanitizeArray(value.incoming, MAX_REQUESTS, sanitizeIncoming);
  const outgoing = sanitizeArray(value.outgoing, MAX_REQUESTS, sanitizeOutgoing);
  const conversations = sanitizeArray(value.conversations, MAX_CONVERSATIONS, sanitizeConversation);
  if (!incoming || !outgoing || !conversations) return null;
  return {
    available: value.available,
    unavailable: value.unavailable === true,
    canRequest: value.canRequest,
    code,
    incoming,
    outgoing,
    conversations,
  };
}
