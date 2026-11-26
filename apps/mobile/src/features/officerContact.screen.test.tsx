import { createSessionBoundWriter } from '../../../../src/lib/sessionBoundWriter.js';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-NATIVE-NO-TWO-PERSON-OFFICER-CONVERSATIONS-20261118 (#9162),
// part 2: a member writes privately to an officer from the phone. This opens
// the real Write to an officer screen, on both phones, against a fake Supabase
// client whose get_chapter_leadership and start_officer_conversation apply the
// server's rules (only canMessage people are reachable; three new pairs per
// 24 hours; the first message opens or reuses the pair's conversation), and
// checks the rows written and the conversation opened.
type Row = Record<string, unknown>;
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  client: null as unknown,
  // Who the shared client is signed in as now, and whose session each write
  // was sent with (#9203).
  signedIn: '',
  capturedFor: [] as string[],
  replace: vi.fn(),
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('expo-router', () => ({ router: { replace: port.replace, push: vi.fn() }, Redirect: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, Avatar: () => null, StateMessage: ({ title, body }: { title: string; body?: string }) => h('section', null, title, ' ', body) };
});
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ title, children }: { title?: string; children?: ReactNode }) => h('div', null, h('h1', null, title), children) }));
vi.mock('../components/ScreenKeyboardReveal', () => ({ useRevealAboveKeyboard: () => ({ reveal: vi.fn(), release: vi.fn() }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: async () => undefined, warning: async () => undefined, select: async () => undefined } }));
// #9203: writers read the shared client's current session and send through a
// client fixed to the screen's session; the stand-in records whose it was.
vi.mock('../services/supabase', () => ({
  captureSessionWriter: (session: unknown) => createSessionBoundWriter({ session, sharedClient: port.client, createSessionClient: (current: { user: { id: string } }) => { port.capturedFor.push(current.user.id); return port.client; } }),
  getSupabaseClient: () => port.client,
  createCapturedSessionRpcClient: (session: { user: { id: string } }) => { port.capturedFor.push(session.user.id); return port.client; },
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));

import OfficerContactRoute from '../../app/officer-contact';

const member = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const officer = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';
const titleOnly = '3e6a9c2b-1d4f-4a8e-9b7c-5f2e1d0c8a47';
const steward = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const chapter = 'tamarack-county';

// get_chapter_leadership's people: canMessage marks who this member may
// write to (private.member_contactable_officer_ids).
const leadership = {
  chapterId: chapter,
  chapterName: 'Tamarack County',
  people: [
    { id: officer, name: ' Marcus Webb ', title: 'Campaign chair', president: true, treasurer: false, administrator: false, organizationAdministrator: false, canMessage: true },
    { id: titleOnly, name: 'Ana Ruiz', title: 'Administrator', president: false, treasurer: true, administrator: false, organizationAdministrator: false, canMessage: true },
    { id: steward, name: 'Dana Cole', title: null, president: false, treasurer: false, administrator: true, organizationAdministrator: false, canMessage: false },
    { id: 'no-name', name: '   ', title: null, president: true, canMessage: true },
    { id: null, name: 'No Id', canMessage: true },
  ],
};

type Db = { requests: Row[]; conversations: Row[]; messages: Row[] };
type ServerOptions = { failLeadership?: boolean; unavailable?: string[]; limitReached?: boolean; failStart?: boolean };

function fakeClient(db: Db, caller: string, options: ServerOptions = {}) {
  const calls: Array<{ name: string; args?: unknown }> = [];
  return {
    calls,
    async rpc(name: string, args?: { p_officer_user_id?: string; p_body?: string }) {
      calls.push({ name, args });
      if (name === 'get_chapter_leadership') {
        if (options.failLeadership) return { data: null, error: { code: '57014', message: 'canceling statement' } };
        return { data: leadership, error: null };
      }
      if (name !== 'start_officer_conversation') return { data: null, error: { code: '42883', message: 'unknown' } };
      if (options.failStart) return { data: null, error: { code: '57014', message: 'canceling statement' } };
      const body = String(args?.p_body ?? '').trim();
      const target = String(args?.p_officer_user_id ?? '');
      const reachable = leadership.people.some((person) => person.id === target && person.canMessage) && !(options.unavailable ?? []).includes(target);
      if (!reachable) return { data: null, error: { code: '42501', message: 'officer unavailable', details: 'officer_unavailable' } };
      let conversation = db.conversations.find((row) => row.pair === [caller, target].sort().join(':'));
      if (!conversation) {
        if (options.limitReached) return { data: null, error: { code: '22023', message: 'officer contact limit', details: 'officer_contact_limit' } };
        db.requests.push({ requester_id: caller, recipient_id: target, officer_contact: true, status: 'accepted' });
        conversation = { id: `conversation-${db.conversations.length + 1}`, pair: [caller, target].sort().join(':') };
        db.conversations.push(conversation);
      }
      const saved = { id: `message-${db.messages.length + 1}`, conversation_id: conversation.id, sender_id: caller, body, created_at: '2026-11-19T08:00:00.000Z' };
      db.messages.push(saved);
      return {
        data: {
          created: db.requests.length > 0,
          message: { id: saved.id, sentByMe: true, body, createdAt: saved.created_at },
          conversation: { id: conversation.id, peerName: 'Marcus Webb', peerInitials: 'MW', updatedAt: saved.created_at },
        },
        error: null,
      };
    },
  };
}

let screen: Rendered | null = null;
let client: ReturnType<typeof fakeClient> | null = null;
const text = () => screen!.container.textContent ?? '';
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const has = (label: string) => { try { getExposed(screen!.container, label); return true; } catch { return false; } };
async function open(db: Db, options?: ServerOptions & { language?: 'en' | 'es'; restricted?: boolean }) {
  const language = options?.language ?? 'en';
  client = fakeClient(db, member, options);
  port.signedIn = member;
  port.capturedFor = [];
  port.client = Object.assign(client, { auth: { getSession: async () => ({ data: { session: { user: { id: port.signedIn }, access_token: `token-${port.signedIn}` } } }) } });
  port.app = { mode: 'authenticated', session: { user: { id: member }, access_token: `token-${member}` }, sessionRestricted: options?.restricted === true, organizationID: 'org-tamarack', memberLanguage: language, dashboard: { member: { id: member, chapterID: chapter, language } } };
  screen = await render(h(OfficerContactRoute));
  await settle();
}
const empty = (): Db => ({ requests: [], conversations: [], messages: [] });

afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); port.replace.mockReset(); });

