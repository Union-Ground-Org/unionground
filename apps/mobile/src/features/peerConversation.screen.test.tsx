import { createSessionBoundWriter } from '../../../../src/lib/sessionBoundWriter.js';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-NATIVE-NO-TWO-PERSON-OFFICER-CONVERSATIONS-20261118 (#9162):
// a member wrote privately to an officer on the website, and the officer on the
// phone never saw it. This opens the real phone conversation screen as each
// side, on both phones, against a fake Supabase client whose
// list_reward_peer_contact and send_reward_peer_message apply the server's
// rules (only the two participants read or write; the text is trimmed and
// limited to 4,000 characters), and checks the rows written and the messages
// shown.
type Row = Record<string, unknown>;
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
  client: null as unknown,
  // Who the shared client is signed in as now, and whose session each write
  // was sent with (#9203).
  signedIn: '',
  capturedFor: [] as string[],
  reveal: vi.fn(),
  release: vi.fn(),
  // Every title the pinned header was rendered with, in order, so a test can
  // see a commit that an effect corrects afterwards.
  titles: [] as Array<string | undefined>,
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useLocalSearchParams: () => port.params, useRouter: () => ({ push: vi.fn() }), Redirect: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, Avatar: () => null, StateMessage: ({ title, body }: { title: string; body?: string }) => h('section', null, title, ' ', body) };
});
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ title, children }: { title?: string; children?: ReactNode }) => { port.titles.push(title); return h('div', null, h('h1', null, title), children); } }));
vi.mock('../components/ScreenKeyboardReveal', () => ({ useRevealAboveKeyboard: () => ({ reveal: port.reveal, release: port.release }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: async () => undefined, warning: async () => undefined } }));
// #9203: writers read the shared client's current session and send through a
// client fixed to the screen's session; the stand-in records whose it was.
vi.mock('../services/supabase', () => ({
  captureSessionWriter: (session: unknown) => createSessionBoundWriter({ session, sharedClient: port.client, createSessionClient: (current: { user: { id: string } }) => { port.capturedFor.push(current.user.id); return port.client; } }),
  getSupabaseClient: () => port.client,
  createCapturedSessionRpcClient: (session: { user: { id: string } }) => { port.capturedFor.push(session.user.id); return port.client; },
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));

import PeerConversationRoute from '../../app/peer-conversation/[id]';
import { notificationDestination } from '../lib/notificationKinds';

const member = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const officer = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';
const bystander = '2d5f8b1e-6c3a-4e9d-b7f0-1a4c8e2d6b93';
const conversationID = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const chapter = 'tamarack-county';
const names: Record<string, { name: string; initials: string }> = {
  [member]: { name: 'Rosa Delgado', initials: 'RD' },
  [officer]: { name: 'Marcus Webb', initials: 'MW' },
};

type Db = {
  member_peer_conversations: Row[];
  member_peer_messages: Row[];
  // #9189 (PR #9201): private.member_peer_blocks and the people who left.
  blocks: Array<{ blocker: string; blocked: string }>;
  left: string[];
};
type ServerOptions = { failSend?: boolean; failBlock?: boolean; server?: 'today' | '9189' };

// The server's functions, as public.list_reward_peer_contact,
// public.send_reward_peer_message and (#9189, PR #9201)
// public.set_peer_conversation_block define them, for one signed-in caller.
// 'today' is Main's server: no state, no block function.
function fakeClient(db: Db, caller: string, options: ServerOptions = {}) {
  const mine = (row: Row) => row.user_low === caller || row.user_high === caller;
  const peerOf = (row: Row) => (row.user_low === caller ? String(row.user_high) : String(row.user_low));
  // private.member_peer_conversation_state: the blocked person sees closed,
  // the same as when the other person left.
  const stateOf = (row: Row) => {
    const peer = peerOf(row);
    if (db.blocks.some((block) => block.blocker === caller && block.blocked === peer)) return 'blocked_by_viewer';
    if (db.blocks.some((block) => block.blocker === peer && block.blocked === caller) || db.left.includes(peer) || db.left.includes(caller)) return 'closed';
    return 'open';
  };
  const v9189 = options.server === '9189';
  return {
    calls: [] as Array<{ name: string; args?: unknown }>,
    hold: null as null | { release: () => void },
    holdNextList: false,
    // A send in flight: the server answers it when released, by its rules
    // at that moment.
    holdNextSend: false,
    async rpc(name: string, args?: { p_conversation_id?: string; p_body?: string; p_blocked?: boolean }): Promise<{ data: unknown; error: unknown }> {
      if (name === 'send_reward_peer_message' && this.holdNextSend) {
        this.holdNextSend = false;
        return new Promise((resolve) => { this.hold = { release: () => { void this.rpcNow(name, args).then(resolve); } }; });
      }
      return this.rpcNow(name, args);
    },
    async rpcNow(name: string, args?: { p_conversation_id?: string; p_body?: string; p_blocked?: boolean }): Promise<{ data: unknown; error: unknown }> {
      this.calls.push({ name, args });
      if (name === 'list_reward_peer_contact') {
        const answer = this.listAnswer();
        if (!this.holdNextList) return answer;
        this.holdNextList = false;
        // A read in flight: its answer is computed now and delivered later.
        return new Promise<typeof answer>((resolve) => { this.hold = { release: () => resolve(answer) }; });
      }
      if (name === 'set_peer_conversation_block') {
        if (!v9189) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        const conversation = db.member_peer_conversations.find((row) => row.id === args?.p_conversation_id && mine(row));
        if (!conversation || options.failBlock) return { data: null, error: { code: '22023', message: 'message unavailable', details: 'peer_conversation_unavailable' } };
        const peer = peerOf(conversation);
        db.blocks = db.blocks.filter((block) => !(block.blocker === caller && block.blocked === peer));
        if (args?.p_blocked === true) db.blocks.push({ blocker: caller, blocked: peer });
        return { data: { id: conversation.id, state: stateOf(conversation) }, error: null };
      }
      if (name !== 'send_reward_peer_message' || options.failSend) return { data: null, error: { code: '57014', message: 'canceling statement' } };
      const conversation = db.member_peer_conversations.find((row) => row.id === args?.p_conversation_id && mine(row));
      const body = String(args?.p_body ?? '').trim();
      if (!conversation || body.length < 1 || body.length > 4000) return { data: null, error: { code: '22023', message: 'message unavailable' } };
      if (v9189 && stateOf(conversation) !== 'open') return { data: null, error: { code: '22023', message: 'message unavailable', details: 'peer_conversation_closed' } };
      const saved = { id: `saved-${db.member_peer_messages.length + 1}`, conversation_id: conversation.id, sender_id: caller, body, created_at: '2026-11-18T23:10:00.000Z' };
      db.member_peer_messages.push(saved);
      conversation.updated_at = saved.created_at;
      return { data: { message: { id: saved.id, sentByMe: true, body, createdAt: saved.created_at } }, error: null };
    },
    listAnswer() {
        const conversations = db.member_peer_conversations.filter(mine)
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
          .map((row) => {
            const peer = row.user_low === caller ? String(row.user_high) : String(row.user_low);
            return {
              id: row.id,
              peerName: names[peer]?.name,
              peerInitials: names[peer]?.initials,
              updatedAt: row.updated_at,
              // #9201: the viewer's state, as the server computes it ('9189'
              // computes it from blocks and leavers; a row may also carry it).
              ...(v9189 ? { state: stateOf(row) } : row.state ? { state: row.state } : {}),
              messages: db.member_peer_messages.filter((message) => message.conversation_id === row.id)
                .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
                .slice(-100)
                .map((message) => ({ id: message.id, sentByMe: message.sender_id === caller, body: message.body, createdAt: message.created_at })),
            };
          });
        return { data: { available: true, canRequest: false, code: 'AB12CD34', incoming: [], outgoing: [], conversations }, error: null as unknown };
    },
  };
}

// The conversation the member opened on the website with
// start_officer_conversation: the pair's row and the member's first message.
function database(): Db {
  return {
    member_peer_conversations: [{ id: conversationID, chapter_id: chapter, user_low: member, user_high: officer, updated_at: '2026-11-17T21:00:00.000Z' }],
    member_peer_messages: [
      { id: 'member-1', conversation_id: conversationID, sender_id: member, body: 'Can you help me file a grievance about the new shift schedule?', created_at: '2026-11-17T21:00:00.000Z' },
    ],
    blocks: [],
    left: [],
  };
}

let screen: Rendered | null = null;
const text = () => screen!.container.textContent ?? '';
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
let client: ReturnType<typeof fakeClient> | null = null;
async function open(caller: string, db: Db, options?: ServerOptions & { language?: 'en' | 'es'; restricted?: boolean }) {
  const language = options?.language ?? 'en';
  client = fakeClient(db, caller, options);
  port.signedIn = caller;
  port.capturedFor = [];
  port.client = Object.assign(client, { auth: { getSession: async () => ({ data: { session: { user: { id: port.signedIn }, access_token: `token-${port.signedIn}` } } }) } });
  port.app = { mode: 'authenticated', session: { user: { id: caller }, access_token: `token-${caller}` }, sessionRestricted: options?.restricted === true, organizationID: 'org-tamarack', memberLanguage: language, conversationPollConnected: true, dashboard: { member: { id: caller, chapterID: chapter, language } } };
  screen = await render(h(PeerConversationRoute));
  await settle();
}

beforeEach(() => { port.params = { id: conversationID }; });
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); port.reveal.mockReset(); port.release.mockReset(); });

