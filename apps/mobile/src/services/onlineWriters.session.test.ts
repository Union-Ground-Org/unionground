import { processLock, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Named here because the pinned Semgrep parser rejects an inline import type
// as a generic argument in original<typeof import(...)>().
type SupabaseSdk = typeof import('@supabase/supabase-js');

// #9254 batch (a): drive the real pinned SDK and Auth coordination at every
// online message/Compass/receipt dispatch seam. A's operation starts while B's
// sign-in is held at /auth/v1/user. Intercepted transport records identities,
// never a real backend. Both refusal and successful same-person refresh are
// required: a blanket refusal would hide this race rather than repair it.
const port = vi.hoisted(() => ({
  shared: null as SupabaseClient | null,
  transport: null as null | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({}) }));
vi.mock('../state/useAppActive', () => ({ useAppActive: () => true }));
const URL_BASE = 'https://unionground-sample.supabase.co';
const KEY = 'sb_publishable_test';
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { releaseEnvironment: 'development' } } } }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, compassNetworkEnabled: true, supabaseUrl: 'https://unionground-sample.supabase.co', supabasePublishableKey: 'sb_publishable_test', portalBaseUrl: 'https://sample.unionground.example' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
vi.mock('@supabase/supabase-js', async (original) => {
  const sdk = await original<SupabaseSdk>();
  return { ...sdk, createClient: (...args: Parameters<typeof sdk.createClient>) => args[2]?.accessToken
    ? sdk.createClient(args[0], args[1], { ...args[2], global: { ...args[2].global, fetch: (input: RequestInfo | URL, init?: RequestInit) => port.transport!(input, init) } })
    : port.shared };
});
import { connectedWorkflowApi } from '../lib/connectedWorkflows';
import { channelControlsApi } from '../data/channelControls';
import { liveChannelStore } from '../data/liveChannels';
import { sendTaskReply } from '../lib/taskConversationReply';
import { messageActionRequest } from '../../../../src/features/messaging/actions.js';
import { createChannelHereReminder } from '../../../../src/features/messaging/remindHere.js';
import { saveMobileCompassExchange } from './livedIn';
import { recordCaseAccess } from './caseAccessHistory';
import { captureSessionWriter, sendMemberMessage, sendStewardReply, startMemberConversation, startMobileMemberStewardConversation, markConversationRead, reactToConversationMessage, askCompass, askCompassAboutCase, type MobileSessionWriter } from './supabase';
const officer = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';
const member = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const conversationID = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (sub: string) => [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub, exp: 9999999999, role: 'authenticated' }), 'sig0'].join('.');
const officerToken = jwt(officer);
const memberToken = jwt(member);
// #9229 round 1 (r1s3): the same person's later tokens.
const jwtFor = (sub: string, exp: number, nonce: string) => [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub, exp, role: 'authenticated', nonce }), 'sig0'].join('.');
const refreshedToken = jwtFor(officer, 9999999999, 'refreshed');
const officerAgainToken = jwtFor(officer, 9999999999, 'signed-in-again');
let refreshes = 0;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let threadless = false;
let afterDispatch: null | (() => Promise<void>) = null;
let rpcRequests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
let memberUser = deferred<Response>();
let memberUserAsked = deferred<void>();

function rpcAnswer(_url: string): Response {
  return json({
    id: conversationID, conversationId: conversationID, created: true,
    body: 'A draft', createdAt: '2026-11-19T12:00:00Z', senderId: officer,
    reacted: true, sent: 1, results: [],
    options: [{ id: conversationID, label: 'Yes', votes: 1 }, { id: officer, label: 'No', votes: 0 }],
    task: { id: conversationID, title: 'Follow up', status: 'open' },
    reminder: { id: conversationID, status: 'scheduled', remindAt: '2026-11-20T12:00:00Z' },
  });
}

