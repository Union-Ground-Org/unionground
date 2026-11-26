import type { Session } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
import { createAccountLocalTeardown, ACCOUNT_CLEANUP_MESSAGE } from '../services/accountLocalTeardown';
import {
  createSessionResumeAttemptCoordinator,
  createSessionResumeGuard,
  exactSessionIdentity,
  exactSessionIdentityMatches,
  resumeProtectedSession,
} from '../services/sessionResume';
import { replacesAuthenticatedLineage, sessionIDFromAccessToken } from '../lib/sessionLineage';
import { SESSION_UNAVAILABLE_ERROR } from '../lib/sessionUnavailableCopy';
import {
  createForegroundSessionRevocationWatch,
  SESSION_REVOCATION_CHECK_INTERVAL_MS,
  SIGNED_OUT_ELSEWHERE_NOTICE,
} from '../lib/foregroundSessionRevocationWatch';
import { createResumeRefreshProvenance, createSignInCompletion } from '../lib/signInCompletion';

// BUG-UG-NATIVE-SIGN-OUT-EVERYWHERE-NOT-NOTICED-IN-FOREGROUND-20261103.
// "Sign out everywhere" on another device ended this session on the server,
// but a phone left in the foreground kept its signed-in Home until it was
// backgrounded. These cases run the provider's real foreground watch effect,
// its notice effect, its resume entry point, its real resume callback and its
// real clearProtectedState (which shows 'booting' while the resume checks),
// extracted from AppProvider.tsx as sessionResumeOwnership.test.ts does,
// against the real watch, resume helper, guard and attempt coordinator, with
// Auth answering as production does after a global sign-out. Every state
// write schedules a render, so the effects see each committed mode in turn.
const provider = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('AppProvider.tsx', provider, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let revalidateCallback = '';
let clearProtectedCallback = '';
let resumeEntryCallback = '';
let errorCallback = '';
let watchEffect = '';
let noticeEffect = '';
const identityHelpers: string[] = [];
(function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    const name = node.name.getText(tree);
    if (name === 'revalidateAuthenticatedSession') revalidateCallback = node.initializer.arguments[0]!.getText(tree);
    if (name === 'clearProtectedState') clearProtectedCallback = node.initializer.arguments[0]!.getText(tree);
    if (name === 'resumeAuthenticatedSession') resumeEntryCallback = node.initializer.arguments[0]!.getText(tree);
    if (name === 'setSignOutError') errorCallback = node.initializer.arguments[0]!.getText(tree);
  }
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect') {
    const body = node.arguments[0]!.getText(tree);
    if (body.includes('createForegroundSessionRevocationWatch(')) watchEffect = body;
    if (body.includes('setSignedOutElsewhere(true)')) noticeEffect = body;
  }
  if (ts.isFunctionDeclaration(node) && ['authIdentityFor', 'authIdentityMatches'].includes(node.name?.text ?? '')) {
    identityHelpers.push(node.getText(tree));
  }
  ts.forEachChild(node, visit);
})(tree);
if (!revalidateCallback || !clearProtectedCallback || !resumeEntryCallback || !errorCallback || !watchEffect || !noticeEffect || identityHelpers.length !== 2) {
  throw new Error('Provider resume, watch, notice, diagnosis or identity code was not found');
}
const compile = (source: string) => ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
const revalidateSource = compile(`(${revalidateCallback})`);
const clearProtectedSource = compile(`(${clearProtectedCallback})`);
const resumeEntrySource = compile(`(${resumeEntryCallback})`);
const errorSource = compile(`(${errorCallback})`);
const watchEffectSource = compile(`(${watchEffect})`);
const noticeEffectSource = compile(`(${noticeEffect})`);
const identitySource = compile(`${identityHelpers.join('\n')}\n({ authIdentityFor, authIdentityMatches });`);

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';

function session(userID: string, sessionID: string): Session {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionID })).toString('base64url');
  return {
    access_token: `header.${payload}.signature`,
    refresh_token: `redacted-refresh-${sessionID}`,
    expires_in: 3_600,
    token_type: 'bearer',
    user: { id: userID, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-03T00:00:00.000Z' },
  } as Session;
}

type ServerState = 'live' | 'revoked' | 'outage';