describe.each<'ios' | 'android'>(['ios', 'android'])('Write to an officer on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it.each<'unsent' | 'accepted'>(['unsent', 'accepted'])('R9256E retires an %s officer start on confirmed organization-only membership during a staff outage', async (phase) => {
    const db = empty();
    await open(db);
    port.app = { ...port.app, organizationID: null, staffScopeAvailable: false, dashboard: { member: { id: member, chapterID: null, language: 'en' } }, confirmedMembershipScope: [{ chapterID: null, organizationID: 'org-a' }] };
    await screen!.rerender(h(OfficerContactRoute)); await settle();
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Original organization first message');
    const rpc = client!.rpc.bind(client);
    let release: () => void = () => undefined;
    client!.rpc = (name: string, args?: { p_officer_user_id?: string; p_body?: string }) => (name === 'start_officer_conversation'
      ? new Promise((resolve) => { release = () => { void rpc(name, args).then(resolve); }; })
      : rpc(name, args)) as ReturnType<typeof rpc>;
    if (phase === 'accepted') await press(getExposed(screen!.container, 'Send message'));
    port.app = { ...port.app, confirmedMembershipScope: [{ chapterID: null, organizationID: 'org-b' }] };
    await screen!.rerender(h(OfficerContactRoute)); await settle();
    if (phase === 'accepted') { await act(async () => { release(); }); await settle(); }
    expect(port.replace).not.toHaveBeenCalled();
    expect(text()).not.toContain('First message to Marcus Webb');
    expect(screen!.container.querySelector('textarea')?.value).not.toBe('Original organization first message');
    expect(db.messages).toHaveLength(phase === 'accepted' ? 1 : 0);
  });

  it('lists only the people the server says the worker may write to, with their roles', async () => {
    await open(empty());
    expect(screen!.container.querySelector('h1')?.textContent).toBe('Write to an officer');
    expect(text()).toContain('Write privately to an officer or administrator of your campaign. No contact code or reward is needed.');
    expect(has('Write to Marcus Webb')).toBe(true);
    expect(has('Write to Ana Ruiz')).toBe(true);
    expect(has('Write to Dana Cole')).toBe(false);
    expect(text()).not.toContain('No Id');
    expect(text()).toContain('Campaign chair');
    // A title that names a role the person does not hold reads as a title only.
    expect(text()).toContain('Administrator · title only, no access · Treasurer');
  });

  it('starts the conversation with the first message and opens it', async () => {
    const db = empty();
    await open(db);
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    expect(text()).toContain('First message to Marcus Webb');
    expect(text()).toContain('A conversation with one officer or worker: only you and Marcus Webb can read it. Committee members, other officers and your employer cannot.');
    expect(getExposed(screen!.container, 'Send message').getAttribute('aria-disabled')).toBe('true');
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), '  Can we talk about the overtime list?  ');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(client!.calls.at(-1)).toEqual({ name: 'start_officer_conversation', args: { p_officer_user_id: officer, p_body: 'Can we talk about the overtime list?', p_operation_id: expect.any(String) } });
    expect(db.requests).toEqual([{ requester_id: member, recipient_id: officer, officer_contact: true, status: 'accepted' }]);
    expect(db.messages).toEqual([expect.objectContaining({ conversation_id: 'conversation-1', sender_id: member, body: 'Can we talk about the overtime list?' })]);
    expect(port.replace).toHaveBeenCalledWith('/peer-conversation/conversation-1');
  });

  it('reuses the first-message operation when the reply is unconfirmed', async () => {
    await open(empty());
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Can we talk?');
    const rpc = vi.spyOn(client!, 'rpc').mockResolvedValueOnce({ data: null, error: { code: '', message: 'Lost reply' } });
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(text()).toContain('We could not confirm that your message was sent.');
    expect(port.replace).not.toHaveBeenCalled();
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    const sends = rpc.mock.calls.filter(([name]) => name === 'start_officer_conversation');
    expect(sends[0]?.[1]).toMatchObject({ p_operation_id: expect.any(String) });
    expect(sends[1]).toEqual(sends[0]);
    expect(port.replace).toHaveBeenCalledWith('/peer-conversation/conversation-1');
  });

  it('keeps the draft and words the refusal when the officer can no longer be reached, and lets the worker choose again', async () => {
    const db = empty();
    await open(db, { unavailable: [officer] });
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Can we talk?');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(text()).toContain("That officer can't be messaged here any more. Choose someone else from your campaign's officers.");
    expect((getExposed(screen!.container, 'Write to Marcus Webb') as HTMLTextAreaElement).value).toBe('Can we talk?');
    expect(port.replace).not.toHaveBeenCalled();
    await press(getExposed(screen!.container, 'Choose someone else'));
    await settle();
    expect(client!.calls.filter((call) => call.name === 'get_chapter_leadership')).toHaveLength(2);
    await press(getExposed(screen!.container, 'Write to Ana Ruiz'));
    // The refused text carries over to the next person picked, for them.
    expect(text()).toContain('First message to Ana Ruiz');
    expect((getExposed(screen!.container, 'Write to Ana Ruiz') as HTMLTextAreaElement).value).toBe('Can we talk?');
    expect(text()).not.toContain("That officer can't be messaged");
  });

  it('words the three-a-day limit and a failed start', async () => {
    await open(empty(), { limitReached: true });
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Hello');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(text()).toContain('You have started three new conversations in the last 24 hours. Try again tomorrow, or continue a conversation you already have.');
    await screen!.unmount(); screen = null;
    await open(empty(), { failStart: true });
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Hello');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(text()).toContain("The conversation couldn't be started. Your message is still here; try again.");
  });

  it('says when no one can be messaged, and when the list could not load', async () => {
    const original = leadership.people;
    leadership.people = original.filter((person) => person.canMessage !== true);
    try {
      await open(empty());
      expect(text()).toContain('No officer or administrator of your campaign can be messaged yet.');
    } finally {
      leadership.people = original;
    }
    await screen!.unmount(); screen = null;
    await open(empty(), { failLeadership: true });
    expect(text()).toContain("Your campaign's officers could not be loaded. Try again in a moment.");
    expect(has('Try again')).toBe(true);
  });

  it('sends the first message with the screen\'s own session, and refuses it when another account is now signed in (#9203)', async () => {
    const db = empty();
    await open(db);
    port.signedIn = officer;
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Can we talk?');
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(db.messages).toEqual([]);
    expect(port.capturedFor).toEqual([]);
    expect(text()).toContain("The conversation couldn't be started. Your message is still here; try again.");
    expect((getExposed(screen!.container, 'Write to Marcus Webb') as HTMLTextAreaElement).value).toBe('Can we talk?');
    port.signedIn = member;
    await press(getExposed(screen!.container, 'Send message'));
    await settle();
    expect(port.capturedFor).toEqual([member]);
    expect(db.messages).toEqual([expect.objectContaining({ sender_id: member, body: 'Can we talk?' })]);
  });

  it('words the screen in Spanish for a Spanish worker', async () => {
    await open(empty(), { language: 'es' });
    expect(screen!.container.querySelector('h1')?.textContent).toBe('Escribir a un cargo');
    expect(text()).toContain('Administrator · solo título, sin acceso · Tesorero/a');
    await press(getExposed(screen!.container, 'Escribir a Marcus Webb'));
    expect(text()).toContain('Primer mensaje a Marcus Webb');
    expect(text()).toContain('Una conversación con un cargo o un trabajador: solo la pueden leer tú y Marcus Webb.');
    expect(has('Elegir a otra persona')).toBe(true);
    expect(text()).not.toMatch(/First message to|Choose someone else/);
  });
});