describe.each<'ios' | 'android'>(['ios', 'android'])('a private two-person conversation on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('shows the officer the worker\'s message, saves the officer\'s answer for the worker, and shows it to the worker', async () => {
    const db = database();
    await open(officer, db);
    expect(screen!.container.querySelector('h1')?.textContent).toBe('Rosa Delgado');
    expect(text()).toContain('Only you and Rosa Delgado can read it');
    expect(text()).toContain('Can you help me file a grievance about the new shift schedule?');
    expect(text()).toContain('A conversation with one officer or worker: only you and Rosa Delgado can read it. Committee members, other officers and your employer cannot.');
    expect(getExposed(screen!.container, 'Send message').getAttribute('aria-disabled')).toBe('true');
    await type(getExposed(screen!.container, 'Write to Rosa Delgado'), '  Yes. Bring the schedule notice to Thursday\'s meeting.  ');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(db.member_peer_messages).toHaveLength(2);
    expect(db.member_peer_messages[1]).toMatchObject({ conversation_id: conversationID, sender_id: officer, body: 'Yes. Bring the schedule notice to Thursday\'s meeting.' });
    expect(db.member_peer_conversations[0]!.updated_at).toBe('2026-11-18T23:10:00.000Z');
    expect(text()).toContain('Message sent.');
    expect((getExposed(screen!.container, 'Write to Rosa Delgado') as HTMLTextAreaElement).value).toBe('');
    // Oldest first, the answer last, each labelled with who wrote it.
    const bubbles = [...screen!.container.querySelectorAll('[aria-label*=": "]')].map((node) => node.getAttribute('aria-label') ?? '');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toMatch(/^Rosa Delgado, .*: Can you help me file a grievance/);
    expect(bubbles[1]).toMatch(/^You, .*: Yes\. Bring the schedule notice/);

    await screen!.unmount(); screen = null;
    await open(member, db);
    expect(screen!.container.querySelector('h1')?.textContent).toBe('Marcus Webb');
    expect(text()).toContain('Only you and Marcus Webb can read it');
    const memberBubbles = [...screen!.container.querySelectorAll('[aria-label*=": "]')].map((node) => node.getAttribute('aria-label') ?? '');
    expect(memberBubbles[0]).toMatch(/^You, .*: Can you help me file a grievance/);
    expect(memberBubbles[1]).toMatch(/^Marcus Webb, .*: Yes\. Bring the schedule notice/);
  });

  it('lifts the field and its Send button above the keyboard while the field has focus', async () => {
    await open(officer, database());
    const field = getExposed(screen!.container, 'Write to Rosa Delgado');
    await act(async () => { field.focus(); });
    expect(port.reveal).toHaveBeenCalledTimes(1);
    await act(async () => { field.blur(); });
    expect(port.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft and says so when the message is not sent, and writes nothing', async () => {
    const db = database();
    await open(officer, db, { failSend: true });
    await type(getExposed(screen!.container, 'Write to Rosa Delgado'), 'Yes, I can help.');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(db.member_peer_messages).toHaveLength(1);
    expect(text()).toContain('That message could not be sent. Your draft is still here.');
    expect((getExposed(screen!.container, 'Write to Rosa Delgado') as HTMLTextAreaElement).value).toBe('Yes, I can help.');
  });

  it('keeps the private draft and retries with its original operation ID', async () => {
    await open(officer, database());
    const field = getExposed(screen!.container, 'Write to Rosa Delgado') as HTMLTextAreaElement;
    await type(field, 'Yes, I can help.');
    const rpc = vi.spyOn(client!, 'rpc').mockResolvedValueOnce({ data: null, error: { code: '', message: 'Lost reply' } });
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(text()).toContain('We could not confirm that your message was sent.');
    expect(field.value).toBe('Yes, I can help.');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    const sends = rpc.mock.calls.filter(([name]) => name === 'send_reward_peer_message');
    expect(sends[0]?.[1]).toMatchObject({ p_operation_id: expect.any(String) });
    expect(sends[1]).toEqual(sends[0]);
    expect(field.value).toBe('');
  });

  it('shows someone outside the pair nothing of it and offers no field', async () => {
    await open(bystander, database());
    expect(text()).toContain('Conversation unavailable');
    expect(text()).not.toContain('grievance');
    expect(() => getExposed(screen!.container, 'Send message')).toThrow();
  });

  it('says who can read it in Spanish for a Spanish worker', async () => {
    const db = database();
    await open(member, db, { language: 'es' });
    expect(text()).toContain('Solo la pueden leer tú y Marcus Webb');
    expect(text()).toContain('Una conversación con un cargo o un trabajador: solo la pueden leer tú y Marcus Webb. Los integrantes del comité, otros cargos y tu empleador no pueden.');
    await type(getExposed(screen!.container, 'Escribir a Marcus Webb'), 'Gracias.');
    await press(getExposed(screen!.container, 'Enviar mensaje'));
    await settle();
    expect(db.member_peer_messages[1]).toMatchObject({ sender_id: member, body: 'Gracias.' });
    expect(text()).toContain('Mensaje enviado.');
    expect(text()).not.toMatch(/Only you and|Message sent\./);
  });
});

