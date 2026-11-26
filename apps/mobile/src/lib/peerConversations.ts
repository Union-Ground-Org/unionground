// Private two-person conversations (public.member_peer_*) on the phone.
//
// BUG-UG-NATIVE-NO-TWO-PERSON-OFFICER-CONVERSATIONS-20261118 (#9162):
// the website lists every two-person conversation of the signed-in person in
// Messages (a member writing to an officer, a code-route or staff contact, a
// cross-chapter peer) and answers it there; the phone had none of them. These
// helpers read the same projection the website reads,
// public.list_reward_peer_contact() (its `conversations`: the 50 newest, each
// with its 100 newest messages), and answer through the website's one writer,
// public.send_reward_peer_message(), which trims the text, refuses anything
// outside 1 to 4,000 characters and lets only the two participants write. The
// server decides who is in a conversation; nothing here names a recipient.
//
// Only the two participants can read one (the website's "who can read it"
// sentence, src/lib/i18n/messageVisibility.js). The rows are protected data:
// they are kept in memory only, never in device storage or the offline cache.

import { callPeerMessageRpc } from '../../../../src/features/messaging/peerMessageRpc.js';

export const PEER_MESSAGE_LIMIT = 4000;
// The server returns at most this many of a conversation's newest messages.
export const PEER_THREAD_WINDOW = 100;

export type PeerMessage = { id: string; body: string; createdAt: string; sentByMe: boolean };

// Whether the viewer may still write (#9189, PR #9201): 'closed' when either
// person left, or the other person blocked (it never says which);
// 'blocked_by_viewer' when the viewer blocked the other person.
export type PeerConversationState = 'open' | 'closed' | 'blocked_by_viewer';

export type PeerConversation = {
  id: string;
  peerName: string;
  peerInitials: string;
  updatedAt: string | null;
  state: PeerConversationState;
  // The server sent a state, so it has set_peer_conversation_block (#9189).
  // An older server sends none: the conversation is open and no Block control
  // is offered, since the call could only fail.
  blockable: boolean;
  messages: PeerMessage[];
};

export type PeerRpc = (
  name: 'list_reward_peer_contact' | 'send_reward_peer_message' | 'set_peer_conversation_block' | 'get_chapter_leadership' | 'start_officer_conversation',
  args?: Record<string, string | boolean>,
) => PromiseLike<{ data: unknown; error: unknown; status?: number }>;

export class PeerMessageNotSent extends Error {
  constructor() { super('Private message not sent'); this.name = 'PeerMessageNotSent'; }
}

export class PeerMessageUnconfirmed extends Error {
  constructor() { super('Private message unconfirmed'); this.name = 'PeerMessageUnconfirmed'; }
}

// The server refused a send because the conversation is no longer open
// (detail peer_conversation_closed): the screen shows it closed, not a failed
// send.
export class PeerConversationClosed extends Error {
  constructor() { super('Private conversation closed'); this.name = 'PeerConversationClosed'; }
}

export class PeerBlockNotChanged extends Error {
  constructor() { super('Block not changed'); this.name = 'PeerBlockNotChanged'; }
}

function errorDetail(error: unknown): string | null {
  const details = (error as { details?: unknown } | null)?.details;
  return typeof details === 'string' ? details : null;
}

function hasErrorCode(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0;
}

// An older server sends no state, which means open. A value this app does not
// know reads as closed: the phone never offers a send the server would refuse,
// and the messages stay readable.
export function peerConversationState(value: unknown): PeerConversationState {
  if (value === undefined || value === null) return 'open';
  return value === 'open' || value === 'closed' || value === 'blocked_by_viewer' ? value : 'closed';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// A message with no usable time is kept with an empty time, which the screen
// shows as "time unavailable"; no time is ever invented for it.
function peerMessage(value: unknown): PeerMessage | null {
  const row = value as { id?: unknown; body?: unknown; createdAt?: unknown; sentByMe?: unknown } | null;
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  return { id: row.id, body: text(row.body), createdAt: text(row.createdAt), sentByMe: row.sentByMe === true };
}

// Oldest first; a message with no readable time sorts first, then by id.
function byTime(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }): number {
  return (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0) || left.id.localeCompare(right.id);
}

