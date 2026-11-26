import { stubSessionWriter } from '../testing/stubSessionWriter';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import * as failure from '../services/signOutFailure';
import { prepareMySignOut } from '../services/sessionSignOut';

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
import { createAccountLocalTeardown, ACCOUNT_CLEANUP_MESSAGE } from '../services/accountLocalTeardown';
import { prepareSessionForServerSignOut } from '../services/sessionResume';
import { createNativeAuthGate } from '../lib/nativeAuthGate';
import { recordLifecycleEvent } from '../services/lifecycleDiagnostics';
import { replacesAuthenticatedLineage } from '../lib/sessionLineage';
import { createResumeRefreshProvenance, createSignInCompletion } from '../lib/signInCompletion';

// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009. "Sign out everywhere" is
// the provider's own sign-out at scope `global`, so these cases run the real
// provider callback — extracted from AppProvider.tsx and executed with
// controlled boundaries, the same way signOutHandler.test.ts does — rather
// than a re-implementation of its ordering and catch blocks.
const provider = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const callback = provider.match(/const signOut = useCallback\((async[\s\S]*?), \[mode, session, sessionResumeGuard, sessionSignOutAttempts, setSession\]\);/)?.[1];
if (!callback) throw new Error('Provider sign-out callback was not found');
const executable = ts.transpile(`const handler = ${callback}; handler;`, { target: ts.ScriptTarget.ES2022 });

type Options = { mode?: string; rpc?: () => Promise<unknown>; sessionGone?: boolean };

function build(options: Options = {}) {
  const mode = options.mode ?? 'authenticated';
  const live = mode !== 'preview';
  const session = live ? { user: { id: 'test-member' } } : null;
  const rpc = vi.fn(options.rpc ?? (async () => ({ data: { serverCleanupComplete: true }, error: null, status: 200 })));
  const revoke = vi.fn(async (_session: unknown, _scope?: string) => true);
  const setSession = vi.fn();
  const setMode = vi.fn();
  const setSignOutError = vi.fn();
  const noop = () => vi.fn();
  const environment = {
    captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'signed-out'),
    sessionRetryOwner: { current: null }, setSessionRetryInFlight: vi.fn(),
    ...failure,
    purgeHomeWidgets: vi.fn(),
    signInCompletion: createSignInCompletion(), resumeRefreshProvenance: createResumeRefreshProvenance(), setSignInNotice: vi.fn(),
    ACCOUNT_CLEANUP_MESSAGE,
    accountLocalTeardown: createAccountLocalTeardown({
      readPending: async () => null, writePending: async () => undefined,
      clearPush: async () => undefined, purgeCaptures: async () => undefined,
    }),
    nativeAuthGate: createNativeAuthGate(), prepareSessionForServerSignOut, prepareMySignOut,
    setOfflineDraftsReady: noop(), suspendOfflineAvailability: noop(),
    OFFLINE_CLEANUP_MESSAGE: 'Offline cleanup pending',
    requestOfflineSignOutCleanup: vi.fn(async () => undefined),
    mode, session,
    pendingAuthTransition: { current: null },
    activeUserID: { current: session?.user.id ?? null },
    observedAuthIdentity: { current: session },
    authIdentityMatches: () => true,
    sessionSignOutAttempts: {
      begin: () => ({}), finish: vi.fn(), identityIsCurrent: () => true, latestSessionFor: () => session,
    },
    shareIsolationBlocked: { current: false },
    sessionTransition: { current: 0 },
    sessionResumeGuard: { invalidate: noop() },
    sessionResumeAttempts: { hasActive: () => false }, deferredForegroundResume: { current: false },
    setSignOutError, setSession, setMode, recordLifecycleEvent,
    globalSignOutIncompleteRef: { current: false }, setGlobalSignOutIncompleteSignedOut: vi.fn(),
    lastAuthenticatedUserIDRef: { current: null as string | null },
    lastAuthenticatedSessionIDRef: { current: null as string | null }, replacesAuthenticatedLineage,
    purgeAttachmentCacheForSignOut: vi.fn(async () => undefined),
    preparePendingSharedAttachmentUploadForSignOut: vi.fn(async () => undefined),
    preparePendingSharedAttachmentStagingForPreviewExit: vi.fn(async () => undefined),
    pauseNativePushRegistration: vi.fn(async () => undefined),
    resumeNativePushRegistration: noop(),
    createCapturedSessionRpcClient: () => ({ rpc }),
    deleteNativePushInstallationForSignOut: vi.fn(async () => undefined),
    clearNativePushPreferenceForSignOut: vi.fn(async () => undefined),
    revokeAndClearCapturedMobileSession: revoke,
    capturedSessionIsGone: vi.fn(async () => options.sessionGone === true),
    purgeQuickCaptureForUser: vi.fn(async () => undefined),
    haptics: { warning: vi.fn(), select: vi.fn() },
    clearLocalNotificationPreference: vi.fn(async () => undefined),
    dashboardRequest: { current: 0 }, blockedShareIsolation: { current: null },
    liveChannelStore: { resetForSession: noop() },
    setDashboard: noop(), setMemberLanguage: noop(), setChapterMemberships: noop(),
    setOrganizationStaffScope: noop(), setDuesContext: noop(), setPreviewHat: noop(),
    setPreviewShellState: noop(), setPreviewDesk: noop(), setPreviewThreads: noop(),
    previewStore: { current: {} }, setWidgetLayouts: noop(),
    setLocked: noop(), setPrivacyCovered: noop(), setAssuranceUnavailable: noop(), setError: noop(),
  };
  const handler = runInNewContext(executable, environment) as (input?: { scope?: string; silent?: boolean }) => Promise<void>;
  return { handler, rpc, revoke, setSession, setMode, setSignOutError };
}

