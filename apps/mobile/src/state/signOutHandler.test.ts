import { stubSessionWriter } from '../testing/stubSessionWriter';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as failure from '../services/signOutFailure';
import { prepareMySignOut } from '../services/sessionSignOut';

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
import { createAccountLocalTeardown, ACCOUNT_CLEANUP_MESSAGE } from '../services/accountLocalTeardown';
import { createSessionSignOutAttemptCoordinator, exactSessionIdentity, prepareSessionForServerSignOut, resumeProtectedSession } from '../services/sessionResume';
import type { Session } from '@supabase/supabase-js';
import { createNativeAuthGate } from '../lib/nativeAuthGate';
import { replacesAuthenticatedLineage } from '../lib/sessionLineage';
import { SESSION_UNAVAILABLE_ERROR } from '../lib/sessionUnavailableCopy';
import {
  readLifecycleDiagnostics,
  recordLifecycleEvent,
  resetLifecycleDiagnostics,
  setLifecycleDiagnosticsSink,
} from '../services/lifecycleDiagnostics';
import { createResumeRefreshProvenance, createSignInCompletion } from '../lib/signInCompletion';

// Execute the actual provider callback with controlled native/service boundaries.
// No React renderer is installed; extracting the callback avoids duplicating its
// ordering, catch blocks, state writes, or failure-copy decisions in a harness.
const provider = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const callback = provider.match(/const signOut = useCallback\((async[\s\S]*?), \[mode, session, sessionResumeGuard, sessionSignOutAttempts, setSession\]\);/)?.[1];
if (!callback) throw new Error('Provider sign-out callback was not found');
const executable = ts.transpile(`const handler = ${callback}; handler;`, { target: ts.ScriptTarget.ES2022 });

async function attempt(options: { response?: unknown; cleanup?: 'cache' | 'share' | 'staging'; localError?: unknown; cleanupError?: unknown } = {}) {
  const session = options.cleanup === 'staging' ? null : { user: { id: 'test-member' } };
  const rpc = vi.fn().mockResolvedValue(options.response ?? { data: { serverCleanupComplete: true }, error: null, status: 200 });
  const setSession = vi.fn();
  const setMode = vi.fn();
  const setSignOutError = vi.fn();
  const revoke = vi.fn().mockResolvedValue(true);
  const purgeQuickCapture = vi.fn();
  const cache = vi.fn().mockImplementation(async () => { if (options.cleanup === 'cache') throw options.cleanupError ?? new Error('cache rejected'); });
  const share = vi.fn().mockImplementation(async () => { if (options.cleanup === 'share' || options.cleanup === 'staging') throw options.cleanupError ?? new Error('share rejected'); });
  const environment = {
    captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'signed-out'),
    sessionRetryOwner: { current: session as unknown }, setSessionRetryInFlight: vi.fn(),
    ...failure,
    purgeHomeWidgets: vi.fn(),
    signInCompletion: createSignInCompletion(), resumeRefreshProvenance: createResumeRefreshProvenance(), setSignInNotice: vi.fn(),
    ACCOUNT_CLEANUP_MESSAGE, accountLocalTeardown: createAccountLocalTeardown({ readPending: async () => null, writePending: async () => undefined, clearPush: async () => undefined, purgeCaptures: async () => undefined }),
    nativeAuthGate: createNativeAuthGate(), prepareSessionForServerSignOut, prepareMySignOut,
    setOfflineDraftsReady: vi.fn(), suspendOfflineAvailability: vi.fn(),
    OFFLINE_CLEANUP_MESSAGE: 'Offline cleanup pending',
    SESSION_UNAVAILABLE_ERROR,
    requestOfflineSignOutCleanup: vi.fn(async () => undefined),
    mode: options.cleanup === 'staging' ? 'preview' : 'authenticated', session,
    pendingAuthTransition: { current: null }, activeUserID: { current: session?.user.id ?? null },
    observedAuthIdentity: { current: session }, authIdentityMatches: () => true,
    sessionSignOutAttempts: { begin: () => ({}), finish: vi.fn(), identityIsCurrent: () => true, latestSessionFor: () => session },
    shareIsolationBlocked: { current: false }, sessionTransition: { current: 0 }, sessionResumeGuard: { invalidate: vi.fn() }, sessionResumeAttempts: { hasActive: () => false }, deferredForegroundResume: { current: false },
    setSignOutError, setSession, setMode, recordLifecycleEvent,
    globalSignOutIncompleteRef: { current: false }, setGlobalSignOutIncompleteSignedOut: vi.fn(),
    lastAuthenticatedUserIDRef: { current: null as string | null },
    lastAuthenticatedSessionIDRef: { current: null as string | null }, replacesAuthenticatedLineage,
    purgeAttachmentCacheForSignOut: cache, preparePendingSharedAttachmentUploadForSignOut: share,
    preparePendingSharedAttachmentStagingForPreviewExit: share,
    pauseNativePushRegistration: vi.fn(), resumeNativePushRegistration: vi.fn(),
    createCapturedSessionRpcClient: () => ({ rpc }), deleteNativePushInstallationForSignOut: vi.fn(),
    clearNativePushPreferenceForSignOut: async () => { if (options.localError) throw options.localError; },
    revokeAndClearCapturedMobileSession: revoke,
    capturedSessionIsGone: vi.fn(async () => false),
    purgeQuickCaptureForUser: purgeQuickCapture,
    haptics: { warning: vi.fn() },
  };
  environment.accountLocalTeardown = createAccountLocalTeardown({ readPending: async () => null, writePending: async () => undefined, clearPush: environment.clearNativePushPreferenceForSignOut, purgeCaptures: environment.purgeQuickCaptureForUser });
  const handler = runInNewContext(executable, environment) as () => Promise<void>;
  const pending = handler();
  // Sign-out releases a retry before its first asynchronous cleanup, even
  // when that cleanup later fails and leaves this same session signed in.
  expect(environment.sessionRetryOwner.current).toBeNull();
  expect(environment.setSessionRetryInFlight).toHaveBeenCalledWith(null);
  await pending;
  expect(environment.purgeHomeWidgets).toHaveBeenCalledOnce();
  expect(setSession).not.toHaveBeenCalled();
  expect(setMode).not.toHaveBeenCalled();
  expect(revoke).not.toHaveBeenCalled();
  expect(environment.requestOfflineSignOutCleanup).not.toHaveBeenCalled();
  return { message: setSignOutError.mock.calls.at(-1)?.[0] as string, rpc, share, purgeQuickCapture };
}