// #9189 (PR #9201, not on Main yet): the server says whether this person may
// still write. Built against that contract; Main's server sends no state, which
// means open, and has no block function, so no Block control is offered.
describe.each<'ios' | 'android'>(['ios', 'android'])('a two-person conversation that can close, on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  const hasField = () => { try { getExposed(screen!.container, 'Write to Rosa Delgado'); return true; } catch { return false; } };
  const hasControl = (label: string) => { try { getExposed(screen!.container, label); return true; } catch { return false; } };

  it('offers no Block control against today\'s server, which sends no state', async () => {
    await open(officer, database(), { server: 'today' });
    expect(hasField()).toBe(true);
    expect(hasControl('Block Rosa Delgado')).toBe(false);
    expect(client!.calls.some((call) => call.name === 'set_peer_conversation_block')).toBe(false);
  });

  it('shows a closed conversation readable, with no field, when the other person has left', async () => {
    const db = database();
    db.left.push(member);
    await open(officer, db, { server: '9189' });
    expect(text()).toContain('Can you help me file a grievance about the new shift schedule?');
    expect(text()).toContain('This conversation is closed. You can still read it.');
    expect(hasField()).toBe(false);
    expect(hasControl('Send message')).toBe(false);
    // The reason is never shown.
    expect(text()).not.toMatch(/left|blocked/i);
    expect(hasControl('Block Rosa Delgado')).toBe(true);
  });

  it('blocks after a confirm step, then shows the block to the blocker and a plain closed conversation to the other person', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    await press(getExposed(screen!.container, 'Block Rosa Delgado'));
    expect(text()).toContain('Block Rosa Delgado? Neither of you will be able to send messages here, and they will see the conversation as closed.');
    await press(getExposed(screen!.container, 'Cancel'));
    expect(db.blocks).toEqual([]);
    expect(text()).not.toContain('Block Rosa Delgado?');
    await press(getExposed(screen!.container, 'Block Rosa Delgado'));
    await press(getExposed(screen!.container, 'Block'));
    await settle();
    expect(client!.calls.filter((call) => call.name === 'set_peer_conversation_block')).toEqual([{ name: 'set_peer_conversation_block', args: { p_conversation_id: conversationID, p_blocked: true } }]);
    expect(db.blocks).toEqual([{ blocker: officer, blocked: member }]);
    expect(text()).toContain('You blocked Rosa Delgado. Neither of you can send messages here.');
    expect(hasField()).toBe(false);
    expect(hasControl('Unblock')).toBe(true);

    await screen!.unmount(); screen = null;
    await open(member, db, { server: '9189' });
    expect(text()).toContain('This conversation is closed. You can still read it.');
    expect(text()).not.toMatch(/blocked/i);
    expect(hasControl('Send message')).toBe(false);
  });

  it('unblocks, and the field comes back', async () => {
    const db = database();
    db.blocks.push({ blocker: officer, blocked: member });
    await open(officer, db, { server: '9189' });
    expect(text()).toContain('You blocked Rosa Delgado. Neither of you can send messages here.');
    await press(getExposed(screen!.container, 'Unblock'));
    await settle();
    expect(db.blocks).toEqual([]);
    expect(hasField()).toBe(true);
    expect(text()).not.toContain('You blocked');
  });

  it('keeps the confirm step and says so when the block does not go through', async () => {
    const db = database();
    await open(officer, db, { server: '9189', failBlock: true });
    await press(getExposed(screen!.container, 'Block Rosa Delgado'));
    await press(getExposed(screen!.container, 'Block'));
    await settle();
    expect(db.blocks).toEqual([]);
    expect(text()).toContain('That did not go through. Try again.');
    expect(text()).toContain('Block Rosa Delgado? Neither of you');
    expect(hasField()).toBe(true);
  });

  it('switches to closed, with no failed-send line, when a send is refused because the conversation closed', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    db.left.push(member);
    await type(getExposed(screen!.container, 'Write to Rosa Delgado'), 'Are you still there?');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(db.member_peer_messages).toHaveLength(1);
    expect(text()).toContain('This conversation is closed. You can still read it.');
    expect(text()).not.toContain('That message could not be sent');
    expect(hasField()).toBe(false);
  });

  it('never lets a read that started before a block put the old state back', async () => {
    const ticks: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 30000) ticks.push(fn);
      return realSetInterval(fn, ms);
    }) as typeof setInterval);
    try {
      const db = database();
      await open(officer, db, { server: '9189' });
      // A poll read starts while the conversation is still open...
      client!.holdNextList = true;
      await act(async () => { ticks.at(-1)!(); });
      expect(client!.hold).not.toBeNull();
      // ...the officer blocks before it answers...
      await press(getExposed(screen!.container, 'Block Rosa Delgado'));
      await press(getExposed(screen!.container, 'Block'));
      await settle();
      expect(text()).toContain('You blocked Rosa Delgado.');
      // ...and its open answer arrives late: the block stays.
      await act(async () => { client!.hold!.release(); });
      await settle();
      expect(text()).toContain('You blocked Rosa Delgado.');
      expect(hasField()).toBe(false);
      // The next read follows the server again.
      await act(async () => { ticks.at(-1)!(); });
      await settle();
      expect(text()).toContain('You blocked Rosa Delgado.');
    } finally {
      spy.mockRestore();
    }
  });

  it('words the closed and blocked lines and the confirm step in Spanish', async () => {
    const db = database();
    db.left.push(officer);
    await open(member, db, { server: '9189', language: 'es' });
    expect(text()).toContain('Esta conversación está cerrada. Todavía puedes leerla.');
    db.left = [];
    db.blocks.push({ blocker: member, blocked: officer });
    await screen!.unmount(); screen = null;
    await open(member, db, { server: '9189', language: 'es' });
    expect(text()).toContain('Bloqueaste a Marcus Webb. Ninguno de los dos puede enviar mensajes aquí.');
    await press(getExposed(screen!.container, 'Desbloquear'));
    await settle();
    await press(getExposed(screen!.container, 'Bloquear a Marcus Webb'));
    expect(text()).toContain('¿Bloquear a Marcus Webb? Ninguno de los dos podrá enviar mensajes aquí, y verá la conversación como cerrada.');
    expect(text()).not.toMatch(/You blocked|This conversation is closed/);
  });
});

