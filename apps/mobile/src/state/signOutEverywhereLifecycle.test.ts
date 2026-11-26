import { stubSessionWriter } from '../testing/stubSessionWriter';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

import * as failure from '../services/signOutFailure';
import { mfaRecoveryMessage, redeemMfaRecoveryCode } from '../lib/mfaRecovery';
import { nativeCatalogLabel } from '../lib/nativeUiCopy';
import { prepareMySignOut } from '../services/sessionSignOut';

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
import { createAccountLocalTeardown, ACCOUNT_CLEANUP_MESSAGE } from '../services/accountLocalTeardown';
import { createSessionResumeGuard, createSessionSignOutAttemptCoordinator, exactSessionIdentity, exactSessionIdentityMatches, prepareSessionForServerSignOut, resumeProtectedSession, SESSION_BOOTSTRAP_DEADLINE_MS } from '../services/sessionResume';
import { createNativeAuthGate } from '../lib/nativeAuthGate';
import { recordLifecycleEvent } from '../services/lifecycleDiagnostics';
import { shouldCoverOnAppState } from '../lib/appStatePrivacyCover';
import { accessTokensShareSessionLineage, replacesAuthenticatedLineage, sessionIDFromAccessToken } from '../lib/sessionLineage';
import { SESSION_UNAVAILABLE_ERROR, sessionUnavailableCopy } from '../lib/sessionUnavailableCopy';
import { createResumeRefreshProvenance, createSignInCompletion, SESSION_NOT_CONFIRMED_NOTICE, SIGN_IN_DID_NOT_COMPLETE_NOTICE } from '../lib/signInCompletion';
import type { MfaRecoveryAttempt } from './AppProvider';

// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009, fourth round. A global
// sign-out may never end half-done and silent. The app being sent to the
// background mid-attempt was the way it could: the AppState handler bumped
// `sessionTransition`, which is what the sign-out's own ownership check reads,
// so every remaining step returned early after `prepare_my_signout('global')`
// had already closed the account's barriers and deleted every push row — and
// nothing told the member, because this device simply stayed signed in and the
// card went back to idle.
//
// These cases run the provider's real code, extracted from AppProvider.tsx and
// executed against controlled boundaries (the pattern signOutHandler.test.ts
// and signOutEverywhereScope.test.ts use), so the lifecycle handler and the
// sign-out share the same refs the provider gives them. A re-implementation
// could not prove the interaction between the two.
const provider = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const providerTree = ts.createSourceFile('AppProvider.tsx', provider, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const recoveryScreen = ts.createSourceFile('mfa-challenge.tsx', readFileSync(new URL('../../app/mfa-challenge.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let recoveryScreenSource = '';
let recoveryReportSource = '';
function findRecovery(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'recover') recoveryScreenSource = ts.transpile(`${node.getText(recoveryScreen)}; recover;`, { target: ts.ScriptTarget.ES2022 });
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'report') recoveryReportSource = ts.transpile(`${node.getText(recoveryScreen)}; report;`, { target: ts.ScriptTarget.ES2022 });
  ts.forEachChild(node, findRecovery);
}
findRecovery(recoveryScreen);
if (!recoveryScreenSource) throw new Error('MFA screen recovery callback was not found');

function providerCallback(name: string): string | null {
  let callback: string | null = null;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(providerTree) === name
      && node.initializer && ts.isCallExpression(node.initializer)) {
      callback = node.initializer.arguments[0]?.getText(providerTree) ?? null;
    }
    ts.forEachChild(node, visit);
  };
  visit(providerTree);
  return callback;
}

const realResumeCallback = providerCallback('revalidateAuthenticatedSession');
if (!realResumeCallback) throw new Error('Provider revalidation callback was not found');
const realResumeSource = ts.transpile(`(${realResumeCallback})`, { target: ts.ScriptTarget.ES2022 });
const establishCallback = providerCallback('establishSession');
if (!establishCallback) throw new Error('Provider establishment callback was not found');
const establishSource = ts.transpile(`(${establishCallback})`, { target: ts.ScriptTarget.ES2022 });
const beginRecoveryCallback = providerCallback('beginMfaRecovery');
const confirmRecoveryCallback = providerCallback('confirmMfaRecoveryGlobalSignOut');
if (!beginRecoveryCallback || !confirmRecoveryCallback) throw new Error('Provider MFA recovery callbacks were not found');
const beginRecoverySource = ts.transpile(`(${beginRecoveryCallback})`, { target: ts.ScriptTarget.ES2022 });
const confirmRecoverySource = ts.transpile(`(${confirmRecoveryCallback})`, { target: ts.ScriptTarget.ES2022 });
const finishRecoveryCallback = providerCallback('finishMfaRecovery');
const finishRecoverySource = finishRecoveryCallback && ts.transpile(`(${finishRecoveryCallback})`, { target: ts.ScriptTarget.ES2022 });
// The Auth listener, so a local sign-out's SIGNED_OUT runs the provider's own
// session-loss branch, which is what re-raises the signed-out warning.
let authCallback = '';
const findAuthCallback = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(providerTree).endsWith('.onAuthStateChange')) {
    authCallback = node.arguments[0]?.getText(providerTree) ?? '';
  }
  ts.forEachChild(node, findAuthCallback);
};
findAuthCallback(providerTree);
if (!authCallback) throw new Error('Provider Auth listener was not found');
const authSource = ts.transpile(`(${authCallback})`, { target: ts.ScriptTarget.ES2022 });
const errorCallback = providerCallback('setSignOutError');
const errorSource = errorCallback && ts.transpile(`(${errorCallback})`, { target: ts.ScriptTarget.ES2022 });
// The value the provider publishes to the sign-in screen and the Sessions
// card: the signed-out global warning is composed in at render, not written.
const visibleErrorExpression = provider.match(/const visibleSignOutError = (.*);/)?.[1];
if (!visibleErrorExpression) throw new Error('Provider visible sign-out error expression was not found');
const visibleErrorSource: string = visibleErrorExpression;
const resumeRender = provider.match(/(  const resumeAuthenticatedSession = useCallback[\s\S]*?)\n  \/\/ Re-read device biometric/)?.[1];
if (!resumeRender) throw new Error('Provider resume callback publication was not found');
const resumeRenderSource = ts.transpile(`((session) => { ${resumeRender}; return resumeAuthenticatedSession; })(renderSession)`, { target: ts.ScriptTarget.ES2022 });

// All three extracts run in one shared context (node's vm caches a context on
// the sandbox object, which is how the handler and the sign-out come to share
// the provider's refs), so each needs its own binding name.
function extract(pattern: RegExp, binding: string, name: string): string {
  const source = provider.match(pattern)?.[1];
  if (!source) throw new Error(`Provider ${name} was not found`);
  const value = source.startsWith('{') ? `(next) => ${source}` : source;
  return ts.transpile(`const ${binding} = ${value}; ${binding};`, { target: ts.ScriptTarget.ES2022 });
}

const signOutSource = extract(
  /const signOut = useCallback\((async[\s\S]*?), \[mode, session, sessionResumeGuard, sessionSignOutAttempts, setSession\]\);/,
  'extractedSignOut', 'sign-out callback',
);
const wrapperSource = extract(
  /const serializedSignOut = useCallback\((async[\s\S]*?), \[signOut\]\);/,
  'extractedWrapper', 'sign-out wrapper',
);
// The handler is the body of the AppState subscription, so it is extracted up
// to the `addEventListener` that registers it.
const retrySource = extract(
  /const retrySessionAuthentication = useCallback\((async[\s\S]*?), \[resumeAuthenticatedSession, session, sessionResumeGuard\]\);/,
  'extractedRetry', 're-authentication callback',
);
const appStateSource = extract(
  /const onAppState = \(next: AppStateStatus\) => (\{[\s\S]*?\n {4}\});\n {4}const subscription = AppState\.addEventListener/,
  'extractedAppState', 'AppState handler',
);

type Options = {
  initialSession?: Session;
  currentSession?: () => Session | null;
  rpc?: (context: Context) => Promise<unknown>;
  scope?: 'local' | 'global';
  realResume?: 'authenticated' | 'signedOut';
  rejectShare?: (context: Context) => void;
  onBootstrap?: (context: Context) => void;
  recoverShare?: (context: Context) => void;
  retryOffline?: () => Promise<void>;
  offlineCleanup?: () => Promise<void>;
  needsMfa?: boolean;
  sharePreparation?: () => Promise<void>;
  // Holds the real resume's first refresh until the case releases it, so a
  // sign-out can be pressed while that check is still in flight.
  holdFirstRefresh?: (release: () => void) => void;
  // An auth event during an active resume reports it interrupted, as the
  // provider's coordinator does ( round 1).
  observeInterrupts?: boolean;
  // Gives the session the identity fields the provider's observed identity
  // carries, so a lineage lookup can match it ( round 2).
  lineage?: boolean;
  // Holds the real resume's first user lookup until the case settles it,
  // which then answers as Auth does for a session it has ended (round 3).
  holdFirstUser?: (settle: () => void) => void;
  // The backend probe the real resume sends; without it the harness has no
  // backend URL and the resume treats the backend as reachable.
  reachable?: () => Promise<'reachable' | 'offline' | 'silent'>;
};

interface Context {
  signOut: (input?: { scope?: string; silent?: boolean }) => Promise<void>;
  serializedSignOut: (input?: { scope?: string; silent?: boolean }) => Promise<void>;
  onAppState: (next: string) => void;
  sessionTransition: { current: number };
  activeUserID: { current: string | null };
  signOutInFlight: { current: boolean };
  signInCompletion: ReturnType<typeof createSignInCompletion>;
  setSignInNotice: ReturnType<typeof vi.fn>;
  signOutError: () => string | null;
  // What the member sees: the diagnosis with the signed-out global warning
  // composed in while the provider holds that condition.
  visibleSignOutError: () => string | null;
  globalSignOutIncompleteSignedOut: () => boolean;
  globalSignOutIncompleteRef: { current: boolean };
  lastAuthenticatedUserIDRef: { current: string | null };
  lastAuthenticatedSessionIDRef: { current: string | null };
  setGlobalSignOutIncompleteSignedOut: (next: boolean) => void;
  setMode: ReturnType<typeof vi.fn>;
  setSession: ReturnType<typeof vi.fn>;
  // Intersected with its call signature so a case can also write the cover the
  // way the real resume does, not only assert on it.
  setPrivacyCovered: ReturnType<typeof vi.fn> & ((next: boolean) => void);
  privacyCovered: () => boolean;
  setSignOutError: (next: string | null) => void;
  invalidated: () => number;
  retrySessionAuthentication: () => Promise<boolean>;
  resumeAuthenticatedSession: ReturnType<typeof vi.fn<() => Promise<void>>>;
  latestResumeAuthenticatedSession: { current: () => Promise<void> };
  revoke: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  purgeHomeWidgets: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  resumeNow: () => Promise<void>;
  renderResumeFor: (accessToken: string) => void;
  refreshEstablishedSession: (userID?: string, accessToken?: string) => Promise<void>;
  globalSignOutIncompleteOwnerRef: { current: { userID: string } | null };
  beginMfaRecovery: () => MfaRecoveryAttempt | null;
  finishMfaRecovery: (attempt: MfaRecoveryAttempt) => Promise<boolean>;
  confirmMfaRecoveryGlobalSignOut: (attempt: { userID: string; latch: { userID: string } | null }) => boolean;
  authEvent: (event: string, nextSession: unknown) => void;
  setAssuranceUnavailable: ReturnType<typeof vi.fn<(unavailable: boolean, reason?: string) => void>>;
  refreshCalls: () => number;
}