beforeEach(async () => {
  rpcRequests = [];
  threadless = false;
  afterDispatch = null;
  refreshes = 0;
  memberUser = deferred<Response>();
  memberUserAsked = deferred<void>();
  port.transport = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('Authorization');
    if (url.endsWith('/auth/v1/user')) {
      if (authorization === `Bearer ${memberToken}`) { memberUserAsked.resolve(); return memberUser.promise; }
      return json({ id: officer, aud: 'authenticated', role: 'authenticated' });
    }
    if (url.includes('/auth/v1/token')) {
      refreshes += 1;
      return json({ access_token: refreshedToken, refresh_token: 'refresh-officer-2', token_type: 'bearer', expires_in: 3600, user: { id: officer, aud: 'authenticated', role: 'authenticated' } });
    }
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    const path = new URL(url).pathname;
    const table = path.split('/').at(-1);
    const rows: Record<string, unknown[]> = {
      chapter_spaces: [{ id: conversationID, name: 'General', description: '', visibility: 'chapter' }],
      chapter_threads: threadless ? [] : [{ id: officer, space_id: conversationID, status: 'open', title: 'General' }],
      chapter_thread_posts: threadless ? [] : [{ id: 'post-1', thread_id: officer, author_id: member, body: 'A post', created_at: '2026-11-19T12:00:00Z' }],
      chapter_channel_polls: [{ id: conversationID, space_id: conversationID, status: 'open', question: 'Vote?', options: ['Yes', 'No'], option_ids: [conversationID, officer] }],
    };
    if (init?.method === 'GET' && !path.includes('/rpc/')) return json(rows[table!] ?? []);
    rpcRequests.push({ url, authorization, body });
    if (afterDispatch) { const callback = afterDispatch; afterDispatch = null; await callback(); }
    if (path.endsWith('/chapter_threads')) return json({ id: conversationID });
    if (path.endsWith('/chapter_thread_posts')) return json({ id: 'saved-post', thread_id: officer, author_id: officer, body: 'A draft', created_at: '2026-11-19T12:00:00Z' });
    if (path.endsWith('/api/guide')) return json({ answer: 'An answer', sources: [] });
    if (path.endsWith('/save_member_guide_exchange')) return json(conversationID);
    if (path.endsWith('/get_channel_poll_tally')) return json({ id: conversationID, options: [{ id: conversationID, label: 'Yes', votes: 0 }, { id: officer, label: 'No', votes: 0 }] });
    return rpcAnswer(url);
  };
  const sdk = await vi.importActual<SupabaseSdk>('@supabase/supabase-js');
  port.shared ??= sdk.createClient(URL_BASE, KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => port.transport!(input, init) },
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => port.transport!(input, init));
  expect((await port.shared.auth.setSession({ access_token: officerToken, refresh_token: 'refresh-officer' })).error).toBeNull();
});
afterEach(() => { liveChannelStore.resetForSession(); vi.unstubAllGlobals(); });

// The officer's session as the screen holds it.
async function officerSession(): Promise<Session> {
  const session = (await port.shared!.auth.getSession()).data.session;
  expect(session?.user.id).toBe(officer);
  return session!;
}

// Starts the change to the member and holds it on the member's user read.
async function holdAccountChange() {
  const replacing = port.shared!.auth.setSession({ access_token: memberToken, refresh_token: 'refresh-member' });
  await memberUserAsked.promise;
  return async () => {
    memberUser.resolve(json({ id: member, aud: 'authenticated', role: 'authenticated' }));
    await replacing;
  };
}