// Review of #9202 (R-9202, F1 to F3): the other person's name follows the
// conversation it was read for, both routes hide the native header, and a
// message with no time is still shown.
describe.each<'ios' | 'android'>(['ios', 'android'])('the conversation screen shell on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  const heading = () => screen!.container.querySelector('h1')?.textContent;

  it('never shows the previous person\'s name above the next conversation when the route is reused', async () => {
    const db = database();
    const other = '6e2c9a4b-8d1f-4b7e-a3c5-2f9d0b8e1a64';
    names[bystander] = { name: 'Lena Ortiz', initials: 'LO' };
    db.member_peer_conversations.push({ id: other, chapter_id: chapter, user_low: officer, user_high: bystander, updated_at: '2026-11-16T10:00:00.000Z' });
    try {
      await open(officer, db);
      expect(heading()).toBe('Rosa Delgado');
      // The same route instance gets the next conversation's id; its first
      // read has not answered yet.
      client!.holdNextList = true;
      port.params = { id: other };
      port.titles.length = 0;
      await screen!.rerender(h(PeerConversationRoute));
      // Not even the first render for the new id carries the old name.
      expect(port.titles.length).toBeGreaterThan(0);
      expect(port.titles).not.toContain('Rosa Delgado');
      expect(heading()).toBe('Private conversation');
      await act(async () => { client!.hold!.release(); });
      await settle();
      expect(heading()).toBe('Lena Ortiz');
      expect(text()).not.toContain('Rosa Delgado');
    } finally {
      delete names[bystander];
    }
  });

  it('shows a message with no time, with the time-unavailable line, instead of dropping it', async () => {
    const db = database();
    db.member_peer_messages[0]!.created_at = null;
    await open(officer, db);
    expect(text()).toContain('Can you help me file a grievance about the new shift schedule?');
    expect(text()).not.toContain('No messages yet');
    const bubble = screen!.container.querySelector('[aria-label*=": "]')?.getAttribute('aria-label') ?? '';
    expect(bubble).toBe('Rosa Delgado, time unavailable: Can you help me file a grievance about the new shift schedule?');
  });
});