function build(options: Options = {}): Context {
  const session = options.initialSession ?? {
    user: { id: 'test-member' }, access_token: 'initial-token',
    ...(options.lineage ? { userID: 'test-member', accessToken: 'initial-token' } : {}),
  };
  const noop = () => vi.fn();
  let error: string | null = null;
  let invalidations = 0;
  const setSignOutErrorState = vi.fn((next: unknown) => {
    error = typeof next === 'function'
      ? (next as (previous: string | null) => string | null)(error)
      : (next as string | null);
  });
  const signOutErrorRef = { current: null as string | null };
  const shareRecoveryErrorRef = { current: null as symbol | null };
  const setSignOutError = errorSource
    ? runInNewContext(errorSource, { signOutErrorRef, setSignOutErrorState, shareRecoveryErrorRef }) as Context['setSignOutError']
    : setSignOutErrorState;
  let globalSignOutIncompleteSignedOut = false;
  const setGlobalSignOutIncompleteSignedOut = vi.fn((next: boolean) => { globalSignOutIncompleteSignedOut = next; });
  const globalSignOutIncompleteRef = { current: false };
  const globalSignOutIncompleteOwnerRef: { current: { userID: string } | null } = { current: null };
  const lastAuthenticatedUserIDRef: { current: string | null } = { current: session.user.id };
  const lastAuthenticatedSessionIDRef: { current: string | null } = { current: sessionIDFromAccessToken(session.access_token) };
  const sessionTransition = { current: 0 };
  const activeUserID: { current: string | null } = { current: session.user.id };
  const signOutInFlight = { current: false };
  const resumeGuard = createSessionResumeGuard();
  const dashboardRequest = { current: 0 };
  const setMode = vi.fn();
  const setSession = vi.fn();
  let covered = false;
  const setPrivacyCovered = vi.fn((next: boolean) => { covered = next; });
  const resumeAuthenticatedSession = vi.fn(async (): Promise<void> => undefined);
  const revoke = vi.fn(async (_session: unknown, _scope?: string) => true);
  const setAssuranceUnavailable = vi.fn<(unavailable: boolean, reason?: string) => void>();
  let refreshCalls = 0;
  let userCalls = 0;
  // Begin and finish track the in-flight attempt the way the provider's
  // coordinator does, so a sign-out can see a check it interrupts.
  let activeResumeAttempt: object | null = null;
  const context = {} as Context;
  const rpc = vi.fn(async () => (options.rpc
    ? options.rpc(context)
    : { data: { serverCleanupComplete: true }, error: null, status: 200 }));
  const environment = {
    captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'signed-out'),
    ...failure,
    purgeHomeWidgets: vi.fn(),
    signInCompletion: createSignInCompletion(), resumeRefreshProvenance: createResumeRefreshProvenance(), setSignInNotice: vi.fn(), revokedElsewhereSessionID: { current: null },
    ACCOUNT_CLEANUP_MESSAGE,
    accountLocalTeardown: createAccountLocalTeardown({
      readPending: async () => null, writePending: async () => undefined,
      clearPush: async () => undefined, purgeCaptures: async () => undefined,
    }),
    nativeAuthGate: createNativeAuthGate(), prepareSessionForServerSignOut, prepareMySignOut,
    setOfflineDraftsReady: noop(), suspendOfflineAvailability: noop(),
    OFFLINE_CLEANUP_MESSAGE: 'Offline cleanup pending',
    SESSION_UNAVAILABLE_ERROR,
    requestOfflineSignOutCleanup: vi.fn(options.offlineCleanup ?? (async () => undefined)),
    setGlobalSignOutIncompleteSignedOut, globalSignOutIncompleteRef, globalSignOutIncompleteOwnerRef, lastAuthenticatedUserIDRef,
    lastAuthenticatedSessionIDRef, replacesAuthenticatedLineage, sessionIDFromAccessToken,
    mode: 'authenticated', session,
    // The Auth listener's own boundaries, beyond what the sign-out shares.
    active: true,
    deletedSessionID: { current: null }, deletedUserID: { current: null }, deletionSession: { current: null },
    deletionCleanupAction: { current: async () => undefined }, setDeletionOutcome: vi.fn(),
    purgeAttachmentCacheForSessionLoss: vi.fn(async () => true),
    pendingAuthTransition: { current: null },
    providerMounted: { current: true },
    sessionRetryOwner: { current: null }, setSessionRetryInFlight: noop(), exactSessionIdentity, exactSessionIdentityMatches,
    setTimeout, clearTimeout, SESSION_BOOTSTRAP_DEADLINE_MS,
    sessionBootstrapDeadline: { current: SESSION_BOOTSTRAP_DEADLINE_MS },
    activeUserID,
    observedAuthIdentity: { current: options.initialSession || !options.realResume ? exactSessionIdentity(session as Session) : session },
    authIdentityMatches: (identity: unknown, nextSession: Session) => options.initialSession
      ? exactSessionIdentityMatches(identity as ReturnType<typeof exactSessionIdentity>, exactSessionIdentity(nextSession))
      : !options.realResume || identity === nextSession,
    authIdentityFor: (nextSession: Session | null) => options.initialSession || !options.realResume
      ? nextSession && exactSessionIdentity(nextSession) : nextSession,
    accessTokensShareSessionLineage,
    sessionSignOutAttempts: options.initialSession ? createSessionSignOutAttemptCoordinator() : {
      begin: () => ({}), finish: vi.fn(), identityIsCurrent: () => true, latestSessionFor: () => session,
      observe: () => ({ status: 'handle' }),
    },
    shareIsolationBlocked: { current: false },
    sessionTransition,
    sessionResumeGuard: { ...resumeGuard, invalidate: () => { invalidations += 1; resumeGuard.invalidate(); } },
    setSignOutError, setSignOutErrorState, signOutErrorRef, shareRecoveryErrorRef, setSession, setMode, recordLifecycleEvent,
    secureShareRecoveryNotice: () => 'Attachment recovery failed',
    ShareIntakeError: class extends Error {},
    purgeAttachmentCacheForSignOut: vi.fn(async () => undefined),
    preparePendingSharedAttachmentUploadForSignOut: vi.fn(async () => { options.rejectShare?.(context); await options.sharePreparation?.(); }),
    preparePendingSharedAttachmentStagingForPreviewExit: vi.fn(async () => undefined),
    pauseNativePushRegistration: vi.fn(async () => undefined),
    resumeNativePushRegistration: noop(),
    createCapturedSessionRpcClient: () => ({ rpc }),
    deleteNativePushInstallationForSignOut: vi.fn(async () => undefined),
    clearNativePushPreferenceForSignOut: vi.fn(async () => undefined),
    revokeAndClearCapturedMobileSession: revoke,
    capturedSessionIsGone: vi.fn(async () => false),
    purgeQuickCaptureForUser: vi.fn(async () => undefined),
    haptics: { warning: vi.fn(), select: vi.fn() },
    clearLocalNotificationPreference: vi.fn(async () => undefined),
    dashboardRequest, blockedShareIsolation: { current: null },
    liveChannelStore: { resetForSession: noop() },
    setDashboard: noop(), setMemberLanguage: noop(), setChapterMemberships: noop(),
    setOrganizationStaffScope: noop(), setDuesContext: noop(), setPreviewHat: noop(),
    setPreviewShellState: noop(), setPreviewDesk: noop(), setPreviewThreads: noop(),
    previewStore: { current: {} }, setWidgetLayouts: noop(),
    setLocked: noop(), setPrivacyCovered, setAssuranceUnavailable,
    // The AppState handler's own boundaries. Only the background/inactive half
    // is driven here; the foreground half has its own cases elsewhere.
    signOutInFlight, setSignOutBusy: vi.fn(), resumeAuthenticatedSession,
    observedAppState: { current: 'active' },
    deletionReceipt: { current: false },
    backgroundedAt: { current: null as number | null },
    shouldCoverOnAppState,
    // The foreground half: a lock and unlock during a sign-out runs all of
    // this before it reaches the resume the sign-out must not lose.
    refreshLowDataSignals: vi.fn(async () => undefined),
    retryPendingOfflineSignOutCleanup: vi.fn(options.retryOffline ?? (async () => undefined)),
    purgeAttachmentCache: vi.fn(async () => undefined),
    isSecureShareStagingCleanupRequired: () => false,
    retryPendingSharedAttachmentCleanup: vi.fn(async () => undefined),
    lockAfterMilliseconds: 60_000,
    biometricLockEnabled: false,
    biometricAvailabilityRefreshDue: () => false,
    refreshBiometricAvailability: vi.fn(async () => ({})),
    foregroundLockAfterRefresh: () => 'keep',
    // Shared by the handler (which parks its resume) and the wrapper (which
    // drains it), exactly as the provider's single ref is.
    deferredForegroundResume: { current: false },
    // The provider keeps this pointed at the resume for the current session;
    // a case swaps it to model a token refresh while the attempt runs.
    latestResumeAuthenticatedSession: { current: resumeAuthenticatedSession as () => Promise<void> },
    resumeProtectedSession,
    sessionResumeAttempts: {
      begin: () => { activeResumeAttempt = {}; return activeResumeAttempt; },
      finish: vi.fn((attempt: object) => { if (activeResumeAttempt === attempt) activeResumeAttempt = null; }),
      sessionIsCurrent: () => true, hasActive: () => activeResumeAttempt !== null,
      observe: () => {
        if (!options.observeInterrupts || activeResumeAttempt === null) return { status: 'handle', interrupted: false };
        activeResumeAttempt = null;
        return { status: 'handle', interrupted: true, interruptedExpectedUserID: session.user.id };
      },
    },
    clearProtectedState: noop(),
    clearCapturedMobileSessionLocally: vi.fn(async () => true),
    captureSecureShareCleanupBoundary: noop(),
    conversationUnreadStore: { reset: noop() },
    preparePendingSharedAttachmentUploadForSessionLoss: vi.fn(async () => 'clear'),
    preparePendingSharedAttachmentUploadForSessionEstablishment: vi.fn(async () => { options.recoverShare?.(context); }),
    purgeSecureShareStaging: vi.fn(async () => undefined),
    purgeOfflineAvailability: vi.fn(async () => undefined),
    fetchDashboard: vi.fn(async () => { options.onBootstrap?.(context); }),
    sessionNeedsMfa: vi.fn(async () => options.needsMfa === true),
    mobileConfig: { supabaseUrl: options.reachable ? 'https://backend.test' : '', supabasePublishableKey: 'publishable' },
    backendReachable: vi.fn(options.reachable ?? (async (): Promise<'reachable'> => 'reachable')),
    setError: noop(),
  };
  const resumeEffects: Array<() => void> = [];
  const resumeEnvironment = Object.assign(environment, {
    renderSession: session,
    useCallback: (callback: () => Promise<void>) => callback,
    useEffect: (effect: () => void) => { resumeEffects.push(effect); },
    getSupabaseClient: () => ({ auth: {
      getSession: async () => ({ data: { session: options.currentSession ? options.currentSession() : environment.session }, error: null }),
      refreshSession: async () => {
        refreshCalls += 1;
        const hold = refreshCalls === 1 ? options.holdFirstRefresh : undefined;
        if (hold) await new Promise<void>((release) => { hold(release); });
        return options.realResume === 'signedOut'
          ? { data: { session: null }, error: { code: 'refresh_token_not_found', status: 400 } }
          : { data: { session: options.currentSession ? options.currentSession() : environment.session }, error: null };
      },
      getUser: async () => {
        userCalls += 1;
        const hold = userCalls === 1 ? options.holdFirstUser : undefined;
        if (!hold) return { data: { user: options.currentSession ? options.currentSession()?.user ?? null : session.user }, error: null };
        await new Promise<void>((settle) => { hold(settle); });
        return { data: { user: null }, error: { code: 'session_not_found', status: 403 } };
      },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    } }),
    revalidateAuthenticatedSession: runInNewContext(realResumeSource, environment) as (nextSession: typeof session) => Promise<void>,
  });
  if (options.realResume) {
    resumeAuthenticatedSession.mockImplementation(() => resumeEnvironment.revalidateAuthenticatedSession(environment.session));
  }
  const renderResumeFor = (accessToken: string) => {
    environment.session = { ...session, access_token: accessToken };
    environment.observedAuthIdentity.current = environment.session;
    resumeEnvironment.renderSession = environment.session;
    runInNewContext(resumeRenderSource, resumeEnvironment);
  };
  if (options.realResume) {
    renderResumeFor(session.access_token);
    resumeEffects.splice(0).forEach((effect) => effect());
  }
  const signOut = runInNewContext(signOutSource, environment) as Context['signOut'];
  (environment as Record<string, unknown>).establishSession = runInNewContext(establishSource, environment);
  (environment as Record<string, unknown>).signOut = signOut;
  const serializedSignOut = runInNewContext(wrapperSource, environment) as Context['serializedSignOut'];
  const onAppState = runInNewContext(appStateSource, environment) as Context['onAppState'];
  const retrySessionAuthentication = runInNewContext(retrySource, environment) as Context['retrySessionAuthentication'];
  Object.assign(context, {
    signOut, serializedSignOut, onAppState, sessionTransition, activeUserID, signOutInFlight,
    signInCompletion: environment.signInCompletion, setSignInNotice: environment.setSignInNotice,
    signOutError: () => error, setMode, setSession, setPrivacyCovered,
    visibleSignOutError: () => runInNewContext(visibleErrorSource, {
      ...failure, globalSignOutIncompleteSignedOut, signOutError: error,
    }) as string | null,
    globalSignOutIncompleteSignedOut: () => globalSignOutIncompleteSignedOut,
    globalSignOutIncompleteRef, lastAuthenticatedUserIDRef, lastAuthenticatedSessionIDRef, setGlobalSignOutIncompleteSignedOut,
    globalSignOutIncompleteOwnerRef,
    beginMfaRecovery: runInNewContext(beginRecoverySource, environment) as Context['beginMfaRecovery'],
    confirmMfaRecoveryGlobalSignOut: runInNewContext(confirmRecoverySource, environment) as Context['confirmMfaRecoveryGlobalSignOut'],
    authEvent: runInNewContext(authSource, environment) as Context['authEvent'],
    privacyCovered: () => covered, setSignOutError,
    invalidated: () => invalidations, revoke, rpc, setAssuranceUnavailable, purgeHomeWidgets: environment.purgeHomeWidgets,
    clear: environment.clearCapturedMobileSessionLocally,
    refreshCalls: () => refreshCalls,
    finishMfaRecovery: finishRecoverySource && runInNewContext(finishRecoverySource, environment) as Context['finishMfaRecovery'],
    retrySessionAuthentication, resumeAuthenticatedSession,
    latestResumeAuthenticatedSession: environment.latestResumeAuthenticatedSession,
    resumeNow: () => environment.latestResumeAuthenticatedSession.current(),
    renderResumeFor,
    refreshEstablishedSession: (userID?: string, accessToken?: string) => {
      if (userID) environment.session = { ...environment.session, user: { id: userID } };
      if (accessToken) environment.session = { ...environment.session, access_token: accessToken };
      environment.observedAuthIdentity.current = environment.authIdentityFor(environment.session as Session)!;
      return (runInNewContext(establishSource, environment) as (nextSession: typeof session) => Promise<void>)(environment.session);
    },
  });
  return context;
}

