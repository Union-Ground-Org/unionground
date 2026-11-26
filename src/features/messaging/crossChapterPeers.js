// REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109 (#7666): helpers
// for the cross-chapter contact dialog. The server
// (public.list_cross_chapter_peers) decides who is listed and
// public.send_cross_chapter_peer_message who is reached; nothing here widens
// either.
import { leadershipRoleLine } from "../../lib/chapterLeadership.js";
import { mergeOfficerConversation } from "./officerContact.js";

// The server refuses more than this many recipients in one send.
export const CROSS_CHAPTER_SEND_LIMIT = 20;

// The access level and display title, through the shared leadership line, so
// a chapter lead reads "Chapter lead" (or their own title) everywhere.
export function crossChapterPeerRole(peer, t) {
  const levels = Array.isArray(peer?.levels) ? peer.levels : [];
  const line = leadershipRoleLine({ title: peer?.title ?? "", president: levels.includes("vp") }, t);
  const steward = levels.includes("steward") ? t("access.role.steward") : "";
  return [line, steward].filter(Boolean).join(" · ");
}

// Each conversation a send opened or reused goes into the member-contact
// projection at once, with the message just sent.
export function mergeCrossChapterConversations(workspace, result) {
  const conversations = Array.isArray(result?.conversations) ? result.conversations : [];
  return conversations.reduce(
    (current, conversation) => mergeOfficerConversation(current, { conversation, message: conversation?.message ?? null }),
    workspace,
  );
}