describe('provider sign-out failure boundaries', () => {
  it.each([
    { data: null, error: { code: 'PGRST202' }, status: 404 },
    { data: null, error: { message: 'non-JSON gateway rejection' }, status: 503 },
  ])('names the service rejection and retains the session', async (response) => {
    const { message } = await attempt({ response });
    expect(message).toContain('service refused');
    expect(message).toContain('try again');
    expect(message).not.toContain('reconnect');
  });

  it('keeps reconnect guidance for a transport failure and retains the session', async () => {
    const { message } = await attempt({ response: { data: null, error: { code: '', message: 'Failed to fetch' }, status: 0 } });
    expect(message).toContain('reconnect and finish signing out');
  });

  it('names local cleanup after a successful RPC without blaming the service', async () => {
    const { message } = await attempt({ localError: Object.assign(new Error('local'), { code: 'ERR_SECURESTORE_WRITE' }) });
    expect(message).toContain('this device');
    expect(message).not.toContain('service refused');
    expect(message).not.toContain('reconnect');
  });

  it.each(['cache', 'share', 'staging'] as const)('names the rejecting %s step and never reaches the RPC', async (cleanup) => {
    const { message, rpc, share } = await attempt({ cleanup });
    expect(message).toContain(cleanup === 'cache' ? 'temporary attachments' : 'pending shared attachments');
    expect(message).toContain('remain signed in');
    expect(rpc).not.toHaveBeenCalled();
    if (cleanup === 'cache') expect(share).not.toHaveBeenCalled();
  });
});