const GLOBAL_INCOMPLETE = failure.GLOBAL_SIGN_OUT_INCOMPLETE_MESSAGE;
const SHARE_FAILURE = 'Union Ground could not prepare pending shared attachments for sign-out. You remain signed in; keep the app open and try again.';
const signOutScopes: Array<'global' | 'local'> = ['global', 'local'];
const resumeOutcomes: Array<'authenticated' | 'signedOut'> = ['authenticated', 'signedOut'];

describe('a sign-out diagnosis survives the real session resume', () => {
  it.each(['resume', 'establish'])('clears only the recovered attachment warning after a failed %s is retried', async (path) => {
    let attempts = 0;
    const run = build({ realResume: 'authenticated', recoverShare: () => {
      if (++attempts === 1) throw new Error('Recovery unavailable');
    } });
    const retry = path === 'resume' ? run.resumeNow : run.refreshEstablishedSession;
    await retry();
    expect(run.signOutError()).toBe('Attachment recovery failed');
    await retry();
    expect(run.signOutError()).toBeNull();
    expect(run.setMode).toHaveBeenLastCalledWith('authenticated');
  });

  it('keeps a newer sign-out diagnosis written while attachment recovery succeeds', async () => {
    let attempts = 0;
    const run = build({ realResume: 'authenticated', recoverShare: (context) => {
      if (++attempts === 1) throw new Error('Recovery unavailable');
      context.setSignOutError(SHARE_FAILURE);
    } });
    await run.resumeNow();
    await run.resumeNow();
    expect(run.signOutError()).toBe(SHARE_FAILURE);
  });

  it.each(signOutScopes)('retains the protected-share diagnosis after a deferred %s attempt', async (scope) => {
    const run = build({
      realResume: 'authenticated',
      rejectShare: (context) => {
        context.onAppState('background');
        context.onAppState('active');
        throw new Error('protected share unavailable');
      },
    });
    await run.serializedSignOut({ scope, silent: true });
    expect(run.signOutError()).toBe(SHARE_FAILURE);
    expect(run.signOutError()).not.toBe(GLOBAL_INCOMPLETE);
    expect(run.privacyCovered()).toBe(false);
    expect(run.activeUserID.current).toBe('test-member');
    expect(run.revoke).not.toHaveBeenCalled();
  });

  it.each(resumeOutcomes)('retains a diagnosis on the next foreground only while still signed in: %s', async (realResume) => {
    const run = build({
      realResume,
      rejectShare: (context) => {
        context.onAppState('background');
        context.onAppState('active');
        context.onAppState('background');
        throw new Error('protected share unavailable');
      },
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.signOutError()).toBe(SHARE_FAILURE);
    expect(run.privacyCovered()).toBe(true);
    run.onAppState('active');
    const resumed = run.resumeAuthenticatedSession.mock.results.at(-1);
    if (!resumed || resumed.type !== 'return') throw new Error('Foreground resume did not run');
    await resumed.value;
    expect(run.signOutError()).toBe(realResume === 'signedOut' ? null : SHARE_FAILURE);
    expect(run.privacyCovered()).toBe(false);
    expect(run.activeUserID.current).toBe(realResume === 'signedOut' ? null : 'test-member');
  });

  it('fills the generic global warning only when no specific diagnosis exists', async () => {
    const run = build({
      realResume: 'authenticated',
      rpc: async (context) => {
        context.onAppState('background');
        context.onAppState('active');
        context.sessionTransition.current += 1;
        return { data: { serverCleanupComplete: true }, error: null, status: 200 };
      },
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.signOutError()).toBe(GLOBAL_INCOMPLETE);
    await run.resumeNow();
    expect(run.signOutError()).toBe(GLOBAL_INCOMPLETE);
  });

  it('uses the refreshed callback when render and settlement precede passive effects', async () => {
    const run = build({
      realResume: 'authenticated',
      rpc: async (context) => {
        context.onAppState('background');
        context.onAppState('active');
        // Commit the TOKEN_REFRESHED render, then let the pending sign-out
        // settle in this turn. Do not flush the render's passive effects.
        context.renderResumeFor('refreshed-token');
        return { data: null, error: { code: 'PGRST202' }, status: 404 };
      },
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.privacyCovered()).toBe(false);
    expect(run.setSession).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'refreshed-token' }));
    expect(run.signOutError()).toContain('the service refused the request');
  });

  it.each(signOutScopes)('clears a retained diagnosis when the next %s sign-out succeeds', async (scope) => {
    const run = build({ realResume: 'authenticated' });
    run.setSignOutError(SHARE_FAILURE);
    await run.serializedSignOut({ scope, silent: true });
    expect(run.signOutError()).toBeNull();
    expect(run.activeUserID.current).toBeNull();
  });

  it('keeps the diagnosis when a same-account auth refresh establishes the session again', async () => {
    const run = build({ realResume: 'authenticated' });
    run.setSignOutError(SHARE_FAILURE);
    await run.refreshEstablishedSession();
    await run.resumeNow();
    expect(run.signOutError()).toBe(SHARE_FAILURE);
  });

  it.each([null, 'Newer cleanup diagnosis'])('keeps the latest diagnostic write during resume: %s', async (message) => {
    const run = build({
      realResume: 'authenticated',
      onBootstrap: (context) => { context.setSignOutError(message); },
    });
    run.setSignOutError(SHARE_FAILURE);
    await run.resumeNow();
    expect(run.signOutError()).toBe(message);
  });

  it.each([SHARE_FAILURE, 'Newer sign-out diagnosis'])('does not replace a signed-in diagnosis with a late foreground cleanup rejection: %s', async (message) => {
    let rejectCleanup: (error: Error) => void = () => undefined;
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
    const run = build({ realResume: 'authenticated', retryOffline: () => cleanup });
    run.setSignOutError(SHARE_FAILURE);
    run.onAppState('background');
    run.onAppState('active');
    await run.resumeNow();
    run.setSignOutError(message);
    rejectCleanup(new Error('Offline purge unavailable'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(run.signOutError()).toBe(message);
    expect(run.activeUserID.current).toBe('test-member');
  });

  it.each([null, 'Newer signed-out recovery diagnosis'])('fills only an absent signed-out diagnosis after a late foreground cleanup rejection: %s', async (message) => {
    let rejectCleanup: (error: Error) => void = () => undefined;
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
    const run = build({ realResume: 'signedOut', retryOffline: () => cleanup });
    run.setSignOutError(SHARE_FAILURE);
    run.onAppState('background');
    run.onAppState('active');
    await run.resumeNow();
    run.setSignOutError(message);
    rejectCleanup(new Error('Offline purge unavailable'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(run.signOutError()).toBe(message ?? 'Offline cleanup pending');
    expect(run.activeUserID.current).toBeNull();
  });
});

describe('backgrounding the app during a global sign-out', () => {
  it('lets the sign-out finish instead of cancelling it silently', async () => {
    // The real failure: the member confirms Sign out everywhere, the server
    // call is in flight, and the phone is locked or an incoming call covers
    // the app. The handler must not take ownership of the session transition
    // away from the sign-out that is running.
    const run = build({
      rpc: async (context) => {
        context.onAppState('background');
        return { data: { serverCleanupComplete: true }, error: null, status: 200 };
      },
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.rpc).toHaveBeenCalledTimes(1);
    expect(run.revoke.mock.calls[0]?.[1]).toBe('global');
    expect(run.setSession).toHaveBeenCalledWith(null);
    expect(run.setMode).toHaveBeenCalledWith('signedOut');
    expect(run.activeUserID.current).toBeNull();
    // A completed sign-out is not an incomplete one.
    expect(run.signOutError()).toBeNull();
  });

  it('still covers the screen and invalidates the resume guard while it runs', async () => {
    // Skipping the transition bump may not weaken the privacy behaviour the
    // same branch is there for.
    const run = build({
      rpc: async (context) => {
        context.onAppState('background');
        expect(context.setPrivacyCovered).toHaveBeenCalledWith(true);
        expect(context.invalidated()).toBeGreaterThan(1);
        return { data: { serverCleanupComplete: true }, error: null, status: 200 };
      },
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.setMode).toHaveBeenCalledWith('signedOut');
  });

  it('bumps the session transition when no sign-out is in flight', () => {
    // The negative control. Outside a sign-out the bump is the behaviour that
    // cancels in-flight reads across a background trip, and it is unchanged.
    const run = build();
    const before = run.sessionTransition.current;
    run.onAppState('background');
    expect(run.sessionTransition.current).toBe(before + 1);
    run.signOutInFlight.current = true;
    run.onAppState('inactive');
    expect(run.sessionTransition.current).toBe(before + 1);
  });
});

describe('a global sign-out that is cancelled anyway says so', () => {
  it('warns that sign out everywhere is incomplete instead of returning to idle', async () => {
    // Belt and braces: a cancellation the sign-out lock cannot prevent — an
    // auth event or a session loss moving the transition — must not leave the
    // member with a card back at idle, this device signed in, and the
    // account's other sessions possibly already closed.
    const run = build({
      rpc: async (context) => {
        context.sessionTransition.current += 1;
        return { data: { serverCleanupComplete: true }, error: null, status: 200 };
      },
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.setMode).not.toHaveBeenCalled();
    expect(run.activeUserID.current).toBe('test-member');
    const message = run.signOutError() ?? '';
    expect(message).toBe(GLOBAL_INCOMPLETE);
    expect(message).toContain('Sign out everywhere is incomplete');
    expect(message).toContain('your other devices may still be signed in');
    expect(message).not.toMatch(/signed out everywhere|all devices/i);
  });

  it('keeps the specific diagnosis the sign-out already reported', async () => {
    // The fail-closed service copy is more useful than the generic warning, so
    // the belt-and-braces fill may only fill an unset message.
    const run = build({
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 }),
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.setMode).not.toHaveBeenCalled();
    const message = run.signOutError() ?? '';
    expect(message).toContain('the service refused the request');
    expect(message).not.toBe(GLOBAL_INCOMPLETE);
  });

  it('does not warn when an ordinary sign-out is cancelled', async () => {
    // The global copy is about the account's other devices. A cancelled local
    // sign-out leaves this device signed in and nothing else changed, which is
    // the pre-existing behaviour this round does not alter.
    const run = build({
      rpc: async (context) => {
        context.sessionTransition.current += 1;
        return { data: { serverCleanupComplete: true }, error: null, status: 200 };
      },
    });
    await run.serializedSignOut({ silent: true });
    expect(run.setMode).not.toHaveBeenCalled();
    expect(run.signOutError()).toBeNull();
  });
});

describe('re-authentication tells its caller when a sign-out refused it', () => {
  it('reports the refusal without revalidating while a sign-out is in flight', async () => {
    // The card spends its once-per-account re-authentication on the answer, so
    // a refusal that reads as a completed attempt would quietly cost the
    // member their one revalidation (the round-3 P2).
    const run = build();
    run.signOutInFlight.current = true;
    await expect(run.retrySessionAuthentication()).resolves.toBe(false);
    expect(run.resumeAuthenticatedSession).not.toHaveBeenCalled();
  });

  it('reports a revalidation that ran', async () => {
    const run = build();
    await expect(run.retrySessionAuthentication()).resolves.toBe(true);
    expect(run.resumeAuthenticatedSession).toHaveBeenCalledTimes(1);
  });
});

describe('locking and unlocking the phone during a global sign-out', () => {
  // The round-4 finding
  // (BUG-UG-FOREGROUND-RESUME-CANCELS-AN-IN-FLIGHT-GLOBAL-SIGN-OUT-20261010).
  // Only the background half of the handler yielded to a sign-out in flight.
  // The foreground half resumed the session unconditionally, and the resume's
  // `prepareSession` bumps `sessionTransition` — the token the sign-out owns —
  // so locking the phone while waiting for Sign out everywhere cancelled it
  // before the revoke and the member was told it may be incomplete. These
  // cases drive the provider's real handler and its real wrapper through the
  // shared refs, so they prove the interaction rather than a re-implementation.
  // The resume mock does what the real resume does to this state: a transition
  // bump, a cleared sign-out error, and the cover revealed.
  function deferredResumeSpy(run: Context, order: string[]): void {
    run.resumeAuthenticatedSession.mockImplementation(async () => {
      order.push(`resume:inFlight=${run.signOutInFlight.current}`);
      run.sessionTransition.current += 1;
      run.setSignOutError(null);
      run.setPrivacyCovered(false);
    });
  }

  it('still reaches the revoke and leaves no incomplete warning', async () => {
    const order: string[] = [];
    const run = build({
      rpc: async (context) => {
        context.onAppState('background');
        context.onAppState('active');
        // The foreground lands while `prepare_my_signout` is still in flight.
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        order.push('prepared');
        return { data: { serverCleanupComplete: true }, error: null, status: 200 };
      },
    });
    deferredResumeSpy(run, order);
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.rpc).toHaveBeenCalledTimes(1);
    expect(run.revoke).toHaveBeenCalledTimes(1);
    expect(run.revoke.mock.calls[0]?.[1]).toBe('global');
    expect(run.setMode).toHaveBeenCalledWith('signedOut');
    expect(run.activeUserID.current).toBeNull();
    expect(run.signOutError()).toBeNull();
    expect(run.privacyCovered()).toBe(false);
    // The sign-out committed, so there is no session left to resume: the
    // deferred foreground reveals the signed-out surface instead of
    // revalidating a session this attempt has just destroyed.
    expect(order).toEqual(['prepared']);
  });

  it('runs the deferred resume once the attempt settles when it fails closed', async () => {
    const order: string[] = [];
    const run = build({
      rpc: async (context) => {
        context.onAppState('background');
        context.onAppState('active');
        order.push('refused');
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    });
    deferredResumeSpy(run, order);
    await run.serializedSignOut({ scope: 'global', silent: true });
    // The attempt stopped at its own fail-closed exit with this session
    // intact, so the deferred foreground resumes it — after the sign-out has
    // released the device, never during it — and that resume is what takes the
    // privacy cover down.
    expect(order).toEqual(['refused', 'resume:inFlight=false']);
    expect(run.resumeAuthenticatedSession).toHaveBeenCalledTimes(1);
    expect(run.setMode).not.toHaveBeenCalled();
    expect(run.activeUserID.current).toBe('test-member');
    expect(run.privacyCovered()).toBe(false);
    // The resume clears the sign-out error, so the member would be left with
    // a silent half-done global attempt unless the warning is filled after it.
    expect(run.signOutError()).toBe(GLOBAL_INCOMPLETE);
  });

  it('warns on the signed-out surface when the drained resume finds this session gone, through the cleanup that settles after it', async () => {
    // SEC-UG-FAILED-SIGN-OUT-EVERYWHERE-END-SIGN-SCREEN-WARNING-20261013.
    // prepare_my_signout refused the global attempt, the lock and unlock during
    // it parked the resume, and the drained resume then found this device's own
    // session definitively invalidated. Its signed-out callback clears the
    // refusal copy and `activeUserID` together, so the incomplete-global
    // outcome has to be read before the drain: otherwise the member lands on
    // sign-in with every other device possibly still signed in and no warning.
    // The cleanup that session loss starts settles after the wrapper returns
    // and writes the diagnosis unconditionally (Codex round-1 finding on
    //), so the warning is a condition composed into the published
    // value, and the real ordering is run here: the offline cleanup rejects
    // only after the sign-out has settled.
    const order: string[] = [];
    let rejectOffline: (error: Error) => void = () => undefined;
    const run = build({
      realResume: 'signedOut',
      offlineCleanup: () => new Promise<void>((_resolve, reject) => { rejectOffline = reject; }),
      rpc: async (context) => {
        context.onAppState('background');
        context.onAppState('active');
        order.push('refused');
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    });
    // The real resume runs through the drain; only its ordering is observed.
    const resume = run.latestResumeAuthenticatedSession.current;
    run.latestResumeAuthenticatedSession.current = async () => {
      order.push(`resume:inFlight=${run.signOutInFlight.current}`);
      await resume();
    };
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(order).toEqual(['refused', 'resume:inFlight=false']);
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.activeUserID.current).toBeNull();
    expect(run.privacyCovered()).toBe(false);
    expect(run.revoke).not.toHaveBeenCalled();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    expect(run.signOutError()).toBeNull();
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
    // The offline cleanup the session loss started now fails: its notice is
    // shown, and the global warning stays with it rather than under it.
    rejectOffline(new Error('Offline purge unavailable'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(run.signOutError()).toBe('Offline cleanup pending');
    expect(run.visibleSignOutError()).toBe(`Offline cleanup pending ${failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE.replace('This device is signed out, but ', '')}`);
    // A later signed-out write that clears the cleanup notice leaves the
    // warning standing on its own.
    run.setSignOutError(null);
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
    // Signing back in reaches the Sessions card, so the signed-out copy ends.
    await run.refreshEstablishedSession();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(false);
    expect(run.visibleSignOutError()).toBe(run.signOutError());
  });

  it('warns on sign-in when the attempt settled in the background and the next foreground finds the session gone', async () => {
    // The drain inside the wrapper is not the only
    // way this device loses its session after a failed global attempt. An
    // attempt that settles while the app is backgrounded leaves the resume to
    // the next foreground, whose `signedOut` callback would clear the
    // diagnosis with nothing to re-arm the warning. The latch carries it.
    const order: string[] = [];
    const run = build({
      realResume: 'signedOut',
      rpc: async (context) => {
        context.onAppState('background');
        order.push('refused');
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    });
    run.resumeAuthenticatedSession.mockImplementation(async () => {
      order.push(`resume:inFlight=${run.signOutInFlight.current}`);
      await run.resumeNow();
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    // Settled in the background: this device is still signed in, the refusal
    // copy stands, the drain never ran and the flag is still down.
    expect(order).toEqual(['refused']);
    expect(run.activeUserID.current).toBe('test-member');
    expect(run.signOutError()).toContain('the service refused the request');
    expect(run.globalSignOutIncompleteSignedOut()).toBe(false);
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    // The next foreground resumes directly and finds the session gone.
    run.onAppState('active');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(order).toEqual(['refused', 'resume:inFlight=false']);
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.activeUserID.current).toBeNull();
    expect(run.signOutError()).toBeNull();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
  });

  it('keeps the signed-out warning through an MFA step and releases it only once authenticated', async () => {
    // The authenticator screen has no Sessions
    // control, so a sign-in that stops at MFA must keep the warning; the
    // establishment that reaches authenticated is what ends it and the latch.
    const mfa = build({ needsMfa: true });
    mfa.globalSignOutIncompleteRef.current = true;
    mfa.setGlobalSignOutIncompleteSignedOut(true);
    await mfa.refreshEstablishedSession();
    expect(mfa.setMode).toHaveBeenLastCalledWith('mfaRequired');
    expect(mfa.globalSignOutIncompleteSignedOut()).toBe(true);
    expect(mfa.globalSignOutIncompleteRef.current).toBe(true);
    // A return from sign-in: the previous session ended, so no user has
    // reached authenticated since.
    const authenticated = build();
    authenticated.globalSignOutIncompleteRef.current = true;
    authenticated.setGlobalSignOutIncompleteSignedOut(true);
    authenticated.lastAuthenticatedUserIDRef.current = null;
    authenticated.activeUserID.current = null;
    await authenticated.refreshEstablishedSession();
    expect(authenticated.setMode).toHaveBeenLastCalledWith('authenticated');
    expect(authenticated.globalSignOutIncompleteRef.current).toBe(false);
    expect(authenticated.globalSignOutIncompleteSignedOut()).toBe(false);
  });

  it('releases the latch when a replacement login reaches authenticated through an MFA step', async () => {
    // Grok r3g1 / Sol r3s1 on: the establishment stores the new user
    // before it returns for MFA, so the establishment that follows the code
    // sees the same user already active. The replacement is recorded when the
    // login begins and consumed only when it reaches authenticated.
    const options = { needsMfa: true };
    const run = build(options);
    run.globalSignOutIncompleteRef.current = true;
    run.setGlobalSignOutIncompleteSignedOut(true);
    // The session ended earlier; the password sign-in path has already
    // written the user into activeUserID before the establishment runs
    // (Grok r4g1), so no comparison inside the establishment can see it.
    run.lastAuthenticatedUserIDRef.current = null;
    run.activeUserID.current = 'test-member';
    await run.refreshEstablishedSession();
    expect(run.setMode).toHaveBeenLastCalledWith('mfaRequired');
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.lastAuthenticatedUserIDRef.current).toBeNull();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    options.needsMfa = false;
    await run.refreshEstablishedSession();
    expect(run.setMode).toHaveBeenLastCalledWith('authenticated');
    expect(run.globalSignOutIncompleteRef.current).toBe(false);
    expect(run.lastAuthenticatedUserIDRef.current).toBe('test-member');
    expect(run.globalSignOutIncompleteSignedOut()).toBe(false);
    // Account B, now signed in, signs out locally: no warning about A's
    // unfinished attempt follows it.
    run.rpc.mockImplementation(async () => ({ data: { serverCleanupComplete: true }, error: null, status: 200 }));
    await run.serializedSignOut({ scope: 'local', silent: true });
    expect(run.activeUserID.current).toBeNull();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(false);
  });

  it('releases the latch when a replacement login reaches authenticated through the resume', async () => {
    const run = build({ realResume: 'authenticated' });
    run.globalSignOutIncompleteRef.current = true;
    run.lastAuthenticatedUserIDRef.current = null;
    await run.resumeNow();
    expect(run.setMode).toHaveBeenLastCalledWith('authenticated');
    expect(run.globalSignOutIncompleteRef.current).toBe(false);
    expect(run.lastAuthenticatedUserIDRef.current).toBe('test-member');
    // The same user's own resume (a same-session refresh) keeps it.
    const same = build({ realResume: 'authenticated' });
    same.globalSignOutIncompleteRef.current = true;
    await same.resumeNow();
    expect(same.globalSignOutIncompleteRef.current).toBe(true);
  });

  it('does not re-arm the latch when a stale global attempt returns after a replacement login released it', async () => {
    // Sol r4s1 on: account A's request is still pending when Auth ends
    // A's session and account B signs in and reaches authenticated, which
    // releases the latch. A's attempt then returns, no longer current, with
    // B active; it must not hang A's warning on B.
    const run = build({
      rpc: async (context) => {
        expect(context.globalSignOutIncompleteRef.current).toBe(true);
        context.sessionTransition.current += 1;
        context.activeUserID.current = 'member-b';
        context.globalSignOutIncompleteRef.current = false;
        context.lastAuthenticatedUserIDRef.current = 'member-b';
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.globalSignOutIncompleteRef.current).toBe(false);
    expect(run.globalSignOutIncompleteSignedOut()).toBe(false);
    expect(run.signOutError()).toBeNull();
  });

  it('does not assign a stale global failure to a replacement account waiting for MFA', async () => {
    const options: Options = {
      needsMfa: true,
      rpc: async (context) => {
        // Auth ends A's session while its server request is outstanding.
        context.sessionTransition.current += 1;
        context.activeUserID.current = null;
        context.lastAuthenticatedUserIDRef.current = null;
        context.setSignOutError(null);
        context.setGlobalSignOutIncompleteSignedOut(true);
        // B's establishment reaches MFA, leaving A's latch armed.
        await context.refreshEstablishedSession('member-b');
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    };
    const run = build(options);
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.activeUserID.current).toBe('member-b');
    expect(run.setMode).toHaveBeenLastCalledWith('mfaRequired');
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.signOutError()).toBeNull();
    options.needsMfa = false;
    await run.refreshEstablishedSession();
    expect(run.setMode).toHaveBeenLastCalledWith('authenticated');
    expect(run.visibleSignOutError()).toBeNull();
  });

  it('rechecks the diagnosis account after a deferred resume reaches a replacement MFA session', async () => {
    const run = build({
      needsMfa: true,
      rpc: async (context) => {
        context.onAppState('background');
        context.onAppState('active');
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    });
    run.latestResumeAuthenticatedSession.current = async () => {
      run.activeUserID.current = null;
      run.lastAuthenticatedUserIDRef.current = null;
      await run.refreshEstablishedSession('member-b');
    };
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.activeUserID.current).toBe('member-b');
    expect(run.setMode).toHaveBeenLastCalledWith('mfaRequired');
    expect(run.signOutError()).toBeNull();
  });

  it('keeps the latch across a same-session token refresh so a later local sign-out still warns', async () => {
    // Sol r2s1 / Grok r2g1 on: TOKEN_REFRESHED for the same user and
    // session is routed through establishSession too, and it proves nothing
    // about the other devices.
    const run = build({
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 }),
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.activeUserID.current).toBe('test-member');
    await run.refreshEstablishedSession();
    expect(run.setMode).toHaveBeenLastCalledWith('authenticated');
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    run.rpc.mockImplementation(async () => ({ data: { serverCleanupComplete: true }, error: null, status: 200 }));
    await run.serializedSignOut({ scope: 'local', silent: true });
    expect(run.activeUserID.current).toBeNull();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
  });

  // SEC-UG-SAME-ACCOUNT-REPLACEMENT-SESSION-INCOMPLETE-WARNING-20261020:
  // a replacement login for the same account (identity linking, or signing in
  // again) commits a new session_id. Keying the latch on the user alone kept a
  // warning about an old session's other devices forever.
  const sessionToken = (sessionID: string, rotation = 0) =>
    `header.${Buffer.from(JSON.stringify({ session_id: sessionID, rotation })).toString('base64url')}.signature`;
  const FIRST_SESSION = '11111111-1111-4111-8111-111111111111';
  const SECOND_SESSION = '22222222-2222-4222-8222-222222222222';

  it('releases the latch when the same account commits a different session, and keeps it across a token rotation', async () => {
    const run = build({
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 }),
    });
    await run.refreshEstablishedSession(undefined, sessionToken(FIRST_SESSION));
    expect(run.lastAuthenticatedSessionIDRef.current).toBe(FIRST_SESSION);
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    // A rotated token for the same session proves nothing about other devices.
    await run.refreshEstablishedSession(undefined, sessionToken(FIRST_SESSION, 1));
    expect(run.setMode).toHaveBeenLastCalledWith('authenticated');
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    // Identity linking commits the same user with a new session_id: a replacement.
    await run.refreshEstablishedSession('test-member', sessionToken(SECOND_SESSION));
    expect(run.globalSignOutIncompleteRef.current).toBe(false);
    expect(run.lastAuthenticatedSessionIDRef.current).toBe(SECOND_SESSION);
    run.rpc.mockImplementation(async () => ({ data: { serverCleanupComplete: true }, error: null, status: 200 }));
    await run.serializedSignOut({ scope: 'local', silent: true });
    expect(run.activeUserID.current).toBeNull();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(false);
    expect(run.visibleSignOutError()).not.toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
  });

  it('keeps the latch when either session_id is unreadable, and releases it for a new session through the resume', async () => {
    const unreadable = build({});
    unreadable.globalSignOutIncompleteRef.current = true;
    unreadable.lastAuthenticatedSessionIDRef.current = FIRST_SESSION;
    await unreadable.refreshEstablishedSession(undefined, 'not-a-jwt');
    expect(unreadable.globalSignOutIncompleteRef.current).toBe(true);
    expect(unreadable.lastAuthenticatedSessionIDRef.current).toBeNull();

    const resumed = build({ realResume: 'authenticated' });
    resumed.globalSignOutIncompleteRef.current = true;
    resumed.lastAuthenticatedSessionIDRef.current = FIRST_SESSION;
    resumed.renderResumeFor(sessionToken(FIRST_SESSION, 2));
    await resumed.resumeNow();
    expect(resumed.setMode).toHaveBeenLastCalledWith('authenticated');
    expect(resumed.globalSignOutIncompleteRef.current).toBe(true);
    resumed.renderResumeFor(sessionToken(SECOND_SESSION));
    await resumed.resumeNow();
    expect(resumed.globalSignOutIncompleteRef.current).toBe(false);
    expect(resumed.lastAuthenticatedSessionIDRef.current).toBe(SECOND_SESSION);
  });

  it('arms the latch before the global request answers, so a session lost during the attempt still warns', async () => {
    // Sol r2s2 on: Auth can report this session gone while
    // prepare_my_signout is pending. Its handler clears activeUserID and
    // consults the latch as it does (accountInvalidation.test.ts), so the
    // latch has to be up before the request returns; the attempt itself then
    // returns silently as no longer current and must not release it.
    let armedDuringRequest: boolean | null = null;
    const run = build({
      rpc: async (context) => {
        armedDuringRequest = context.globalSignOutIncompleteRef.current;
        // What the auth listener's session-loss branch does to the shared refs.
        context.sessionTransition.current += 1;
        context.activeUserID.current = null;
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(armedDuringRequest).toBe(true);
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.revoke).not.toHaveBeenCalled();
  });

  it('warns after a local sign-out that follows an incomplete global attempt, and releases the latch when a global one completes', async () => {
    const run = build({
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 }),
    });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.activeUserID.current).toBe('test-member');
    run.rpc.mockImplementation(async () => ({ data: { serverCleanupComplete: true }, error: null, status: 200 }));
    await run.serializedSignOut({ scope: 'local', silent: true });
    expect(run.activeUserID.current).toBeNull();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
    const completed = build({
      rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 }),
    });
    await completed.serializedSignOut({ scope: 'global', silent: true });
    expect(completed.globalSignOutIncompleteRef.current).toBe(true);
    completed.rpc.mockImplementation(async () => ({ data: { serverCleanupComplete: true }, error: null, status: 200 }));
    await completed.serializedSignOut({ scope: 'global', silent: true });
    expect(completed.activeUserID.current).toBeNull();
    expect(completed.globalSignOutIncompleteRef.current).toBe(false);
    expect(completed.globalSignOutIncompleteSignedOut()).toBe(false);
  });

  it('drains through the resume for the session current at settlement', async () => {
    // Round-5 finding: a parked callback captured the session of the
    // foreground, so a token refresh while the attempt ran made the drain
    // fail its identity check and leave the cover up. The drain must call the
    // resume the provider holds when the attempt settles.
    const order: string[] = [];
    const refreshed = vi.fn(async () => {
      order.push('resume:refreshed');
      run.setPrivacyCovered(false);
    });
    const run = build({
      rpc: async (context) => {
        context.onAppState('background');
        context.onAppState('active');
        context.latestResumeAuthenticatedSession.current = refreshed;
        order.push('refused');
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    });
    deferredResumeSpy(run, order);
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(order).toEqual(['refused', 'resume:refreshed']);
    expect(run.resumeAuthenticatedSession).not.toHaveBeenCalled();
    expect(run.privacyCovered()).toBe(false);
  });

  it('keeps the cover up when the app left the foreground again before the attempt settled', async () => {
    // Round-5 finding: the background invalidated the resume guard before the
    // deferred resume began, so nothing could stop a drain that revealed
    // protected rows behind a backgrounded app. The next foreground resumes.
    const order: string[] = [];
    const run = build({
      rpc: async (context) => {
        context.onAppState('background');
        context.onAppState('active');
        context.onAppState('background');
        order.push('refused');
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 };
      },
    });
    deferredResumeSpy(run, order);
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(order).toEqual(['refused']);
    expect(run.privacyCovered()).toBe(true);
    expect(run.signOutError()).toContain('the service refused the request');
    run.onAppState('active');
    expect(order).toEqual(['refused', 'resume:inFlight=false']);
    expect(run.privacyCovered()).toBe(false);
  });

  it('resumes an ordinary lock and unlock immediately', () => {
    // The negative control: with no sign-out in flight the foreground resume
    // is unchanged, and the background bump it depends on still happens.
    const run = build();
    const before = run.sessionTransition.current;
    run.onAppState('background');
    expect(run.privacyCovered()).toBe(true);
    expect(run.sessionTransition.current).toBe(before + 1);
    run.onAppState('active');
    expect(run.resumeAuthenticatedSession).toHaveBeenCalledTimes(1);
  });
});

// SEC-UG-MFA-RECOVERY-GLOBAL-LOGOUT-CLEARS-INCOMPLETE-WARNING-20261020
// ( r3g2, r4s2, r5s2). A recovery code redeemed at the authenticator
// screen makes /api/mfa-recovery run GoTrue's global logout and answer
// recovered only once it succeeded. The local sign-out that follows reached
// the Auth listener, which re-raised the warning from the latch, so sign-in
// still said other devices might be signed in after every one was signed out.
describe('the MFA screen finishes only its own recovered session', () => {
  const recoveryLanguages: Array<'en' | 'es'> = ['en', 'es'];
  it.each(recoveryLanguages)('retries only local cleanup after an accepted code, with %s feedback', async (language) => {
    const run = build();
    run.clear.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const recoveryCleanup = { current: null };
    const request = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ recovered: true, sessionsRevoked: true }) }));
    const setMessage = vi.fn();
    const report = runInNewContext(recoveryReportSource, {
      catalogLabel: (text: string) => nativeCatalogLabel(language, text), setMessage,
      Platform: { OS: 'android' },
    }) as (text: string, failed?: boolean) => void;
    const recover = runInNewContext(recoveryScreenSource, {
      runOperation: async (_active: boolean, work: () => Promise<void>) => work(),
      getSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'test-member' }, access_token: 'initial-token' } } }) } }),
      beginMfaRecovery: run.beginMfaRecovery, finishMfaRecovery: run.finishMfaRecovery, recoveryCleanup,
      confirmMfaRecoveryGlobalSignOut: run.confirmMfaRecoveryGlobalSignOut,
      redeemMfaRecoveryCode: (code: string, dependencies: Parameters<typeof redeemMfaRecoveryCode>[1]) => redeemMfaRecoveryCode(code, { ...dependencies, request }),
      resolveMfaRecoveryApiOrigin: () => 'https://sample.unionground.example', recoveryCode: 'UG-1A2B-3C4D-5E6F-7089',
      mfaRecoveryMessage, setRecovering: vi.fn(), setMessage, setRecoveryCode: vi.fn(), report, mounted: { current: true },
      signInCompletion: run.signInCompletion, signOut: run.serializedSignOut,
    }) as () => Promise<void>;
    await recover();
    expect(request).toHaveBeenCalledOnce();
    expect(run.activeUserID.current).toBe('test-member');
    expect(setMessage).toHaveBeenLastCalledWith({
      text: language === 'es' ? 'Se aceptó el código de recuperación. Termine de cerrar la sesión en este dispositivo; el código no se enviará otra vez.' : mfaRecoveryMessage('cleanup-required'), failed: true,
    });
    expect(recoveryCleanup.current).not.toBeNull();
    await recover();
    expect(request).toHaveBeenCalledOnce();
    expect(run.clear).toHaveBeenCalledTimes(2);
    expect(run.activeUserID.current).toBeNull();
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(recoveryCleanup.current).toBeNull();
  });
  it.each(['refresh in getSession', 'refresh during POST', 'pending refresh', 'revoked share', 'account switch', 'same-user replacement', 'pending account switch', 'pending same-user replacement'])(
    'settles accepted recovery without clearing a replacement: %s', async (boundary) => {
      const sessionID = '11111111-1111-4111-8111-111111111111';
      const initial: Session = {
        user: { id: 'test-member' } as Session['user'], token_type: 'bearer', expires_in: 3600,
        access_token: `header.${Buffer.from(JSON.stringify({ session_id: sessionID, rotation: 0 })).toString('base64url')}.signature`,
        refresh_token: 'initial-refresh',
      };
      const replacement = boundary.includes('account switch') || boundary.includes('same-user replacement');
      const next: Session = {
        ...initial, user: { ...initial.user, id: boundary.includes('account switch') ? 'other-member' : initial.user.id },
        access_token: `header.${Buffer.from(JSON.stringify({
          session_id: replacement ? '22222222-2222-4222-8222-222222222222' : sessionID, rotation: 1,
        })).toString('base64url')}.signature`, refresh_token: 'rotated-refresh',
      };
      let stored: Session | null = initial;
      const run = build({ initialSession: initial, currentSession: () => stored, needsMfa: true,
        sharePreparation: boundary === 'revoked share' ? async () => { throw Object.assign(new Error('session_not_found'), { code: 'session_not_found', status: 403 }); } : undefined,
      });
      run.clear.mockImplementation(async (captured: unknown) => {
        if (!stored || !exactSessionIdentityMatches(exactSessionIdentity(stored), exactSessionIdentity(captured as Session))) return false;
        stored = null;
        return true;
      });
      const mounted = { current: true };
      const report = vi.fn();
      const changeSession = async () => {
        stored = next;
        run.authEvent(replacement ? 'SIGNED_IN' : 'TOKEN_REFRESHED', next);
        if (boundary.startsWith('pending ')) {
          if (replacement) mounted.current = false;
          return;
        }
        // Let the real listener's deferred establishment settle. This proves
        // admission after a rotation, rather than a pending-transition exit.
        await vi.waitFor(() => expect(run.setMode).toHaveBeenLastCalledWith('mfaRequired'));
        expect(run.activeUserID.current).toBe(next.user.id);
        if (replacement) mounted.current = false;
      };
      const liveSignOut = vi.fn();
      const client = { auth: {
        getSession: async () => {
          if (boundary === 'refresh in getSession') await changeSession();
          return { data: { session: stored } };
        }, signOut: liveSignOut,
      } };
      const redeem: typeof redeemMfaRecoveryCode = (code, dependencies) => redeemMfaRecoveryCode(code, {
        ...dependencies, request: async () => {
          if (boundary !== 'refresh in getSession') await changeSession();
          return { ok: true, status: 200, json: async () => ({ recovered: true, sessionsRevoked: true }) };
        },
      });
      const recover = runInNewContext(recoveryScreenSource, {
        runOperation: async (_active: boolean, work: () => Promise<void>) => work(),
        getSupabaseClient: () => client, beginMfaRecovery: run.beginMfaRecovery, finishMfaRecovery: run.finishMfaRecovery,
        recoveryCleanup: { current: null },
        confirmMfaRecoveryGlobalSignOut: run.confirmMfaRecoveryGlobalSignOut,
        redeemMfaRecoveryCode: redeem, resolveMfaRecoveryApiOrigin: () => 'https://sample.unionground.example',
        recoveryCode: 'UG-1A2B-3C4D-5E6F-7089', mfaRecoveryMessage: () => 'Recovery accepted',
        setRecovering: vi.fn(), setMessage: vi.fn(), setRecoveryCode: vi.fn(), report, mounted,
        signInCompletion: run.signInCompletion, signOut: run.serializedSignOut,
      }) as () => Promise<void>;
      await recover();
      expect(liveSignOut).not.toHaveBeenCalled();
      if (replacement) {
        await vi.waitFor(() => expect(run.activeUserID.current).toBe(next.user.id));
        expect(stored).toBe(next);
        expect(run.activeUserID.current).toBe(next.user.id);
        expect(run.revoke).not.toHaveBeenCalled();
        expect(run.clear).not.toHaveBeenCalled();
        expect(run.rpc).not.toHaveBeenCalled();
        expect(run.purgeHomeWidgets).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
      } else {
        expect(stored).toBeNull();
        expect(run.clear).toHaveBeenCalledExactlyOnceWith(next);
        expect(run.revoke).not.toHaveBeenCalled();
        expect(run.activeUserID.current).toBeNull();
        expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
        expect(report).toHaveBeenCalledWith('Recovery accepted', false);
        if (boundary === 'pending refresh') {
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
          expect(run.setSession).toHaveBeenLastCalledWith(null);
        }
      }
    },
  );

  it.each([false, true])('uses the guarded provider cleanup when a replacement arrives during POST: %s', async (replace) => {
    const run = build();
    const mounted = { current: true };
    const report = vi.fn();
    const liveSignOut = vi.fn(async () => { run.authEvent('SIGNED_OUT', null); });
    const client = { auth: {
      getSession: async () => ({ data: { session: { user: { id: 'test-member' }, access_token: 'initial-token' } } }),
      signOut: liveSignOut,
    } };
    const redeem: typeof redeemMfaRecoveryCode = (code, dependencies) => redeemMfaRecoveryCode(code, {
      ...dependencies,
      request: async () => {
        if (replace) { run.activeUserID.current = 'replacement-member'; mounted.current = false; }
        return { ok: true, status: 200, json: async () => ({ recovered: true, sessionsRevoked: true }) };
      },
    });
    const recover = runInNewContext(recoveryScreenSource, {
      runOperation: async (_active: boolean, work: () => Promise<void>) => work(),
      getSupabaseClient: () => client, beginMfaRecovery: run.beginMfaRecovery, finishMfaRecovery: run.finishMfaRecovery,
      recoveryCleanup: { current: null },
      confirmMfaRecoveryGlobalSignOut: run.confirmMfaRecoveryGlobalSignOut,
      redeemMfaRecoveryCode: redeem, resolveMfaRecoveryApiOrigin: () => 'https://sample.unionground.example',
      recoveryCode: 'UG-1A2B-3C4D-5E6F-7089', mfaRecoveryMessage: () => 'Recovery accepted',
      setRecovering: vi.fn(), setMessage: vi.fn(), setRecoveryCode: vi.fn(), report, mounted,
      signInCompletion: run.signInCompletion, signOut: run.serializedSignOut,
    }) as () => Promise<void>;
    await recover();
    if (replace) {
      expect(run.activeUserID.current).toBe('replacement-member');
      expect(liveSignOut).not.toHaveBeenCalled();
      expect(run.revoke).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } else {
      expect(run.clear).toHaveBeenCalledOnce();
      expect(run.revoke).not.toHaveBeenCalled();
      expect(run.activeUserID.current).toBeNull();
      expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    }
  });
});