describe('the pushed conversation routes', () => {
  it('hide the native header, since each draws its own pinned header', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const layout = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../app/_layout.tsx'), 'utf8');
    for (const name of ['peer-conversation/[id]', 'officer-contact']) {
      const entry = layout.split('\n').find((line) => line.includes(`<Stack.Screen name="${name}"`)) ?? '';
      expect(entry, name).toContain('headerShown: false');
    }
  });
});

// #9203: a write carries the session of the screen that started it, and is
// refused when the account signed in is no longer that person's.
describe.each<'ios' | 'android'>(['ios', 'android'])('whose session a write carries, on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('sends the reply with the screen\'s own session', async () => {
    const db = database();
    await open(officer, db);
    await type(getExposed(screen!.container, 'Write to Rosa Delgado'), 'Yes, I can help.');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(port.capturedFor).toEqual([officer]);
    expect(db.member_peer_messages.at(-1)).toMatchObject({ sender_id: officer, body: 'Yes, I can help.' });
  });

  it('refuses the reply, keeps the draft and writes nothing when another account is now signed in', async () => {
    const db = database();
    await open(officer, db);
    port.signedIn = member;
    await type(getExposed(screen!.container, 'Write to Rosa Delgado'), 'Yes, I can help.');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(db.member_peer_messages).toHaveLength(1);
    expect(port.capturedFor).toEqual([]);
    expect(text()).toContain('That message could not be sent. Your draft is still here.');
    expect((getExposed(screen!.container, 'Write to Rosa Delgado') as HTMLTextAreaElement).value).toBe('Yes, I can help.');
  });

  it('refuses a block when another account is now signed in', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    port.signedIn = member;
    await press(getExposed(screen!.container, 'Block Rosa Delgado'));
    await press(getExposed(screen!.container, 'Block'));
    await settle();
    expect(db.blocks).toEqual([]);
    expect(text()).toContain('That did not go through. Try again.');
  });
});