// BUG-UG-MOBILE-SIGNOUT-CACHE-PURGE-ABORT-20260905: the offline-lock abort
// was observed once and its originating exception was discarded by the early
// catch, so the failing call could not be named. The provider must now record
// a content-free cleanup-failed event that names the step and reduces the
// thrown value to an enumerated reason, while the refusal copy and the
// retained session keep their fail-closed behaviour.
describe('offline-lock cleanup failure evidence', () => {
  beforeEach(() => {
    resetLifecycleDiagnostics();
    setLifecycleDiagnosticsSink(() => undefined);
  });

  type CleanupFailureCase = {
    cleanup: 'cache' | 'share' | 'staging';
    code: string;
    step: 'purge-attachment-cache' | 'pending-share-upload' | 'pending-share-staging';
    reason: 'not-found' | 'permission-denied';
  };
  const cleanupFailureCases: CleanupFailureCase[] = [
    { cleanup: 'cache', code: 'ENOENT', step: 'purge-attachment-cache', reason: 'not-found' },
    { cleanup: 'cache', code: 'EACCES', step: 'purge-attachment-cache', reason: 'permission-denied' },
    { cleanup: 'share', code: 'EACCES', step: 'pending-share-upload', reason: 'permission-denied' },
    { cleanup: 'staging', code: 'ERR_NO_PERMISSION', step: 'pending-share-staging', reason: 'permission-denied' },
  ];

  it.each(cleanupFailureCases)('captures the $code failure of $step as reason $reason and keeps the session', async ({ cleanup, code, step, reason }) => {
    const cleanupError = Object.assign(new Error('private worker file path'), { code });
    const { message, rpc } = await attempt({ cleanup, cleanupError });
    expect(message).toContain(cleanup === 'cache' ? 'temporary attachments' : 'pending shared attachments');
    expect(message).toContain('remain signed in');
    expect(rpc).not.toHaveBeenCalled();

    const events = readLifecycleDiagnostics();
    // The failing step is bracketed by a start event and a captured failure
    // event whose reason is the classified originating exception.
    expect(events).toContainEqual(expect.objectContaining({
      scope: 'sign-out', step: 'cleanup-step-start', outcome: step,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      scope: 'sign-out', step: 'cleanup-failed', outcome: step, reason, status: null,
    }));
    // The exception's own text never reaches the retained channel.
    expect(JSON.stringify(events)).not.toContain('private worker file path');
  });

  it('records the step transitions in order when the cache purge rejects', async () => {
    await attempt({ cleanup: 'cache', cleanupError: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    const steps = readLifecycleDiagnostics()
      .filter((event) => event.scope === 'sign-out')
      .map((event) => `${event.step}:${event.outcome ?? ''}`);
    expect(steps).toEqual([
      'cleanup-step-start:purge-attachment-cache',
      'cleanup-failed:purge-attachment-cache',
    ]);
  });
});

// BUG-UG-MOBILE-TESTS-03-F1-20260919: sessionResume.test.ts's "AppProvider
// foreground boundary" suite proved the stale-transition guard ordering by
// running `indexOf` over the raw source text, so a guard hidden behind a
// comment or an `if (false)` would still read as "present and in order". This
// runs the real extracted callback end to end and proves, by execution, that
// once the session transition goes stale mid-await no later sign-out side
// effect fires.
type GuardedStep = 'cache' | 'share' | 'pause' | 'deleteInstallation' | 'rpc' | 'clearPushPreference' | 'revoke' | 'clearLocalNotificationPreference';
type SignOutTraceStep = GuardedStep
  | 'resumePushRegistration'
  | 'purgeQuickCapture'
  | 'purgeOfflineItems'
  | 'resetForSession'
  | 'setSession'
  | 'setDashboard'
  | 'setMemberLanguage'
  | 'setChapterMemberships'
  | 'setOrganizationStaffScope'
  | 'setPreviewHat'
  | 'setPreviewShellState'
  | 'setPreviewDesk'
  | 'setPreviewThreads'
  | 'setWidgetLayouts'
  | 'setMode'
  | 'setLocked'
  | 'setPrivacyCovered'
  | 'setAssuranceUnavailable'
  | 'setError'
  | 'setSignOutError';
const GUARDED_STEPS: readonly GuardedStep[] = [
  'cache', 'share', 'pause', 'deleteInstallation', 'rpc', 'clearPushPreference', 'revoke',
  'clearLocalNotificationPreference',
];
const FINAL_STATE_RESET_ORDER: readonly SignOutTraceStep[] = [
  'resetForSession', 'setSession', 'setDashboard', 'setMemberLanguage', 'setChapterMemberships',
  'setOrganizationStaffScope', 'setPreviewHat', 'setPreviewShellState',
  'setPreviewDesk', 'setPreviewThreads', 'setWidgetLayouts', 'setMode', 'setLocked',
  'setPrivacyCovered', 'setAssuranceUnavailable', 'setError', 'setSignOutError',
];
const FULL_SIGN_OUT_ORDER: readonly SignOutTraceStep[] = [
  'setSignOutError', ...GUARDED_STEPS, 'resumePushRegistration', 'purgeQuickCapture', 'purgeOfflineItems',
  ...FINAL_STATE_RESET_ORDER,
];

function buildLiveSignOutEnvironment(staleAfter?: GuardedStep, purgeFailure?: unknown) {
  const session = { user: { id: 'test-member' } };
  const sessionTransition = { current: 0 };
  const calls: SignOutTraceStep[] = [];
  const purgedUsers: string[] = [];
  const bump = (name: GuardedStep) => {
    calls.push(name);
    if (staleAfter === name) sessionTransition.current += 1;
  };
  const rpc = vi.fn(async () => {
    bump('rpc');
    return { data: { serverCleanupComplete: true }, error: null, status: 200 };
  });
  const cache = vi.fn(async () => bump('cache'));
  const share = vi.fn(async () => bump('share'));
  const pause = vi.fn(async () => bump('pause'));
  const deleteInstallation = vi.fn(async () => bump('deleteInstallation'));
  const clearPushPreference = vi.fn(async () => bump('clearPushPreference'));
  const revoke = vi.fn(async () => {
    bump('revoke');
    return true;
  });
  const clearLocalNotificationPreference = vi.fn(async () => bump('clearLocalNotificationPreference'));
  const resumePushRegistration = vi.fn(() => calls.push('resumePushRegistration'));
  const purgeQuickCapture = vi.fn(async (userId: string) => {
    calls.push('purgeQuickCapture');
    purgedUsers.push(userId);
    if (purgeFailure) throw purgeFailure;
  });
  const tracedStateWrite = (name: SignOutTraceStep) => vi.fn(() => calls.push(name));
  const setSession = vi.fn(() => calls.push('setSession'));
  const setMode = vi.fn(() => calls.push('setMode'));
  const setSignOutError = tracedStateWrite('setSignOutError');
  const environment = {
    captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'signed-out'),
    sessionRetryOwner: { current: null }, setSessionRetryInFlight: vi.fn(),
    ...failure,
    purgeHomeWidgets: vi.fn(),
    signInCompletion: createSignInCompletion(), resumeRefreshProvenance: createResumeRefreshProvenance(), setSignInNotice: vi.fn(),
    ACCOUNT_CLEANUP_MESSAGE, accountLocalTeardown: createAccountLocalTeardown({ readPending: async () => null, writePending: async () => undefined, clearPush: async () => undefined, purgeCaptures: async () => undefined }),
    nativeAuthGate: createNativeAuthGate(), prepareSessionForServerSignOut, prepareMySignOut,
    setOfflineDraftsReady: vi.fn(), suspendOfflineAvailability: vi.fn(),
    OFFLINE_CLEANUP_MESSAGE: 'Offline cleanup pending',
    SESSION_UNAVAILABLE_ERROR,
    requestOfflineSignOutCleanup: vi.fn(async () => { calls.push('purgeOfflineItems'); }),
    mode: 'authenticated', session,
    pendingAuthTransition: { current: null },
    activeUserID: { current: session.user.id },
    observedAuthIdentity: { current: session },
    authIdentityMatches: () => true,
    sessionSignOutAttempts: {
      begin: () => ({}), finish: vi.fn(), identityIsCurrent: () => true, latestSessionFor: () => session,
    },
    shareIsolationBlocked: { current: false }, sessionTransition, sessionResumeGuard: { invalidate: vi.fn() }, sessionResumeAttempts: { hasActive: () => false }, deferredForegroundResume: { current: false },
    setSignOutError, setSession, setMode, recordLifecycleEvent,
    globalSignOutIncompleteRef: { current: false }, setGlobalSignOutIncompleteSignedOut: vi.fn(),
    lastAuthenticatedUserIDRef: { current: null as string | null },
    lastAuthenticatedSessionIDRef: { current: null as string | null }, replacesAuthenticatedLineage,
    purgeAttachmentCacheForSignOut: cache, preparePendingSharedAttachmentUploadForSignOut: share,
    preparePendingSharedAttachmentStagingForPreviewExit: share,
    pauseNativePushRegistration: pause, resumeNativePushRegistration: resumePushRegistration,
    createCapturedSessionRpcClient: () => ({ rpc }), deleteNativePushInstallationForSignOut: deleteInstallation,
    clearNativePushPreferenceForSignOut: clearPushPreference,
    revokeAndClearCapturedMobileSession: revoke,
    capturedSessionIsGone: vi.fn(async () => false),
    purgeQuickCaptureForUser: purgeQuickCapture,
    haptics: { warning: vi.fn(), select: vi.fn() },
    clearLocalNotificationPreference,
    dashboardRequest: { current: 0 }, blockedShareIsolation: { current: null },
    liveChannelStore: { resetForSession: tracedStateWrite('resetForSession') },
    setDashboard: tracedStateWrite('setDashboard'), setMemberLanguage: tracedStateWrite('setMemberLanguage'),
    setChapterMemberships: tracedStateWrite('setChapterMemberships'),
    setOrganizationStaffScope: tracedStateWrite('setOrganizationStaffScope'),
    setPreviewHat: tracedStateWrite('setPreviewHat'),
    setPreviewShellState: tracedStateWrite('setPreviewShellState'),
    setPreviewDesk: tracedStateWrite('setPreviewDesk'), setPreviewThreads: tracedStateWrite('setPreviewThreads'),
    previewStore: { current: {} }, setWidgetLayouts: tracedStateWrite('setWidgetLayouts'),
    setLocked: tracedStateWrite('setLocked'), setPrivacyCovered: tracedStateWrite('setPrivacyCovered'),
    setAssuranceUnavailable: tracedStateWrite('setAssuranceUnavailable'),
    setError: tracedStateWrite('setError'),
  };
  environment.accountLocalTeardown = createAccountLocalTeardown({ readPending: async () => null, writePending: async () => undefined, clearPush: environment.clearNativePushPreferenceForSignOut, purgeCaptures: environment.purgeQuickCaptureForUser });
  return { environment, calls, setSession, setMode, setSignOutError, revoke, purgeQuickCapture, purgedUsers };
}

describe('provider sign-out transition guard (behavioral)', () => {
  it('invalidates a pending native result before any sign-out side effect', async () => {
    const { environment } = buildLiveSignOutEnvironment();
    const operation = environment.nativeAuthGate.begin(null);
    const handler = runInNewContext(executable, environment) as () => Promise<void>;
    await handler();
    expect(operation.current()).toBe(false);
    expect(operation.signal.aborted).toBe(true);
    operation.finish();
  });
  it('runs every guarded step in order and clears the session when nothing goes stale', async () => {
    const { environment, calls, setSession, setMode, revoke } = buildLiveSignOutEnvironment();
    const handler = runInNewContext(executable, environment) as () => Promise<void>;
    await handler();
    expect(calls).toEqual([...FULL_SIGN_OUT_ORDER]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(setSession).toHaveBeenCalledWith(null);
    expect(setMode).toHaveBeenCalledWith('signedOut');
  });

  it.each(GUARDED_STEPS)(
    'stops right after %s and never reaches a later sign-out side effect once the transition goes stale mid-await',
    async (staleStep) => {
      const { environment, calls, setSession, setMode } = buildLiveSignOutEnvironment(staleStep);
      const handler = runInNewContext(executable, environment) as () => Promise<void>;
      await handler();
      const staleIndex = FULL_SIGN_OUT_ORDER.indexOf(staleStep);
      const expected = [...FULL_SIGN_OUT_ORDER.slice(0, staleIndex + 1)];
      if (GUARDED_STEPS.indexOf(staleStep) >= GUARDED_STEPS.indexOf('pause')) {
        expected.push('resumePushRegistration');
      }
      expect(calls).toEqual(expected);
      expect(setSession).not.toHaveBeenCalled();
      expect(setMode).not.toHaveBeenCalled();
    },
  );
});

describe('server sign-out while an expired session refreshes', () => {
  it('waits for the same-session refresh after local cleanup and uses its newest token for the barriers', async () => {
    const { environment, revoke } = buildLiveSignOutEnvironment();
    const sessionID = '11111111-1111-4111-8111-111111111111';
    const token = (version: string) => `header.${Buffer.from(JSON.stringify({ session_id: sessionID, version })).toString('base64url')}.signature`;
    const initial = { user: { id: 'test-member' }, access_token: token('old'), refresh_token: 'fixture-old', expires_at: Math.floor(Date.now() / 1000) - 10 } as Session;
    const refreshed = { ...initial, access_token: token('new'), refresh_token: 'fixture-new', expires_at: Math.floor(Date.now() / 1000) + 600 };
    const coordinator = createSessionSignOutAttemptCoordinator();
    const observed = { current: exactSessionIdentity(initial) };
    let releaseRead!: (answer: { data: { session: Session }; error: null }) => void;
    const getSession = vi.fn(() => new Promise<{ data: { session: Session }; error: null }>((resolve) => { releaseRead = resolve; }));
    const capturedClient = vi.fn((captured: Session) => {
      expect(captured.user.id).toBe('test-member');
      return environment.createCapturedSessionRpcClient();
    });
    const context = {
      ...environment, session: initial, sessionSignOutAttempts: coordinator,
      observedAuthIdentity: observed, getSupabaseClient: () => ({ auth: { getSession } }),
      createCapturedSessionRpcClient: capturedClient,
      mobileConfig: { supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-key' },
      backendReachable: async () => true,
    };
    const handler = runInNewContext(executable, context) as () => Promise<void>;
    const completion = handler();
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce(), { timeout: 100 });
    expect(environment.preparePendingSharedAttachmentUploadForSignOut).toHaveBeenCalledOnce();
    expect(environment.deleteNativePushInstallationForSignOut).not.toHaveBeenCalled();
    expect(capturedClient).not.toHaveBeenCalled();
    expect(coordinator.observe('TOKEN_REFRESHED', refreshed).status).toBe('adopted-refresh');
    observed.current = exactSessionIdentity(refreshed);
    releaseRead({ data: { session: refreshed }, error: null });
    await completion;
    expect(capturedClient).toHaveBeenCalledTimes(2);
    expect(capturedClient.mock.calls.map(([value]) => value)).toEqual([refreshed, refreshed]);
    expect(revoke).toHaveBeenCalledWith(refreshed, 'local');
    expect(environment.setMode).toHaveBeenCalledWith('signedOut');
  });
});

// SEC-UG-MOBILE-QUICK-CAPTURE-SURVIVES-SIGNOUT: quick-capture notes, tasks
// and voice memos are member-authored content held in SecureStore and the app
// cache, and sign-out had no step that removed them. The purge must run only
// once the sign-out is committed — a refused sign-out leaves the member signed
// in and their captures intact — and must never turn a completed sign-out into
// a reported failure.
describe('provider sign-out quick-capture purge', () => {
  it('purges the signed-out account after the session is released and before the state reset', async () => {
    const { environment, calls, purgeQuickCapture, purgedUsers } = buildLiveSignOutEnvironment();
    const handler = runInNewContext(executable, environment) as () => Promise<void>;
    await handler();
    expect(purgeQuickCapture).toHaveBeenCalledTimes(1);
    expect(purgedUsers).toEqual(['test-member']);
    expect(calls.indexOf('purgeQuickCapture')).toBeGreaterThan(calls.indexOf('revoke'));
    expect(calls.indexOf('purgeQuickCapture')).toBeLessThan(calls.indexOf('setSession'));
  });

  it('completes sign-out and reports retryable cleanup when the purge rejects', async () => {
    const { environment, calls, setSession, setMode, setSignOutError } = buildLiveSignOutEnvironment(
      undefined,
      Object.assign(new Error('keychain unavailable'), { code: 'ERR_SECURESTORE_DELETE' }),
    );
    const handler = runInNewContext(executable, environment) as () => Promise<void>;
    await handler();
    expect(calls).toEqual([...FULL_SIGN_OUT_ORDER]);
    expect(setSession).toHaveBeenCalledWith(null);
    expect(setMode).toHaveBeenCalledWith('signedOut');
    expect(setSignOutError).toHaveBeenLastCalledWith(ACCOUNT_CLEANUP_MESSAGE);
  });

  it('never purges when the service refuses the sign-out', async () => {
    const { purgeQuickCapture } = await attempt({ response: { data: null, error: { code: 'PGRST202' }, status: 404 } });
    expect(purgeQuickCapture).not.toHaveBeenCalled();
  });

  it('never purges when an earlier cleanup step refuses the sign-out', async () => {
    const { purgeQuickCapture } = await attempt({ cleanup: 'cache' });
    expect(purgeQuickCapture).not.toHaveBeenCalled();
  });

  it('never purges when the preview exit leaves no worker identity', async () => {
    const { purgeQuickCapture } = await attempt({ cleanup: 'staging' });
    expect(purgeQuickCapture).not.toHaveBeenCalled();
  });
});


it('keeps a committed sign-out signed out while reporting a failed offline purge', async () => {
  const { environment, setSession, setMode, setSignOutError, revoke } = buildLiveSignOutEnvironment();
  environment.requestOfflineSignOutCleanup.mockRejectedValueOnce(new Error('keychain unavailable'));
  const handler = runInNewContext(executable, environment) as () => Promise<void>;
  await handler();
  expect(revoke).toHaveBeenCalledOnce();
  expect(setSession).toHaveBeenCalledWith(null);
  expect(setMode).toHaveBeenCalledWith('signedOut');
  expect(setSignOutError).toHaveBeenLastCalledWith(environment.OFFLINE_CLEANUP_MESSAGE);
});

// BUG-UG-MOBILE-REVOKED-SESSION-STUCK-20261002: a session revoked on the
// server (an MFA recovery on another phone) must let the member reach sign-in.
// These drive the real provider callbacks with the answers the phones got.
const resumeCallback = provider.match(/const revalidateAuthenticatedSession = useCallback\((async[\s\S]*?), \[clearProtectedState, fetchDashboard, purgeSecureShareStaging, sessionResumeAttempts, sessionResumeGuard, setSession\]\);/)?.[1];
if (!resumeCallback) throw new Error('Provider resume callback was not found');
const resumeExecutable = ts.transpile(`const handler = ${resumeCallback}; handler;`, { target: ts.ScriptTarget.ES2022 });

// What Auth answered for the revoked session: refresh_token_not_found, HTTP 400.
const definitiveRefreshFailure = { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' };
// What PostgREST answers when private.current_member_session_id() raises 42501.
const memberSessionRequired = { data: null, error: { code: '42501', message: 'worker session required', details: null, hint: null }, status: 403 };

function coldRestoreOfRevokedSession(localClear: boolean) {
  const session = { user: { id: 'test-member' }, access_token: 'revoked-access', refresh_token: 'revoked-refresh' };
  const setMode = vi.fn();
  const environment = {
    captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'signed-out'),
    sessionBootstrapDeadline: { current: 10_000 }, SESSION_BOOTSTRAP_DEADLINE_MS: 10_000,
    sessionRetryOwner: { current: null }, setSessionRetryInFlight: vi.fn(),
    pendingAuthTransition: { current: null }, authIdentityMatches: () => true,
    observedAuthIdentity: { current: session }, blockedShareIsolation: { current: null },
    activeUserID: { current: null as string | null }, sessionTransition: { current: 0 },
    shareIsolationBlocked: { current: false }, dashboardRequest: { current: 0 }, previewStore: { current: {} },
    getSupabaseClient: () => ({ auth: { refreshSession: async () => ({ data: { session: null }, error: definitiveRefreshFailure }) } }),
    mobileConfig: { supabaseUrl: '' },
    sessionResumeAttempts: { begin: () => ({}), finish: vi.fn(), sessionIsCurrent: () => true },
    signInCompletion: createSignInCompletion(), resumeRefreshProvenance: createResumeRefreshProvenance(), setSignInNotice: vi.fn(), revokedElsewhereSessionID: { current: null },
    sessionResumeGuard: { begin: () => ({ isCurrent: () => true }), invalidate: vi.fn() },
    resumeProtectedSession,
    // true: the storage fix (an already-removed session counts as cleared);
    // false: a genuinely different session is stored, which must stay intact.
    clearCapturedMobileSessionLocally: vi.fn(async () => localClear),
    captureSecureShareCleanupBoundary: vi.fn(), conversationUnreadStore: { reset: vi.fn() },
    preparePendingSharedAttachmentUploadForSessionLoss: vi.fn(async () => 'clear'),
    suspendOfflineAvailability: vi.fn(), setOfflineDraftsReady: vi.fn(), requestOfflineSignOutCleanup: vi.fn(async () => undefined),
    clearLocalNotificationPreference: vi.fn(async () => undefined),
    setSession: vi.fn(), setPreviewHat: vi.fn(), setPreviewShellState: vi.fn(), setPreviewDesk: vi.fn(), setPreviewThreads: vi.fn(),
    setWidgetLayouts: vi.fn(), setError: vi.fn(), setAssuranceUnavailable: vi.fn(), setLocked: vi.fn(), setSignOutError: vi.fn(),
    setSignOutErrorState: vi.fn(), signOutErrorRef: { current: null },
    globalSignOutIncompleteRef: { current: false }, setGlobalSignOutIncompleteSignedOut: vi.fn(),
    lastAuthenticatedUserIDRef: { current: null as string | null },
    lastAuthenticatedSessionIDRef: { current: null as string | null }, replacesAuthenticatedLineage,
    setMode, setPrivacyCovered: vi.fn(), purgeSecureShareStaging: vi.fn(async () => undefined), clearProtectedState: vi.fn(),
  };
  Object.assign(environment, { ACCOUNT_CLEANUP_MESSAGE, SESSION_UNAVAILABLE_ERROR, accountLocalTeardown: createAccountLocalTeardown({ readPending: async () => null, writePending: async () => undefined, clearPush: vi.fn(async () => undefined), purgeCaptures: vi.fn(async () => undefined) }) });
  return { session, environment, setMode };
}

describe('a session revoked on the server reaches the sign-in screen', () => {
  it('cold restore with a definitive refresh failure goes to signedOut once the local copy clears', async () => {
    const restored = coldRestoreOfRevokedSession(true);
    await (runInNewContext(resumeExecutable, restored.environment) as (covered: unknown) => Promise<void>)(restored.session);
    expect(restored.environment.clearCapturedMobileSessionLocally).toHaveBeenCalledWith(restored.session);
    expect(restored.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(restored.environment.activeUserID.current).toBeNull();
  });

  it('a fail-closed resume keeps the covered account as the owner "Sign out instead" needs', async () => {
    const restored = coldRestoreOfRevokedSession(false);
    await (runInNewContext(resumeExecutable, restored.environment) as (covered: unknown) => Promise<void>)(restored.session);
    expect(restored.setMode).toHaveBeenLastCalledWith('mfaRequired');
    // A refused refresh while online is an assurance failure, not an offline one.
    expect(restored.environment.setAssuranceUnavailable).toHaveBeenLastCalledWith(true, 'assurance');
    expect(restored.environment.setError).toHaveBeenLastCalledWith(SESSION_UNAVAILABLE_ERROR.assurance);
    expect(restored.environment.activeUserID.current).toBe('test-member');
  });

  it.each(['prepare_my_signout', 'delete_my_native_push_installation'])(
    '"Sign out instead" finishes locally when %s refuses a session Auth confirms is gone',
    async (refusingCall) => {
      const { environment, setSession, setMode, revoke } = buildLiveSignOutEnvironment();
      Object.assign(environment, { mode: 'mfaRequired' });
      if (refusingCall === 'prepare_my_signout') {
        Object.assign(environment, { createCapturedSessionRpcClient: () => ({ rpc: vi.fn(async () => memberSessionRequired) }) });
      } else {
        environment.deleteNativePushInstallationForSignOut = vi.fn(async () => {
          throw new failure.SignOutRpcRejectionError(memberSessionRequired);
        });
      }
      environment.capturedSessionIsGone = vi.fn(async () => true);
      await (runInNewContext(executable, environment) as () => Promise<void>)();
      expect(environment.capturedSessionIsGone).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(setSession).toHaveBeenCalledWith(null);
      expect(setMode).toHaveBeenCalledWith('signedOut');
    },
  );

  it('stays fail-closed on the same 42501 when Auth does not confirm the session is gone', async () => {
    const { environment, setSession, setMode, revoke, setSignOutError } = buildLiveSignOutEnvironment();
    Object.assign(environment, { mode: 'mfaRequired' });
    Object.assign(environment, { createCapturedSessionRpcClient: () => ({ rpc: vi.fn(async () => memberSessionRequired) }) });
    await (runInNewContext(executable, environment) as () => Promise<void>)();
    expect(environment.capturedSessionIsGone).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
    expect(setSignOutError).toHaveBeenLastCalledWith(expect.stringContaining('service refused'));
  });
});