describe('a confirmed MFA recovery ends an incomplete Sign out everywhere warning', () => {
  const SAVED_CODE = 'UG-1A2B-3C4D-5E6F-7089';
  const refused = async () => ({ data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 });

  // Failed global attempt, then this session is lost: sign-in shows the
  // warning. The member signs in again and stops at the authenticator step.
  async function atChallengeAfterFailedGlobal(nextUserID = 'test-member') {
    const options = { rpc: refused, needsMfa: false };
    const run = build(options);
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.activeUserID.current).toBe('test-member');
    run.authEvent('SIGNED_OUT', null);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
    options.needsMfa = true;
    run.activeUserID.current = nextUserID;
    await run.refreshEstablishedSession(nextUserID);
    expect(run.setMode).toHaveBeenLastCalledWith('mfaRequired');
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    return run;
  }

  // The real exchange, with the server's answer and the local sign-out wired
  // to the provider's Auth listener as the challenge screen wires them.
  async function recover(run: Context, answer: RecoveryAnswer, attempt = run.beginMfaRecovery(), whileRequestRuns?: (order: string[]) => void) {
    const order: string[] = [];
    const outcome = await redeemMfaRecoveryCode(SAVED_CODE, {
      apiOrigin: () => 'https://sample.unionground.example',
      accessToken: async () => 'aal1-token',
      request: async () => {
        whileRequestRuns?.(order);
        if (answer instanceof Error) throw answer;
        return {
          ok: answer.status >= 200 && answer.status < 300, status: answer.status,
          ...(answer.body === undefined ? {} : { json: async () => answer.body }),
        };
      },
      confirmGlobalSignOut: () => {
        order.push('confirm');
        if (attempt) order.push(`released=${run.confirmMfaRecoveryGlobalSignOut(attempt)}`);
      },
      signOutLocally: async () => {
        order.push('local-sign-out');
        run.authEvent('SIGNED_OUT', null);
      },
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return { outcome, order };
  }

  const confirmed = { status: 200, body: { recovered: true, removed: 1, sessionsRevoked: true, signInAgain: true } };

  it('clears the latch and the warning before the local sign-out, so its SIGNED_OUT does not re-raise them', async () => {
    const run = await atChallengeAfterFailedGlobal();
    const { outcome, order } = await recover(run, confirmed);
    expect(outcome).toBe('recovered');
    expect(order).toEqual(['confirm', 'released=true', 'local-sign-out']);
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.activeUserID.current).toBeNull();
    expect(run.globalSignOutIncompleteRef.current).toBe(false);
    expect(run.globalSignOutIncompleteOwnerRef.current).toBeNull();
    expect(run.globalSignOutIncompleteSignedOut()).toBe(false);
    expect(run.visibleSignOutError()).toBeNull();
  });

  type RecoveryAnswer = { status: number; body?: unknown } | Error;
  const failedRecoveries: Array<[string, RecoveryAnswer]> = [
    ['a refused code', { status: 400 }],
    ['an unavailable service', { status: 502 }],
    ['a network failure', new Error('offline')],
  ];
  const unconfirmedRecoveries: Array<[string, RecoveryAnswer]> = [
    ['no body', { status: 200 }],
    ['a body without the revocation statement', { status: 200, body: { recovered: true } }],
    ['a body that says the revocation did not happen', { status: 200, body: { recovered: true, sessionsRevoked: false } }],
  ];

  it.each(failedRecoveries)('keeps the warning after %s', async (_name, answer) => {
    const run = await atChallengeAfterFailedGlobal();
    const { outcome, order } = await recover(run, answer);
    expect(outcome).not.toBe('recovered');
    expect(order).toEqual([]);
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
  });

  it.each(unconfirmedRecoveries)('keeps the warning when an accepted answer has %s', async (_name, answer) => {
    const run = await atChallengeAfterFailedGlobal();
    const { outcome, order } = await recover(run, answer);
    // The stored session still goes, and its SIGNED_OUT keeps the warning up.
    expect(outcome).toBe('recovered');
    expect(order).toEqual(['local-sign-out']);
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
  });

  it('keeps the warning when another account recovers at the challenge', async () => {
    // Account B's recovery revokes B's sessions, not the ones A's failed
    // Sign out everywhere left live.
    const run = await atChallengeAfterFailedGlobal('other-member');
    const { order } = await recover(run, confirmed);
    expect(order).toEqual(['confirm', 'released=false', 'local-sign-out']);
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
  });

  it('keeps a newer warning when a recovery started before that global attempt failed', async () => {
    const run = build({ rpc: refused });
    const stale = run.beginMfaRecovery();
    expect(stale).toEqual({ userID: 'test-member', session: { user: { id: 'test-member' }, access_token: 'initial-token' }, latch: null });
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.confirmMfaRecoveryGlobalSignOut(stale!)).toBe(false);
    // An attempt that saw an earlier failed attempt is stale once a newer one
    // has been admitted in its place.
    const earlier = run.beginMfaRecovery();
    expect(earlier?.latch).toBe(run.globalSignOutIncompleteOwnerRef.current);
    await run.serializedSignOut({ scope: 'global', silent: true });
    expect(run.globalSignOutIncompleteOwnerRef.current).not.toBe(earlier?.latch);
    expect(run.confirmMfaRecoveryGlobalSignOut(earlier!)).toBe(false);
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    run.authEvent('SIGNED_OUT', null);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(run.visibleSignOutError()).toBe(failure.GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE);
  });

  it('still clears the warning when this device saw the revoked session before the answer arrived', async () => {
    //  P1 / P2 on: a lock and unlock while the request
    // runs makes the resume find the refresh token revoked by the server's
    // global logout; the device signs out (raising the warning) before the
    // confirmed answer lands with no active account.
    const run = await atChallengeAfterFailedGlobal();
    const { outcome, order } = await recover(run, confirmed, undefined, (order) => {
      order.push('session-lost');
      run.authEvent('SIGNED_OUT', null);
    });
    expect(outcome).toBe('recovered');
    expect(order).toEqual(['session-lost', 'confirm', 'released=true', 'local-sign-out']);
    expect(run.activeUserID.current).toBeNull();
    expect(run.globalSignOutIncompleteRef.current).toBe(false);
    expect(run.globalSignOutIncompleteSignedOut()).toBe(false);
    expect(run.visibleSignOutError()).toBeNull();
  });

  it('keeps the warning when another account signed in after the session loss and before the answer', async () => {
    const run = await atChallengeAfterFailedGlobal();
    const { order } = await recover(run, confirmed, undefined, () => {
      run.authEvent('SIGNED_OUT', null);
      run.activeUserID.current = 'other-member';
    });
    expect(order).toEqual(['confirm', 'released=false', 'local-sign-out']);
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
  });

  it('releases nothing when the account at the challenge changed after the recovery started', async () => {
    const run = await atChallengeAfterFailedGlobal();
    const attempt = run.beginMfaRecovery();
    run.activeUserID.current = 'other-member';
    expect(run.confirmMfaRecoveryGlobalSignOut(attempt!)).toBe(false);
    expect(run.globalSignOutIncompleteRef.current).toBe(true);
    expect(run.globalSignOutIncompleteSignedOut()).toBe(true);
  });
});

