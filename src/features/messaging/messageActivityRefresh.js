// The Saved and Reminders inbox filters read the member's saved and reminder
// rows (list_member_message_activity, or the two tables when that projection is
// unavailable). Save, unsave, remind and unremind change exactly those rows, so
// after one of them the loader must read them again; without this the button
// flipped while the filters kept their boot-time contents until a reload.
export const MESSAGE_ACTIVITY_RESOURCES = Object.freeze([
  "rpc:list_member_message_activity",
  "table:member_saved_messages",
  "table:member_message_reminders",
]);

const ACTIVITY_ACTIONS = new Set(["save", "unsave", "remind", "unremind"]);

export function refreshMessageActivityAfter(loader, action) {
  if (!ACTIVITY_ACTIONS.has(action)) return false;
  loader?.invalidateResources(MESSAGE_ACTIVITY_RESOURCES);
  return true;
}