// #9201 round 1 (the website's keepOwnBlock): a slow send that comes back
// refused as closed after this person blocked never replaces their own block.
describe.each<'ios' | 'android'>(['ios', 'android'])('a slow send and a block, on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('keeps "You blocked" and Unblock when the send started before the block comes back refused', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    client!.holdNextSend = true;
    await type(getExposed(screen!.container, 'Write to Rosa Delgado'), 'One more thing.');
    await press(getExposed(screen!.container, 'Send message'));
    await press(getExposed(screen!.container, 'Block Rosa Delgado'));
    await press(getExposed(screen!.container, 'Block'));
    await settle();
    expect(text()).toContain('You blocked Rosa Delgado. Neither of you can send messages here.');
    await act(async () => { client!.hold!.release(); });
    await settle();
    expect(db.member_peer_messages).toHaveLength(1);
    expect(text()).toContain('You blocked Rosa Delgado. Neither of you can send messages here.');
    expect(text()).not.toContain('This conversation is closed.');
    expect(text()).not.toContain('That message could not be sent');
    expect(getExposed(screen!.container, 'Unblock')).toBeTruthy();
  });
});

// #9227 round 1: what the person wrote is never lost to the screen. r2s1: a
// conversation that closes keeps the unsent text, shown for copying, and puts
// it back in the field if it reopens. r1s1: leaving the app and coming back
// (AppProvider's resume clears the dashboard and organization while it
// re-checks the session) keeps the draft.
describe.each<'ios' | 'android'>(['ios', 'android'])('the draft survives on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  const field = () => getExposed(screen!.container, 'Write to Rosa Delgado') as HTMLTextAreaElement;
  const fieldShown = () => { try { field(); return true; } catch { return false; } };
  const unsent = (body: string) => [...screen!.container.querySelectorAll('[aria-label]')].find((node) => node.getAttribute('aria-label') === `Your unsent message: ${body}`)?.textContent ?? null;

  it('shows the unsent text for copying when a send is refused because the conversation closed', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    db.left.push(member);
    await type(field(), 'Are you still there?');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(db.member_peer_messages).toHaveLength(1);
    expect(text()).toContain('This conversation is closed. You can still read it.');
    expect(fieldShown()).toBe(false);
    expect(text()).toContain('Your message was not sent. You can copy it from here:');
    expect(unsent('Are you still there?')).toBe('Are you still there?');
  });

  it('keeps the text through the person\'s own block and puts it back in the field when they unblock', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    await type(field(), 'Before I go: the notice is attached.');
    await press(getExposed(screen!.container, 'Block Rosa Delgado'));
    await press(getExposed(screen!.container, 'Block'));
    await settle();
    expect(fieldShown()).toBe(false);
    expect(unsent('Before I go: the notice is attached.')).toBe('Before I go: the notice is attached.');
    await press(getExposed(screen!.container, 'Unblock'));
    await settle();
    expect(field().value).toBe('Before I go: the notice is attached.');
    expect(unsent('Before I go: the notice is attached.')).toBeNull();
    expect(db.member_peer_messages).toHaveLength(1);
  });

  it('shows nothing to copy once the text is sent, and nothing when the field was empty', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    await type(field(), 'Sent before the block.');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    await press(getExposed(screen!.container, 'Block Rosa Delgado'));
    await press(getExposed(screen!.container, 'Block'));
    await settle();
    expect(text()).not.toContain('Your message was not sent');
  });

  it('keeps the draft when the person leaves the app and comes back', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    await type(field(), 'Half a thought');
    const signedIn = port.app;
    // The resume: booting, with the dashboard and organization cleared.
    port.app = { ...signedIn, mode: 'booting', organizationID: null, dashboard: null };
    await screen!.rerender(h(PeerConversationRoute));
    await settle();
    expect(text()).toContain('Loading conversation');
    expect(text()).not.toContain('Half a thought');
    port.app = signedIn;
    await screen!.rerender(h(PeerConversationRoute));
    await settle();
    expect(field().value).toBe('Half a thought');
  });

  it('lands a send that was in flight while the app came back, and clears the draft', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    client!.holdNextSend = true;
    await type(field(), 'Sent across a resume.');
    await press(getExposed(screen!.container, 'Send message'));
    const signedIn = port.app;
    port.app = { ...signedIn, mode: 'booting', organizationID: null, dashboard: null };
    await screen!.rerender(h(PeerConversationRoute));
    await act(async () => { client!.hold!.release(); });
    await settle();
    port.app = signedIn;
    await screen!.rerender(h(PeerConversationRoute));
    await settle();
    expect(db.member_peer_messages).toHaveLength(2);
    expect(field().value).toBe('');
    expect(text()).toContain('Sent across a resume.');
  });

  it('never carries the draft to another person who signs in on the same screen', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    await type(field(), 'For Rosa only');
    port.app = { ...port.app, mode: 'booting', organizationID: null, dashboard: null };
    await screen!.rerender(h(PeerConversationRoute));
    port.client = fakeClient(db, member, { server: '9189' });
    port.app = { mode: 'authenticated', session: { user: { id: member } }, sessionRestricted: false, organizationID: 'org-tamarack', memberLanguage: 'en', conversationPollConnected: true, dashboard: { member: { id: member, chapterID: chapter, language: 'en' } } };
    await screen!.rerender(h(PeerConversationRoute));
    await settle();
    expect((getExposed(screen!.container, 'Write to Marcus Webb') as HTMLTextAreaElement).value).toBe('');
    expect(text()).not.toContain('For Rosa only');
  });
});