const reference = { kind: 'task' as const, id: conversationID };
const accessTarget = { caseID: conversationID, actorUserID: officer, subjectUserID: member, organizationID: conversationID };
const writers: Array<[string, (writer: MobileSessionWriter, session: Session) => Promise<unknown>]> = [
  ['worker send', (w) => sendMemberMessage(w, conversationID, 'A draft')],
  ['committee member send', (w) => sendStewardReply(w, conversationID, 'A draft')],
  ['start direct', (w) => startMemberConversation(w, 'A draft')],
  ['start selected committee member', (w) => startMobileMemberStewardConversation(w, member, 'A draft')],
  ['direct read receipt', (w) => markConversationRead(w, officer, conversationID)],
  ['direct reaction', (w) => reactToConversationMessage(w, officer, conversationID, conversationID, 'like')],
  ['task reply', (w) => sendTaskReply(async (name, args) => (await w.client()).rpc(name, args), conversationID, 'A draft')],
  ['channel post', (w) => liveChannelStore.send(w, officer, 'A draft', '', '')],
  ['channel read receipt', async (w) => liveChannelStore.markRead(w, officer)],
  ['channel reaction', async (w) => liveChannelStore.toggleReaction(w, officer, 'post-1', 'like')],
  ['channel vote', async (w) => liveChannelStore.vote(w, 0)],
  ['channel level', (w) => channelControlsApi.setLevel(w, conversationID, 'all')],
  ['channel mute', (w) => channelControlsApi.setMute(w, conversationID, true, null)],
  ['channel keywords', (w) => channelControlsApi.setKeywords(w, conversationID, ['hours'])],
  ['channel pin', (w) => channelControlsApi.setPinned(w, conversationID, true)],
  ['channel presence', (w) => channelControlsApi.heartbeat(w, 'online')],
  ['message reply', async (w) => messageActionRequest(await w.client(), 'channel', conversationID, 'reply', 'A draft')],
  ['message edit', async (w) => messageActionRequest(await w.client(), 'private', conversationID, 'edit', 'A draft')],
  ['message save', async (w) => messageActionRequest(await w.client(), 'channel', conversationID, 'save')],
  ['message redact', async (w) => messageActionRequest(await w.client(), 'private', conversationID, 'redact')],
  ['channel here reminder', async (w) => createChannelHereReminder(await w.client(), { spaceId: conversationID, remindAt: '2099-01-01T12:00:00Z', note: 'A draft' })],
  ['connected task', (_w, session) => connectedWorkflowApi(session)!.createTask(reference)],
  ['connected reminder', (_w, session) => connectedWorkflowApi(session)!.remind(reference, new Date(Date.now() + 3600000).toISOString(), 'A draft')],
  ['connected message', (_w, session) => connectedWorkflowApi(session)!.send(reference, [member], 'A draft', conversationID)],
  ['connected reminder action', (_w, session) => connectedWorkflowApi(session)!.updateReminder(conversationID, 'complete')],
  ['connected organizer', (_w, session) => connectedWorkflowApi(session)!.setEventOrganizer(conversationID, member, 1)],
  ['connected contact opt-in', (_w, session) => connectedWorkflowApi(session)!.setEventContactOptIn(conversationID, true, member)],
  ['Guide ask', (w) => askCompass(w, 'A question', [])],
  ['Guide issue ask', (w) => askCompassAboutCase(w, conversationID, 'next')],
  ['Guide save/retry', (w) => saveMobileCompassExchange(w, null, 'A question', 'An answer', [])],
  ['issue viewed receipt', (w) => recordCaseAccess(w, 'viewed_case', accessTarget)],
  ['issue acknowledged-update receipt', (w) => recordCaseAccess(w, 'updated_case', accessTarget)],
];

async function prepare() {
  const session = await officerSession();
  await liveChannelStore.refresh();
  rpcRequests = [];
  return { session, writer: captureSessionWriter(session) };
}

it.each(writers)('%s refuses B held across dispatch', async (_name, write) => {
  const { session, writer } = await prepare();
  const release = await holdAccountChange();
  const pending = write(writer, session);
  pending.catch(() => undefined);
  await release();
  await pending.catch(() => undefined);
  expect(rpcRequests).toEqual([]);
});

