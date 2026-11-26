import { describe, expect, it, vi } from 'vitest';

import { buildMessageInbox, countMessageFilters, filterMessageInbox } from './messageInbox';
import { messageInboxCopy } from './messageInboxCopy';
import { groupNativeMessageItems } from './messageWorkflow';
import {
  OfficerConversationNotStarted,
  PeerBlockNotChanged,
  PeerConversationClosed,
  PeerMessageNotSent,
  PeerMessageUnconfirmed,
  contactableOfficers,
  loadContactableOfficers,
  loadPeerConversations,
  officerRoleLine,
  peerConversationState,
  peerConversationsFrom,
  peerInitials,
  peerReplyBody,
  sendPeerMessage,
  setPeerConversationBlock,
  startOfficerConversation,
  withPeerMessage,
  type ContactableOfficer,
  type PeerConversationState,
  type PeerRpc,
} from './peerConversations';

// BUG-UG-NATIVE-NO-TWO-PERSON-OFFICER-CONVERSATIONS-20261118 (#9162):
// the phone reads the website's projection (list_reward_peer_contact) and
// answers through its one writer (send_reward_peer_message). The screen test
// (src/features/peerConversation.screen.test.tsx) drives both sides; these
// pin the projection, the call and the Messages rows.

const projection = {
  available: true,
  canRequest: false,
  code: 'AB12CD34',
  incoming: [],
  outgoing: [],
  conversations: [
    {
      id: 'older',
      peerName: 'Marcus Webb',
      peerInitials: 'MW',
      updatedAt: '2026-11-16T15:00:00.000Z',
      messages: [{ id: 'm1', sentByMe: true, body: 'Thanks for the committee member contact.', createdAt: '2026-11-16T15:00:00.000Z' }],
    },
    {
      id: 'newer',
      peerName: ' Rosa Delgado ',
      peerInitials: '',
      updatedAt: '2026-11-17T21:05:00.000Z',
      messages: [
        { id: 'r2', sentByMe: true, body: 'Bring the schedule notice.', createdAt: '2026-11-17T21:05:00.000Z' },
        { id: 'r1', sentByMe: false, body: 'Can you help me file a grievance?', createdAt: '2026-11-17T21:00:00.000Z' },
        { id: 7, body: 'malformed' },
      ],
    },
    { peerName: 'No id' },
  ],
};