// #9227 round 1 (r1s1): leaving the app and coming back (AppProvider's resume
// clears the dashboard and organization while it re-checks the session) keeps
// the person picked and the unsent first message, and a first message in
// flight still opens its conversation.
describe.each<'ios' | 'android'>(['ios', 'android'])('Write to an officer across a return to the app on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  const resume = async () => {
    const signedIn = port.app;
    port.app = { ...signedIn, mode: 'booting', organizationID: null, dashboard: null };
    await screen!.rerender(h(OfficerContactRoute));
    await settle();
    return async () => { port.app = signedIn; await screen!.rerender(h(OfficerContactRoute)); await settle(); };
  };

  it('keeps the officer picked and the first message', async () => {
    await open(empty());
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'About the overtime list');
    const back = await resume();
    // Nothing protected shows while the session is re-checked.
    expect(text()).not.toContain('Marcus Webb');
    expect(text()).not.toContain('About the overtime list');
    await back();
    expect(text()).toContain('First message to Marcus Webb');
    expect((getExposed(screen!.container, 'Write to Marcus Webb') as HTMLTextAreaElement).value).toBe('About the overtime list');
  });

  it('opens the conversation when a first message in flight is answered meanwhile', async () => {
    const db = empty();
    await open(db);
    const rpc = client!.rpc.bind(client);
    let release: () => void = () => undefined;
    client!.rpc = (name: string, args?: { p_officer_user_id?: string; p_body?: string }) => (name === 'start_officer_conversation'
      ? new Promise((resolve) => { release = () => { void rpc(name, args).then(resolve); }; })
      : rpc(name, args)) as ReturnType<typeof rpc>;
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Sent across a resume');
    await press(getExposed(screen!.container, 'Send message'));
    const back = await resume();
    await act(async () => { release(); });
    await settle();
    expect(db.messages).toHaveLength(1);
    expect(port.replace).toHaveBeenCalledWith('/peer-conversation/conversation-1');
    await back();
  });

  it('never carries the first message to another person who signs in', async () => {
    await open(empty());
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Mine only');
    await resume();
    port.app = { ...port.app, mode: 'authenticated', session: { user: { id: steward } }, organizationID: 'org-tamarack', dashboard: { member: { id: steward, chapterID: chapter, language: 'en' } } };
    await screen!.rerender(h(OfficerContactRoute));
    await settle();
    expect(text()).not.toContain('Mine only');
    expect(text()).not.toContain('First message to');
  });
});

