import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  adminSignOut: vi.fn(),
  getUser: vi.fn(),
  removeSessionIfMatches: vi.fn(),
}));

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      admin: { signOut: boundaries.adminSignOut },
      getUser: boundaries.getUser,
    },
  }),
  processLock: vi.fn(),
}));
vi.mock('../lib/config', () => ({
  mobileConfig: {
    backendConfigured: true,
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'publishable-test-key',
  },
}));
vi.mock('../lib/secureSessionStorage', () => ({
  createBackendScopedSessionStorage: () => ({
    removeSessionIfMatches: boundaries.removeSessionIfMatches,
  }),
}));

import * as supabaseService from './supabase';
import { classifySignOutFailure, runLocalSignOutStep } from './signOutFailure';

type RevocationError = { status?: unknown; name?: unknown; code?: unknown };
type CapturedSessionRevocation = (
  capturedAccessToken: string,
  dependencies: {
    signOut(
      accessToken: string,
      scope: 'local' | 'global',
    ): Promise<{ error: RevocationError | null }>;
    compareAndClear(): Promise<boolean>;
  },
  scope?: 'local' | 'global',
) => Promise<boolean>;

const revokeCapturedSessionWithLocalCompareAndSwap = (
  supabaseService as {
    revokeCapturedSessionWithLocalCompareAndSwap?: CapturedSessionRevocation;
  }
).revokeCapturedSessionWithLocalCompareAndSwap;

function requireRevocationHelper(): CapturedSessionRevocation {
  expect(revokeCapturedSessionWithLocalCompareAndSwap).toBeTypeOf('function');
  return revokeCapturedSessionWithLocalCompareAndSwap as CapturedSessionRevocation;
}

const capturedSession = {
  access_token: 'captured-access-token',
  refresh_token: 'captured-refresh-token',
  token_type: 'bearer',
  expires_in: 3_600,
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'captured@example.test',
    app_metadata: {},
    user_metadata: {},
    identities: [],
    created_at: '2026-09-03T12:00:00.000Z',
  },
} as Session;

describe('captured Supabase session revocation', () => {
  beforeEach(() => {
    boundaries.adminSignOut.mockReset();
    boundaries.removeSessionIfMatches.mockReset();
  });

  it('passes the captured access token to admin signOut locally before storage CAS', async () => {
    const events: string[] = [];
    boundaries.adminSignOut.mockImplementation(async (accessToken, scope) => {
      events.push(`revoke:${accessToken}:${scope}`);
      return { error: null };
    });
    boundaries.removeSessionIfMatches.mockImplementation(async () => {
      events.push('compare-and-clear');
      return true;
    });

    const cleared = await supabaseService.revokeAndClearCapturedMobileSession(capturedSession);

    expect(boundaries.adminSignOut).toHaveBeenCalledWith('captured-access-token', 'local');
    expect(boundaries.removeSessionIfMatches).toHaveBeenCalledWith(
      'org.unionground.app.auth',
      {
        accessToken: 'captured-access-token',
        refreshToken: 'captured-refresh-token',
      },
    );
    expect({ cleared, events }).toEqual({
      cleared: true,
      events: ['revoke:captured-access-token:local', 'compare-and-clear'],
    });
  });

  it('does not compare and clear local storage after a 500 revocation failure', async () => {
    let compareAndClearCalls = 0;
    const revoke = requireRevocationHelper();

    await expect(revoke('captured-access-token', {
      signOut: async () => ({ error: { status: 500 } }),
      compareAndClear: async () => {
        compareAndClearCalls += 1;
        return true;
      },
    })).rejects.toThrow('could not securely close this session');

    expect(compareAndClearCalls).toBe(0);
  });

  it.each([401, 403, 404])(
    'keeps local auth after an ambiguous %i revocation response',
    async (status) => {
      let compareAndClearCalls = 0;
      const revoke = requireRevocationHelper();

      await expect(revoke('captured-access-token', {
        signOut: async () => ({ error: { status } }),
        compareAndClear: async () => {
          compareAndClearCalls += 1;
          return true;
        },
      })).rejects.toThrow('could not securely close this session');

      expect(compareAndClearCalls).toBe(0);
    },
  );

  it('keeps a bare session_not_found body code ambiguous: auth-js never surfaces that shape', async () => {
    let compareAndClearCalls = 0;
    const revoke = requireRevocationHelper();
    await expect(revoke('captured-access-token', {
      signOut: async () => ({ error: { status: 403, code: 'session_not_found' } as RevocationError }),
      compareAndClear: async () => {
        compareAndClearCalls += 1;
        return true;
      },
    })).rejects.toThrow('could not securely close this session');
    expect(compareAndClearCalls).toBe(0);
  });

  it.each([
    // auth-js 2.110.7 raises an HTTP session_not_found as AuthSessionMissingError: status 400, no code.
    { name: 'AuthSessionMissingError', status: 400 },
  ])('clears locally when Auth reports the session is already gone (%o) (BUG-UG-MOBILE-REVOKED-SESSION-STUCK-20261002)', async (error) => {
    let compareAndClearCalls = 0;
    const revoke = requireRevocationHelper();

    await expect(revoke('captured-access-token', {
      signOut: async () => ({ error }),
      compareAndClear: async () => {
        compareAndClearCalls += 1;
        return true;
      },
    })).resolves.toBe(true);

    expect(compareAndClearCalls).toBe(1);
  });

  it('returns false when local CAS preserves a newer persisted session', async () => {
    const revoke = requireRevocationHelper();

    const cleared = await revoke('captured-access-token', {
      signOut: async () => ({ error: null }),
      compareAndClear: async () => false,
    });

    expect(cleared).toBe(false);
  });
});

// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: the same helper carries
// Account > Sessions' account-wide revoke. The scope it is given is the scope
// GoTrue is asked for, and the one shortcut the local path allows does not
// survive the widening.
describe('global revocation for sign out everywhere', () => {
  beforeEach(() => {
    boundaries.adminSignOut.mockReset();
    boundaries.removeSessionIfMatches.mockReset();
  });

  it('asks GoTrue for the user-wide logout and then clears this device', async () => {
    boundaries.adminSignOut.mockResolvedValue({ error: null });
    boundaries.removeSessionIfMatches.mockResolvedValue(true);
    await expect(supabaseService.revokeAndClearCapturedMobileSession(capturedSession, 'global')).resolves.toBe(true);
    expect(boundaries.adminSignOut).toHaveBeenCalledWith('captured-access-token', 'global');
  });

  it('refuses the already-gone shortcut, because it proves nothing about the other devices', async () => {
    // The local path clears on this answer (see the case above): the captured
    // session's row is gone, so its refresh chain is gone with it. A global
    // request never reached the user-wide delete, so the account's other
    // sessions are untouched and the member must not be told otherwise.
    let compareAndClearCalls = 0;
    const revoke = requireRevocationHelper();
    await expect(revoke('captured-access-token', {
      signOut: async () => ({ error: { name: 'AuthSessionMissingError', status: 400 } as RevocationError }),
      compareAndClear: async () => {
        compareAndClearCalls += 1;
        return true;
      },
    }, 'global')).rejects.toThrow('could not sign out your other devices');
    expect(compareAndClearCalls).toBe(0);
  });

  it('keeps the local wording and the local shortcut when no scope is given', async () => {
    const revoke = requireRevocationHelper();
    await expect(revoke('captured-access-token', {
      signOut: async () => ({ error: { status: 500 } }),
      compareAndClear: async () => true,
    })).rejects.toThrow('could not securely close this session');
  });
});

describe('sign-out revocation provenance', () => {
  it.each([[503, 'service'], [0, 'transport']] as const)('preserves remote status %s through local orchestration', async (status, kind) => {
    const compareAndClear = vi.fn();
    const error = await runLocalSignOutStep(() => requireRevocationHelper()('captured', {
      signOut: async () => ({ error: { status } }), compareAndClear,
    })).catch((error: unknown) => error);
    expect(classifySignOutFailure(error)).toBe(kind);
    expect(compareAndClear).not.toHaveBeenCalled();
  });
});

it('never clears a session when the revocation transport throws without an error object', async () => {
  const compareAndClear = vi.fn();
  await expect(runLocalSignOutStep(() => requireRevocationHelper()('captured', {
    signOut: async () => { throw undefined; }, compareAndClear,
  }))).rejects.toThrow('could not securely close');
  expect(compareAndClear).not.toHaveBeenCalled();
});

describe('capturedSessionIsGone (BUG-UG-MOBILE-REVOKED-SESSION-STUCK-20261002)', () => {
  const captured = { access_token: 'captured-access-token', refresh_token: 'captured-refresh' } as Session;

  it('asks Auth about exactly the captured token and accepts only its session_not_found', async () => {
    boundaries.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthSessionMissingError', status: 400 } });
    await expect(supabaseService.capturedSessionIsGone(captured)).resolves.toBe(true);
    expect(boundaries.getUser).toHaveBeenLastCalledWith('captured-access-token');
  });

  it.each([
    ['a live user', { data: { user: { id: 'test-member' } }, error: null }],
    ['an expired or refused token', { data: { user: null }, error: { name: 'AuthApiError', status: 403, code: 'bad_jwt' } }],
    ['a 5xx', { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503 } }],
  ])('is not proof on %s', async (_label, answer) => {
    boundaries.getUser.mockResolvedValueOnce(answer);
    await expect(supabaseService.capturedSessionIsGone(captured)).resolves.toBe(false);
  });

  it('is not proof when the request itself fails', async () => {
    boundaries.getUser.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(supabaseService.capturedSessionIsGone(captured)).resolves.toBe(false);
  });
});