it.each(writers)('%s sends as the initiating person on a legitimate dispatch', async (_name, write) => {
  const { session, writer } = await prepare();
  await write(writer, session);
  expect(rpcRequests.length).toBeGreaterThan(0);
  expect(rpcRequests.every((request) => request.authorization === `Bearer ${officerToken}`)).toBe(true);
});

it.each(writers)('%s accepts same-person refreshed sign-in using its current token', async (_name, write) => {
  const { session, writer } = await prepare();
  await port.shared!.auth.setSession({ access_token: officerAgainToken, refresh_token: 'renewed-a' });
  await write(writer, session);
  expect(rpcRequests.length).toBeGreaterThan(0);
  expect(rpcRequests.every((request) => request.authorization === `Bearer ${officerAgainToken}`)).toBe(true);
});

it('a client already checked for A never picks up B even when B signs in before dispatch', async () => {
  const { writer } = await prepare();
  const client = await writer.client();
  const release = await holdAccountChange(); await release();
  await client.rpc('send_member_message', { p_body: 'A draft', p_conversation_id: conversationID });
  expect(rpcRequests.map((r) => r.authorization)).toEqual([`Bearer ${officerToken}`]);
  expect(await writer.acknowledged('saved')).toEqual({ acknowledged: true, value: 'saved', continuationCurrent: false });
});

it('an accepted post remains acknowledged when its cache is retired before the answer', async () => {
  const { writer } = await prepare();
  afterDispatch = async () => { liveChannelStore.resetForSession(); const release = await holdAccountChange(); await release(); };
  const result = await liveChannelStore.sendOutcome(writer, officer, 'A draft', '', '');
  expect(result).toMatchObject({ acknowledged: true, continuationCurrent: false });
  expect(rpcRequests).toHaveLength(1);
  expect(liveChannelStore.channels()).toEqual([]);
});

it('a receipt for an acknowledged business write never adopts B, and is not a retry of the business write', async () => {
  const { writer } = await prepare();
  const acceptedBusinessWrite = { acknowledged: true, value: 'case-saved' };
  const release = await holdAccountChange(); await release();
  expect(await recordCaseAccess(writer, 'updated_case', accessTarget)).toBe(false);
  expect(acceptedBusinessWrite.acknowledged).toBe(true);
  expect(rpcRequests).toEqual([]);
});

it('an unbound cached connected facade cannot mutate', async () => {
  const { session } = await prepare();
  expect(connectedWorkflowApi(session)).toBe(connectedWorkflowApi(session));
  await expect(connectedWorkflowApi()!.createTask(reference)).rejects.toBeDefined();
  expect(rpcRequests).toEqual([]);
});

it.each(writers)('%s refreshes an expiring token for the same person at the checked read', async (_name, write) => {
  const { session, writer } = await prepare();
  const expiring = jwtFor(officer, Math.floor(Date.now() / 1000) + 30, 'expiring');
  await port.shared!.auth.setSession({ access_token: expiring, refresh_token: 'refresh-a' });
  await write(writer, session);
  expect(refreshes).toBe(1);
  expect(rpcRequests.length).toBeGreaterThan(0);
  expect(rpcRequests.every((r) => r.authorization === `Bearer ${refreshedToken}`)).toBe(true);
});

it('a replacement at the thread-created seam stops the post and keeps it unacknowledged', async () => {
  threadless = true;
  const { writer } = await prepare();
  afterDispatch = async () => { const release = await holdAccountChange(); await release(); };
  expect(await liveChannelStore.sendOutcome(writer, conversationID, 'A draft', '', '')).toMatchObject({ acknowledged: false, continuationCurrent: false });
  expect(rpcRequests).toHaveLength(1);
  expect(rpcRequests[0]!.url).toContain('/chapter_threads');
  expect(rpcRequests[0]!.authorization).toBe(`Bearer ${officerToken}`);
});

