import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_BACKENDS } from '../test/backends';

const mocks = vi.hoisted(() => ({
  config: { backendConfigured: true, supabaseUrl: 'https://unionground-live.supabase.co', portalBaseUrl: 'https://app.unionground.example' },
  rpc: vi.fn(), captured: vi.fn(),
}));
vi.mock('../lib/config', () => ({ mobileConfig: mocks.config }));
vi.mock('./supabase', () => ({ createCapturedSessionRpcClient: mocks.captured }));

import { loadMemberInvitationAccess, loadMemberInvitationsEnabled, MemberInvitationError, memberInvitationNotice, sendMemberInvitation } from './memberInvitations';

// This edition ships no hosted pair; the test setup trusts two fictional ones.
const SAMPLE_SUPABASE_ORIGIN = TEST_BACKENDS.sample.supabaseUrl;
const UNION_GROUND_PORTAL_ORIGIN = TEST_BACKENDS.live.portal;
const UNION_GROUND_SUPABASE_ORIGIN = TEST_BACKENDS.live.supabaseUrl;

const session = { access_token: 'member-session-token', user: { id: 'member-a' } } as Session;
const fields = { fullName: ' Alex Worker ', email: ' alex@example.test ', locale: 'es' };
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const readFailures: [{ code?: string; status?: number; message?: string }, 'disabled' | 'unavailable'][] = [
  [{ code: '42501' }, 'disabled'], [{ status: 403 }, 'disabled'],
  [{ code: 'PGRST301' }, 'unavailable'], [{ status: 401 }, 'unavailable'],
  [{ message: 'offline' }, 'unavailable'],
];

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.config, { backendConfigured: true, supabaseUrl: UNION_GROUND_SUPABASE_ORIGIN, portalBaseUrl: UNION_GROUND_PORTAL_ORIGIN });
  mocks.captured.mockReturnValue({ rpc: mocks.rpc });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('native worker invitations switch', () => {
  it.each([401, 403])('classifies outer HTTP %s with an inner refreshable code', async (status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST303' }, status });
    await expect(loadMemberInvitationAccess(session)).resolves.toBe(status === 403 ? 'disabled' : 'unavailable');
  });
  it.each(readFailures)('distinguishes confirmed access loss from a recoverable read: %j', async (error, expected) => {
    mocks.rpc.mockResolvedValue({ data: null, error });
    await expect(loadMemberInvitationAccess(session)).resolves.toBe(expected);
    mocks.rpc.mockRejectedValue(error);
    await expect(loadMemberInvitationAccess(session)).resolves.toBe(expected);
  });
  it('reads the member-visible configuration with the captured session', async () => {
    mocks.rpc.mockResolvedValue({ data: { switches: { 'features.member_invitations.enabled': true } }, error: null });
    await expect(loadMemberInvitationsEnabled(session)).resolves.toBe(true);
    expect(mocks.captured).toHaveBeenCalledWith(session);
    expect(mocks.rpc).toHaveBeenCalledWith('get_member_organization_configuration');
  });
  it.each([null, {}, { switches: {} }, { switches: { 'features.member_invitations.enabled': false } }, { switches: { 'features.member_invitations.enabled': 'true' } }])('hides the form unless the switch is exactly true: %j', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(loadMemberInvitationsEnabled(session)).resolves.toBe(false);
  });
  it('fails closed on a refused or rejected read', async () => {
    mocks.rpc.mockResolvedValue({ data: { switches: { 'features.member_invitations.enabled': true } }, error: { message: 'refused' } });
    await expect(loadMemberInvitationsEnabled(session)).resolves.toBe(false);
    mocks.rpc.mockRejectedValue(new Error('offline'));
    await expect(loadMemberInvitationsEnabled(session)).resolves.toBe(false);
  });
  it('bounds an unreadable configuration', async () => {
    vi.useFakeTimers();
    mocks.rpc.mockImplementation(() => new Promise(() => {}));
    const pending = loadMemberInvitationsEnabled(session);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toBe(false);
  });
});