// #9227 delta read F2 (its probe): after a return to the app the kept
// conversation, its title and the reply field wait for the fresh list read; a
// conversation that read no longer lists stays hidden. The draft is kept.
describe.each<'ios' | 'android'>(['ios', 'android'])('the conversation after a return to the app on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  const field = () => getExposed(screen!.container, 'Write to Rosa Delgado') as HTMLTextAreaElement;
  const heading = () => screen!.container.querySelector('h1')?.textContent;

  it('waits for the fresh read before showing the kept conversation, and keeps it hidden when it is gone', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    await type(field(), 'Private draft');
    const signedIn = port.app;
    port.app = { ...signedIn, mode: 'booting', organizationID: null, dashboard: null };
    await screen!.rerender(h(PeerConversationRoute));
    db.member_peer_conversations = [];
    client!.holdNextList = true;
    port.app = signedIn;
    await screen!.rerender(h(PeerConversationRoute));
    await settle();
    const beforeRead = text();
    expect(heading()).toBe('Private conversation');
    await act(async () => { client!.hold!.release(); });
    await settle();
    expect(text()).toContain('Conversation unavailable');
    expect(text()).not.toContain('grievance');
    expect(beforeRead).not.toContain('grievance');
    expect(beforeRead).not.toContain('Rosa Delgado');
  });

  it('shows the kept conversation, title and draft again once the fresh read lists it', async () => {
    const db = database();
    await open(officer, db, { server: '9189' });
    await type(field(), 'Private draft');
    const signedIn = port.app;
    port.app = { ...signedIn, mode: 'booting', organizationID: null, dashboard: null };
    await screen!.rerender(h(PeerConversationRoute));
    expect(heading()).toBe('Private conversation');
    client!.holdNextList = true;
    port.app = signedIn;
    await screen!.rerender(h(PeerConversationRoute));
    await settle();
    expect(text()).not.toContain('grievance');
    await act(async () => { client!.hold!.release(); });
    await settle();
    expect(heading()).toBe('Rosa Delgado');
    expect(text()).toContain('grievance');
    expect(field().value).toBe('Private draft');
  });
});

