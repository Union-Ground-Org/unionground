import { describe, expect, it, vi } from 'vitest';
import { nativeSignInPlatform, PASSWORD_SIGN_IN_FAILED, PASSWORD_SIGN_IN_RATE_LIMITED, PASSWORD_SIGN_IN_UNREACHABLE, signInThroughPortalPasswordProxy } from './passwordSignIn';

// SEC-UG-NATIVE-PASSKEY-FAILED-LOGIN-TELEMETRY-20260921: native password
// sign-in goes through the portal proxy that records refused attempts, and
// every server answer stays one flat public error. Only the proxy's 429 and a
// fetch that rejects before any response say something else, and neither
// reveals whether the address has an account.
function reply(status: number, payload: unknown, json: () => Promise<unknown> = async () => payload) {
  return { ok: status >= 200 && status < 300, status, json } as Response;
}

const input = { portalOrigin: 'https://sample.unionground.example', email: 'member@example.com', password: 'long-password', platform: 'ios' as const };

describe('native password sign-in through the portal proxy', () => {
  it('posts the credentials and platform to the proxy and installs the returned session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { accessToken: 'access', refreshToken: 'refresh' }));
    const setSession = vi.fn().mockResolvedValue({ error: null });
    await signInThroughPortalPasswordProxy(input, { fetch: fetchMock, setSession });
    expect(fetchMock).toHaveBeenCalledWith('https://sample.unionground.example/api/auth-password-signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.com', password: 'long-password', client: 'ios' }),
    });
    expect(setSession).toHaveBeenCalledWith({ access_token: 'access', refresh_token: 'refresh' });
  });

  it('omits the platform when the OS is not a native one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { accessToken: 'a', refreshToken: 'r' }));
    await signInThroughPortalPasswordProxy({ ...input, platform: null }, { fetch: fetchMock, setSession: async () => ({ error: null }) });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toEqual({ email: 'member@example.com', password: 'long-password' });
    expect(nativeSignInPlatform('ios')).toBe('ios');
    expect(nativeSignInPlatform('android')).toBe('android');
    expect(nativeSignInPlatform('web')).toBeNull();
  });

  it('gives a refusal, a bad request, an outage, a malformed reply and a refused session the same error', async () => {
    const cases: Array<[() => Promise<Response>, { error: unknown }]> = [
      [async () => reply(400, { error: 'invalid-request' }), { error: null }],
      [async () => reply(401, { error: 'sign-in-failed' }), { error: null }],
      [async () => reply(503, { error: 'sign-in-unavailable' }), { error: null }],
      [async () => reply(200, { accessToken: 'a' }), { error: null }],
      [async () => reply(200, { accessToken: 'a', refreshToken: 'r' }), { error: new Error('invalid JWT') }],
    ];
    for (const [fetchImpl, sessionResult] of cases) {
      const setSession = vi.fn().mockResolvedValue(sessionResult);
      await expect(signInThroughPortalPasswordProxy(input, { fetch: vi.fn(fetchImpl), setSession }))
        .rejects.toThrow(new Error(PASSWORD_SIGN_IN_FAILED));
    }
  });

  // BUG-UG-NATIVE-NO-SIGNAL-SHOWN-AS-WRONG-PASSWORD-20261018: when
  // fetch rejects, no server saw the attempt, so the member is told to check
  // the connection rather than the password it never checked.
  it('tells the person to check the connection when fetch rejects before any response', async () => {
    const setSession = vi.fn();
    for (const failure of [new TypeError('Network request failed'), new Error('getaddrinfo ENOTFOUND app.unionground.example'), 'aborted']) {
      await expect(signInThroughPortalPasswordProxy(input, {
        fetch: vi.fn(async () => { throw failure; }),
        setSession,
      })).rejects.toThrow(new Error(PASSWORD_SIGN_IN_UNREACHABLE));
    }
    expect(setSession).not.toHaveBeenCalled();
    expect(PASSWORD_SIGN_IN_UNREACHABLE).not.toBe(PASSWORD_SIGN_IN_FAILED);
    expect(PASSWORD_SIGN_IN_UNREACHABLE).not.toMatch(/password|account|email/i);
  });

  it('keeps the flat message when the reply body cannot be read or the session install throws', async () => {
    const brokenBody = reply(200, null, async () => { throw new TypeError('Network request failed'); });
    await expect(signInThroughPortalPasswordProxy(input, { fetch: vi.fn(async () => brokenBody), setSession: vi.fn() }))
      .rejects.toThrow(new Error(PASSWORD_SIGN_IN_FAILED));
    await expect(signInThroughPortalPasswordProxy(input, {
      fetch: vi.fn(async () => reply(200, { accessToken: 'a', refreshToken: 'r' })),
      setSession: vi.fn(async () => { throw new TypeError('Network request failed'); }),
    })).rejects.toThrow(new Error(PASSWORD_SIGN_IN_FAILED));
  });

  // SEC-UG-PASSWORD-SIGNIN-THROTTLE-20261001: the proxy's 429 is the same
  // for every address, so the app says to wait instead of blaming the password.
  it('tells the person to wait when the proxy throttles the attempt', async () => {
    const setSession = vi.fn();
    await expect(signInThroughPortalPasswordProxy(input, {
      fetch: vi.fn(async () => reply(429, { error: 'try-later' })),
      setSession,
    })).rejects.toThrow(new Error(PASSWORD_SIGN_IN_RATE_LIMITED));
    expect(setSession).not.toHaveBeenCalled();
    expect(PASSWORD_SIGN_IN_RATE_LIMITED).not.toMatch(/password|account|email/i);
  });
});