function fakeAppState() {
  const listeners = new Set<(next: string) => void>();
  return {
    currentState: 'active',
    addEventListener: (_type: string, listener: (next: string) => void) => {
      listeners.add(listener);
      return { remove: () => { listeners.delete(listener); } };
    },
    emit(next: string) {
      this.currentState = next;
      for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

function harness(initial: Session) {
  const effects: Array<[string, unknown]> = [];
  const record = (name: string) => vi.fn((value?: unknown) => { effects.push([name, value]); });
  // The rendered state the effects read; setters update it as React would.
  const state = { mode: 'authenticated' as string, session: initial as Session | null, signedOutElsewhere: false };
  const refs = {
    signOutErrorRef: { current: null as string | null },
    shareRecoveryErrorRef: { current: null as symbol | null },
    observedAuthIdentity: { current: exactSessionIdentity(initial) as unknown },
    activeUserID: { current: initial.user.id as string | null },
    sessionTransition: { current: 0 },
    pendingAuthTransition: { current: null as unknown },
    dashboardRequest: { current: 0 },
    revokedElsewhereSessionID: { current: null as string | null },
    signOutInFlight: { current: false },
    deferredForegroundResume: { current: false },
    latestResumeAuthenticatedSession: { current: async () => undefined },
  };
  const setSignOutErrorState = vi.fn((message: string | null) => { effects.push(['setSignOutErrorState', message]); });
  const writeDiagnosis = runInNewContext(errorSource, { ...refs, setSignOutErrorState }) as (next: string | null) => void;
  const setSignOutError = vi.fn((next: string | null) => { writeDiagnosis(next); });
  const server = { state: 'live' as ServerState };
  // The isolated probe: Auth's GET /user for the exact token.
  const capturedSessionIsGone = vi.fn(async (captured: Session) => {
    expect(captured.access_token).toBe(state.session?.access_token);
    if (server.state === 'outage') throw new Error('network');
    return server.state === 'revoked';
  });
  const refreshSession = vi.fn(async () => {
    if (server.state === 'revoked') {
      return { data: { session: null }, error: { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found' } };
    }
    if (server.state === 'outage') return { data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 503 } };
    return { data: { session: state.session }, error: null };
  });
  const clearCapturedMobileSessionLocally = vi.fn(async () => true);
  const AppState = fakeAppState();
  const identity = runInNewContext(identitySource, { exactSessionIdentity, exactSessionIdentityMatches }) as object;
  const env: Record<string, unknown> = {
    ...refs,
    ...identity,
    AppState,
    createForegroundSessionRevocationWatch,
    capturedSessionIsGone,
    sessionIDFromAccessToken,
    setSignedOutElsewhere: vi.fn((next: boolean) => { state.signedOutElsewhere = next; effects.push(['setSignedOutElsewhere', next]); }),
    resumeProtectedSession,
    sessionBootstrapDeadline: { current: 10_000 }, SESSION_BOOTSTRAP_DEADLINE_MS: 10_000,
    sessionRetryOwner: { current: null }, setSessionRetryInFlight: vi.fn(),
    sessionResumeGuard: createSessionResumeGuard(),
    sessionResumeAttempts: createSessionResumeAttemptCoordinator(),
    setGlobalSignOutIncompleteSignedOut: vi.fn(),
    signInCompletion: createSignInCompletion(), resumeRefreshProvenance: createResumeRefreshProvenance(), setSignInNotice: vi.fn(),
    globalSignOutIncompleteRef: { current: false },
    lastAuthenticatedUserIDRef: { current: initial.user.id as string | null },
    lastAuthenticatedSessionIDRef: { current: SID_A as string | null }, replacesAuthenticatedLineage,
    blockedShareIsolation: { current: null }, shareIsolationBlocked: { current: false },
    previewStore: { current: {} },
    mobileConfig: { supabaseUrl: '' },
    getSupabaseClient: () => ({ auth: {
      refreshSession,
      getUser: async () => ({ data: { user: { id: state.session!.user.id } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    } }),
    clearCapturedMobileSessionLocally,
    captureSecureShareCleanupBoundary: () => ({}),
    preparePendingSharedAttachmentUploadForSessionEstablishment: vi.fn(async () => undefined),
    preparePendingSharedAttachmentUploadForSessionLoss: vi.fn(async () => 'clear'),
    secureShareRecoveryNotice: () => 'Attachment recovery failed',
    fetchDashboard: vi.fn(async () => undefined),
    setSignOutError, setSignOutErrorState,
    purgeSecureShareStaging: vi.fn(async () => undefined),
    setPrivacyCovered: record('setPrivacyCovered'),
    setSession: vi.fn((next: Session | null) => { state.session = next; scheduleRender(); }),
    setMode: vi.fn((next: string) => { state.mode = next; effects.push(['setMode', next]); scheduleRender(); }),
    suspendHomeWidgets: record('suspendHomeWidgets'),
    liveChannelStore: { resetForSession: record('resetLiveChannels') },
    setDashboard: record('setDashboard'), setMemberLanguage: record('setMemberLanguage'),
    setChapterMemberships: record('setChapterMemberships'), setOrganizationStaffScope: record('setOrganizationStaffScope'),
    setDuesContext: record('setDuesContext'), setRefreshing: record('setRefreshing'),
    setResumeDraftReads: record('setResumeDraftReads'),
    providerMounted: { current: true },
    setError: record('setError'), setAssuranceUnavailable: record('setAssuranceUnavailable'),
    setLocked: record('setLocked'), setPreviewHat: record('setPreviewHat'), setPreviewShellState: record('setPreviewShellState'),
    setPreviewDesk: record('setPreviewDesk'), setPreviewThreads: record('setPreviewThreads'), setWidgetLayouts: record('setWidgetLayouts'),
    setOfflineDraftsReady: record('setOfflineDraftsReady'),
    suspendOfflineAvailability: record('suspendOfflineAvailability'),
    conversationUnreadStore: { reset: record('resetUnread') },
    requestOfflineSignOutCleanup: vi.fn(async () => undefined), OFFLINE_CLEANUP_MESSAGE: 'offline cleanup pending',
    SESSION_UNAVAILABLE_ERROR,
    ACCOUNT_CLEANUP_MESSAGE,
    accountLocalTeardown: createAccountLocalTeardown({
      readPending: async () => null, writePending: async () => undefined,
      clearPush: async () => undefined, purgeCaptures: async () => undefined,
    }),
    clearLocalNotificationPreference: vi.fn(async () => undefined),
  };
  env.clearProtectedState = runInNewContext(clearProtectedSource, env);
  env.revalidateAuthenticatedSession = runInNewContext(revalidateSource, env);

  // One render: publish the latest resume entry point, then rerun both
  // effects when their inputs (mode, session) changed, as React does.
  let cleanup: (() => void) | undefined;
  let rendered: { mode: string; session: Session | null } | null = null;
  const renderedModes: string[] = [];
  let renderScheduled = false;
  // React commits a batch of state writes after the synchronous code that
  // made them, before the next awaited answer resumes the resume.
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    void Promise.resolve().then(() => { renderScheduled = false; render(); });
  }
  function render() {
    const scope = { ...env, mode: state.mode, session: state.session };
    refs.latestResumeAuthenticatedSession.current = runInNewContext(resumeEntrySource, scope);
    if (rendered && rendered.mode === state.mode && rendered.session === state.session) return;
    rendered = { mode: state.mode, session: state.session };
    renderedModes.push(state.mode);
    cleanup?.();
    cleanup = (runInNewContext(watchEffectSource, scope) as () => (() => void) | undefined)();
    (runInNewContext(noticeEffectSource, scope) as () => void)();
  }
  render();
  // The mount's own effects are not part of any case below.
  effects.length = 0;
  return {
    state, refs, effects, server, AppState, render, renderedModes, capturedSessionIsGone, refreshSession, clearCapturedMobileSessionLocally,
    notice: () => (state.mode === 'signedOut' && state.signedOutElsewhere ? SIGNED_OUT_ELSEWHERE_NOTICE : null),
    // Let the resume settle, then render what it set.
    async settle() {
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 5; index += 1) await vi.advanceTimersByTimeAsync(0);
      render();
    },
  };
}

describe('a foreground app notices "Sign out everywhere" from another device', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns to sign-in with the web notice within one check, through the ordinary resume', async () => {
    const h = harness(session('member-a', SID_A));
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(h.capturedSessionIsGone).toHaveBeenCalledTimes(1);
    expect(h.refreshSession).not.toHaveBeenCalled();
    expect(h.state.mode).toBe('authenticated');

    // Device B runs "Sign out everywhere"; this phone stays in the foreground.
    h.server.state = 'revoked';
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    await h.settle();

    expect(h.capturedSessionIsGone).toHaveBeenCalledTimes(2);
    // The resume's real clearProtectedState rendered 'booting' with the same
    // session before the refresh answered.
    expect(h.renderedModes).toEqual(['authenticated', 'booting', 'signedOut']);
    expect(h.effects).toContainEqual(['suspendHomeWidgets', undefined]);
    // The ordinary resume decided it: covered, refreshed, cleared locally.
    expect(h.refreshSession).toHaveBeenCalledTimes(1);
    expect(h.clearCapturedMobileSessionLocally).toHaveBeenCalledTimes(1);
    expect(h.effects).toContainEqual(['setPrivacyCovered', true]);
    expect(h.state.mode).toBe('signedOut');
    expect(h.state.session).toBeNull();
    expect(h.notice()).toBe('You were signed out on this device. Sign in again to continue.');
    expect(h.refs.revokedElsewhereSessionID.current).toBeNull();

    // Signed out: no watch runs and nothing asks again.
    expect(h.AppState.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS * 4);
    expect(h.capturedSessionIsGone).toHaveBeenCalledTimes(2);
  });

  it('clears the notice when the next session signs in', async () => {
    const h = harness(session('member-a', SID_A));
    h.server.state = 'revoked';
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    await h.settle();
    expect(h.notice()).toBe(SIGNED_OUT_ELSEWHERE_NOTICE);

    h.server.state = 'live';
    h.state.session = session('member-a', SID_B);
    h.state.mode = 'authenticated';
    h.render();
    expect(h.state.signedOutElsewhere).toBe(false);
    h.state.mode = 'signedOut';
    h.state.session = null;
    h.render();
    expect(h.notice()).toBeNull();
  });

  it('pauses in the background, where the resume on return owns the check', async () => {
    const h = harness(session('member-a', SID_A));
    h.AppState.emit('background');
    h.server.state = 'revoked';
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS * 5);
    expect(h.capturedSessionIsGone).not.toHaveBeenCalled();
    expect(h.refreshSession).not.toHaveBeenCalled();
    expect(h.state.mode).toBe('authenticated');

    h.AppState.emit('active');
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    await h.settle();
    expect(h.capturedSessionIsGone).toHaveBeenCalledTimes(1);
    expect(h.state.mode).toBe('signedOut');
  });

  it.each<ServerState>(['live', 'outage'])('a %s answer proves nothing and leaves the session signed in', async (answer) => {
    const h = harness(session('member-a', SID_A));
    h.server.state = answer;
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS * 3);
    await h.settle();
    expect(h.capturedSessionIsGone).toHaveBeenCalledTimes(3);
    expect(h.refreshSession).not.toHaveBeenCalled();
    expect(h.state.mode).toBe('authenticated');
    expect(h.effects).toEqual([]);
  });

  it('keeps the resume fail-closed: a proof followed by a refresh outage shows the locked retry surface, no notice', async () => {
    const h = harness(session('member-a', SID_A));
    h.server.state = 'revoked';
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS - 1);
    // The probe proves the revocation; the refresh then meets an outage.
    h.capturedSessionIsGone.mockImplementationOnce(async () => {
      h.server.state = 'outage';
      return true;
    });
    await vi.advanceTimersByTimeAsync(1);
    await h.settle();

    expect(h.refreshSession).toHaveBeenCalledTimes(1);
    expect(h.clearCapturedMobileSessionLocally).not.toHaveBeenCalled();
    expect(h.state.mode).toBe('mfaRequired');
    expect(h.renderedModes).toEqual(['authenticated', 'booting', 'mfaRequired']);
    expect(h.effects).toContainEqual(['setAssuranceUnavailable', true]);
    expect(h.notice()).toBeNull();
    expect(h.refs.revokedElsewhereSessionID.current).toBeNull();
  });

  it('parks the resume behind a sign-out already in flight, and its own signed-out screen shows no notice', async () => {
    const h = harness(session('member-a', SID_A));
    h.refs.signOutInFlight.current = true;
    // This device's own revoke is what the probe sees.
    h.server.state = 'revoked';
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    await h.settle();
    expect(h.capturedSessionIsGone).toHaveBeenCalledTimes(1);
    expect(h.refs.deferredForegroundResume.current).toBe(true);
    expect(h.refreshSession).not.toHaveBeenCalled();
    expect(h.refs.revokedElsewhereSessionID.current).toBeNull();

    // The own sign-out commits straight to signed out, as serializedSignOut does.
    h.refs.observedAuthIdentity.current = null;
    h.state.session = null;
    h.state.mode = 'signedOut';
    h.refs.signOutInFlight.current = false;
    h.render();
    expect(h.state.signedOutElsewhere).toBe(false);
    expect(h.notice()).toBeNull();
  });

  it('ignores a proof about a session this device no longer shows', async () => {
    const h = harness(session('member-a', SID_A));
    h.server.state = 'revoked';
    // An auth event has already moved the observed identity to a new sign-in.
    h.refs.observedAuthIdentity.current = exactSessionIdentity(session('member-a', SID_B));
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    await h.settle();
    expect(h.capturedSessionIsGone).toHaveBeenCalledTimes(1);
    expect(h.refreshSession).not.toHaveBeenCalled();
    expect(h.refs.revokedElsewhereSessionID.current).toBeNull();
    expect(h.state.mode).toBe('authenticated');
  });
});