// #9227 delta read F1 (its probe): after a return to the app the form waits
// for the fresh officer list, and a person picked before it who is no longer
// listed is dropped, the draft kept for the next person picked.
describe.each<'ios' | 'android'>(['ios', 'android'])('Write to an officer after the list changed meanwhile on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('drops a kept pick when the fresh list no longer allows that officer, and keeps the draft', async () => {
    await open(empty());
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    await type(getExposed(screen!.container, 'Write to Marcus Webb'), 'Private draft');
    const signedIn = port.app;
    port.app = { ...signedIn, mode: 'booting', organizationID: null, dashboard: null };
    await screen!.rerender(h(OfficerContactRoute));
    const original = leadership.people;
    leadership.people = original.map((person) => (person.id === officer ? { ...person, canMessage: false } : person));
    try {
      port.app = signedIn;
      await screen!.rerender(h(OfficerContactRoute));
      await settle();
      expect(client!.calls.filter((call) => call.name === 'get_chapter_leadership')).toHaveLength(2);
      expect(text()).not.toContain('First message to Marcus Webb');
      expect(has('Send message')).toBe(false);
      expect(text()).toContain("That officer can't be messaged here any more. Choose someone else from your campaign's officers.");
      await press(getExposed(screen!.container, 'Write to Ana Ruiz'));
      expect((getExposed(screen!.container, 'Write to Ana Ruiz') as HTMLTextAreaElement).value).toBe('Private draft');
    } finally { leadership.people = original; }
  });

  it('shows the form only once the fresh list has answered', async () => {
    await open(empty());
    await press(getExposed(screen!.container, 'Write to Marcus Webb'));
    const rpc = client!.rpc.bind(client);
    let release: () => void = () => undefined;
    client!.rpc = (name: string, args?: { p_officer_user_id?: string; p_body?: string }) => (name === 'get_chapter_leadership'
      ? new Promise((resolve) => { release = () => { void rpc(name, args).then(resolve); }; })
      : rpc(name, args)) as ReturnType<typeof rpc>;
    const signedIn = port.app;
    port.app = { ...signedIn, mode: 'booting', organizationID: null, dashboard: null };
    await screen!.rerender(h(OfficerContactRoute));
    port.app = signedIn;
    await screen!.rerender(h(OfficerContactRoute));
    await settle();
    expect(text()).not.toContain('First message to Marcus Webb');
    await act(async () => { release(); });
    await settle();
    expect(text()).toContain('First message to Marcus Webb');
  });
});
