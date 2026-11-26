// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: shared
// by the classic Messages view, the alternate shell and Settings' Who runs
// this chapter card. The server's get_chapter_leadership decides who the
// member may write to (canMessage, the same set start_officer_conversation
// accepts); nothing here widens it.

// The officers a member may write to, in the leadership list's order.
export function contactableOfficers(people) {
  return (Array.isArray(people) ? people : []).filter((person) => person?.canMessage === true && typeof person.id === "string");
}

// Folds a start_officer_conversation result into the member-contact
// projection (list_reward_peer_contact's shape), so the new or reused
// conversation shows in the inbox at once with the message just sent.
export function mergeOfficerConversation(workspace, result) {
  const conversation = result?.conversation;
  if (!conversation?.id) return workspace;
  const current = workspace || { available: true, canRequest: false, code: "", incoming: [], outgoing: [], conversations: [] };
  const message = result.message?.id ? result.message : null;
  const existing = (current.conversations || []).find((item) => item.id === conversation.id) || null;
  const messages = [...(existing?.messages || [])];
  if (message && !messages.some((item) => item.id === message.id)) {
    messages.push(message);
    messages.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }
  const merged = {
    ...(existing || {}),
    id: conversation.id,
    peerName: conversation.peerName ?? existing?.peerName ?? "",
    peerInitials: conversation.peerInitials ?? existing?.peerInitials ?? "",
    updatedAt: messages.at(-1)?.createdAt ?? conversation.updatedAt ?? existing?.updatedAt ?? null,
    // #9189: the server just accepted this send, so the conversation is open
    // for the sender again (an officer or cross-chapter route may have
    // re-opened one that was closed). The viewer's own block stays: a slow
    // send can land after the viewer blocked, and the block holds on the
    // server (ledger 519).
    ...(message && existing?.state !== "blocked_by_viewer" ? { state: "open" } : {}),
    messages,
  };
  return {
    ...current,
    conversations: [merged, ...(current.conversations || []).filter((item) => item.id !== conversation.id)],
  };
}
