import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptEmailInvitation, beginEmailPasswordReset, finishEmailPasswordReset, passwordResetRequestAvailable,
  requestEmailPasswordReset, resetRequestEmailValid, signedInResetAccount, type EmailAuthFailure } from './emailAuth';
import { normalizeResetEmail } from '../../../../api/_lib/passwordReset.js';
import { legalAcceptanceVersions } from '../lib/legalAcceptance';

const versions = legalAcceptanceVersions();

const config = vi.hoisted(() => ({ backendConfigured: true, supabaseUrl: 'https://unionground-live.supabase.co', portalBaseUrl: 'https://app.unionground.example' }));
vi.mock('../lib/config', () => ({ mobileConfig: config }));
const fetcher = vi.fn<typeof fetch>();
function reply(payload: unknown, status = 200) {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status }));
}
beforeEach(() => { config.backendConfigured = true; config.portalBaseUrl = 'https://app.unionground.example'; fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('native email acceptance and two-step reset', () => {
  it('accepts an invitation only through the existing endpoint and never retains a returned session', async () => {
    reply({ accepted: true, access_token: 'must-not-retain', password: 'must-not-retain' });
    expect(await acceptEmailInvitation('one-time-invitation', versions, 'TX', true)).toEqual({ status: 'accepted', reactivated: false });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://app.unionground.example/api/accept-invitation');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Origin: 'https://app.unionground.example' });
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ token: 'one-time-invitation', acceptedVersions: versions, residenceState: 'TX', ageAttested: true });
  });

  // #8175: the optional referral code goes with the acceptance, as on the web.
  it('sends a referral code only when one was entered', async () => {
    reply({ accepted: true });
    reply({ accepted: true });
    reply({ accepted: true });
    await acceptEmailInvitation('invitation', versions, 'TX', true, ' 0a1b-2c3d-4e5f ');
    await acceptEmailInvitation('invitation', versions, 'TX', true, '   ');
    await acceptEmailInvitation('invitation', versions, 'TX', true);
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies[0]).toEqual({ token: 'invitation', acceptedVersions: versions, residenceState: 'TX', ageAttested: true, referralCode: '0a1b-2c3d-4e5f' });
    expect(bodies[1]).not.toHaveProperty('referralCode');
    expect(bodies[2]).not.toHaveProperty('referralCode');
  });

  it('recognizes restored membership without inventing a new password', async () => {
    reply({ accepted: true, reactivated: true });
    expect(await acceptEmailInvitation('invitation', versions, 'TX', true)).toEqual({ status: 'accepted', reactivated: true });
  });

  it.each([410, 429, 503])('returns a fixed safe failure for invitation HTTP %s', async (status) => {
    reply({ error: 'private backend detail' }, status);
    expect(await acceptEmailInvitation('expired', versions, 'TX', true)).toEqual({ status: status === 410 ? 'link-invalid' : status === 429 ? 'rate-limited' : 'unavailable' });
  });

  it('reports a stale displayed pack instead of inviting another identical retry', async () => {
    reply({ error: 'terms-version-stale', versions: { 'terms-of-use': '9.9.9' } }, 409);
    expect(await acceptEmailInvitation('invitation', versions, 'TX', true)).toEqual({ status: 'terms-version-stale' });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ token: 'invitation', acceptedVersions: versions, residenceState: 'TX', ageAttested: true });
  });

  it('does not cross the SAMPLE or unconfigured backend boundary', async () => {
    config.portalBaseUrl = 'https://sibling-saas.example';
    expect(await acceptEmailInvitation('invitation', versions, 'TX', true)).toEqual({ status: 'unavailable' });
    expect(await beginEmailPasswordReset('ticket')).toEqual({ status: 'unavailable' });
    expect(await requestEmailPasswordReset('member@example.org', 'en')).toEqual({ status: 'unavailable' });
    expect(passwordResetRequestAvailable()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requests a reset email through the existing endpoint with the trimmed address and locale', async () => {
    reply({ accepted: true });
    expect(passwordResetRequestAvailable()).toBe(true);
    expect(await requestEmailPasswordReset('  member@example.org ', 'es')).toEqual({ status: 'sent' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://app.unionground.example/api/password-reset');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Origin: 'https://app.unionground.example' });
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'request', email: 'member@example.org', locale: 'es' });
  });

  it.each(['member@example.org', ' Member@Example.ORG ', 'member@gmail', 'member@', '@example.org', 'member example@test.org',
    'a@b.c', `${'a'.repeat(242)}@example.org`, `${'a'.repeat(243)}@example.org`, ''])(
    'accepts %j exactly when the route would mail it', async (address) => {
      expect(resetRequestEmailValid(address)).toBe(normalizeResetEmail(address) !== '');
    });

  it('never asks the route for an address it would accept without sending mail', async () => {
    expect(await requestEmailPasswordReset('member@gmail', 'en')).toEqual({ status: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('gives up on a stalled reset request after 15 seconds, since it spends nothing', async () => {
    vi.useFakeTimers();
    fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private timeout detail')));
    }));
    let settled = false;
    const pending = requestEmailPasswordReset('member@example.org', 'en').finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(vi.getTimerCount()).toBe(0);
  });

  const requestFailures: [number, EmailAuthFailure][] = [[429, 'rate-limited'], [503, 'unavailable'], [200, 'unavailable']];
  it.each(requestFailures)(
    'returns a fixed safe failure for a reset request answered with HTTP %s', async (status, expected) => {
      reply(status === 200 ? { accepted: 'yes' } : { error: 'private backend detail' }, status);
      expect(await requestEmailPasswordReset('member@example.org', 'en')).toEqual({ status: expected });
    });

  it('keeps the recovery session server-side for both authenticator modes', async () => {
    for (const mode of ['challenge', 'enroll']) {
      reply({ mode, state: 'sealed-state', secret: 'A'.repeat(32), access_token: 'must-not-retain' });
      expect(await beginEmailPasswordReset('ticket')).toEqual({ status: mode, state: 'sealed-state', secret: 'A'.repeat(32) });
    }
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ action: 'begin', token: 'ticket' });
  });

  it('requires usable enrollment material instead of rendering an incomplete setup', async () => {
    reply({ mode: 'enroll', state: 'sealed-state' });
    expect(await beginEmailPasswordReset('ticket')).toEqual({ status: 'unavailable' });
  });

  it.each([429, 502, 503])('preserves possible mutation before generic HTTP %s handling', async (status) => {
    reply({ error: 'reset-invalidated', reason: 'reset-unavailable' }, status);
    expect(await beginEmailPasswordReset('ticket')).toEqual({ status: 'reset-invalidated', reason: status === 429 ? 'rate-limited' : 'unavailable' });
  });

  it('keeps the staff-only reason after invalidation', async () => {
    reply({ error: 'reset-invalidated', reason: 'two-step-unavailable' }, 409);
    expect(await beginEmailPasswordReset('ticket')).toEqual({ status: 'reset-invalidated', reason: 'two-step-unavailable' });
  });

  it('finishes only through server-enforced two-step verification and reports incomplete revocation', async () => {
    reply({ completed: true, sessionsEnded: false, access_token: 'must-not-retain' });
    expect(await finishEmailPasswordReset('sealed-state', '123456', 'new-private-password')).toEqual({ status: 'completed', sessionsEnded: false, recoveryCodeUsed: false });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ action: 'finish', state: 'sealed-state', code: '123456', password: 'new-private-password' });
  });

  it('reports that a recovery code was spent only when the server says so', async () => {
    reply({ completed: true, sessionsEnded: true, recoveryCodeUsed: true });
    expect(await finishEmailPasswordReset('sealed-state', 'UG-ABCD-1234-ABCD-1234', 'new-private-password'))
      .toEqual({ status: 'completed', sessionsEnded: true, recoveryCodeUsed: true });
  });

  it.each(['link-invalid', 'code-not-accepted', 'password-rejected', 'two-step-unavailable', 'recovery-incomplete', 'recovery-unfinished', 'recovery-held', 'email-domain-blocked'])('keeps %s failures closed', async (error) => {
    reply({ error }, 400);
    expect(await finishEmailPasswordReset('state', '123456', 'password')).toEqual({ status: error });
  });

  it('ends a stalled network request after the bounded budget', async () => {
    vi.useFakeTimers();
    fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private timeout detail')));
    }));
    // Every call outwaits the server's link-spending chain.
    for (const call of [() => acceptEmailInvitation('ticket', versions, 'TX', true), () => beginEmailPasswordReset('ticket'),
      () => finishEmailPasswordReset('state', '123456', 'password')]) {
      let settled = false;
      const pending = call().finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(119_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({ status: 'unavailable' });
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  // BUG-UG-AUTHENTICATED-NATIVE-RESET-RESUME-20261021: Account reads
  // the signed-in account's reset tag with the member's own bearer.
  it('reads the signed-in reset tag with the worker bearer, and nothing else', async () => {
    reply({ account: 'a1.AAAAAAAAAAAAAAAAAAAAAA', extra: 'ignored' });
    expect(await signedInResetAccount('member-token')).toBe('a1.AAAAAAAAAAAAAAAAAAAAAA');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://app.unionground.example/api/password-reset');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Origin: 'https://app.unionground.example', Authorization: 'Bearer member-token' });
    expect(init?.credentials).toBe('omit');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'account' });
  });

  it('answers no tag for a refusal, a malformed tag, no token or another backend', async () => {
    reply({ error: 'not-signed-in' }, 401);
    expect(await signedInResetAccount('stale')).toBeNull();
    reply({ account: 'user-1111' });
    expect(await signedInResetAccount('member-token')).toBeNull();
    expect(await signedInResetAccount('')).toBeNull();
    config.portalBaseUrl = 'https://sibling-saas.example';
    expect(await signedInResetAccount('member-token')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