// BUG-UG-NATIVE-SIGN-OUT-DURING-SESSION-CHECK-SHOWS-OFFLINE-20261103.
// Sign out was pressed while the secure-session check ran; the session stayed
// and the screen said "You're offline" with the network up. The press made the
// check stale, so a sign-out that then kept the session left the cover, or an
// earlier verdict, with no owner, and the next verdict took its offline words
// from one probe. These run the real sign-out, wrapper and resume.
describe('Sign out pressed during the secure-session check', () => {
  const refused = async () => ({ data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 });

  async function pressDuringCheck(options: Options) {
    let releaseCheck: (() => void) | undefined;
    const run = build({ realResume: 'authenticated', holdFirstRefresh: (release) => { releaseCheck = release; }, ...options });
    const check = run.resumeNow();
    await vi.waitFor(() => expect(releaseCheck).toBeDefined());
    expect(run.privacyCovered()).toBe(true);
    await run.serializedSignOut({ silent: true });
    // The interrupted check settles last and writes nothing.
    releaseCheck?.();
    await check;
    return run;
  }

  const offlineCalls = (run: Context) => run.setAssuranceUnavailable.mock.calls.filter(([, reason]) => reason === 'offline');

  it('re-runs the interrupted check when the sign-out keeps the session, and reveals what it finds', async () => {
    const run = await pressDuringCheck({ rpc: refused });
    expect(run.activeUserID.current).toBe('test-member');
    expect(run.refreshCalls()).toBe(2);
    expect(run.setMode).toHaveBeenLastCalledWith('authenticated');
    expect(run.privacyCovered()).toBe(false);
    expect(run.setAssuranceUnavailable.mock.calls.filter(([unavailable]) => unavailable)).toEqual([]);
    expect(run.signOutError()).toMatch(/^Sign-out is incomplete because the service refused the request/);
  });

  it('signs the worker out when the sign-out commits, without checking the ended session again', async () => {
    const run = await pressDuringCheck({});
    expect(run.activeUserID.current).toBeNull();
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.refreshCalls()).toBe(1);
    expect(run.privacyCovered()).toBe(false);
    expect(offlineCalls(run)).toEqual([]);
  });

  it('says the security check could not finish, not offline, when only the first probe of the re-run misfires', async () => {
    // The interrupted check's probe, then the re-run's probe that misfires,
    // then the fresh probe that gets an HTTP answer: the network is up.
    const answers: Array<'reachable' | 'offline' | 'silent'> = ['reachable', 'offline', 'reachable'];
    const run = await pressDuringCheck({ rpc: refused, reachable: async () => answers.shift() ?? 'reachable' });
    expect(run.setAssuranceUnavailable).toHaveBeenLastCalledWith(true, 'assurance');
    expect(offlineCalls(run)).toEqual([]);
    expect(sessionUnavailableCopy('assurance').title).toBe('Confirming account security');
    expect(run.setMode).toHaveBeenLastCalledWith('mfaRequired');
    expect(run.privacyCovered()).toBe(false);
  });

  it('still says offline when the fresh probe gets no answer either', async () => {
    const answers: Array<'reachable' | 'offline' | 'silent'> = ['reachable', 'offline', 'offline'];
    const run = await pressDuringCheck({ rpc: refused, reachable: async () => answers.shift() ?? 'offline' });
    expect(run.setAssuranceUnavailable).toHaveBeenLastCalledWith(true, 'offline');
    expect(run.privacyCovered()).toBe(false);
  });
});