// BUG-UG-PRIVATE-TWO-PERSON-MESSAGES-SEND-NO-NOTIFICATION-20261118
// (#9173): the notice for a private two-person message opens this screen for
// its own conversation, which reads the member's own list first.
describe('opened from a private message notice', () => {
  const fromNotice = (peerConversationID: string | null) => {
    const href = notificationDestination('messages', 'peer.message', peerConversationID);
    const match = /^\/peer-conversation\/([^/?#]+)$/.exec(href ?? '');
    return { href, id: match?.[1] ?? null };
  };

  it('opens the conversation the notice names, as the officer it was sent to', async () => {
    const { href, id } = fromNotice(conversationID);
    expect(href).toBe(`/peer-conversation/${conversationID}`);
    port.params = { id: id! };
    await open(officer, database());
    expect(screen!.container.querySelector('h1')?.textContent).toBe('Rosa Delgado');
    expect(text()).toContain('Can you help me file a grievance about the new shift schedule?');
  });

  it('shows only the neutral unavailable state for a conversation the worker no longer has, and never says why', async () => {
    const { id } = fromNotice(conversationID);
    port.params = { id: id! };
    const db = database();
    db.member_peer_conversations = [];
    await open(officer, db);
    expect(text()).toContain('Conversation unavailable');
    expect(text()).not.toContain('grievance');
    expect(text()).not.toMatch(/block|bloque/i);
    expect(() => getExposed(screen!.container, 'Send message')).toThrow();
  });

  // #9201 (leave and block): a block by the other person reaches the blocked
  // person as state 'closed', exactly as the other person leaving does. With
  // #9162's closed line (#9227), such a conversation opened from its notice
  // shows the same closed screen either way, and nothing names a block.
  it('shows a conversation the other person closed, by leaving or by a block, the same way, with no word of a block', async () => {
    const { id } = fromNotice(conversationID);
    port.params = { id: id! };
    const left = database();
    left.left.push(officer);
    await open(member, left, { server: '9189' });
    const leftText = text();
    await screen!.unmount(); screen = null;
    const blocked = database();
    blocked.blocks.push({ blocker: officer, blocked: member });
    await open(member, blocked, { server: '9189' });
    expect(text()).toBe(leftText);
    expect(text()).toContain('Can you help me file a grievance about the new shift schedule?');
    expect(text()).toContain('This conversation is closed. You can still read it.');
    // The person's own Block control stays (either person may block); no line
    // says anyone was blocked.
    expect(text()).not.toMatch(/blocked/i);
    expect(() => getExposed(screen!.container, 'Send message')).toThrow();
  });

  it('opens Messages, not a conversation, for a notice without a well-formed id', () => {
    expect(fromNotice(null)).toEqual({ href: '/messages', id: null });
    expect(fromNotice('../../account')).toEqual({ href: '/messages', id: null });
  });
});