const REFUSED_PREPARE = async () => ({
  data: null,
  error: { code: '42501', message: 'worker session required' },
  status: 403,
});

describe('sign out everywhere carries the global scope to the server', () => {
  it('prepares and revokes at global scope, then returns the app to sign-in', async () => {
    const run = build();
    await run.handler({ scope: 'global', silent: true });
    expect(run.rpc).toHaveBeenCalledWith('prepare_my_signout', {
      p_scope: 'global',
      p_expected_user_id: 'test-member',
    });
    // GoTrue's user-wide logout is what revokes the other devices; the local
    // compare-and-clear that follows is what returns this one to sign-in.
    expect(run.revoke.mock.calls[0]?.[1]).toBe('global');
    expect(run.setSession).toHaveBeenCalledWith(null);
    expect(run.setMode).toHaveBeenCalledWith('signedOut');
    expect(run.setSignOutError).toHaveBeenLastCalledWith(null);
  });

  it('keeps the ordinary sign-out local', async () => {
    const run = build();
    await run.handler({ silent: true });
    expect(run.rpc).toHaveBeenCalledWith('prepare_my_signout', {
      p_scope: 'local',
      p_expected_user_id: 'test-member',
    });
    expect(run.revoke.mock.calls[0]?.[1]).toBe('local');
  });

  it('refuses to promote a preview exit to a server-wide revoke', async () => {
    // Preview has no server session to revoke. Asking for `global` there must
    // not reach the Auth boundary at all.
    const run = build({ mode: 'preview' });
    await run.handler({ scope: 'global', silent: true });
    expect(run.rpc).not.toHaveBeenCalled();
    expect(run.revoke).not.toHaveBeenCalled();
    expect(run.setMode).toHaveBeenCalledWith('signedOut');
  });
});

describe('a global sign-out never reports a success it cannot prove', () => {
  it('stays signed in when this session is already gone, because the other devices are not', async () => {
    // The local path may finish on proof that this captured session is absent
    // from auth.sessions. That proof says nothing about the account's other
    // sessions, and GoTrue's user-wide delete never ran, so accepting it for a
    // global sign-out would clear this device and silently leave every other
    // session alive.
    const run = build({ rpc: REFUSED_PREPARE, sessionGone: true });
    await run.handler({ scope: 'global', silent: true });
    expect(run.revoke).not.toHaveBeenCalled();
    expect(run.setSession).not.toHaveBeenCalled();
    expect(run.setMode).not.toHaveBeenCalled();
    const message = run.setSignOutError.mock.calls.at(-1)?.[0] as string;
    expect(message).toContain('Sign out everywhere is incomplete');
    expect(message).toContain('your other devices may still be signed in');
    expect(message).not.toMatch(/signed out everywhere|all devices/i);
  });

  it('still lets the ordinary sign-out finish on that same proof', async () => {
    const run = build({ rpc: REFUSED_PREPARE, sessionGone: true });
    await run.handler({ silent: true });
    expect(run.revoke).toHaveBeenCalledTimes(1);
    expect(run.setMode).toHaveBeenCalledWith('signedOut');
  });

  it('reports a request that never reached the service without clearing the session', async () => {
    const run = build({
      rpc: async () => ({ data: null, error: { code: '', message: 'Network request failed' }, status: 0 }),
    });
    await run.handler({ scope: 'global', silent: true });
    expect(run.revoke).not.toHaveBeenCalled();
    expect(run.setSession).not.toHaveBeenCalled();
    const message = run.setSignOutError.mock.calls.at(-1)?.[0] as string;
    expect(message).toContain('Sign out everywhere is incomplete');
    expect(message).toContain('reconnect and finish signing out');
  });
});