// BUG-UG-NATIVE-SIGN-IN-SILENT-DROP-20261104, round 1 on: the
// notice must survive both orders in which Auth can report a refusal, and a
// loss while the first load is still covered.
describe('a sign-in that does not complete says so in every meeting order', () => {
  it.each([false, true])('names a refused revalidation when Auth emits SIGNED_OUT before refreshSession returns (sign-in pending: %s)', async (pending) => {
    let run!: Context;
    run = build({
      realResume: 'signedOut', observeInterrupts: true,
      // auth-js 2.118.0 removes the session, which notifies SIGNED_OUT,
      // before the failed refresh returns to the resume.
      holdFirstRefresh: (release) => { run.authEvent('SIGNED_OUT', null); release(); },
    });
    if (pending) run.signInCompletion.begin();
    await run.resumeNow();
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.setSignInNotice).toHaveBeenCalledTimes(1);
    expect(run.setSignInNotice).toHaveBeenCalledWith(pending ? SIGN_IN_DID_NOT_COMPLETE_NOTICE : SESSION_NOT_CONFIRMED_NOTICE);
  });

  it('names a refused revalidation when refreshSession returns before any meeting', async () => {
    const run = build({ realResume: 'signedOut', observeInterrupts: true });
    await run.resumeNow();
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.setSignInNotice).toHaveBeenCalledWith(SESSION_NOT_CONFIRMED_NOTICE);
    // The local clear's own SIGNED_OUT, after the resume settled, adds nothing.
    run.authEvent('SIGNED_OUT', null);
    expect(run.setSignInNotice).toHaveBeenCalledTimes(1);
  });

  it('owes the notice to a loss during the covered first load, and settles once the cover lifts', async () => {
    const lost = build({ onBootstrap: (context) => context.authEvent('SIGNED_OUT', null) });
    lost.signInCompletion.begin();
    await lost.refreshEstablishedSession();
    expect(lost.setSignInNotice).toHaveBeenCalledWith(SIGN_IN_DID_NOT_COMPLETE_NOTICE);

    const kept = build();
    kept.signInCompletion.begin();
    await kept.refreshEstablishedSession();
    expect(kept.privacyCovered()).toBe(false);
    expect(kept.signInCompletion.isPending()).toBe(false);
  });

  it('keeps a pending sign-in when the worker\'s sign-out refuses before the revoke', async () => {
    const run = build({ rpc: async () => ({ data: null, error: { message: 'unavailable' }, status: 503 }) });
    run.signInCompletion.begin();
    await run.signOut({ scope: 'local' });
    expect(run.revoke).not.toHaveBeenCalled();
    expect(run.signInCompletion.isPending()).toBe(true);
  });

  it('settles the pending sign-in at the worker\'s committed sign-out', async () => {
    const run = build();
    run.signInCompletion.begin();
    await run.signOut({ scope: 'local' });
    expect(run.revoke).toHaveBeenCalled();
    expect(run.signInCompletion.isPending()).toBe(false);
  });
});

