// The signed-in person's private two-person conversations, read and answered
// through the website's own functions (src/lib/peerConversations.ts; #9162).

import {
  loadContactableOfficers,
  loadPeerConversations,
  sendPeerMessage,
  setPeerConversationBlock,
  startOfficerConversation,
  type ContactableOfficer,
  type PeerConversation,
  type PeerConversationState,
  type PeerMessage,
  type PeerRpc,
} from '../lib/peerConversations';
import type { Session } from '@supabase/supabase-js';
import { captureSessionWriter, getSupabaseClient } from './supabase';

// Reads go through the shared client: their answers are dropped by the
// screens' scope and alive checks if the account changes, and they write
// nothing.
function peerRpc(): PeerRpc | null {
  const client = getSupabaseClient();
  return client ? (name, args) => client.rpc(name, args) : null;
}

// SEC-UG-PRIVATE-MESSAGE-SEND-GOES-OUT-UNDER-WHOEVER-IS-SIGNED-IN-20261119
// (#9203): a write carries the session of the person who started it. The
// shared client reads its session only when the request leaves, after the
// auth lock, so a write started by one person could go out under the next
// person's token while an account change was in flight. Each writer is given
// the screen's session; it refuses (null, which every writer turns into its
// own not-sent error, keeping the draft) when the shared client's current
// session is no longer that person's, and otherwise sends through a client
// fixed to the token that same read returned, so a change that starts after
// the check cannot change the sender either.
async function sessionPeerRpc(session: Session | null): Promise<PeerRpc | null> {
  const writer = captureSessionWriter(session);
  try {
    const captured = await writer.client();
    return (name, args) => captured.rpc(name, args);
  } catch {
    return null; // swallow-ok: each peer writer reports its own refusal and keeps the draft
  }
}

const listeners = new Set<() => void>();

// Messages re-reads its list when a conversation screen sends, blocks or
// unblocks, or a first message to an officer starts a conversation, so the
// row follows at once instead of at the next poll.
export function subscribePeerConversations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function loadMyPeerConversations(): Promise<PeerConversation[]> {
  return loadPeerConversations(peerRpc());
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export async function sendMyPeerMessage(session: Session | null, conversationID: string, draft: string, operationID?: string): Promise<PeerMessage> {
  const saved = await sendPeerMessage(await sessionPeerRpc(session), conversationID, draft, operationID);
  changed();
  return saved;
}

export async function setMyPeerConversationBlock(session: Session | null, conversationID: string, blocked: boolean): Promise<PeerConversationState> {
  const state = await setPeerConversationBlock(await sessionPeerRpc(session), conversationID, blocked);
  changed();
  return state;
}

export function loadMyContactableOfficers(): Promise<ContactableOfficer[]> {
  return loadContactableOfficers(peerRpc());
}

export async function startMyOfficerConversation(session: Session | null, officerID: string, draft: string, operationID?: string): Promise<PeerConversation> {
  const conversation = await startOfficerConversation(await sessionPeerRpc(session), officerID, draft, operationID);
  changed();
  return conversation;
}