describe('native worker invitation transport', () => {
  it('posts only member-send, name, email and language with the worker’s own bearer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(202, { accepted: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(sendMemberInvitation(session, fields)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://app.unionground.example/api/admin-invitations');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer member-session-token', 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'member-send', fullName: 'Alex Worker', email: 'alex@example.test', locale: 'es' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('normalizes an unsupported invitee language to English', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(202, { accepted: true }));
    vi.stubGlobal('fetch', fetcher);
    await sendMemberInvitation(session, { ...fields, locale: 'fr' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).locale).toBe('en');
  });
  it.each([
    { supabaseUrl: SAMPLE_SUPABASE_ORIGIN, portalBaseUrl: UNION_GROUND_PORTAL_ORIGIN },
    { supabaseUrl: 'https://another.example.test', portalBaseUrl: UNION_GROUND_PORTAL_ORIGIN },
    { supabaseUrl: UNION_GROUND_SUPABASE_ORIGIN, portalBaseUrl: 'https://another.example.test' },
    { backendConfigured: false },
  ])('refuses configurations without an approved backend pair before any network call: %j', async (config) => {
    Object.assign(mocks.config, config);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(loadMemberInvitationsEnabled(session)).resolves.toBe(false);
    await expect(sendMemberInvitation(session, fields)).rejects.toMatchObject({ code: 'not-permitted' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.captured).not.toHaveBeenCalled();
  });
  it('refuses a missing bearer before reading or sending', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const expired = { ...session, access_token: '' };
    await expect(loadMemberInvitationsEnabled(expired)).resolves.toBe(false);
    await expect(sendMemberInvitation(expired, fields)).rejects.toMatchObject({ code: 'not-permitted' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.captured).not.toHaveBeenCalled();
  });
  it.each(['not-permitted', 'email-domain-blocked', 'service-unavailable', 'delivery-unavailable', 'delivery-status-unavailable', 'unknown'])('carries a plain refusal for %s without server prose', async (code) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(403, { error: code, message: 'address already registered' })));
    await expect(sendMemberInvitation(session, fields)).rejects.toMatchObject({ code });
  });
  it('keeps valid rate metadata for the Eastern retry answer', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(429, { error: 'rate-limited', retryAt: '2026-11-12T01:30:00Z', limit: 'member_daily' })));
    await expect(sendMemberInvitation(session, fields)).rejects.toMatchObject({ code: 'rate-limited', retryAt: '2026-11-12T01:30:00Z' });
  });
  it.each([{}, null, { accepted: false }, { accepted: 'true' }])('never announces a malformed success: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(200, body)));
    await expect(sendMemberInvitation(session, fields)).rejects.toBeInstanceOf(MemberInvitationError);
  });
  it('bounds both a never-settling request and a stalled response body without resending', async () => {
    vi.useFakeTimers();
    for (const fetcher of [
      vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
      vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response),
    ]) {
      vi.stubGlobal('fetch', fetcher);
      const pending = sendMemberInvitation(session, fields).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toBeInstanceOf(MemberInvitationError);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    }
  });
});

describe('private, English invitation answers', () => {
  it('translates success, failures and the Eastern retry time into Spanish', () => {
    expect(memberInvitationNotice(undefined, 'es')).toBe('Si esa dirección puede recibir una invitación, ya va en camino. Es válida durante 15 minutos.');
    expect(memberInvitationNotice(new MemberInvitationError('not-permitted'), 'es')).toContain('Su cuenta no puede enviar invitaciones');
    expect(memberInvitationNotice(new MemberInvitationError('email-domain-blocked'), 'es')).toContain('Use un correo personal.');
    expect(memberInvitationNotice(new Error('private server details'), 'es')).toBe('No se pudo enviar la invitación. Revísela e inténtelo de nuevo.');
    expect(memberInvitationNotice(new MemberInvitationError('rate-limited', '2026-11-12T01:30:00Z'), 'es')).toContain('Puede enviar más después de Nov 11, 2026 · 8:30 PM ET.');
  });
  it('uses the same conditional answer for every accepted address', () => {
    expect(memberInvitationNotice()).toBe('If that address can be invited, the invitation is on its way. It works for 15 minutes.');
  });
  it.each([
    ['not-permitted', "Your account can't send invitations right now. New accounts can send invitations after their first week."],
    ['email-domain-blocked', "Use a personal email address. Government and employer email addresses can't be used for a Union Ground account."],
    ['failed', 'The invitation could not be sent. Check it and try again.'],
    ['already-registered', 'The invitation could not be sent. Check it and try again.'],
  ])('names %s in its own sentence', (code, copy) => {
    expect(memberInvitationNotice(new MemberInvitationError(code))).toBe(copy);
  });
  it.each([
    ['2026-11-12T01:30:00Z', 'Nov 11, 2026 · 8:30 PM ET'],
    ['2026-07-12T01:30:00Z', 'Jul 11, 2026 · 9:30 PM ET'],
  ])('dates a limit in Eastern time across standard and daylight time', (retryAt, time) => {
    expect(memberInvitationNotice(new MemberInvitationError('rate-limited', retryAt))).toBe(`You have sent as many invitations as you can for now. You can send more after ${time}.`);
  });
  it('does not invent a retry time from invalid metadata or expose arbitrary errors', () => {
    expect(memberInvitationNotice(new MemberInvitationError('rate-limited', 'not a date'))).toBe('The invitation could not be sent. Check it and try again.');
    expect(memberInvitationNotice(new Error('address already registered'))).toBe('The invitation could not be sent. Check it and try again.');
  });
});
