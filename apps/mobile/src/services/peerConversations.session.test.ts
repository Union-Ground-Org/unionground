import { createSessionBoundWriter } from '../../../../src/lib/sessionBoundWriter.js';
import { createClient, processLock, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SEC-UG-PRIVATE-MESSAGE-SEND-GOES-OUT-UNDER-WHOEVER-IS-SIGNED-IN-20261119
// (#9203): a private two-person write must carry the session of the person
// who started it. This drives the real pinned Supabase client with the app's
// auth process lock (no network: the transport is intercepted, the tokens are
// synthetic). The shared client is signed in as the officer; an account change
// to the member starts and is held on its /auth/v1/user answer while the
// officer's write is made. Before the repair the write waited on the lock and
// left with the member's token (R-9202-RESULT.md, A1).
const port = vi.hoisted(() => ({
  shared: null as SupabaseClient | null,
  captured: [] as string[],
  transport: null as null | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
}));
const URL_BASE = 'https://peer-session-test.invalid';
const KEY = 'sb_publishable_test';
vi.mock('./supabase', () => ({
  captureSessionWriter: (session: Session) => createSessionBoundWriter({ session, sharedClient: port.shared, createSessionClient: (current: Session) => {
    port.captured.push(current.user.id);
    const token = current.access_token;
    return createClient(URL_BASE, KEY, { accessToken: async () => token, global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => port.transport!(input, init) }, auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  } }),
  getSupabaseClient: () => port.shared,
  // As apps/mobile/src/services/supabase.ts builds it: the access token is
  // fixed to the captured session, with no auth state of its own.
  createCapturedSessionRpcClient: (session: Session) => {
    port.captured.push(session.user.id);
    const token = session.access_token;
    return createClient(URL_BASE, KEY, {
      accessToken: async () => token,
      global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => port.transport!(input, init) },
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  },
}));

import { PeerBlockNotChanged, PeerMessageNotSent, OfficerConversationNotStarted } from '../lib/peerConversations';
import { sendMyPeerMessage, setMyPeerConversationBlock, startMyOfficerConversation } from './peerConversations';

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

let rpcRequests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
let memberUser = deferred<Response>();
let memberUserAsked = deferred<void>();

function rpcAnswer(url: string): Response {
  if (url.endsWith('/rpc/send_reward_peer_message')) return json({ message: { id: 'saved-1', body: 'Bring the overtime list', createdAt: '2026-11-19T10:00:00.000Z' } });
  if (url.endsWith('/rpc/set_peer_conversation_block')) return json({ id: conversationID, state: 'blocked_by_viewer' });
  return json({ created: true, message: { id: 'saved-2', body: 'Hello', createdAt: '2026-11-19T10:00:00.000Z' }, conversation: { id: conversationID, peerName: 'Rosa Delgado', peerInitials: 'RD', updatedAt: '2026-11-19T10:00:00.000Z' } });
}

beforeEach(async () => {
  rpcRequests = [];
  refreshes = 0;
  port.captured = [];
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
    rpcRequests.push({ url, authorization, body: init?.body ? JSON.parse(String(init.body)) : null });
    return rpcAnswer(url);
  };
  port.shared = createClient(URL_BASE, KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => port.transport!(input, init) },
  });
  expect((await port.shared.auth.setSession({ access_token: officerToken, refresh_token: 'refresh-officer' })).error).toBeNull();
});
afterEach(() => { port.shared = null; });

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