describe('a sign out everywhere in flight owns sign-out until it settles', () => {
  // The provider's own wrapper, extracted and run against a controllable
  // sign-out, so a second press cannot supersede the global attempt.
  const wrapper = provider.match(/const serializedSignOut = useCallback\((async[\s\S]*?), \[signOut\]\);/)?.[1];
  if (!wrapper) throw new Error('Provider sign-out wrapper was not found');
  const wrapperSource = ts.transpile(`const handler = ${wrapper}; handler;`, { target: ts.ScriptTarget.ES2022 });
  // The wrapper also fills an unset sign-out error after a global attempt that
  // leaves this device signed in; these cases are about the lock, so the device
  // is already signed out and that fill stays out of their way. The warning
  // itself is proved in signOutEverywhereLifecycle.test.ts.
  const wrapperBoundaries = () => ({
    activeUserID: { current: null }, setSignOutError: vi.fn(),
    globalSignOutIncompleteRef: { current: false }, setGlobalSignOutIncompleteSignedOut: vi.fn(),
    lastAuthenticatedUserIDRef: { current: null as string | null },
    lastAuthenticatedSessionIDRef: { current: null as string | null }, replacesAuthenticatedLineage,
    // No foreground was deferred in these cases, so the wrapper's drain has
    // nothing to run (BUG-UG-FOREGROUND-RESUME-CANCELS-AN-IN-FLIGHT-GLOBAL-SIGN-OUT-20261010).
    deferredForegroundResume: { current: false }, setPrivacyCovered: vi.fn(),
    GLOBAL_SIGN_OUT_INCOMPLETE_MESSAGE: failure.GLOBAL_SIGN_OUT_INCOMPLETE_MESSAGE,
  });

  it('refuses a global sign-out while a local one runs', async () => {
    let release: () => void = () => undefined;
    const signOut = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const setSignOutBusy = vi.fn();
    const serialized = runInNewContext(wrapperSource, {
      signOutInFlight: { current: false }, setSignOutBusy, signOut, ...wrapperBoundaries(),
    }) as (input?: { scope?: string }) => Promise<void>;
    const local = serialized();
    await serialized({ scope: 'global' });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(setSignOutBusy.mock.calls).toEqual([[true]]);
    release();
    await local;
    expect(setSignOutBusy.mock.calls).toEqual([[true], [false]]);
  });

  it('refuses any second sign-out while the global one runs, then allows the next', async () => {
    let release: () => void = () => undefined;
    const signOut = vi.fn((options?: { scope?: string }) => (options?.scope === 'global'
      ? new Promise<void>((resolve) => { release = resolve; })
      : Promise.resolve()));
    const serialized = runInNewContext(wrapperSource, {
      signOutInFlight: { current: false }, setSignOutBusy: vi.fn(), signOut, ...wrapperBoundaries(),
    }) as (input?: { scope?: string; silent?: boolean }) => Promise<void>;
    const global = serialized({ scope: 'global' });
    await serialized();
    await serialized({ silent: true });
    await serialized({ scope: 'global' });
    expect(signOut).toHaveBeenCalledTimes(1);
    release();
    await global;
    await serialized();
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(signOut.mock.calls[1]?.[0]).toBeUndefined();
  });

  it('releases the guard when the global attempt throws', async () => {
    const signOut = vi.fn(async (options?: { scope?: string }) => {
      if (options?.scope === 'global') throw new Error('boom');
    });
    const serialized = runInNewContext(wrapperSource, {
      signOutInFlight: { current: false }, setSignOutBusy: vi.fn(), signOut, ...wrapperBoundaries(),
    }) as (input?: { scope?: string }) => Promise<void>;
    await expect(serialized({ scope: 'global' })).rejects.toThrow('boom');
    await serialized();
    expect(signOut).toHaveBeenCalledTimes(2);
  });
});