// The conversations of a list_reward_peer_contact() answer, newest first, each
// with its messages oldest first (the server's order, kept even if a row
// arrives out of place). Malformed rows are dropped, never shown half-filled.
export function peerConversationsFrom(payload: unknown): PeerConversation[] {
  const list = (payload as { conversations?: unknown } | null)?.conversations;
  if (!Array.isArray(list)) return [];
  const conversations: PeerConversation[] = [];
  for (const value of list) {
    const row = value as { id?: unknown; peerName?: unknown; peerInitials?: unknown; updatedAt?: unknown; state?: unknown; messages?: unknown } | null;
    if (!row || typeof row.id !== 'string') continue;
    const messages = (Array.isArray(row.messages) ? row.messages : [])
      .map(peerMessage)
      .filter((message): message is PeerMessage => message !== null)
      .sort(byTime);
    conversations.push({
      id: row.id,
      peerName: text(row.peerName).trim(),
      peerInitials: text(row.peerInitials).trim(),
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : messages.at(-1)?.createdAt || null,
      state: peerConversationState(row.state),
      blockable: row.state !== undefined && row.state !== null,
      messages,
    });
  }
  return conversations.sort((left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0) || left.id.localeCompare(right.id));
}

export async function loadPeerConversations(rpc: PeerRpc | null): Promise<PeerConversation[]> {
  if (!rpc) throw new Error('unavailable');
  const { data, error } = await rpc('list_reward_peer_contact');
  if (error) throw error;
  return peerConversationsFrom(data);
}

// The text that would be sent, or null when there is nothing to send or it is
// over the limit.
export function peerReplyBody(draft: string): string | null {
  const body = draft.trim();
  return body && body.length <= PEER_MESSAGE_LIMIT ? body : null;
}

// Sends one message in a conversation the caller is part of and returns the
// saved message. A conversation that is no longer open throws
// PeerConversationClosed; any other refusal (not a participant, the
// 20-in-5-minutes limit, a PIN session that must step up) throws
// PeerMessageNotSent, never the server's own wording.
export async function sendPeerMessage(rpc: PeerRpc | null, conversationID: string, draft: string, operationID?: string): Promise<PeerMessage> {
  const body = peerReplyBody(draft);
  if (!rpc || !body || !conversationID) throw new PeerMessageNotSent();
  const { data, error } = await callPeerMessageRpc((args) => rpc('send_reward_peer_message', args), 'send_reward_peer_message', {
    p_conversation_id: conversationID, p_body: body,
  }, operationID);
  if (error && errorDetail(error) === 'peer_conversation_closed') throw new PeerConversationClosed();
  const saved = error ? null : peerMessage((data as { message?: unknown } | null)?.message);
  if (!saved) throw hasErrorCode(error) ? new PeerMessageNotSent() : new PeerMessageUnconfirmed();
  return { ...saved, body: saved.body || body, sentByMe: true };
}

// A conversation list with one just-sent message added: the conversation
// moves to the top and its time becomes the message's.
export function withPeerMessage(conversations: readonly PeerConversation[], conversationID: string, message: PeerMessage): PeerConversation[] {
  const current = conversations.find((item) => item.id === conversationID);
  if (!current) return [...conversations];
  const messages = current.messages.some((item) => item.id === message.id) ? current.messages : [...current.messages, message].sort(byTime);
  return [{ ...current, messages, updatedAt: message.createdAt || current.updatedAt }, ...conversations.filter((item) => item.id !== conversationID)];
}

// The other participant's initials for an avatar, from the server's label or
// the name.
export function peerInitials(conversation: Pick<PeerConversation, 'peerInitials' | 'peerName'>): string {
  if (conversation.peerInitials) return conversation.peerInitials.slice(0, 2).toUpperCase();
  const parts = conversation.peerName.split(/\s+/).filter(Boolean);
  return parts.length ? parts.slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') : '·';
}

// Blocks or unblocks the other person of one of the caller's own
// conversations (set_peer_conversation_block, #9189) and returns the caller's
// new state. Any refusal, or an answer without a known state, throws
// PeerBlockNotChanged.
export async function setPeerConversationBlock(rpc: PeerRpc | null, conversationID: string, blocked: boolean): Promise<PeerConversationState> {
  if (!rpc || !conversationID) throw new PeerBlockNotChanged();
  const { data, error } = await rpc('set_peer_conversation_block', { p_conversation_id: conversationID, p_blocked: blocked });
  const answer = error ? null : (data as { id?: unknown; state?: unknown } | null);
  if (!answer || answer.id !== conversationID || (answer.state !== 'open' && answer.state !== 'closed' && answer.state !== 'blocked_by_viewer')) throw new PeerBlockNotChanged();
  return answer.state;
}

// ---------------------------------------------------------------------------
// Writing to an officer (the website's "Write to an officer",
// src/features/messaging/officerContact.js). get_chapter_leadership() lists the
// caller's chapter leadership; canMessage marks who the caller may write to,
// the same set start_officer_conversation() accepts. Nothing here widens it.

export type ContactableOfficer = {
  id: string;
  name: string;
  title: string | null;
  president: boolean;
  treasurer: boolean;
  administrator: boolean;
  organizationAdministrator: boolean;
};