describe.each([
  { name: 'send_reward_peer_message', targetArg: 'p_conversation_id', send: sendPeerMessage },
  { name: 'start_officer_conversation', targetArg: 'p_officer_user_id', send: startOfficerConversation },
])('$name rollout on mobile', ({ name, targetArg, send }) => {
  const legacy = { [targetArg]: 'target', p_body: 'Hi' };
  const keyed = { ...legacy, p_operation_id: 'operation' };
  const signature = Object.keys(keyed).sort().join(', ');
  const missing = {
    code: 'PGRST202',
    message: `Could not find the function public.${name}(${signature}) in the schema cache`,
    details: `Searched for the function public.${name} with parameters ${signature} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
    hint: null,
  };

  it('falls back once after the exact missing-overload response', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, status: 404, error: missing })
      .mockResolvedValueOnce({ data: { message: { id: 'm1', body: 'Hi' }, conversation: { id: 'c1' } }, status: 200, error: null });
    await expect(send(rpc, 'target', 'Hi', 'operation')).resolves.toBeTruthy();
    expect(rpc.mock.calls).toEqual([[name, keyed], [name, legacy]]);
  });

  it.each([
    [404, { code: 'PGRST202', message: 'Not found' }],
    [504, { code: '57014', message: 'Timed out' }],
    [0, { code: '', message: 'Network request failed' }],
  ])('never falls back on another failure (status %s)', async (status, error) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, status, error });
    await expect(send(rpc, 'target', 'Hi', 'operation')).rejects.toBeTruthy();
    expect(rpc.mock.calls).toEqual([[name, keyed]]);
  });
});

describe('peerConversationsFrom', () => {
  it('lists conversations newest first with their messages oldest first, and drops malformed rows', () => {
    const conversations = peerConversationsFrom(projection);
    expect(conversations.map((item) => item.id)).toEqual(['newer', 'older']);
    expect(conversations[0]).toMatchObject({ peerName: 'Rosa Delgado', updatedAt: '2026-11-17T21:05:00.000Z' });
    expect(conversations[0]!.messages.map((item) => [item.id, item.sentByMe])).toEqual([['r1', false], ['r2', true]]);
  });

  it('reads nothing from an answer with no conversation list', () => {
    expect(peerConversationsFrom(null)).toEqual([]);
    expect(peerConversationsFrom({ available: false })).toEqual([]);
  });

  it('names the avatar from the server label, else from the name', () => {
    expect(peerInitials({ peerInitials: 'mw', peerName: 'Marcus Webb' })).toBe('MW');
    expect(peerInitials({ peerInitials: '', peerName: 'Rosa Delgado' })).toBe('RD');
    expect(peerInitials({ peerInitials: '', peerName: '' })).toBe('·');
  });
});

describe('reading and sending through the website functions', () => {
  it('reads list_reward_peer_contact and refuses a failed read', async () => {
    const rpc = vi.fn<PeerRpc>(async () => ({ data: projection, error: null }));
    expect((await loadPeerConversations(rpc)).map((item) => item.id)).toEqual(['newer', 'older']);
    expect(rpc).toHaveBeenCalledWith('list_reward_peer_contact');
    await expect(loadPeerConversations(async () => ({ data: null, error: { code: '42501' } }))).rejects.toEqual({ code: '42501' });
    await expect(loadPeerConversations(null)).rejects.toThrow();
  });

  it('sends the trimmed text to send_reward_peer_message for that conversation and returns the saved message', async () => {
    const rpc = vi.fn<PeerRpc>(async () => ({ data: { message: { id: 'saved', sentByMe: true, body: 'Yes, I can help.', createdAt: '2026-11-18T23:10:00.000Z' } }, error: null }));
    const saved = await sendPeerMessage(rpc, 'newer', '  Yes, I can help.  ', 'operation');
    expect(rpc).toHaveBeenCalledWith('send_reward_peer_message', { p_conversation_id: 'newer', p_body: 'Yes, I can help.', p_operation_id: 'operation' });
    expect(saved).toEqual({ id: 'saved', body: 'Yes, I can help.', createdAt: '2026-11-18T23:10:00.000Z', sentByMe: true });
  });

  it('sends nothing empty or over 4,000 characters, and turns any refusal into one not-sent error', async () => {
    const rpc = vi.fn<PeerRpc>(async () => ({ data: null, error: { code: '22023', message: 'message unavailable' } }));
    expect(peerReplyBody('   ')).toBeNull();
    expect(peerReplyBody('x'.repeat(4001))).toBeNull();
    expect(peerReplyBody(` ${'x'.repeat(4000)} `)).toHaveLength(4000);
    await expect(sendPeerMessage(rpc, 'newer', '   ')).rejects.toBeInstanceOf(PeerMessageNotSent);
    expect(rpc).not.toHaveBeenCalled();
    await expect(sendPeerMessage(rpc, 'newer', 'Hello')).rejects.toBeInstanceOf(PeerMessageNotSent);
    await expect(sendPeerMessage(async () => ({ data: { message: null }, error: null }), 'newer', 'Hello')).rejects.toBeInstanceOf(PeerMessageUnconfirmed);
  });

  it('moves a conversation to the top with the message just sent', () => {
    const conversations = peerConversationsFrom(projection);
    const sent = { id: 'm2', body: 'One more thing.', createdAt: '2026-11-18T09:00:00.000Z', sentByMe: true };
    const next = withPeerMessage(conversations, 'older', sent);
    expect(next.map((item) => item.id)).toEqual(['older', 'newer']);
    expect(next[0]!.messages.at(-1)).toEqual(sent);
    expect(next[0]!.updatedAt).toBe(sent.createdAt);
    expect(withPeerMessage(next, 'older', sent)[0]!.messages).toHaveLength(2);
  });
});

describe('Messages rows', () => {
  const peers = peerConversationsFrom(projection);
  const steward = { id: 'steward-1', title: 'Campaign committee members', initials: 'CS', latestMessage: 'We received your note.', unreadCount: 1, updatedAt: '2026-11-17T10:00:00.000Z' } as never;

  it('lists each two-person conversation as a private direct row, newest first among the others', () => {
    const items = buildMessageInbox([steward], [], messageInboxCopy.en, 'en-US', false, peers);
    expect(items.map((item) => item.key)).toEqual(['peer-newer', 'direct-steward-1', 'peer-older']);
    expect(items[0]).toMatchObject({ id: 'newer', kind: 'direct', peer: true, title: 'Rosa Delgado', meta: 'Private worker conversation', preview: 'Bring the schedule notice.', initials: 'RD', unread: 0 });
    expect(items[1]!.peer).toBeUndefined();
  });

  it('counts them under All and Direct, finds them by name or text, and groups them with people', () => {
    const items = buildMessageInbox([steward], [], messageInboxCopy.en, 'en-US', false, peers);
    expect(countMessageFilters(items)).toMatchObject({ all: 3, direct: 3, unread: 1, channel: 0 });
    expect(filterMessageInbox(items, 'all', 'rosa', 'en-US').map((item) => item.id)).toEqual(['newer']);
    expect(filterMessageInbox(items, 'direct', 'schedule notice', 'en-US').map((item) => item.id)).toEqual(['newer']);
    expect(groupNativeMessageItems(items, 'people-spaces-work')).toEqual([{ key: 'people', items }]);
  });

  it('shows the empty-conversation line and Spanish row words', () => {
    const empty = peerConversationsFrom({ conversations: [{ id: 'quiet', peerName: 'Ana Ruiz', peerInitials: 'AR', updatedAt: '2026-11-18T10:00:00.000Z', messages: [] }] });
    expect(buildMessageInbox([], [], messageInboxCopy.en, 'en-US', false, empty)[0]!.preview).toBe('Accepted — write the first message.');
    expect(buildMessageInbox([], [], messageInboxCopy.es, 'es-US', false, empty)[0]).toMatchObject({ meta: 'Conversación privada entre trabajadores', preview: 'Aceptada — escribe el primer mensaje.' });
  });

  it('titles a row whose other person has no name with the conversation kind, never a blank', () => {
    const unnamed = peerConversationsFrom({ conversations: [{ id: 'unnamed', peerName: null, peerInitials: null, updatedAt: null, messages: null }] });
    expect(buildMessageInbox([], [], messageInboxCopy.en, 'en-US', false, unnamed)[0]).toMatchObject({ title: 'Private worker conversation', initials: '·', preview: 'Accepted — write the first message.', timestamp: 0 });
    expect(buildMessageInbox([], [], messageInboxCopy.es, 'es-US', false, unnamed)[0]!.title).toBe('Conversación privada entre trabajadores');
  });

  it('leaves the inbox unchanged when there are none', () => {
    expect(buildMessageInbox([steward], [], messageInboxCopy.en)).toEqual(buildMessageInbox([steward], [], messageInboxCopy.en, 'en-US', false, []));
  });
});

// #9189 (PR #9201, not on Main yet): whether the viewer may still write.
describe('conversation state', () => {
  it('reads a missing state as open with no block control, and each known state as sent', () => {
    const [legacy] = peerConversationsFrom({ conversations: [{ id: 'a', peerName: 'Rosa', peerInitials: 'R', updatedAt: '2026-11-18T10:00:00.000Z', messages: [] }] });
    expect(legacy).toMatchObject({ state: 'open', blockable: false });
    const states: PeerConversationState[] = ['open', 'closed', 'blocked_by_viewer'];
    for (const state of states) {
      expect(peerConversationsFrom({ conversations: [{ id: 'a', state, messages: [] }] })[0]).toMatchObject({ state, blockable: true });
    }
  });

  it('reads a state this app does not know, or a null one, safely', () => {
    expect(peerConversationState('archived')).toBe('closed');
    expect(peerConversationState(7)).toBe('closed');
    expect(peerConversationState(null)).toBe('open');
    expect(peerConversationsFrom({ conversations: [{ id: 'a', state: null, messages: [] }] })[0]).toMatchObject({ state: 'open', blockable: false });
  });

  it('tells a send refused because the conversation closed from any other refusal', async () => {
    const closed: PeerRpc = async () => ({ data: null, error: { code: '22023', message: 'message unavailable', details: 'peer_conversation_closed' } });
    await expect(sendPeerMessage(closed, 'a', 'Hello')).rejects.toBeInstanceOf(PeerConversationClosed);
    const other: PeerRpc = async () => ({ data: null, error: { code: '22023', message: 'message unavailable', details: null } });
    await expect(sendPeerMessage(other, 'a', 'Hello')).rejects.toBeInstanceOf(PeerMessageNotSent);
    const nullError: PeerRpc = async () => ({ data: null, error: null });
    await expect(sendPeerMessage(nullError, 'a', 'Hello')).rejects.toBeInstanceOf(PeerMessageUnconfirmed);
    const lostReply: PeerRpc = async () => ({ data: null, error: { code: '', message: 'Network request failed' } });
    await expect(sendPeerMessage(lostReply, 'a', 'Hello')).rejects.toBeInstanceOf(PeerMessageUnconfirmed);
  });

  it('blocks and unblocks through set_peer_conversation_block and returns the caller\'s new state', async () => {
    const calls: unknown[] = [];
    const rpc: PeerRpc = async (name, args) => { calls.push([name, args]); return { data: { id: 'a', state: args?.p_blocked ? 'blocked_by_viewer' : 'open' }, error: null }; };
    await expect(setPeerConversationBlock(rpc, 'a', true)).resolves.toBe('blocked_by_viewer');
    await expect(setPeerConversationBlock(rpc, 'a', false)).resolves.toBe('open');
    expect(calls).toEqual([
      ['set_peer_conversation_block', { p_conversation_id: 'a', p_blocked: true }],
      ['set_peer_conversation_block', { p_conversation_id: 'a', p_blocked: false }],
    ]);
  });

  it('never applies a block answer for another conversation, an unknown state, a null answer or a refusal', async () => {
    const answer = (data: unknown, error: unknown = null): PeerRpc => async () => ({ data, error });
    await expect(setPeerConversationBlock(answer({ id: 'b', state: 'blocked_by_viewer' }), 'a', true)).rejects.toBeInstanceOf(PeerBlockNotChanged);
    await expect(setPeerConversationBlock(answer({ id: 'a', state: 'archived' }), 'a', true)).rejects.toBeInstanceOf(PeerBlockNotChanged);
    await expect(setPeerConversationBlock(answer(null), 'a', true)).rejects.toBeInstanceOf(PeerBlockNotChanged);
    await expect(setPeerConversationBlock(answer(null, { details: 'peer_conversation_unavailable' }), 'a', true)).rejects.toBeInstanceOf(PeerBlockNotChanged);
    await expect(setPeerConversationBlock(null, 'a', true)).rejects.toBeInstanceOf(PeerBlockNotChanged);
    await expect(setPeerConversationBlock(answer({ id: '', state: 'open' }), '', true)).rejects.toBeInstanceOf(PeerBlockNotChanged);
  });
});

describe('writing to an officer', () => {
  const words = {
    titleOnly: (title: string) => `${title} · title only, no access`,
    treasurer: 'Treasurer',
    president: 'Campaign lead',
    administrator: 'Campaign administrator',
    organizationAdministrator: 'Organization administrator',
  };
  const person = (fields: Partial<ContactableOfficer>): ContactableOfficer => ({ id: 'x', name: 'X', title: null, president: false, treasurer: false, administrator: false, organizationAdministrator: false, ...fields });

  it('keeps only canMessage people with an id and a name, in the server\'s order', () => {
    const officers = contactableOfficers({ people: [
      { id: 'b', name: ' Marcus Webb ', title: ' Campaign chair ', president: true, canMessage: true },
      { id: 'c', name: 'Dana Cole', canMessage: false },
      { id: 'd', name: '', canMessage: true },
      { id: 'e', name: null, canMessage: true },
      { name: 'No Id', canMessage: true },
      null,
      { id: 'a', name: 'Ana Ruiz', title: null, treasurer: true, canMessage: true },
    ] });
    expect(officers).toEqual([
      person({ id: 'b', name: 'Marcus Webb', title: 'Campaign chair', president: true }),
      person({ id: 'a', name: 'Ana Ruiz', treasurer: true }),
    ]);
    expect(contactableOfficers(null)).toEqual([]);
    expect(contactableOfficers({ people: null })).toEqual([]);
  });

  it('reads get_chapter_leadership and refuses a failed read', async () => {
    const rpc: PeerRpc = async (name) => ({ data: name === 'get_chapter_leadership' ? { people: [{ id: 'a', name: 'Ana', canMessage: true }] } : null, error: null });
    await expect(loadContactableOfficers(rpc)).resolves.toEqual([person({ id: 'a', name: 'Ana' })]);
    await expect(loadContactableOfficers(async () => ({ data: null, error: { code: '57014' } }))).rejects.toBeTruthy();
    await expect(loadContactableOfficers(null)).rejects.toThrow('unavailable');
  });

  it('words the role line as the website does, title-only rule included', () => {
    expect(officerRoleLine(person({ title: 'Campaign chair', president: true }), words)).toBe('Campaign chair');
    expect(officerRoleLine(person({ president: true, administrator: true }), words)).toBe('Campaign lead · Campaign administrator');
    expect(officerRoleLine(person({ title: 'Campaign chair' }), words)).toBe('Campaign chair · title only, no access');
    expect(officerRoleLine(person({ title: 'Administrator', organizationAdministrator: true }), words)).toBe('Administrator · Organization administrator');
    expect(officerRoleLine(person({ title: 'Campaign administrator', administrator: true }), words)).toBe('Campaign administrator');
    expect(officerRoleLine(person({}), words)).toBe('');
  });

  it('starts the conversation with the trimmed first message and returns it open, with the message', async () => {
    const calls: unknown[] = [];
    const rpc: PeerRpc = async (name, args) => {
      calls.push([name, args]);
      return { data: { created: true, message: { id: 'm1', body: 'Hello', createdAt: '2026-11-19T08:00:00.000Z' }, conversation: { id: 'c1', peerName: 'Marcus Webb', peerInitials: 'MW', updatedAt: '2026-11-19T08:00:00.000Z' } }, error: null };
    };
    await expect(startOfficerConversation(rpc, 'officer-1', '  Hello  ', 'operation')).resolves.toEqual({
      id: 'c1', peerName: 'Marcus Webb', peerInitials: 'MW', updatedAt: '2026-11-19T08:00:00.000Z', state: 'open', blockable: false,
      messages: [{ id: 'm1', body: 'Hello', createdAt: '2026-11-19T08:00:00.000Z', sentByMe: true }],
    });
    expect(calls).toEqual([['start_officer_conversation', { p_officer_user_id: 'officer-1', p_body: 'Hello', p_operation_id: 'operation' }]]);
  });

  it('turns each refusal into its reason and sends nothing empty', async () => {
    const refusal = (details: unknown): PeerRpc => async () => ({ data: null, error: { code: '42501', details } });
    const reason = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof OfficerConversationNotStarted ? error.reason : 'other'));
    expect(await reason(startOfficerConversation(refusal('officer_unavailable'), 'o', 'Hi'))).toBe('officer_unavailable');
    expect(await reason(startOfficerConversation(refusal('officer_contact_limit'), 'o', 'Hi'))).toBe('officer_contact_limit');
    expect(await reason(startOfficerConversation(refusal('member_pin_step_up_required'), 'o', 'Hi'))).toBe('not_started');
    expect(await reason(startOfficerConversation(refusal(null), 'o', 'Hi'))).toBe('not_started');
    await expect(startOfficerConversation(async () => ({ data: null, error: { code: '', message: 'Network request failed' } }), 'o', 'Hi')).rejects.toBeInstanceOf(PeerMessageUnconfirmed);
    const never: PeerRpc = async () => { throw new Error('called'); };
    expect(await reason(startOfficerConversation(never, 'o', '   '))).toBe('not_started');
    expect(await reason(startOfficerConversation(never, '', 'Hi'))).toBe('not_started');
  });

  it('cannot confirm an officer message without its canonical row', async () => {
    const missingRow: PeerRpc = async () => ({ data: { conversation: { id: 'c1' }, message: null }, error: null });
    await expect(startOfficerConversation(missingRow, 'o', 'Hi')).rejects.toBeInstanceOf(PeerMessageUnconfirmed);
  });
});

// Review of #9202 (R-9202, F3): a message with no usable time is kept, never
// dropped, and no time is invented for it.
describe('messages without a time', () => {
  it('keeps a message whose time is null, missing or unreadable, with an empty or unchanged time', () => {
    const [conversation] = peerConversationsFrom({ conversations: [{ id: 'a', peerName: 'Rosa', updatedAt: null, messages: [
      { id: 'm-null', body: 'One', createdAt: null },
      { id: 'm-missing', body: 'Two' },
      { id: 'm-bad', body: 'Three', createdAt: 'not a time' },
      { id: 'm-ok', body: 'Four', createdAt: '2026-11-18T10:00:00.000Z' },
      { id: '', body: 'No id', createdAt: '2026-11-18T10:00:00.000Z' },
    ] }] });
    expect(conversation!.messages.map((message) => [message.id, message.createdAt])).toEqual([
      ['m-bad', 'not a time'], ['m-missing', ''], ['m-null', ''], ['m-ok', '2026-11-18T10:00:00.000Z'],
    ]);
    expect(conversation!.updatedAt).toBe('2026-11-18T10:00:00.000Z');
  });

  it('keeps a conversation\'s time when a message with no time is added', () => {
    const [conversation] = peerConversationsFrom({ conversations: [{ id: 'a', updatedAt: '2026-11-18T10:00:00.000Z', messages: [] }] });
    const [updated] = withPeerMessage([conversation!], 'a', { id: 'm', body: 'Hi', createdAt: '', sentByMe: true });
    expect(updated!.updatedAt).toBe('2026-11-18T10:00:00.000Z');
  });
});