describe('a private two-person write while the account changes', () => {
  const writers: Array<[string, (session: Session) => Promise<unknown>, new (...args: never[]) => Error]> = [
    ['a reply', (session) => sendMyPeerMessage(session, conversationID, 'Bring the overtime list'), PeerMessageNotSent],
    ['a block', (session) => setMyPeerConversationBlock(session, conversationID, true), PeerBlockNotChanged],
    ['a first message to an officer', (session) => startMyOfficerConversation(session, member, 'Hello'), OfficerConversationNotStarted],
  ];

  it.each(writers)('never sends %s under the next person\'s token, and refuses it', async (_label, write, refusal) => {
    const session = await officerSession();
    const release = await holdAccountChange();
    const pending = write(session);
    pending.catch(() => undefined);
    expect(rpcRequests).toEqual([]);
    await release();
    await pending.catch(() => undefined);
    // The defect: the officer's write left with the member's token.
    expect(rpcRequests.map((request) => request.authorization)).not.toContain(`Bearer ${memberToken}`);
    expect(rpcRequests).toEqual([]);
    await expect(pending).rejects.toBeInstanceOf(refusal);
  });

  it.each(writers)('refuses %s from a screen whose person is no longer the one signed in', async (_label, write, refusal) => {
    const session = await officerSession();
    const release = await holdAccountChange();
    await release();
    await expect(write(session)).rejects.toBeInstanceOf(refusal);
    expect(rpcRequests).toEqual([]);
  });

  it.each(writers)('sends %s with the starting person\'s own token when nothing changed', async (_label, write) => {
    const session = await officerSession();
    await write(session);
    expect(rpcRequests).toHaveLength(1);
    expect(rpcRequests[0]!.authorization).toBe(`Bearer ${officerToken}`);
    expect(port.captured).toEqual([officer]);
  });

  it('refuses every write with no session, and sends nothing', async () => {
    await expect(sendMyPeerMessage(null, conversationID, 'Hi')).rejects.toBeInstanceOf(PeerMessageNotSent);
    await expect(setMyPeerConversationBlock(null, conversationID, true)).rejects.toBeInstanceOf(PeerBlockNotChanged);
    await expect(startMyOfficerConversation(null, member, 'Hi')).rejects.toBeInstanceOf(OfficerConversationNotStarted);
    expect(rpcRequests).toEqual([]);
  });

  it('sends the body the person wrote, to the conversation they wrote in', async () => {
    await sendMyPeerMessage(await officerSession(), conversationID, '  Bring the overtime list  ');
    expect(rpcRequests[0]).toMatchObject({ url: `${URL_BASE}/rest/v1/rpc/send_reward_peer_message`, body: { p_conversation_id: conversationID, p_body: 'Bring the overtime list' } });
  });
});

// #9229 round 1 (r1s3): the binding is the person, not the token. Pinning the
// screen's own token refused a legitimate write once the same person's token
// was refreshed; now the write goes with the token the check itself read.
describe('a private two-person write after the same person\'s session changes', () => {
  const writers: Array<[string, (session: Session) => Promise<unknown>]> = [
    ['a reply', (session) => sendMyPeerMessage(session, conversationID, 'Bring the overtime list')],
    ['a block', (session) => setMyPeerConversationBlock(session, conversationID, true)],
    ['a first message to an officer', (session) => startMyOfficerConversation(session, member, 'Hello')],
  ];

  it.each(writers)('sends %s with the refreshed token, not the screen\'s expiring one', async (_label, write) => {
    // A token inside auth-js's refresh margin: the check's read refreshes it.
    const expiring = jwtFor(officer, Math.floor(Date.now() / 1000) + 30, 'expiring');
    const screen = (await port.shared!.auth.setSession({ access_token: expiring, refresh_token: 'refresh-officer' })).data.session;
    expect(screen?.access_token).toBe(expiring);
    await write(screen!);
    expect(refreshes).toBe(1);
    expect(rpcRequests.map((request) => request.authorization)).toEqual([`Bearer ${refreshedToken}`]);
    expect(port.captured).toEqual([officer]);
  });

  it.each(writers)('sends %s after the same person signs in again, with the new session\'s token', async (_label, write) => {
    const session = await officerSession();
    expect((await port.shared!.auth.setSession({ access_token: officerAgainToken, refresh_token: 'refresh-officer-again' })).error).toBeNull();
    await write(session);
    expect(rpcRequests.map((request) => request.authorization)).toEqual([`Bearer ${officerAgainToken}`]);
  });
});
