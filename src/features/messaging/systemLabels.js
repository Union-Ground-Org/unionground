import { catalogue } from "../../lib/i18n.js";

// The loaders recognize this reserved system title separately from authored
// conversation titles. Keep its key until render so a later label save (or
// language change) also updates an already-loaded conversation.
export function withSystemSenderLabels(row, t) {
  const defaults = Object.values(catalogue).map((table) => table["inbox.chapterSteward"]).filter(Boolean);
  const key = row.senderLabelKey ?? (defaults.includes(row.sender) ? "inbox.chapterSteward" : null);
  if (key !== "inbox.chapterSteward") return row;
  const sender = t(key);
  let changed = sender !== row.sender;
  const messages = row.messages?.map((message) => {
    if (message.sender_kind !== "steward" || !defaults.includes(message.sender_name) || message.sender_name === sender) return message;
    changed = true;
    return { ...message, sender_name: sender };
  });
  return changed ? { ...row, sender, ...(messages ? { messages } : {}) } : row;
}
