import type { Session } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  boundColdSessionRead,
  createSessionResumeAttemptCoordinator,
  createSessionResumeGuard,
  createSessionSignOutAttemptCoordinator,
  exactSessionIdentity,
  prepareSessionForServerSignOut,
  revalidateSessionOnResume,
  resumeProtectedSession,
  SESSION_BOOTSTRAP_DEADLINE_MS,
  SESSION_OFFLINE_CONFIRM_MS,
  SESSION_REVALIDATION_DEADLINE_MS,
  type SessionResumeAuth,
} from './sessionResume';
import { classifySignOutFailure } from './signOutFailure';

function session(
  userID = 'user-current',
  tokenVersion = 'current',
  sessionID = userID === 'user-current'
    ? '11111111-1111-4111-8111-111111111111'
    : '22222222-2222-4222-8222-222222222222',
): Session {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionID, tokenVersion })).toString('base64url');
  return {
    access_token: `header.${payload}.signature`,
    refresh_token: `redacted-refresh-token-${tokenVersion}`,
    expires_in: 3_600,
    token_type: 'bearer',
    user: {
      id: userID,
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '2026-09-03T12:00:00.000Z',
    },
  } as Session;
}

function authFor(
  currentSession: Session | null = session(),
  options: {
    refreshError?: unknown;
    userID?: string | null;
    userError?: unknown;
    assurance?: { currentLevel?: string | null; nextLevel?: string | null } | null;
    assuranceError?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const auth = {
    refreshSession: vi.fn(async () => {
      calls.push('refresh');
      return { data: { session: currentSession }, error: options.refreshError ?? null };
    }),
    getUser: vi.fn(async () => {
      calls.push('user');
      const userID = options.userID === undefined ? currentSession?.user.id ?? null : options.userID;
      return { data: { user: userID ? { id: userID } : null }, error: options.userError ?? null };
    }),
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn(async () => {
        calls.push('assurance');
        return {
          data: options.assurance === undefined
            ? { currentLevel: 'aal1', nextLevel: 'aal1' }
            : options.assurance,
          error: options.assuranceError ?? null,
        };
      }),
    },
  } satisfies SessionResumeAuth;
  return { auth, calls };
}

function providerAuthError(code: string, status = 400, name = 'AuthApiError') {
  return { code, status, name };
}

