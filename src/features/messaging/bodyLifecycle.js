// How a redacted message body is presented, in one place.
//
// SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904 destroys the body in the database
// rather than hiding it behind a flag, so a redacted row arrives with an empty
// body and a complete tombstone. Every surface still has to say *something*, and
// it must say it in the reader's language — which is why the projection returns
// a translation key rather than server-authored English.

import { MESSAGE_REDACTION_REASONS } from "./generated/messagingContract.js";

// Preservation-order reason codes, mirroring the CHECK constraint on
// public.member_message_legal_holds.reason_code (20260907121000). The server
// refuses anything else with 22023; the client only offers these four.
export const LEGAL_HOLD_REASONS = Object.freeze([
  "litigation",
  "arbitration",
  "agency_charge",
  "internal_investigation",
]);

export function isRedactedMessage(row) {
  return Boolean(row && row.redacted_at);
}

/**
 * @param {{ redacted_at?: string | null, redaction_reason?: string | null } | null | undefined} row
 * @returns {string | null}
 */
export function redactionReasonOf(row) {
  const reason = row && row.redaction_reason;
  return MESSAGE_REDACTION_REASONS.includes(reason) ? reason : null;
}

// The single projection every message renderer runs a row through.
// `body` is always safe to display: for a redacted row it is the empty string,
// never the removed text, because the removed text no longer exists anywhere.
export function projectMessageBody(row) {
  if (!isRedactedMessage(row)) {
    return { redacted: false, body: (row && row.body) || "", noticeKey: null, reason: null };
  }
  const reason = redactionReasonOf(row) || "sender_removed";
  return {
    redacted: true,
    body: "",
    reason,
    noticeKey: `inbox.redacted.${reason}`,
  };
}

// Preview text for inbox rows, saved messages and reminders. A redacted source
// must never fall back to a stale cached preview.
export function projectMessagePreview(row, fallbackKey = "inbox.redacted.short") {
  const projected = projectMessageBody(row);
  return projected.redacted
    ? { redacted: true, preview: "", noticeKey: fallbackKey }
    : { redacted: false, preview: projected.body, noticeKey: null };
}

// Apply only a confirmed tombstone to the current authorized snapshot. No body
// enters an event or persistent cache, and every preview of this source clears.
export function applyMessageTombstone(data, message) {
  if (!message?.id || !message.redacted_at) return data;
  const replace = (row) => row.id === message.id ? { ...row, ...message, body: "" } : row;
  const activity = (rows) => (rows || []).map((row) => row.sourceKind === "private"
    && (row.sourceId === message.id || row.messageId === message.id)
    ? { ...row, preview: "", redacted: true, noticeKey: "inbox.redacted.short" } : row);
  return {
    ...data,
    conversations: (data.conversations || []).map((conversation) => {
      const messages = (conversation.messages || []).map(replace);
      return { ...conversation, messages,
        preview: messages.at(-1)?.id === message.id ? "" : conversation.preview,
        // Pending drafts project conversation_id and id, with no delivered
        // message link. Discard this conversation's cached drafts on a newly
        // confirmed removal. A refreshed tombstoned snapshot restores only
        // the server's remaining pending rows.
        scheduled: (conversation.messages || []).some((row) => row.id === message.id && !row.redacted_at)
          ? [] : (conversation.scheduled || []),
      };
    }),
    savedMessages: activity(data.savedMessages),
    messageReminders: activity(data.messageReminders),
  };
}