it('a pending Guide history retry retains A and never saves the answer as B', async () => {
  const { writer } = await prepare();
  expect((await askCompass(writer, 'A question', [])).answer).toBe('An answer');
  rpcRequests = [];
  const release = await holdAccountChange(); await release();
  await expect(saveMobileCompassExchange(writer, null, 'A question', 'An answer', [])).rejects.toBeDefined();
  expect(rpcRequests).toEqual([]);
});

it('keeps the same-person send when refresh retires the channel cache before dispatch', async () => {
  const { writer } = await prepare();
  const expiring = jwtFor(officer, Math.floor(Date.now() / 1000) + 30, 'refresh-with-cache-retirement');
  await port.shared!.auth.setSession({ access_token: expiring, refresh_token: 'refresh-a' });
  const subscription = port.shared!.auth.onAuthStateChange((event) => {
    if (event === 'TOKEN_REFRESHED') liveChannelStore.resetForSession();
  }).data.subscription;
  try {
    const outcome = await liveChannelStore.sendOutcome(writer, officer, 'A draft', '', '');
    expect(refreshes).toBe(1);
    expect(outcome).toMatchObject({ acknowledged: true, continuationCurrent: false });
    expect(rpcRequests.map((request) => request.authorization)).toEqual([`Bearer ${refreshedToken}`]);
    expect(liveChannelStore.channels()).toEqual([]);
  } finally { subscription.unsubscribe(); }
});

it.each<'refresh' | 'renewed sign-in' | 'refresh with cache retirement'>(['refresh', 'renewed sign-in', 'refresh with cache retirement'])('rechecks the first-post token after thread creation across same-person %s', async (change) => {
  threadless = true;
  const { writer } = await prepare();
  const now = Date.now();
  const expiring = jwtFor(officer, Math.floor(now / 1000) + 120, 'thread-start');
  await port.shared!.auth.setSession({ access_token: expiring, refresh_token: 'thread-start-a' });
  const subscription = port.shared!.auth.onAuthStateChange((event) => {
    if (event === 'TOKEN_REFRESHED' && change === 'refresh with cache retirement') liveChannelStore.resetForSession();
  }).data.subscription;
  let restoreClock: (() => void) | undefined;
  afterDispatch = async () => {
    if (change !== 'renewed sign-in') { const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120000); restoreClock = () => clock.mockRestore(); }
    else await port.shared!.auth.setSession({ access_token: officerAgainToken, refresh_token: 'renewed-a' });
  };
  try {
    const outcome = await liveChannelStore.sendOutcome(writer, conversationID, 'A first post', '', '');
    expect(outcome).toMatchObject({ acknowledged: true, continuationCurrent: change !== 'refresh with cache retirement' });
    expect(rpcRequests.map((request) => new URL(request.url).pathname)).toEqual(['/rest/v1/chapter_threads', '/rest/v1/chapter_thread_posts']);
    expect(rpcRequests.map((request) => request.authorization)).toEqual([`Bearer ${expiring}`, `Bearer ${change !== 'renewed sign-in' ? refreshedToken : officerAgainToken}`]);
    expect(refreshes).toBe(change !== 'renewed sign-in' ? 1 : 0);
    if (change === 'refresh with cache retirement') expect(liveChannelStore.channels()).toEqual([]);
  } finally { restoreClock?.(); subscription.unsubscribe(); }
});

it('constructs captured SDK clients without an Auth API or Auth listener', async () => {
  const { writer } = await prepare();
  const client = await writer.client();
  expect(() => client.auth.getSession).toThrow(/configured with the accessToken option/);
  expect(() => client.auth.onAuthStateChange).toThrow(/configured with the accessToken option/);
  expect(client.getChannels()).toEqual([]);
  expect(client.realtime.isConnected()).toBe(false);
  await client.rpc('send_member_message', { p_body: 'A draft', p_conversation_id: conversationID });
  expect(rpcRequests.map((request) => request.authorization)).toEqual([`Bearer ${officerToken}`]);
});