describe('foreground session revalidation', () => {
  it('forces refresh, validates the authoritative user, and checks MFA in order', async () => {
    const currentSession = session();
    const { auth, calls } = authFor(currentSession);

    await expect(revalidateSessionOnResume(auth)).resolves.toEqual({
      status: 'authenticated',
      session: currentSession,
    });
    expect(calls).toEqual(['refresh', 'user', 'assurance']);
  });

  it('fails closed when refresh cannot authoritatively restore the session', async () => {
    const refreshFailure = authFor(session(), { refreshError: new Error('offline') });
    await expect(revalidateSessionOnResume(refreshFailure.auth)).resolves.toEqual({ status: 'unavailable' });
    expect(refreshFailure.auth.getUser).not.toHaveBeenCalled();
    expect(refreshFailure.auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();

    const expired = authFor(null);
    await expect(revalidateSessionOnResume(expired.auth)).resolves.toEqual({ status: 'unavailable' });
    expect(expired.auth.getUser).not.toHaveBeenCalled();
  });

  it('classifies only definitive provider invalidation as signed out', async () => {
    for (const code of [
      'refresh_token_not_found',
      'refresh_token_already_used',
      'session_not_found',
      'session_expired',
      'user_not_found',
      'user_banned',
      'bad_jwt',
      'no_authorization',
      'invalid_jwt',
    ]) {
      const terminal = authFor(session(), { refreshError: providerAuthError(code, 401) });
      await expect(revalidateSessionOnResume(terminal.auth)).resolves.toEqual({ status: 'signedOut' });
    }

    const namedMissing = authFor(session(), {
      refreshError: providerAuthError('', 400, 'AuthSessionMissingError'),
    });
    await expect(revalidateSessionOnResume(namedMissing.auth)).resolves.toEqual({ status: 'signedOut' });

    for (const error of [
      new Error('offline'),
      providerAuthError('request_timeout', 503),
      providerAuthError('session_not_found', 503),
    ]) {
      const transient = authFor(session(), { refreshError: error });
      await expect(revalidateSessionOnResume(transient.auth)).resolves.toEqual({ status: 'unavailable' });
    }
  });

  it('retains the session after a successful refresh followed by a bare gateway 401', async () => {
    const { auth } = authFor(session(), { userError: providerAuthError('', 401) });
    await expect(revalidateSessionOnResume(auth)).resolves.toEqual({ status: 'unavailable' });
    expect(auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it('classifies definitive authoritative-user refusal while retaining transient retry', async () => {
    const refused = authFor(session(), { userError: providerAuthError('bad_jwt', 401) });
    await expect(revalidateSessionOnResume(refused.auth)).resolves.toEqual({ status: 'signedOut' });

    const unavailable = authFor(session(), { userError: providerAuthError('request_timeout', 503) });
    await expect(revalidateSessionOnResume(unavailable.auth)).resolves.toEqual({ status: 'unavailable' });

    const rejectedAssurance = authFor(session(), { assuranceError: providerAuthError('no_authorization', 401) });
    await expect(revalidateSessionOnResume(rejectedAssurance.auth)).resolves.toEqual({ status: 'signedOut' });
  });

  it('rejects a missing or mismatched authoritative user before MFA inspection', async () => {
    for (const userID of [null, 'different-user']) {
      const { auth } = authFor(session(), { userID });
      await expect(revalidateSessionOnResume(auth)).resolves.toEqual({ status: 'unavailable' });
      expect(auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    }
  });

  it('rejects a refreshed identity that differs from the covered session', async () => {
    const { auth } = authFor(session('replacement-user'), { userID: 'replacement-user' });

    await expect(revalidateSessionOnResume(auth, 'user-current')).resolves.toEqual({ status: 'unavailable' });
    expect(auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it('routes required MFA and assurance failures to protected outcomes', async () => {
    const currentSession = session();
    const required = authFor(currentSession, {
      assurance: { currentLevel: 'aal1', nextLevel: 'aal2' },
    });
    await expect(revalidateSessionOnResume(required.auth)).resolves.toEqual({
      status: 'mfaRequired',
      session: currentSession,
    });

    for (const options of [
      { userError: new Error('unavailable') },
      { assuranceError: new Error('unavailable') },
      { assurance: { currentLevel: null, nextLevel: null } },
    ]) {
      const unavailable = authFor(currentSession, options);
      await expect(revalidateSessionOnResume(unavailable.auth)).resolves.toEqual({ status: 'unavailable' });
    }
  });
});

describe('protected foreground resume coordination', () => {
  it('uses monotonic attempt IDs and interrupts a stale same-user token generation', () => {
    const coordinator = createSessionResumeAttemptCoordinator();
    const first = coordinator.begin('user-current');
    const tokenTwo = session('user-current', 't2');
    const tokenThree = session('user-current', 't3');

    expect(coordinator.observe('TOKEN_REFRESHED', tokenTwo)).toMatchObject({
      status: 'expected-refresh',
      attempt: { id: first.id },
    });
    expect(coordinator.sessionIsCurrent(first, tokenTwo)).toBe(true);
    expect(coordinator.observe('TOKEN_REFRESHED', tokenThree)).toEqual({
      status: 'handle',
      interrupted: true,
      interruptedExpectedUserID: 'user-current',
    });

    const second = coordinator.begin('user-current');
    expect(second.id).toBeGreaterThan(first.id);
    expect(coordinator.finish(first)).toBe(false);
    expect(coordinator.isActive(second)).toBe(true);
  });

  it('rejects an older resume result after a newer exact same-user session arrives', async () => {
    const tokenTwo = session('user-current', 't2');
    const tokenThree = session('user-current', 't3');
    const { auth } = authFor(tokenTwo);
    let releaseUser: (() => void) | undefined;
    auth.getUser.mockImplementation(() => new Promise((resolve) => {
      releaseUser = () => resolve({ data: { user: { id: tokenTwo.user.id } }, error: null });
    }));
    let currentSession = tokenTwo;
    const events: string[] = [];

    const resumed = resumeProtectedSession({
      auth,
      guard: createSessionResumeGuard(),
      cover: () => events.push('cover'),
      clearProtectedState: () => events.push('clear'),
      isSessionCurrent: (candidate) => (
        candidate.access_token === currentSession.access_token
        && candidate.refresh_token === currentSession.refresh_token
      ),
      clearLocalSession: async () => { events.push('local-clear'); },
      prepareSession: () => events.push('prepare'),
      bootstrap: async () => { events.push('bootstrap'); },
      authenticated: () => events.push('authenticated'),
      mfaRequired: () => events.push('mfa'),
      signedOut: () => events.push('signed-out'),
      unavailable: () => events.push('unavailable'),
      reveal: () => events.push('reveal'),
    });
    await vi.waitFor(() => expect(releaseUser).toBeTypeOf('function'));
    currentSession = tokenThree;
    releaseUser?.();

    await expect(resumed).resolves.toBe('stale');
    expect(events).toEqual(['cover', 'clear']);
  });

  it('answers unavailable at once when the device already has no path to the backend', async () => {
    const currentSession = session();
    const { auth } = authFor(currentSession);
    auth.refreshSession.mockImplementation(() => new Promise(() => undefined));
    const events: string[] = [];
    const result = await resumeProtectedSession({
      auth,
      guard: createSessionResumeGuard(),
      cover: () => events.push('cover'),
      clearProtectedState: () => events.push('clear'),
      clearLocalSession: async () => { events.push('local-clear'); },
      prepareSession: () => events.push('prepare'),
      bootstrap: async () => { events.push('bootstrap'); },
      authenticated: () => events.push('authenticated'),
      mfaRequired: () => events.push('mfa'),
      signedOut: () => events.push('signed-out'),
      unavailable: (reason) => events.push(`unavailable:${reason}`),
      reveal: () => events.push('reveal'),
      reachable: async () => false,
    });
    expect(result).toBe('unavailable');
    // UX-UG-NATIVE-OFFLINE-START-SHOWN-AS-SECURITY-CHECK-20261018:
    // the screen is told the device was offline, not that assurance failed.
    expect(events).toEqual(['cover', 'clear', 'unavailable:offline', 'reveal']);
  });

  it('keeps waiting for the real answer when the backend is reachable', async () => {
    const currentSession = session();
    const { auth } = authFor(currentSession);
    const result = await resumeProtectedSession({
      auth,
      guard: createSessionResumeGuard(),
      cover: () => undefined,
      clearProtectedState: () => undefined,
      clearLocalSession: async () => undefined,
      prepareSession: () => undefined,
      bootstrap: async () => undefined,
      authenticated: () => undefined,
      mfaRequired: () => undefined,
      signedOut: () => undefined,
      unavailable: () => undefined,
      reveal: () => undefined,
      reachable: async () => true,
    });
    expect(result).not.toBe('unavailable');
  });

  it('stops waiting on an offline refresh at the deadline and reveals the fail-closed retry surface', async () => {
    // Physical iPhone, October 1, 2026, and Android SAMPLE: an offline open
    // stayed blank under the privacy cover while Supabase kept retrying.
    vi.useFakeTimers();
    try {
      const currentSession = session();
      const { auth } = authFor(currentSession);
      auth.refreshSession.mockImplementation(() => new Promise(() => undefined));
      const events: string[] = [];
      const resumed = resumeProtectedSession({
        auth,
        guard: createSessionResumeGuard(),
        cover: () => events.push('cover'),
        clearProtectedState: () => events.push('clear'),
        clearLocalSession: async () => { events.push('local-clear'); },
        prepareSession: () => events.push('prepare'),
        bootstrap: async () => { events.push('bootstrap'); },
        authenticated: () => events.push('authenticated'),
        mfaRequired: () => events.push('mfa'),
        signedOut: () => events.push('signed-out'),
        unavailable: (reason) => events.push(`unavailable:${reason}`),
        reveal: () => events.push('reveal'),
      });
      await vi.advanceTimersByTimeAsync(SESSION_REVALIDATION_DEADLINE_MS - 1);
      expect(events).toEqual(['cover', 'clear']);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resumed).resolves.toBe('unavailable');
      // A merely slow network past the deadline keeps the security wording.
      expect(events).toEqual(['cover', 'clear', 'unavailable:assurance', 'reveal']);
    } finally {
      vi.useRealTimers();
    }
  });

  // A silent probe means offline
  // only while Auth has not answered. A refresh that answered proves traffic
  // moves, so a later stage that runs out the clock keeps the security wording.
  const silentProbeCases: Array<[string, boolean, string]> = [
    ['refresh answered, then getUser stalled', true, 'unavailable:assurance'],
    ['nothing answered after a silent probe', false, 'unavailable:offline'],
  ];
  it.each(silentProbeCases)('after a silent probe: %s', async (_label, refreshAnswers, expected) => {
    vi.useFakeTimers();
    try {
      const currentSession = session();
      const { auth } = authFor(currentSession);
      if (refreshAnswers) auth.getUser.mockImplementation(() => new Promise(() => undefined));
      else auth.refreshSession.mockImplementation(() => new Promise(() => undefined));
      const events: string[] = [];
      const resumed = resumeProtectedSession({
        auth,
        guard: createSessionResumeGuard(),
        cover: () => events.push('cover'),
        clearProtectedState: () => events.push('clear'),
        clearLocalSession: async () => { events.push('local-clear'); },
        prepareSession: () => events.push('prepare'),
        bootstrap: async () => { events.push('bootstrap'); },
        authenticated: () => events.push('authenticated'),
        mfaRequired: () => events.push('mfa'),
        signedOut: () => events.push('signed-out'),
        unavailable: (reason) => events.push(`unavailable:${reason}`),
        reveal: () => events.push('reveal'),
        reachable: async () => 'silent',
      });
      await vi.advanceTimersByTimeAsync(SESSION_REVALIDATION_DEADLINE_MS);
      await expect(resumed).resolves.toBe('unavailable');
      expect(events).toEqual(['cover', 'clear', expected, 'reveal']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the exact refreshed retry handle when post-refresh validation is unavailable', async () => {
    const coordinator = createSessionResumeAttemptCoordinator();
    const tokenTwo = session('user-current', 't2');
    const resumeAttempt = coordinator.begin(tokenTwo.user.id);
    const refreshEvent = coordinator.observe('TOKEN_REFRESHED', tokenTwo);
    let actionableSession: Session | null = null;
    if (refreshEvent.status === 'expected-refresh') actionableSession = tokenTwo;
    const { auth } = authFor(tokenTwo, {
      userError: providerAuthError('request_timeout', 503),
    });
    const events: string[] = [];

    const result = await resumeProtectedSession({
      auth,
      guard: createSessionResumeGuard(),
      cover: () => events.push('cover'),
      clearProtectedState: () => events.push('clear'),
      isSessionCurrent: (candidate) => coordinator.sessionIsCurrent(resumeAttempt, candidate),
      clearLocalSession: async () => { events.push('local-clear'); },
      prepareSession: () => events.push('prepare'),
      bootstrap: async () => { events.push('bootstrap'); },
      authenticated: () => events.push('authenticated'),
      mfaRequired: () => events.push('mfa'),
      signedOut: () => events.push('signed-out'),
      unavailable: () => events.push('unavailable'),
      reveal: () => events.push('reveal'),
    });

    expect(result).toBe('unavailable');
    expect(actionableSession).toBe(tokenTwo);
    expect(events).toEqual(['cover', 'clear', 'unavailable', 'reveal']);
    expect(coordinator.finish(resumeAttempt)).toBe(true);
    expect(coordinator.begin(tokenTwo.user.id).id).toBeGreaterThan(resumeAttempt.id);
  });

  it('covers and clears protected state before auth, then reveals only after fresh RLS bootstrap', async () => {
    const currentSession = session();
    const { auth } = authFor(currentSession);
    const events: string[] = [];
    auth.refreshSession.mockImplementation(async () => {
      events.push('refresh');
      return { data: { session: currentSession }, error: null };
    });
    auth.getUser.mockImplementation(async () => {
      events.push('user');
      return { data: { user: { id: currentSession.user.id } }, error: null };
    });
    auth.mfa.getAuthenticatorAssuranceLevel.mockImplementation(async () => {
      events.push('assurance');
      return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
    });

    const result = await resumeProtectedSession({
      auth,
      guard: createSessionResumeGuard(),
      cover: () => events.push('cover'),
      clearProtectedState: () => events.push('clear'),
      clearLocalSession: async () => { events.push('local-clear'); },
      prepareSession: () => events.push('prepare'),
      bootstrap: async () => { events.push('bootstrap'); },
      authenticated: () => events.push('authenticated'),
      mfaRequired: () => events.push('mfa'),
      signedOut: () => events.push('signed-out'),
      unavailable: () => events.push('unavailable'),
      reveal: () => events.push('reveal'),
    });

    expect(result).toBe('authenticated');
    expect(events).toEqual([
      'cover',
      'clear',
      'refresh',
      'user',
      'assurance',
      'prepare',
      'bootstrap',
      'authenticated',
      'reveal',
    ]);
  });

  it('reveals only a fail-closed unavailable surface when bootstrap fails', async () => {
    const events: string[] = [];
    let protectedState: string | null = 'old-dashboard';
    const { auth } = authFor();

    const result = await resumeProtectedSession({
      auth,
      guard: createSessionResumeGuard(),
      cover: () => events.push('cover'),
      clearProtectedState: () => {
        events.push('clear');
        protectedState = null;
      },
      clearLocalSession: async () => { events.push('local-clear'); },
      prepareSession: () => events.push('prepare'),
      bootstrap: async () => {
        events.push('bootstrap');
        protectedState = 'partially-loaded-language';
        throw new Error('RLS unavailable');
      },
      authenticated: () => events.push('authenticated'),
      mfaRequired: () => events.push('mfa'),
      signedOut: () => events.push('signed-out'),
      unavailable: () => events.push('unavailable'),
      reveal: () => events.push('reveal'),
    });

    expect(result).toBe('unavailable');
    expect(events).toEqual(['cover', 'clear', 'prepare', 'bootstrap', 'clear', 'unavailable', 'reveal']);
    expect(protectedState).toBeNull();
  });

  it('lets backgrounding or a newer attempt invalidate stale async completion', async () => {
    let finishRefresh: ((value: { data: { session: Session | null }; error: null }) => void) | undefined;
    const auth = authFor().auth;
    auth.refreshSession.mockImplementation(() => new Promise((resolve) => { finishRefresh = resolve; }));
    const events: string[] = [];
    const guard = createSessionResumeGuard();

    const pending = resumeProtectedSession({
      auth,
      guard,
      cover: () => events.push('cover'),
      clearProtectedState: () => events.push('clear'),
      clearLocalSession: async () => { events.push('local-clear'); },
      prepareSession: () => events.push('prepare'),
      bootstrap: async () => { events.push('bootstrap'); },
      authenticated: () => events.push('authenticated'),
      mfaRequired: () => events.push('mfa'),
      signedOut: () => events.push('signed-out'),
      unavailable: () => events.push('unavailable'),
      reveal: () => events.push('reveal'),
    });

    guard.invalidate();
    finishRefresh?.({ data: { session: session() }, error: null });

    await expect(pending).resolves.toBe('stale');
    expect(events).toEqual(['cover', 'clear']);
  });

  it('retains a replacement persisted identity while revealing an unavailable surface', async () => {
    const replacementSession = session('replacement-user');
    const { auth } = authFor(replacementSession, { userID: 'replacement-user' });
    let persistedSession: Session | null = replacementSession;
    const events: string[] = [];

    const result = await resumeProtectedSession({
      auth,
      expectedUserID: 'user-current',
      guard: createSessionResumeGuard(),
      cover: () => events.push('cover'),
      clearProtectedState: () => events.push('clear'),
      clearLocalSession: async () => {
        events.push('local-clear');
        persistedSession = null;
      },
      prepareSession: () => events.push('prepare'),
      bootstrap: async () => { events.push('bootstrap'); },
      authenticated: () => events.push('authenticated'),
      mfaRequired: () => events.push('mfa'),
      signedOut: () => {
        expect(persistedSession).toBe(replacementSession);
        events.push('signed-out');
      },
      unavailable: () => events.push('unavailable'),
      reveal: () => {
        expect(persistedSession).toBe(replacementSession);
        events.push('reveal');
      },
    });

    expect(result).toBe('unavailable');
    expect(events).toEqual(['cover', 'clear', 'unavailable', 'reveal']);
    expect(persistedSession).toBe(replacementSession);
  });
});

describe('explicit sign-out coordination', () => {
  it('adopts a deferred same-lineage token rotation without letting an old completion clear a new session', async () => {
    const coordinator = createSessionSignOutAttemptCoordinator();
    const tokenOne = session('user-current', 't1');
    const tokenTwo = session('user-current', 't2');
    const newLogin = session(
      'user-current',
      'new-login',
      '33333333-3333-4333-8333-333333333333',
    );
    const attempt = coordinator.begin(tokenOne);
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const completion = (async () => {
      await cleanup;
      return coordinator.identityIsCurrent(attempt, exactSessionIdentity(tokenTwo));
    })();

    expect(coordinator.observe('TOKEN_REFRESHED', tokenTwo)).toMatchObject({
      status: 'adopted-refresh',
      attempt: { id: attempt.id },
    });
    expect(coordinator.latestSessionFor(attempt)).toBe(tokenTwo);
    releaseCleanup?.();
    await expect(completion).resolves.toBe(true);

    expect(coordinator.observe('SIGNED_IN', newLogin)).toEqual({
      status: 'handle',
      interrupted: true,
    });
    expect(coordinator.identityIsCurrent(attempt, exactSessionIdentity(tokenTwo))).toBe(false);
    expect(coordinator.latestSessionFor(attempt)).toBeNull();
    expect(coordinator.finish(attempt)).toBe(false);
  });
});

describe('expiring session before server sign-out', () => {
  const now = () => 2_000_000;
  const expired = () => ({ ...session(), expires_at: 1_999 });
  const live = () => ({ ...session('user-current', 'rotated'), expires_at: 2_600 });

  it('never reads Auth for a healthy captured token', async () => {
    const current = { ...session(), expires_at: 2_600 };
    const read = vi.fn(() => new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined));
    await expect(prepareSessionForServerSignOut(() => current, read, { now })).resolves.toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a rotated SDK tuple before the campaign lead has adopted it', async () => {
    const current = expired();
    await expect(prepareSessionForServerSignOut(() => current,
      async () => ({ data: { session: live() }, error: null }), { now }))
      .rejects.toMatchObject({ signOutFailureKind: 'local' });
  });

  it('stops when a new login supersedes the expired attempt during Auth', async () => {
    const coordinator = createSessionSignOutAttemptCoordinator();
    const attempt = coordinator.begin(expired());
    const replacement = { ...session('user-current', 'new-login', '33333333-3333-4333-8333-333333333333'), expires_at: 2_600 };
    const read = async () => {
      coordinator.observe('SIGNED_IN', replacement);
      return { data: { session: replacement }, error: null };
    };
    await expect(prepareSessionForServerSignOut(() => coordinator.latestSessionFor(attempt), read, { now })).resolves.toBe(false);
    expect(coordinator.latestSessionFor(attempt)).toBeNull();
  });

  it('fails promptly with reconnect provenance when reachability is definitively offline', async () => {
    const current = expired();
    const failure = await prepareSessionForServerSignOut(() => current,
      () => new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined),
      { now, reachable: async () => false }).catch((error: unknown) => error);
    expect(classifySignOutFailure(failure)).toBe('transport');
    expect(current.expires_at).toBe(1_999);
  });

  it('bounds a hung refresh at five seconds and never consumes its late result', async () => {
    vi.useFakeTimers();
    try {
      const current = expired();
      let release!: (value: { data: { session: Session }; error: null }) => void;
      const read = new Promise<{ data: { session: Session }; error: null }>((resolve) => { release = resolve; });
      let observed: unknown = 'pending';
      const completion = prepareSessionForServerSignOut(() => current, () => read, { now })
        .then((value) => { observed = value; }, (error: unknown) => { observed = error; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(observed).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await completion;
      expect(classifySignOutFailure(observed)).toBe('transport');
      release({ data: { session: live() }, error: null });
      await Promise.resolve();
      expect(classifySignOutFailure(observed)).toBe('transport');
    } finally { vi.useRealTimers(); }
  });

  it('keeps an unchanged expired token and an Auth refusal fail-closed', async () => {
    const current = expired();
    await expect(prepareSessionForServerSignOut(() => current,
      async () => ({ data: { session: current }, error: null }), { now }))
      .rejects.toMatchObject({ signOutFailureKind: 'local' });
    const refusal = { name: 'AuthApiError', status: 401 };
    await expect(prepareSessionForServerSignOut(() => current,
      async () => ({ data: { session: null }, error: refusal }), { now })).rejects.toBe(refusal);
  });
});

describe('cold launch session read', () => {
  // Pixel 10a SAMPLE, October 1, 2026: a cold launch offline stayed blank past
  // 18 seconds. getSession() waits for the auth client's initialization, which
  // refreshes a near-expiry token and, offline, retries for up to 30 seconds.
  it('answers unavailable at once when the device has no path to the backend', async () => {
    const read = new Promise<{ data: { session: Session | null } }>(() => undefined);
    await expect(boundColdSessionRead(read, { reachable: async () => false })).resolves.toEqual({ status: 'unavailable', reason: 'offline' });
  });

  // UX-UG-NATIVE-BLACKHOLED-NETWORK-SHOWN-AS-SECURITY-CHECK-20261020:
  // a radio that is up but passes no traffic lets the probe end by its own
  // abort with no HTTP answer. That alone decides nothing, but once the
  // deadline also passes with no answer the screen says offline, not
  // "security"; an answer before the deadline keeps the normal path.
  it('reports offline at the deadline when the probe was silent and nothing answered', async () => {
    const never = new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined);
    await expect(boundColdSessionRead(never, { deadlineMs: 20, reachable: async () => 'silent' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'offline' });
  });

  it('keeps the security reason at the deadline when the probe found a path', async () => {
    const never = new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined);
    await expect(boundColdSessionRead(never, { deadlineMs: 20, reachable: async () => 'reachable' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'assurance' });
  });

  it('answers offline at once when the probe is definitively offline', async () => {
    const never = new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined);
    await expect(boundColdSessionRead(never, { deadlineMs: 5_000, reachable: async () => 'offline' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'offline' });
  });

  // BUG-UG-NATIVE-SIGN-OUT-DURING-SESSION-CHECK-SHOWS-OFFLINE-20261103:
  // the offline words need a fresh probe that also goes unanswered. One that is
  // answered means the network is up, so the verdict keeps the security words.
  const probes = (...answers: Array<'reachable' | 'offline' | 'silent' | Error>) => vi.fn(async () => {
    const answer = answers.shift() ?? 'offline';
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const confirmationCases: Array<[string, ReturnType<typeof probes>, string]> = [
    ['an offline answer the fresh probe contradicts', probes('offline', 'reachable'), 'assurance'],
    ['a silent probe the fresh probe contradicts at the deadline', probes('silent', 'reachable'), 'assurance'],
    ['an offline answer the fresh probe confirms', probes('offline', 'offline'), 'offline'],
    ['a silent probe and a silent fresh probe', probes('silent', 'silent'), 'offline'],
    ['an offline answer and a fresh probe that throws', probes('offline', new Error('probe failed')), 'offline'],
  ];
  it.each(confirmationCases)('confirms the offline words with a fresh probe: %s', async (_label, reachable, reason) => {
    const never = new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined);
    await expect(boundColdSessionRead(never, { deadlineMs: 20, reachable }))
      .resolves.toEqual({ status: 'unavailable', reason });
    expect(reachable).toHaveBeenCalledTimes(2);
  });

  // The fresh probe ran after the deadline,
  // so a dead network reached the fail-closed screen after about 13 s.
  it('shows the dead-network verdict at the deadline itself, not after a fresh probe', async () => {
    vi.useFakeTimers();
    try {
      // Each probe ends by its own 3 s abort, as backendReachable does on a
      // network that carries nothing.
      const reachable = vi.fn(() => new Promise<'silent'>((resolve) => { setTimeout(() => resolve('silent'), 3_000); }));
      const never = new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined);
      let outcome: unknown = null;
      void boundColdSessionRead(never, { reachable }).then((value) => { outcome = value; });
      await vi.advanceTimersByTimeAsync(SESSION_REVALIDATION_DEADLINE_MS - 1);
      expect(outcome).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ status: 'unavailable', reason: 'offline' });
      expect(reachable).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the fresh probe after an offline answer by its own short timer', async () => {
    vi.useFakeTimers();
    try {
      const reachable = vi.fn()
        .mockResolvedValueOnce('offline')
        .mockImplementationOnce(() => new Promise(() => undefined));
      const never = new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined);
      let outcome: unknown = null;
      void boundColdSessionRead(never, { reachable }).then((value) => { outcome = value; });
      await vi.advanceTimersByTimeAsync(SESSION_OFFLINE_CONFIRM_MS);
      expect(outcome).toEqual({ status: 'unavailable', reason: 'offline' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('decides at the offline answer, so work that settles during the fresh probe cannot win', async () => {
    let settle: (value: { data: { session: Session | null }; error: unknown }) => void = () => undefined;
    const read = new Promise<{ data: { session: Session | null }; error: unknown }>((resolve) => { settle = resolve; });
    let answerFresh: (answer: 'reachable') => void = () => undefined;
    const reachable = vi.fn()
      .mockResolvedValueOnce('offline')
      .mockImplementationOnce(() => new Promise((resolve) => { answerFresh = resolve; }));
    const bounded = boundColdSessionRead(read, { deadlineMs: 5_000, reachable });
    await vi.waitFor(() => expect(reachable).toHaveBeenCalledTimes(2));
    settle({ data: { session: session() }, error: null });
    await Promise.resolve();
    answerFresh('reachable');
    await expect(bounded).resolves.toEqual({ status: 'unavailable', reason: 'assurance' });
  });

  it('sends no fresh probe for a caller that does not tell offline apart', async () => {
    const reachable = vi.fn(async () => false);
    const current = { ...session(), expires_at: 1_999 };
    const never = () => new Promise<{ data: { session: Session | null }; error: unknown }>(() => undefined);
    await expect(prepareSessionForServerSignOut(() => current, never, { now: () => 2_000_000, reachable }))
      .rejects.toMatchObject({ signOutFailureKind: 'transport' });
    expect(reachable).toHaveBeenCalledTimes(1);
  });

  it('keeps the normal path when a slow network answers before the deadline despite a silent probe', async () => {
    const restored = session();
    const slow = new Promise<{ data: { session: Session | null }; error: unknown }>((resolve) => {
      setTimeout(() => resolve({ data: { session: restored }, error: null }), 10);
    });
    await expect(boundColdSessionRead(slow, { deadlineMs: 200, reachable: async () => 'silent' }))
      .resolves.toEqual({ status: 'settled', value: { data: { session: restored }, error: null } });
  });

  it('stops waiting on an offline refresh behind getSession at the revalidation deadline', async () => {
    vi.useFakeTimers();
    try {
      // auth-js keeps retrying the refresh with backoff until its 30 s tick.
      const read = new Promise<{ data: { session: Session | null } }>((resolve) => {
        setTimeout(() => resolve({ data: { session: null } }), 30_000);
      });
      let outcome: unknown = 'pending';
      const bounded = boundColdSessionRead(read, { reachable: async () => true }).then((value) => { outcome = value; return value; });
      await vi.advanceTimersByTimeAsync(SESSION_REVALIDATION_DEADLINE_MS - 1);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await expect(bounded).resolves.toEqual({ status: 'unavailable', reason: 'assurance' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers a read that settles before the deadline', async () => {
    const restored = session();
    await expect(boundColdSessionRead(Promise.resolve({ data: { session: restored } }), { reachable: async () => true }))
      .resolves.toEqual({ status: 'settled', value: { data: { session: restored } } });
  });

  it('never delivers a late result and keeps a late failure handled', async () => {
    vi.useFakeTimers();
    try {
      let resolveLate: (value: { data: { session: Session | null } }) => void = () => undefined;
      let rejectLate: (reason: unknown) => void = () => undefined;
      const lateSuccess = new Promise<{ data: { session: Session | null } }>((resolve) => { resolveLate = resolve; });
      const lateFailure = new Promise<{ data: { session: Session | null } }>((_resolve, reject) => { rejectLate = reject; });
      const first = boundColdSessionRead(lateSuccess);
      const second = boundColdSessionRead(lateFailure);
      await vi.advanceTimersByTimeAsync(SESSION_REVALIDATION_DEADLINE_MS);
      await expect(first).resolves.toEqual({ status: 'unavailable', reason: 'assurance' });
      await expect(second).resolves.toEqual({ status: 'unavailable', reason: 'assurance' });
      resolveLate({ data: { session: session() } });
      rejectLate(new Error('refresh failed after the deadline'));
      await vi.advanceTimersByTimeAsync(0);
      await expect(first).resolves.toEqual({ status: 'unavailable', reason: 'assurance' });
      await expect(second).resolves.toEqual({ status: 'unavailable', reason: 'assurance' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a read failure that arrives before the deadline to the existing fail-closed catch', async () => {
    const failure = new Error('storage unavailable');
    await expect(boundColdSessionRead(Promise.reject(failure), { reachable: async () => true })).rejects.toBe(failure);
  });

  it('keeps the cold attempt active after the bound so a late refresh is an interruption, not an establishment', () => {
    const attempts = createSessionResumeAttemptCoordinator();
    const cold = attempts.begin(null);
    // The bounded launch leaves the attempt active until the real read settles.
    expect(attempts.hasActive()).toBe(true);
    expect(attempts.observe('TOKEN_REFRESHED', session())).toEqual({
      status: 'handle',
      interrupted: true,
      interruptedExpectedUserID: null,
    });
    // Had the attempt been finished at the bound, the same late event would
    // have been handled as a fresh event, the direct establishment path.
    const finishedEarly = createSessionResumeAttemptCoordinator();
    finishedEarly.finish(finishedEarly.begin(null));
    expect(finishedEarly.observe('TOKEN_REFRESHED', session())).toEqual({
      status: 'handle',
      interrupted: false,
      interruptedExpectedUserID: null,
    });
    expect(attempts.finish(cold)).toBe(false);
  });
});

function coldUnavailableBranch(provider: string) {
  const refreshStart = provider.indexOf('const stopAuthRefresh');
  expect(refreshStart, 'AppProvider must start the cold auth refresh lifecycle').toBeGreaterThanOrEqual(0);
  const restoreStart = provider.indexOf('Promise.all([', refreshStart);
  expect(restoreStart, 'AppProvider must contain the cold restore block').toBeGreaterThan(refreshStart);
  const restoreEnd = provider.indexOf('const { data: listener }', restoreStart);
  expect(restoreEnd, 'The auth listener must delimit the cold restore block').toBeGreaterThan(restoreStart);
  const restore = provider.slice(restoreStart, restoreEnd);
  const branchStart = restore.indexOf("if (coldRead.status === 'unavailable') {");
  expect(branchStart, 'Cold restore must handle an unavailable session read').toBeGreaterThanOrEqual(0);
  const branchEnd = restore.indexOf('const { data, error: sessionError } = coldRead.value;', branchStart);
  expect(branchEnd, 'The settled read must delimit the unavailable branch').toBeGreaterThan(branchStart);
  return { restore, branch: restore.slice(branchStart, branchEnd) };
}

describe('AppProvider foreground boundary', () => {
  it('bounds the cold getSession read into the fail-closed surface without authorizing the persisted session', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const { restore, branch } = coldUnavailableBranch(provider);
    // Require both calls before comparing positions: a missing call is -1.
    const clearProtected = branch.indexOf('clearProtectedState();');
    const retainSession = branch.indexOf('setSession(persistedSession);');
    expect(clearProtected, 'Cold restore must call clearProtectedState').toBeGreaterThanOrEqual(0);
    expect(retainSession, 'Cold restore must retain the persisted retry handle').toBeGreaterThanOrEqual(0);
    expect(provider).toContain('const coldSessionRead = supabase.auth.getSession();');
    expect(restore).toContain('boundColdSessionRead(coldSessionRead, {');
    expect(restore).toContain('backendReachable(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey)');
    // The attempt is released only when the real read settles.
    expect(branch).toContain('coldReadBounded = true;');
    expect(branch).toContain('void coldSessionRead.then(() => undefined, () => undefined)');
    expect(branch).toContain('sessionResumeAttempts.finish(coldRestoreAttempt);');
    expect(restore).toContain('if (!coldReadBounded) sessionResumeAttempts.finish(coldRestoreAttempt);');
    // Lineage: the late read cannot apply, and the handle is the stored tuple.
    expect(branch).toContain('const persistedSession = await readPersistedMobileSession()');
    expect(branch.indexOf('sessionTransition.current += 1;')).toBeGreaterThan(branch.indexOf('readPersistedMobileSession()'));
    expect(branch.indexOf('sessionTransition.current += 1;')).toBeLessThan(retainSession);
    expect(branch).toContain('observedAuthIdentity.current = authIdentityFor(persistedSession);');
    // Fail closed: the same retry surface as an unavailable resume, nothing revealed.
    expect(clearProtected, 'Protected state must clear before the retry handle is retained').toBeLessThan(retainSession);
    // The reason travels with the flag: offline says so, a slow read keeps
    // the security wording (UX-UG-NATIVE-OFFLINE-START-SHOWN-AS-SECURITY-CHECK-20261018).
    expect(branch).toContain('setError(SESSION_UNAVAILABLE_ERROR[coldRead.reason]);');
    expect(branch).toContain('setAssuranceUnavailable(true, coldRead.reason);');
    expect(branch).toContain("setMode('mfaRequired');");
    expect(branch).toContain("setMode('signedOut');");
    for (const forbidden of ['establishSession', "setMode('authenticated')", 'fetchDashboard', 'revalidateAuthenticatedSession', 'setPrivacyCovered(false)']) {
      expect(branch).not.toContain(forbidden);
    }
  });

  it('clears protected rows and finishes in MFA retry mode while the cold read is pending', async () => {
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    const { branch } = coldUnavailableBranch(provider);
    const persistedSession = session();
    const protectedRows = ['private row from the covered session'];
    const published: { session: Session; rows: string[] }[] = [];
    let mode = 'authenticated';
    const setMode = vi.fn((nextMode: string) => { mode = nextMode; });
    const environment = {
      coldRead: { status: 'unavailable', reason: 'assurance' },
      coldReadBounded: false,
      coldSessionRead: new Promise<never>(() => undefined),
      sessionResumeAttempts: { finish: vi.fn() },
      coldRestoreAttempt: {},
      readPersistedMobileSession: vi.fn(async () => persistedSession),
      active: true,
      sessionTransition: { current: 7 },
      coldRestoreTransition: 7,
      observedAuthIdentity: { current: null },
      authIdentityFor: vi.fn((value: Session) => value.user.id),
      activeUserID: { current: null },
      clearProtectedState: vi.fn(() => {
        protectedRows.length = 0;
        // The real clear helper resets mode as well as protected data. A
        // later clear must overwrite an incorrectly early retry-mode write.
        setMode('booting');
      }),
      setSession: vi.fn((value: Session) => { published.push({ session: value, rows: [...protectedRows] }); }),
      lockEnabled: true,
      setLocked: vi.fn(),
      SESSION_UNAVAILABLE_ERROR: { offline: 'offline words', assurance: 'assurance words' },
      setError: vi.fn(),
      setAssuranceUnavailable: vi.fn(),
      setMode,
      purgeSecureShareStaging: vi.fn(async () => undefined),
    };
    // Execute the production branch, rather than a copy of its clear/retain
    // sequence. Snapshot rows at publication so a later clear cannot mask it.
    const executable = ts.transpile(`(async () => { ${branch} })()`, { target: ts.ScriptTarget.ES2022 });
    await (runInNewContext(executable, environment) as Promise<void>);

    expect(environment.readPersistedMobileSession).toHaveBeenCalledTimes(1);
    expect(environment.clearProtectedState).toHaveBeenCalledTimes(1);
    expect(environment.setSession).toHaveBeenCalledExactlyOnceWith(persistedSession);
    expect(published).toEqual([{ session: persistedSession, rows: [] }]);
    expect(environment.setAssuranceUnavailable).toHaveBeenCalledExactlyOnceWith(true, 'assurance');
    expect(mode).toBe('mfaRequired');
    expect(environment.coldReadBounded).toBe(true);
    expect(environment.sessionResumeAttempts.finish).not.toHaveBeenCalled();
  });

  it('treats a persisted cold-launch session only as a covered revalidation and retry handle', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const restoreStart = provider.indexOf('Promise.all([', provider.indexOf('const stopAuthRefresh'));
    const restoreEnd = provider.indexOf('const { data: listener }', restoreStart);
    const restore = provider.slice(restoreStart, restoreEnd);
    const revalidateStart = provider.indexOf('const revalidateAuthenticatedSession');
    const revalidateEnd = provider.indexOf('const resumeAuthenticatedSession', revalidateStart);
    const revalidate = provider.slice(revalidateStart, revalidateEnd);
    const listener = provider.slice(
      provider.indexOf('supabase.auth.onAuthStateChange'),
      provider.indexOf('return () => {', provider.indexOf('supabase.auth.onAuthStateChange')),
    );
    expect(restoreStart).toBeGreaterThan(-1);
    expect(restoreEnd).toBeGreaterThan(restoreStart);
    expect(revalidateStart).toBeGreaterThan(-1);
    expect(restore).toContain('setSession(data.session);');
    expect(restore).toContain('if (lockEnabled) setLocked(true);');
    expect(restore).toContain('await revalidateAuthenticatedSession(data.session);');
    expect(restore).not.toContain('establishSession(data.session');
    expect(restore.indexOf('setSession(data.session);')).toBeLessThan(
      restore.indexOf('await revalidateAuthenticatedSession(data.session);'),
    );
    expect(provider).toContain('const coldRestoreAttempt = sessionResumeAttempts.begin(null);');
    expect(provider.indexOf('const coldRestoreAttempt = sessionResumeAttempts.begin(null);')).toBeLessThan(
      provider.indexOf('startSupabaseAuthRefreshLifecycle(supabase.auth)'),
    );
    expect(restore).toContain('.finally(() => {');
    expect(restore).toContain('sessionResumeAttempts.finish(coldRestoreAttempt);');
    expect(revalidate).toContain('const resumeAttempt = sessionResumeAttempts.begin(coveredSession.user.id);');
    expect(revalidate).toContain('sessionResumeAttempts.finish(resumeAttempt);');
    expect(revalidate).toContain('resumeProtectedSession({');
    expect(revalidate).toContain('expectedUserID: coveredSession.user.id');
    expect(listener).toContain('const resumeDecision = sessionResumeAttempts.observe(event, nextSession);');
    expect(listener).toContain("resumeDecision.status === 'expected-refresh'");
    expect(listener).toContain('setSession(nextSession);');
    expect(listener).toContain('setTimeout(() => {');
    expect(listener).toContain('void establishSession(nextSession, authEventShareCleanupBoundary);');
  });

  it('clears protected rows before a same-user token refresh can fail fresh RLS bootstrap', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const establishStart = provider.indexOf('const establishSession');
    const establishEnd = provider.indexOf('const revalidateAuthenticatedSession', establishStart);
    const establish = provider.slice(establishStart, establishEnd);
    const previousUser = establish.indexOf('const previousUserID = activeUserID.current;');
    const privacyCover = establish.indexOf('setPrivacyCovered(true);', previousUser);
    const clear = establish.indexOf('clearProtectedState();', previousUser);
    const isolationBoundary = establish.indexOf('const isolationBoundary = blockedShareIsolation.current', previousUser);
    const mfaCheck = establish.indexOf('requiresMfa = await sessionNeedsMfa();', previousUser);
    const freshRlsRead = establish.indexOf("fetchDashboard(nextSession, 'automatic', true)", previousUser);
    const listener = provider.slice(
      provider.indexOf('supabase.auth.onAuthStateChange'),
      provider.indexOf('return () => {', provider.indexOf('supabase.auth.onAuthStateChange')),
    );
    const clearProtectedState = provider.slice(
      provider.indexOf('const clearProtectedState'),
      provider.indexOf('const fetchDashboard'),
    );

    expect(listener).toContain('if (nextSession) {');
    expect(listener).toContain('void establishSession(nextSession, authEventShareCleanupBoundary);');
    expect(privacyCover).toBeGreaterThan(previousUser);
    expect(clear).toBeGreaterThan(privacyCover);
    expect(isolationBoundary).toBeGreaterThan(clear);
    expect(clear).toBeLessThan(mfaCheck);
    expect(clear).toBeLessThan(freshRlsRead);
    expect(clearProtectedState).toContain('setDashboard(null);');
    expect(clearProtectedState).toContain('setChapterMemberships([]);');
    expect(clearProtectedState).toContain('liveChannelStore.resetForSession();');
  });

  it('publishes each auth identity synchronously and generation-checks deferred establishment', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const listener = provider.slice(
      provider.indexOf('supabase.auth.onAuthStateChange'),
      provider.indexOf('return () => {', provider.indexOf('supabase.auth.onAuthStateChange')),
    );
    const publish = listener.indexOf('observedAuthIdentity.current = authIdentityFor(nextSession);');
    const resumeReturn = listener.indexOf('const resumeDecision = sessionResumeAttempts.observe(event, nextSession);');
    const timer = listener.indexOf('setTimeout(() => {');
    const generationGuard = listener.indexOf('sessionTransition.current !== authEventTransition', timer);
    const establish = listener.indexOf(
      'void establishSession(nextSession, authEventShareCleanupBoundary);',
      timer,
    );

    expect(publish).toBeGreaterThan(-1);
    expect(publish).toBeLessThan(resumeReturn);
    expect(listener).toContain('const authEventTransition = ++sessionTransition.current;');
    expect(listener).toContain('const authEventShareCleanupBoundary = captureSecureShareCleanupBoundary();');
    expect(generationGuard).toBeGreaterThan(timer);
    expect(generationGuard).toBeLessThan(establish);
    expect(listener).toContain('!authIdentityMatches(observedAuthIdentity.current, nextSession)');
    expect(listener).toContain('void revalidateAuthenticatedSession(nextSession);');
    expect(listener).toContain('interruptedResumeExpectedUserID');
    expect(listener).toContain('authEventShareCleanupBoundary,');
  });

  it('refuses PREVIEW while live auth is pending and invalidates every queued resume', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const previewStart = provider.indexOf('const enterPreview = useCallback');
    const previewEnd = provider.indexOf('const switchPreviewHat', previewStart);
    const preview = provider.slice(previewStart, previewEnd);
    const identityGuard = preview.indexOf('observedAuthIdentity.current !== null');
    const transition = preview.indexOf('sessionTransition.current += 1;');

    expect(identityGuard).toBeGreaterThan(-1);
    expect(identityGuard).toBeLessThan(transition);
    expect(preview).toContain('sessionResumeAttempts.hasActive()');
    expect(preview).toContain('sessionResumeGuard.invalidate();');
  });

  // Text pins for the wiring this file cannot reach through a render — honest
  // about being tripwires rather than behavioural proof. The actual guard
  // ordering (that a stale transition mid-await stops every later sign-out
  // side effect) is proven by executing the real callback in
  // ../state/signOutHandler.test.ts's "provider sign-out transition guard
  // (behavioral)" suite.
  it('invalidates a stale account sign-out before every next-account side effect', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const signOutStart = provider.indexOf('const signOut = useCallback');
    const signOutEnd = provider.indexOf('const refresh = useCallback', signOutStart);
    const signOut = provider.slice(signOutStart, signOutEnd);

    expect(signOut).toContain('const signOutTransition = ++sessionTransition.current;');
    expect(signOut).toContain('const renderedSession = liveSession ? session : null;');
    expect(signOut).toContain('observedIdentity.userID === renderedSession.user.id');
    expect(signOut).toContain('accessTokensShareSessionLineage(observedIdentity.accessToken, renderedSession.access_token)');
    expect(signOut).toContain('const expectedUserID = capturedSession?.user.id ?? null;');
    expect(signOut).toContain('authIdentityMatches(observedAuthIdentity.current, capturedSession)');
    expect(signOut.indexOf('activeUserID.current !== expectedUserID')).toBeLessThan(
      signOut.indexOf('const signOutTransition = ++sessionTransition.current;'),
    );
    expect(signOut.indexOf('activeUserID.current !== expectedUserID')).toBeLessThan(
      signOut.indexOf('await purgeAttachmentCacheForSignOut(signOutStillCurrent);'),
    );
    expect(signOut).toContain("if (mode === 'preview' && (session !== null");
    expect(signOut).toContain('|| observedAuthIdentity.current !== null)) return;');
    expect(signOut).toContain('const signOutStillCurrent = () =>');
    expect(signOut).toContain('sessionTransition.current === signOutTransition');
    expect(signOut).toContain('activeUserID.current === expectedUserID');
    expect(signOut).toContain('await preparePendingSharedAttachmentUploadForSignOut(expectedUserID, signOutStillCurrent, captureSessionWriter(capturedSession));');
    expect(signOut).toContain('sessionSignOutAttempts.latestSessionFor(signOutAttempt)');
    expect(signOut).toContain('createCapturedSessionRpcClient(pushCleanupSession)');
    expect(signOut).toContain('createCapturedSessionRpcClient(serverCleanupSession)');
    expect(signOut).toContain('await runLocalSignOutStep(() => revokeAndClearCapturedMobileSession(revocationSession, scope));');
    expect(signOut).not.toContain("supabase.auth.signOut({ scope: 'local' })");

    const guardedAwaits = [
      'await purgeAttachmentCacheForSignOut(signOutStillCurrent);',
      'await preparePendingSharedAttachmentUploadForSignOut(expectedUserID, signOutStillCurrent, captureSessionWriter(capturedSession));',
      'await runLocalSignOutStep(() => pauseNativePushRegistration());',
      'await deleteNativePushInstallationForSignOut(',
      'await prepareMySignOut(serverCleanupClient, scope, expectedUserID);',
      'await runLocalSignOutStep(() => clearNativePushPreferenceForSignOut(expectedUserID, signOutStillCurrent));',
      'await runLocalSignOutStep(() => revokeAndClearCapturedMobileSession(revocationSession, scope));',
      'await clearLocalNotificationPreference().catch(() => undefined);',
    ];
    let searchFrom = 0;
    for (const [index, awaited] of guardedAwaits.entries()) {
      const awaitPosition = signOut.indexOf(awaited, searchFrom);
      expect(awaitPosition, awaited).toBeGreaterThan(-1);
      const nextEffectPosition = index + 1 < guardedAwaits.length
        ? signOut.indexOf(guardedAwaits[index + 1] ?? '', awaitPosition + awaited.length)
        : signOut.indexOf('observedAuthIdentity.current = null;', awaitPosition);
      expect(nextEffectPosition, `next effect after ${awaited}`).toBeGreaterThan(awaitPosition);
      const guardPosition = signOut.indexOf('if (!signOutStillCurrent())', awaitPosition);
      expect(guardPosition, `${awaited} must be followed by its own stale-transition guard`)
        .toBeGreaterThan(awaitPosition);
      expect(guardPosition, `${awaited} must be guarded before the next sensitive effect`)
        .toBeLessThan(nextEffectPosition);
      searchFrom = awaitPosition + awaited.length;
    }
  });

  it('preserves an existing biometric lock across transient revalidation while keeping MFA reachable', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const revalidateStart = provider.indexOf('const revalidateAuthenticatedSession');
    const revalidateEnd = provider.indexOf('const resumeAuthenticatedSession', revalidateStart);
    const revalidate = provider.slice(revalidateStart, revalidateEnd);
    const unavailableBackend = revalidate.slice(
      revalidate.indexOf('if (!supabase) {'),
      revalidate.indexOf('const resumeAttempt'),
    );
    const mfaStart = revalidate.indexOf('mfaRequired:');
    const signedOutStart = revalidate.indexOf('signedOut:', mfaStart);
    const unavailableStart = revalidate.indexOf('unavailable:', signedOutStart);
    const revealStart = revalidate.indexOf('reveal:', unavailableStart);
    const mfaRequired = revalidate.slice(mfaStart, signedOutStart);
    const unavailable = revalidate.slice(unavailableStart, revealStart);

    expect(mfaStart).toBeGreaterThan(-1);
    expect(unavailableStart).toBeGreaterThan(signedOutStart);
    expect(mfaRequired).toContain('setLocked(false);');
    expect(unavailableBackend).not.toContain('setLocked(false);');
    expect(unavailable).not.toContain('setLocked(false);');
  });

  it('wires foreground and retry through the forced-refresh campaign lead', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const appStateEffect = provider.slice(
      provider.indexOf('const onAppState'),
      provider.indexOf("if (mode !== 'authenticated'", provider.indexOf('const onAppState')),
    );
    const retry = provider.slice(
      provider.indexOf('const retrySessionAuthentication'),
      provider.indexOf('const applyPreviewHat'),
    );

    expect(provider).toContain("from '../services/sessionResume'");
    expect(provider).toContain('resumeProtectedSession({');
    expect(provider).toContain('clearCapturedMobileSessionLocally(coveredSession)');
    expect(provider).toContain('revokeAndClearCapturedMobileSession(revocationSession, scope)');
    expect(provider).not.toContain("supabase.auth.signOut({ scope: 'local' })");
    expect(provider).toContain('sessionResumeAttempts.hasActive()');
    expect(provider).toContain('sessionResumeAttempts.observe(event, nextSession)');
    expect(provider).toContain('void revalidateAuthenticatedSession(nextSession);');
    expect(provider).toContain('void establishSession(nextSession, authEventShareCleanupBoundary);');
    expect(appStateEffect).toContain('sessionResumeGuard.invalidate();');
    expect(appStateEffect).toContain('void resumeAuthenticatedSession();');
    expect(retry).toContain('await resumeAuthenticatedSession();');
    expect(retry).not.toContain('establishSession(session)');
  });

  it('enters a loading authorization mode that invalidates mounted issue and conversation caches', () => {
    const provider = readFileSync(
      fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
      'utf8',
    );
    const caseScreen = readFileSync(
      fileURLToPath(new URL('../../app/issue/[id].tsx', import.meta.url)),
      'utf8',
    );
    const conversationScreen = readFileSync(
      fileURLToPath(new URL('../../app/conversation/[id].tsx', import.meta.url)),
      'utf8',
    );
    const clearBoundary = provider.slice(
      provider.indexOf('const clearProtectedState'),
      provider.indexOf('const fetchDashboard'),
    );

    expect(clearBoundary).toContain("setMode('booting');");
    expect(caseScreen).toMatch(/setDetail\(null\);[\s\S]*if \(mode === 'booting'\) return/);
    expect(caseScreen).toMatch(/\[[^\]]*mode[^\]]*userID[^\]]*\]/);
    expect(conversationScreen).toMatch(/setThread\(null\);[\s\S]*if \(mode === 'booting'\) return/);
    expect(conversationScreen).toMatch(/\[[^\]]*mode[^\]]*userID[^\]]*\]/);
  });
});

// SEC-UG-MOBILE-SESSION-LINEAGE-RACE-20260903: the guard was checked only
// after a whole stage or callback settled, so a superseded attempt still
// started its next Auth request and ran its bootstrap continuation.
describe('resume attempt ownership between stages', () => {
  type Stage = 'refresh' | 'user' | 'assurance';
  function deferredAuth(held: Stage, currentSession = session()) {
    const { auth, calls } = authFor(currentSession);
    let release: (() => void) | undefined;
    const answers = {
      refresh: () => ({ data: { session: currentSession }, error: null }),
      user: () => ({ data: { user: { id: currentSession.user.id } }, error: null }),
      assurance: () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }),
    };
    const hold = <T,>(stage: Stage, answer: () => T) => () => {
      calls.push(stage);
      return new Promise<T>((resolve) => { release = () => resolve(answer()); });
    };
    if (held === 'refresh') auth.refreshSession.mockImplementation(hold('refresh', answers.refresh));
    if (held === 'user') auth.getUser.mockImplementation(hold('user', answers.user));
    if (held === 'assurance') auth.mfa.getAuthenticatorAssuranceLevel.mockImplementation(hold('assurance', answers.assurance));
    return { auth, calls, release: () => release?.(), held: () => typeof release === 'function' };
  }

  function recorder() {
    const events: string[] = [];
    return {
      events,
      callbacks: {
        cover: () => events.push('cover'),
        clearProtectedState: () => events.push('clear'),
        clearLocalSession: async () => { events.push('local-clear'); },
        prepareSession: () => events.push('prepare'),
        bootstrap: async () => { events.push('bootstrap'); },
        authenticated: () => events.push('authenticated'),
        mfaRequired: () => events.push('mfa'),
        signedOut: () => events.push('signed-out'),
        unavailable: () => events.push('unavailable'),
        settle: () => events.push('settle'),
        reveal: () => events.push('reveal'),
      },
    };
  }

  const stageCases: Array<{ held: Stage; started: Stage[] }> = [
    { held: 'refresh', started: ['refresh'] },
    { held: 'user', started: ['refresh', 'user'] },
    { held: 'assurance', started: ['refresh', 'user', 'assurance'] },
  ];
  it.each(stageCases)('starts no later stage once a newer attempt replaces it during $held', async ({ held, started }) => {
    const auth = deferredAuth(held);
    const guard = createSessionResumeGuard();
    const { events, callbacks } = recorder();
    const resumed = resumeProtectedSession({ auth: auth.auth, guard, ...callbacks });
    await vi.waitFor(() => expect(auth.held()).toBe(true));
    guard.begin();
    auth.release();
    await expect(resumed).resolves.toBe('stale');
    expect(auth.calls).toEqual(started);
    expect(events).toEqual(['cover', 'clear']);
  });

  it('starts no later stage after the deadline answered unavailable', async () => {
    vi.useFakeTimers();
    try {
      const auth = deferredAuth('refresh');
      const { events, callbacks } = recorder();
      const resumed = resumeProtectedSession({ auth: auth.auth, guard: createSessionResumeGuard(), ...callbacks });
      await vi.advanceTimersByTimeAsync(SESSION_REVALIDATION_DEADLINE_MS);
      await expect(resumed).resolves.toBe('unavailable');
      auth.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(auth.calls).toEqual(['refresh']);
      expect(events).toEqual(['cover', 'clear', 'unavailable', 'settle', 'reveal']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts no later stage after an offline answer', async () => {
    const auth = deferredAuth('refresh');
    const { events, callbacks } = recorder();
    await expect(resumeProtectedSession({
      auth: auth.auth, guard: createSessionResumeGuard(), ...callbacks, reachable: async () => false,
    })).resolves.toBe('unavailable');
    auth.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(auth.calls).toEqual(['refresh']);
    expect(events).toEqual(['cover', 'clear', 'unavailable', 'settle', 'reveal']);
  });

  // The expiry handler closes the predicate itself. A held stage released in
  // the turns between that handler and the resume's own continuation must not
  // start the next Auth request (G2-02).
  const expiryOffsets = [0, 1, 2, 3, 4, 5];
  const expiryStages: Array<'refresh' | 'user'> = ['refresh', 'user'];
  async function ticks(count: number) { for (let i = 0; i < count; i += 1) await Promise.resolve(); }

  it.each(expiryStages)('starts no later stage when %s settles just after an offline answer', async (held) => {
    for (const offset of expiryOffsets) {
      const auth = deferredAuth(held);
      const { events, callbacks } = recorder();
      let answerReachable: ((ok: boolean) => void) | undefined;
      // The offline words are confirmed by a fresh probe, which also fails.
      const resumed = resumeProtectedSession({
        auth: auth.auth, guard: createSessionResumeGuard(), ...callbacks,
        reachable: () => (answerReachable
          ? Promise.resolve(false)
          : new Promise<boolean>((resolve) => { answerReachable = resolve; })),
      });
      await vi.waitFor(() => expect(auth.held()).toBe(true));
      answerReachable?.(false);
      await ticks(offset);
      auth.release();
      await expect(resumed).resolves.toBe('unavailable');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(auth.calls, `offset ${offset}`).toEqual(held === 'refresh' ? ['refresh'] : ['refresh', 'user']);
      expect(events).toEqual(['cover', 'clear', 'unavailable', 'settle', 'reveal']);
    }
  });

  it.each(expiryStages)('starts no later stage when %s settles just after the deadline', async (held) => {
    vi.useFakeTimers();
    try {
      for (const offset of expiryOffsets) {
        const auth = deferredAuth(held);
        const { events, callbacks } = recorder();
        const resumed = resumeProtectedSession({ auth: auth.auth, guard: createSessionResumeGuard(), ...callbacks });
        await vi.waitFor(() => expect(auth.held()).toBe(true));
        vi.advanceTimersByTime(SESSION_REVALIDATION_DEADLINE_MS);
        await ticks(offset);
        auth.release();
        await expect(resumed).resolves.toBe('unavailable');
        await vi.advanceTimersByTimeAsync(0);
        expect(auth.calls, `offset ${offset}`).toEqual(held === 'refresh' ? ['refresh'] : ['refresh', 'user']);
        expect(events).toEqual(['cover', 'clear', 'unavailable', 'settle', 'reveal']);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults the stage predicate to current for direct callers', async () => {
    const { auth, calls } = authFor();
    await expect(revalidateSessionOnResume(auth)).resolves.toMatchObject({ status: 'authenticated' });
    expect(calls).toEqual(['refresh', 'user', 'assurance']);
    const stale = authFor();
    await expect(revalidateSessionOnResume(stale.auth, undefined, () => false)).resolves.toEqual({ status: 'stale' });
    expect(stale.calls).toEqual(['refresh']);
  });

  it('settles once before reveal for every current outcome', async () => {
    const outcomes = [
      { auth: authFor().auth, expected: 'authenticated' },
      { auth: authFor(session(), { assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } }).auth, expected: 'mfaRequired' },
      { auth: authFor(session(), { refreshError: providerAuthError('refresh_token_not_found') }).auth, expected: 'signedOut' },
      { auth: authFor(session(), { userError: providerAuthError('request_timeout', 503) }).auth, expected: 'unavailable' },
    ];
    for (const { auth, expected } of outcomes) {
      const { events, callbacks } = recorder();
      await expect(resumeProtectedSession({ auth, guard: createSessionResumeGuard(), ...callbacks })).resolves.toBe(expected);
      expect(events.slice(-2)).toEqual(['settle', 'reveal']);
      expect(events.filter((event) => event === 'settle')).toHaveLength(1);
    }
  });

  it('hands bootstrap a capability that a newer attempt revokes for good, even for the same user again', async () => {
    const guard = createSessionResumeGuard();
    const coordinator = createSessionResumeAttemptCoordinator();
    const accountA = session('user-current', 'a1');
    const attemptA = coordinator.begin(accountA.user.id);
    const { events, callbacks } = recorder();
    let capability: (() => boolean) | undefined;
    let releaseBootstrap: (() => void) | undefined;
    const resumed = resumeProtectedSession({
      auth: authFor(accountA).auth,
      guard,
      ...callbacks,
      isSessionCurrent: (candidate) => coordinator.sessionIsCurrent(attemptA, candidate),
      bootstrap: async (_session, isCurrent) => {
        capability = isCurrent;
        events.push('bootstrap');
        await new Promise<void>((resolve) => { releaseBootstrap = resolve; });
      },
    });
    await vi.waitFor(() => expect(releaseBootstrap).toBeTypeOf('function'));
    expect(capability?.()).toBe(true);
    // A -> B -> A: a different account, then the original user again under a
    // new login. Only the generation decides ownership, not the user ID.
    coordinator.observe('SIGNED_IN', session('user-replacement', 'b1'));
    guard.begin();
    expect(capability?.()).toBe(false);
    const returnedA = coordinator.begin(accountA.user.id);
    guard.begin();
    expect(coordinator.sessionIsCurrent(returnedA, accountA)).toBe(true);
    expect(capability?.()).toBe(false);
    releaseBootstrap?.();
    await expect(resumed).resolves.toBe('stale');
    expect(events).toEqual(['cover', 'clear', 'prepare', 'bootstrap']);
  });

  it('revokes the capability for a new SID of the same user without a guard change', async () => {
    const coordinator = createSessionResumeAttemptCoordinator();
    const accountA = session('user-current', 'a1');
    const attemptA = coordinator.begin(accountA.user.id);
    let capability: (() => boolean) | undefined;
    const { events, callbacks } = recorder();
    const resumed = resumeProtectedSession({
      auth: authFor(accountA).auth,
      guard: createSessionResumeGuard(),
      ...callbacks,
      isSessionCurrent: (candidate) => coordinator.sessionIsCurrent(attemptA, candidate),
      bootstrap: async (_session, isCurrent) => {
        capability = isCurrent;
        coordinator.observe('SIGNED_IN', session('user-current', 'a2', '33333333-3333-4333-8333-333333333333'));
        throw new Error('stale recovery rejection');
      },
    });
    await expect(resumed).resolves.toBe('stale');
    expect(capability?.()).toBe(false);
    expect(events).toEqual(['cover', 'clear', 'prepare']);
  });

  it('bounds a bootstrap that never settles after successful authorization', async () => {
    vi.useFakeTimers();
    try {
      const { events, callbacks } = recorder();
      let outcome: string | undefined;
      const bootstrapTimedOut = vi.fn();
      void resumeProtectedSession({
        auth: authFor().auth,
        guard: createSessionResumeGuard(),
        ...callbacks,
        bootstrapTimedOut,
        bootstrap: async () => {
          events.push('bootstrap');
          await new Promise<void>(() => undefined);
        },
      }).then(result => { outcome = result; });

      await vi.advanceTimersByTimeAsync(SESSION_BOOTSTRAP_DEADLINE_MS - 1);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBe('unavailable');
      expect(bootstrapTimedOut).toHaveBeenCalledOnce();
      expect(events).toEqual(['cover', 'clear', 'prepare', 'bootstrap', 'clear', 'unavailable', 'settle', 'reveal']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes timed-out bootstrap writes before the resume continuation runs', async () => {
    vi.useFakeTimers();
    try {
      const { events, callbacks } = recorder();
      let capability: (() => boolean) | undefined;
      let release: (() => void) | undefined;
      const resumed = resumeProtectedSession({
        auth: authFor().auth,
        guard: createSessionResumeGuard(),
        ...callbacks,
        bootstrapDeadlineMs: 25,
        bootstrap: async (_session, isCurrent) => {
          capability = isCurrent;
          events.push('bootstrap');
          await new Promise<void>(resolve => { release = resolve; });
          if (isCurrent()) events.push('late-protected-write');
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(capability?.()).toBe(true);
      vi.advanceTimersByTime(25);
      expect(capability?.()).toBe(false);
      release?.();
      await expect(resumed).resolves.toBe('unavailable');
      expect(events).toEqual(['cover', 'clear', 'prepare', 'bootstrap', 'clear', 'unavailable', 'settle', 'reveal']);
      expect(capability?.()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recover or reveal a superseded attempt when its bootstrap times out', async () => {
    vi.useFakeTimers();
    try {
      const guard = createSessionResumeGuard();
      const { events, callbacks } = recorder();
      const bootstrapTimedOut = vi.fn();
      const resumed = resumeProtectedSession({
        auth: authFor().auth,
        guard,
        ...callbacks,
        bootstrapDeadlineMs: 25,
        bootstrapTimedOut,
        bootstrap: async () => {
          events.push('bootstrap');
          await new Promise<void>(() => undefined);
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      guard.invalidate();
      await vi.advanceTimersByTimeAsync(25);
      await expect(resumed).resolves.toBe('stale');
      expect(bootstrapTimedOut).not.toHaveBeenCalled();
      expect(events).toEqual(['cover', 'clear', 'prepare', 'bootstrap']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the bootstrap timer on success and keeps the completed capability closed', async () => {
    vi.useFakeTimers();
    try {
      const { events, callbacks } = recorder();
      let capability: (() => boolean) | undefined;
      await expect(resumeProtectedSession({
        auth: authFor().auth,
        guard: createSessionResumeGuard(),
        ...callbacks,
        bootstrapDeadlineMs: 25,
        bootstrap: async (_session, isCurrent) => {
          capability = isCurrent;
          expect(isCurrent()).toBe(true);
          events.push('bootstrap');
        },
      })).resolves.toBe('authenticated');
      expect(capability?.()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(25);
      expect(events).toEqual(['cover', 'clear', 'prepare', 'bootstrap', 'authenticated', 'settle', 'reveal']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an adopted same-SID refresh current through bootstrap', async () => {
    const coordinator = createSessionResumeAttemptCoordinator();
    const before = session('user-current', 'before-refresh');
    const rotated = session('user-current', 'after-refresh');
    const attempt = coordinator.begin(before.user.id);
    const { auth } = authFor(rotated);
    auth.refreshSession.mockImplementation(async () => {
      expect(coordinator.observe('TOKEN_REFRESHED', rotated)).toMatchObject({ status: 'expected-refresh' });
      return { data: { session: rotated }, error: null };
    });
    let capability: boolean | undefined;
    const { events, callbacks } = recorder();
    await expect(resumeProtectedSession({
      auth,
      guard: createSessionResumeGuard(),
      ...callbacks,
      isSessionCurrent: (candidate) => coordinator.sessionIsCurrent(attempt, candidate),
      bootstrap: async (_session, isCurrent) => {
        await Promise.resolve();
        capability = isCurrent();
        events.push('bootstrap');
      },
    })).resolves.toBe('authenticated');
    expect(capability).toBe(true);
    expect(events).toEqual(['cover', 'clear', 'prepare', 'bootstrap', 'authenticated', 'settle', 'reveal']);
  });
});
