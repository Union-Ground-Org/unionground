// BUG-UG-NOTIFICATION-ITEMS-DO-NOT-OPEN-WHAT-THEY-ANNOUNCE-20261004.
// A notification opens what it announces only when its copy key names one
// place. Keys not listed here, and rows written before the copy_key column
// (20261005100000), stay plain text rather than a control that goes nowhere.
// A chapter destination shows the member's selected chapter, so it opens only
// when the notice came from that chapter (source_chapter_id); a member in two
// chapters is never sent to the other chapter's record.
const DESTINATIONS = Object.freeze({
  "institutional.minutes.published": Object.freeze({ view: "hub", path: "/m/organize/record", chapterScoped: true }),
  // BUG-UG-MEMBER-NEVER-SEES-GRIEVANCE-OUTCOME-20261106: the notice
  // names no case, so it opens the member's Cases list.
  "case.resolved": Object.freeze({ view: "cases", path: "/m/cases" }),
  // REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030.
  ...Object.fromEntries([
    "requests.invitation_suggested", "requests.access_requested",
    "requests.suggestion.approved", "requests.suggestion.declined",
    "requests.access.approved", "requests.access.declined",
  ].map((key) => [key, Object.freeze({ view: "settings", path: "/m/settings/requests" })])),
});

// BUG-UG-PRIVATE-TWO-PERSON-MESSAGES-SEND-NO-NOTIFICATION-20261118:
// a private two-person message notice opens that conversation. The row names
// it in peer_conversation_id (a participant's own conversation); a notice
// without a well-formed id stays plain text.
const PEER_MESSAGE_KEY = "peer.message";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function notificationDestination(item, { chapterId = null } = {}) {
  const key = typeof item?.copy_key === "string" ? item.copy_key : "";
  if (key === PEER_MESSAGE_KEY) {
    const conversationId = item?.peer_conversation_id;
    if (typeof conversationId !== "string" || !UUID.test(conversationId)) return null;
    return { view: "messages", path: `/m/messages?peerConversation=${encodeURIComponent(conversationId)}` };
  }
  if (!Object.hasOwn(DESTINATIONS, key)) return null;
  const destination = DESTINATIONS[key];
  if (destination.chapterScoped && (!chapterId || item.source_chapter_id !== chapterId)) return null;
  return { view: destination.view, path: destination.path };
}