// Round 2 on: a refusal that arrives after the resume's deadline, an
// MFA recovery's own sign-out during a resume, and a revoke that fails.
describe('a sign-in notice owner survives the resume deadline and the worker\'s own exits', () => {
  it('names a refusal that Auth reports after the 10-second deadline, and nothing once that refresh settled', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const run = build({ realResume: 'signedOut', lineage: true, holdFirstRefresh: (go) => { release = go; } });
      const resume = run.resumeNow();
      await vi.advanceTimersByTimeAsync(10_000);
      await resume;
      expect(run.setMode).not.toHaveBeenLastCalledWith('signedOut');
      expect(run.setSignInNotice).not.toHaveBeenCalled();
      // The refresh is still awaiting Auth; auth-js removes the session first.
      run.authEvent('SIGNED_OUT', null);
      expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
      expect(run.setSignInNotice).toHaveBeenCalledWith(SESSION_NOT_CONFIRMED_NOTICE);
      release();
      await vi.advanceTimersByTimeAsync(0);

      const settled = build({ realResume: 'signedOut', lineage: true });
      await settled.resumeNow();
      settled.setSignInNotice.mockClear();
      settled.authEvent('SIGNED_OUT', null);
      expect(settled.setSignInNotice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names a refusal that Auth reports while the user lookup outlives the deadline', async () => {
    vi.useFakeTimers();
    try {
      let settle!: () => void;
      const run = build({ realResume: 'authenticated', lineage: true, holdFirstUser: (go) => { settle = go; } });
      const resume = run.resumeNow();
      await vi.advanceTimersByTimeAsync(10_000);
      await resume;
      expect(run.setMode).not.toHaveBeenLastCalledWith('signedOut');
      expect(run.setSignInNotice).not.toHaveBeenCalled();
      // The refresh answered before the deadline; getUser is still awaiting
      // Auth, which removes the session before the lookup rejects.
      run.authEvent('SIGNED_OUT', null);
      expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
      expect(run.setSignInNotice).toHaveBeenCalledWith(SESSION_NOT_CONFIRMED_NOTICE);
      settle();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives no refusal notice to an MFA recovery that signs out during a resume', async () => {
    let run!: Context;
    run = build({
      realResume: 'signedOut', observeInterrupts: true,
      holdFirstRefresh: (go) => {
        void run.signInCompletion.intentionalExit(async () => { run.authEvent('SIGNED_OUT', null); });
        go();
      },
    });
    run.signInCompletion.begin();
    await run.resumeNow();
    expect(run.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(run.setSignInNotice).not.toHaveBeenCalled();
  });

  it('keeps the pending sign-in when the revoke fails, and leaves its own loss to the sign-out', async () => {
    const run = build();
    run.revoke.mockRejectedValueOnce(new Error('network'));
    run.signInCompletion.begin();
    await run.signOut({ scope: 'local' });
    expect(run.revoke).toHaveBeenCalled();
    expect(run.signInCompletion.isPending()).toBe(true);

    run.signOutInFlight.current = true;
    run.authEvent('SIGNED_OUT', null);
    run.signOutInFlight.current = false;
    expect(run.setSignInNotice).not.toHaveBeenCalled();
    expect(run.signInCompletion.isPending()).toBe(true);
  });
});
