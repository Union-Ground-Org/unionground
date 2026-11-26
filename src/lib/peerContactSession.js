import { createSessionBoundWriter } from "./sessionBoundWriter.js";
// SEC-UG-PRIVATE-MESSAGE-SEND-GOES-OUT-UNDER-WHOEVER-IS-SIGNED-IN-20261119
// (#9203): a private two-person write carries the session of the person who
// started it. The app's shared Supabase client reads its session only when a
// request leaves, after the browser's auth lock, so a message written by one
// person could go out under the next person's token while an account change
// was in flight; both people of a pair are participants, so the server would
// save it as written by the second person.
//
// Each writer here (a reply, a contact request and its answer, a first
// message to an officer, a cross-chapter message, a block or unblock) is bound
// to the person the page rendered for. Before it sends, it reads the shared
// client's current session (that read waits on the same lock, so a change in
// flight is seen) and refuses when it is not that person's; it then sends
// through a client fixed to the token that same read returned
// (createCapturedAppSessionRpcClient), so a change that starts after the check
// cannot change the sender either. The binding is the person, not the token:
// #9229 round 1 (r1s3) found that pinning the page's own token refused a
// legitimate send after the same person's token was refreshed, so a refresh, a
// new sign-in as the same person or another tab of theirs sends with the
// current token, and only another person is refused. The same pinning as the
// sealed form save (memberApi.js saveFormDraft, PR 8966) and #8996's outbox.
// Reads stay on the shared client: they write nothing, and the views drop an
// answer that arrives for a session they no longer show.
import {
  listRewardPeerContact,
  requestRewardPeerContact,
  respondRewardPeerContact,
  sendCrossChapterPeerMessage,
  sendRewardPeerMessage,
  setPeerConversationBlock,
  startOfficerConversation,
} from "./memberApi.js";

export class PeerSessionChanged extends Error {
  constructor() {
    super("The account changed before this was sent.");
    this.name = "PeerSessionChanged";
    this.details = "peer_session_changed";
  }
}

// A function that returns the client to write with, or throws
// PeerSessionChanged when the person who started the write is no longer the
// one signed in.
export function sessionPeerWriter({ sharedClient, session, createSessionClient }) {
  const binding = createSessionBoundWriter({ sharedClient, session, createSessionClient });
  return async () => {
    try { return await binding.client(); }
    catch { throw new PeerSessionChanged(); }
  };
}

// The member-contact api for one session: the reader on the shared client,
// every writer bound to `session`.
export function createSessionPeerContactApi({ sharedClient, session, createSessionClient }) {
  const writer = sessionPeerWriter({ sharedClient, session, createSessionClient });
  return {
    list: () => listRewardPeerContact(sharedClient),
    request: async (contactCode) => requestRewardPeerContact(await writer(), contactCode),
    respond: async (requestId, accept) => respondRewardPeerContact(await writer(), requestId, accept),
    send: async (conversationId, body, operationId) => sendRewardPeerMessage(await writer(), conversationId, body, operationId),
    startOfficer: async (officerUserId, body, operationId) => startOfficerConversation(await writer(), officerUserId, body, operationId),
    sendCrossChapter: async (recipientIds, body) => sendCrossChapterPeerMessage(await writer(), recipientIds, body),
    // #9189: block or unblock the other person of one of this person's conversations.
    setBlock: async (conversationId, blocked) => setPeerConversationBlock(await writer(), conversationId, blocked),
  };
}
