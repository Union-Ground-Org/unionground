// Which private-thread messages may carry a staff "Create task" control.
//
// Presentation only. The database is the authority: a private message becomes a
// task source through the connected-workflow createTask (kind private_message),
// which re-proves source access and the caller's staff grant in their current
// chapter, links in BOTH directions of an authorized conversation (a member's
// message or a steward's), and names the task and its link with fixed generic
// text, so a client never supplies, and this helper never exposes, anything
// from the message. What is filtered here is only what the server would refuse
// or what no longer reads as a message:
//   - not written by either side of the conversation,
//   - still pending or carrying a client-made id (no delivered row to link),
//   - removed (the body is destroyed; a tombstone is not new work, though a task
//     already linked to it stays reachable through its own control).
// Whether the viewer may create tasks at all is the parent's decision: a view
// renders the control only when it was handed onCreateTaskFromSource.
const CONVERSATION_SENDERS = new Set(["member", "steward"]);

/**
 * A row that is a real, delivered, still-present record a server action can
 * name: it has an id, is not an optimistic bubble, carries no client-made id,
 * and has not been removed. Private messages, channel posts and task messages
 * all pass through here before a connected control (the common ConnectedRecord
 * Actions slot) is offered on them, so the control always names one exact row.
 */
export function isDeliveredMessage(message) {
  if (!message?.id || message.pending) return false;
  if (String(message.id).startsWith("local-")) return false;
  if (message.redacted_at || message.redactedAt || message.deleted_at) return false;
  return true;
}

export function canOfferSourceTask(message) {
  return isDeliveredMessage(message) && CONVERSATION_SENDERS.has(message.sender_kind);
}