export function contactableOfficers(payload: unknown): ContactableOfficer[] {
  const people = (payload as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) return [];
  const officers: ContactableOfficer[] = [];
  for (const value of people as unknown[]) {
    const row = value as Record<string, unknown> | null;
    if (!row || row.canMessage !== true || typeof row.id !== 'string' || !row.id) continue;
    const name = text(row.name).trim();
    if (!name) continue;
    const title = text(row.title).trim();
    officers.push({
      id: row.id,
      name,
      title: title || null,
      president: row.president === true,
      treasurer: row.treasurer === true,
      administrator: row.administrator === true,
      organizationAdministrator: row.organizationAdministrator === true,
    });
  }
  return officers;
}

export async function loadContactableOfficers(rpc: PeerRpc | null): Promise<ContactableOfficer[]> {
  if (!rpc) throw new Error('unavailable');
  const { data, error } = await rpc('get_chapter_leadership');
  if (error) throw error;
  return contactableOfficers(data);
}

// src/lib/chapterLeadership.js ROLE_TITLE_WORDS: a title that is a role's own
// name on someone without that role reads as a title only, never as the role.
const ROLE_TITLE_WORDS: Record<'president' | 'administrator', readonly string[]> = {
  president: ['president', 'campaign chair', 'presidente', 'presidenta', 'presidente/a', 'campaign lead', 'líder de la campaña'],
  administrator: [
    'administrator', 'admin', 'campaign administrator', 'campaign admin',
    'administrador', 'administradora', 'administrador/a', 'administrador/a de la campaña',
  ],
};

export type OfficerRoleWords = {
  titleOnly: (title: string) => string;
  treasurer: string;
  president: string;
  administrator: string;
  organizationAdministrator: string;
};

function titleOnly(officer: ContactableOfficer): boolean {
  const title = (officer.title ?? '').trim().toLowerCase();
  if (!title) return false;
  const holds = { president: officer.president, administrator: officer.administrator || officer.organizationAdministrator };
  const roles: Array<'president' | 'administrator'> = ['president', 'administrator'];
  return roles.some((role) => !holds[role] && ROLE_TITLE_WORDS[role].includes(title));
}

// The website's leadershipRoleLine: the title (or its title-only form), then
// each held role, each said once.
export function officerRoleLine(officer: ContactableOfficer, words: OfficerRoleWords): string {
  const title = officer.title ?? '';
  const parts = [
    titleOnly(officer) ? words.titleOnly(title) : title,
    officer.treasurer ? words.treasurer : '',
    officer.president && !title ? words.president : '',
    officer.administrator ? words.administrator : '',
    officer.organizationAdministrator ? words.organizationAdministrator : '',
  ].filter((part) => part.trim());
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = part.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(' · ');
}

export type OfficerStartRefusal = 'officer_unavailable' | 'officer_contact_limit' | 'not_started';

export class OfficerConversationNotStarted extends Error {
  readonly reason: OfficerStartRefusal;
  constructor(reason: OfficerStartRefusal) { super('Officer conversation not started'); this.name = 'OfficerConversationNotStarted'; this.reason = reason; }
}

// Opens (or reuses) the caller's conversation with one listed officer and
// sends the first message in one call. Returns the conversation, open, with
// the message just sent. A refusal throws OfficerConversationNotStarted with
// the server's detail when it is one the website words, otherwise
// not_started.
export async function startOfficerConversation(rpc: PeerRpc | null, officerID: string, draft: string, operationID?: string): Promise<PeerConversation> {
  const body = peerReplyBody(draft);
  if (!rpc || !body || !officerID) throw new OfficerConversationNotStarted('not_started');
  const { data, error } = await callPeerMessageRpc((args) => rpc('start_officer_conversation', args), 'start_officer_conversation', {
    p_officer_user_id: officerID, p_body: body,
  }, operationID);
  if (error) {
    const detail = errorDetail(error);
    if (detail === 'officer_unavailable' || detail === 'officer_contact_limit') throw new OfficerConversationNotStarted(detail);
    if (hasErrorCode(error)) throw new OfficerConversationNotStarted('not_started');
    throw new PeerMessageUnconfirmed();
  }
  const result = data as { message?: unknown; conversation?: { id?: unknown; peerName?: unknown; peerInitials?: unknown; updatedAt?: unknown } | null } | null;
  const conversation = result?.conversation;
  const message = peerMessage(result?.message);
  if (!conversation || typeof conversation.id !== 'string' || !conversation.id || !message) throw new PeerMessageUnconfirmed();
  return {
    id: conversation.id,
    peerName: text(conversation.peerName).trim(),
    peerInitials: text(conversation.peerInitials).trim(),
    updatedAt: typeof conversation.updatedAt === 'string' ? conversation.updatedAt : message.createdAt || null,
    state: 'open',
    blockable: false,
    messages: [{ ...message, body: message.body || body, sentByMe: true }],
  };
}
