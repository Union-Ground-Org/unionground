import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, processLock, type SupabaseClient } from '@supabase/supabase-js';

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099 part 4, review R-9235 R1): an invitation change belongs to the
// account that started it. With the real Supabase client and its auth lock, a
// second account signing in while the change waits must never lend the change
// its token: the request is not sent, or it carries the first account's token.

const port = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('./supabase', () => ({ getSupabaseClient: () => port.client }));
vi.mock('../lib/config', () => ({ mobileConfig: {
  backendConfigured: true, supabaseUrl: 'https://unionground-sample.supabase.co',
  portalBaseUrl: 'https://sample.unionground.example',
} }));

import {
  invitationIsActionable,
  loadChapterInvitations,
  resendChapterInvitation,
  revokeChapterInvitation,
  sendChapterInvitation,
  type InvitationSession,
} from './chapterInvitations';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const firstUser = '11111111-1111-4111-8111-111111111111';
const secondUser = '22222222-2222-4222-8222-222222222222';
const invitationId = '33333333-3333-4333-8333-333333333333';
const fields = { fullName: 'Synthetic invitee', email: 'fixture@example.org', chapterId: 'chapter-fixture', locale: 'en' as const };
const jwt = (sub: string) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub, exp: 9999999999, role: 'authenticated' })).toString('base64url'),
  'sig0',
].join('.');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const firstToken = jwt(firstUser);
const secondToken = jwt(secondUser);
const firstSession: InvitationSession = { access_token: firstToken, user: { id: firstUser } };

type Action = 'create' | 'resend' | 'revoke';
const write = (action: Action, session: InvitationSession | null) => (action === 'create'
  ? sendChapterInvitation(session, fields)
  : action === 'resend' ? resendChapterInvitation(session, invitationId) : revokeChapterInvitation(session, invitationId));

// A real client whose user lookups answer with the account the token names;
// the second account's answer waits until the test releases it.
async function realClient(name: string) {
  const secondRequested = deferred<void>();
  const secondAnswer = deferred<Response>();
  const transport = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).get('Authorization') === `Bearer ${secondToken}`) {
      secondRequested.resolve();
      return secondAnswer.promise;
    }
    return json({ id: firstUser });
  };
  const client = createClient('https://auth-fixture.invalid', 'sb_publishable_fixture', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock, lockAcquireTimeout: -1, storageKey: `invitations-${name}` },
    global: { fetch: transport },
  });
  expect((await client.auth.setSession({ access_token: firstToken, refresh_token: 'fixture-first' })).error).toBeNull();
  port.client = client;
  return { client, secondRequested, releaseSecond: () => secondAnswer.resolve(json({ id: secondUser })) };
}

function captureRequests() {
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { requests.push(init); return json({ accepted: true }, 202); }));
  return requests;
}

afterEach(() => {
  void port.client?.auth?.stopAutoRefresh();
  port.client = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each<Action>(['create', 'resend', 'revoke'])('the %s change', (action) => {
  it('is not sent when another account signs in while it waits on the auth lock', async () => {
    const { client, secondRequested, releaseSecond } = await realClient(`${action}-replaced`);
    const requests = captureRequests();
    // The first officer's screen is still up; a second account is signing in.
    const replacing = client.auth.setSession({ access_token: secondToken, refresh_token: 'fixture-second' });
    await secondRequested.promise;
    const writing = write(action, firstSession);
    releaseSecond();
    await replacing;
    await expect(writing).rejects.toMatchObject({ code: 'session-expired' });
    expect(requests).toHaveLength(0);
  });

  it('carries only the starting session\'s token while that account is still signed in', async () => {
    await realClient(`${action}-same`);
    const requests = captureRequests();
    await write(action, firstSession);
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0]?.headers).get('Authorization')).toBe(`Bearer ${firstToken}`);
    expect(JSON.parse(String(requests[0]?.body)).action).toBe(action);
  });

  it('sends nothing without a starting session', async () => {
    await realClient(`${action}-none`);
    const requests = captureRequests();
    await expect(write(action, null)).rejects.toMatchObject({ code: 'session-expired' });
    expect(requests).toHaveLength(0);
  });
});

describe('invitation statuses', () => {
  it('keeps the server\'s statuses and offers changes where the website does', async () => {
    const statuses = ['pending', 'accepting', 'accepted', 'revoked', 'delivery_failed', 'expired', 'superseded', 'something-new'];
    const answer = { chapter: { id: 'c', name: 'Fixture' }, items: statuses.map((status, index) => ({ id: `inv-${index}`, normalizedEmail: 'a@example.org', fullName: 'A', status })) };
    port.client = createClient('https://rest-fixture.invalid', 'sb_publishable_fixture', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'invitations-statuses' },
      global: { fetch: async () => json(answer) },
    });
    const desk = await loadChapterInvitations();
    expect(desk.items.map((item) => item.status)).toEqual(['pending', 'accepting', 'accepted', 'revoked', 'delivery_failed', 'expired', 'superseded', 'unknown']);
    expect(desk.items.filter((item) => invitationIsActionable(item.status)).map((item) => item.status)).toEqual(['pending', 'delivery_failed', 'expired']);
  });
});
