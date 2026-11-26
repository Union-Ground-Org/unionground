import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createAccountLocalTeardown, ACCOUNT_CLEANUP_MESSAGE } from '../services/accountLocalTeardown';
import { resumeProtectedSession } from '../services/sessionResume';
import { replacesAuthenticatedLineage } from '../lib/sessionLineage';
import { createResumeRefreshProvenance, createSignInCompletion, SESSION_NOT_CONFIRMED_NOTICE, SIGN_IN_DID_NOT_COMPLETE_NOTICE } from '../lib/signInCompletion';

// Extract actual provider callbacks, without reproducing their implementation.
const source = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('AppProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let authCallback = '';
let resumeCallback = '';
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree).endsWith('.onAuthStateChange')) authCallback = node.arguments[0]!.getText(tree);
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'revalidateAuthenticatedSession' && node.initializer && ts.isCallExpression(node.initializer)) resumeCallback = node.initializer.arguments[0]!.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
if (!authCallback || !resumeCallback) throw new Error('Provider callbacks not found');
const compile = (callback: string) => ts.transpile(`const callback = ${callback}; callback;`, { target: ts.ScriptTarget.ES2022 });

function environment() {
  const session = { user: { id: 'departing' }, access_token: 'captured', refresh_token: 'captured-refresh' };
  const clearPush = vi.fn(async () => undefined);
  const purgeCaptures = vi.fn(async () => undefined);
  const accountLocalTeardown = createAccountLocalTeardown({ readPending: async () => null, writePending: async () => undefined, clearPush, purgeCaptures });
  const env = {
    sessionBootstrapDeadline: { current: 10_000 }, SESSION_BOOTSTRAP_DEADLINE_MS: 10_000,
    sessionRetryOwner: { current: null }, setSessionRetryInFlight: vi.fn(),
    deletedSessionID: { current: null }, sessionIDFromAccessToken: () => null, deletedUserID: { current: null }, deletionReceipt: { current: false }, deletionSession: { current: null }, setDeletionOutcome: vi.fn(),
    active: true, ACCOUNT_CLEANUP_MESSAGE, accountLocalTeardown, resumeProtectedSession,
    activeUserID: { current: 'departing' as string | null }, observedAuthIdentity: { current: session as unknown },
    sessionTransition: { current: 0 }, dashboardRequest: { current: 0 }, pendingAuthTransition: { current: null },
    blockedShareIsolation: { current: null }, shareIsolationBlocked: { current: false }, previewStore: { current: {} },
    nativeAuthGate: { observe: () => true, isStaged: () => false },
    sessionSignOutAttempts: { observe: () => ({ status: 'handle' }) },
    sessionResumeAttempts: { begin: () => ({}), finish: vi.fn(), observe: () => ({ status: 'handle', interrupted: false }), sessionIsCurrent: () => true },
    sessionResumeGuard: { invalidate: vi.fn(), begin: () => ({ isCurrent: () => true }) },
    authIdentityFor: (value: unknown) => value, authIdentityMatches: () => true,
    getSupabaseClient: () => ({ auth: { refreshSession: async () => ({ data: { session: null }, error: { status: 400, code: 'refresh_token_not_found' } }) } }),
    mobileConfig: { supabaseUrl: '' }, clearCapturedMobileSessionLocally: vi.fn(async () => true),
    captureSecureShareCleanupBoundary: vi.fn(), conversationUnreadStore: { reset: vi.fn() }, liveChannelStore: { resetForSession: vi.fn() },
    preparePendingSharedAttachmentUploadForSessionLoss: vi.fn(async () => 'clear'), purgeSecureShareStaging: vi.fn(async () => undefined),
    purgeAttachmentCacheForSessionLoss: vi.fn(async () => true),
    clearLocalNotificationPreference: vi.fn(async () => undefined), requestOfflineSignOutCleanup: vi.fn(async () => undefined),
    suspendOfflineAvailability: vi.fn(), setOfflineDraftsReady: vi.fn(), OFFLINE_CLEANUP_MESSAGE: 'offline cleanup pending',
    setMode: vi.fn(), setSignOutError: vi.fn(), setSignOutErrorState: vi.fn(), signOutErrorRef: { current: null as string | null },
    setGlobalSignOutIncompleteSignedOut: vi.fn(),
    signInCompletion: createSignInCompletion(), resumeRefreshProvenance: createResumeRefreshProvenance(), signOutInFlight: { current: false }, setSignInNotice: vi.fn(), revokedElsewhereSessionID: { current: null },
    globalSignOutIncompleteRef: { current: false },
    lastAuthenticatedUserIDRef: { current: null as string | null },
    lastAuthenticatedSessionIDRef: { current: null as string | null }, replacesAuthenticatedLineage,
    setError: vi.fn(), clearProtectedState: vi.fn(), setSession: vi.fn(),
    setDashboard: vi.fn(), setMemberLanguage: vi.fn(), setChapterMemberships: vi.fn(), setOrganizationStaffScope: vi.fn(), setDuesContext: vi.fn(),
    setPreviewHat: vi.fn(), setPreviewShellState: vi.fn(), setPreviewDesk: vi.fn(), setPreviewThreads: vi.fn(), setWidgetLayouts: vi.fn(),
    setLocked: vi.fn(), setPrivacyCovered: vi.fn(), setAssuranceUnavailable: vi.fn(),
  };
  return { env, session, clearPush, purgeCaptures };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe('provider automatic account-local teardown', () => {
  it('clears signed-in sign-out guidance when Auth reports definitive session loss', async () => {
    const f = environment();
    const diagnosis = 'Sign-out service refused the request';
    f.env.signOutErrorRef.current = diagnosis;
    f.env.setSignOutError.mockImplementation((message: string | null) => { f.env.signOutErrorRef.current = message; });
    (runInNewContext(compile(authCallback), f.env) as (event: string, session: null) => void)('SIGNED_OUT', null);
    await flush();
    expect(f.env.signOutErrorRef.current).toBeNull();
    expect(f.env.setSignOutError).toHaveBeenCalledWith(null);
    expect(f.env.activeUserID.current).toBeNull();
    expect(f.env.setMode).toHaveBeenLastCalledWith('signedOut');
  });
  it.each(['cold-resume', 'foreground-resume', 'SIGNED_OUT'])('clears only the departing account on %s', async (path) => {
    const f = environment();
    if (path === 'cold-resume') f.env.activeUserID.current = null;
    if (path === 'SIGNED_OUT') (runInNewContext(compile(authCallback), f.env) as (event: string, session: null) => void)('SIGNED_OUT', null);
    else await (runInNewContext(compile(resumeCallback), f.env) as (session: unknown) => Promise<void>)(f.session);
    await flush();
    expect(f.clearPush).toHaveBeenCalledWith('departing', expect.any(Function));
    expect(f.purgeCaptures).toHaveBeenCalledWith('departing', expect.any(Function));
    expect(f.env.setMode).toHaveBeenLastCalledWith('signedOut');
  });
  it('leaves a replacement session alone if it arrives before queued auth-event cleanup', async () => {
    const f = environment();
    (runInNewContext(compile(authCallback), f.env) as (event: string, session: null) => void)('SIGNED_OUT', null);
    f.env.sessionTransition.current++; f.env.activeUserID.current = 'replacement';
    await flush();
    expect(f.clearPush).not.toHaveBeenCalled(); expect(f.purgeCaptures).not.toHaveBeenCalled();
  });
  it.each([true, false])('raises the signed-out global warning on Auth session loss only while the latch is set (%s)', async (latched) => {
    // SEC-UG-FAILED-SIGN-OUT-EVERYWHERE-END-SIGN-SCREEN-WARNING-20261013,
    // Sol r2s2 on #4763: a SIGNED_OUT that lands while a global attempt is
    // pending reaches this branch with the latch already up.
    const f = environment();
    f.env.globalSignOutIncompleteRef.current = latched;
    (runInNewContext(compile(authCallback), f.env) as (event: string, session: null) => void)('SIGNED_OUT', null);
    await flush();
    expect(f.env.setMode).toHaveBeenLastCalledWith('signedOut');
    if (latched) expect(f.env.setGlobalSignOutIncompleteSignedOut).toHaveBeenCalledWith(true);
    else expect(f.env.setGlobalSignOutIncompleteSignedOut).not.toHaveBeenCalled();
  });
  it('reports failed local purge without undoing the definitive sign-out', async () => {
    const f = environment(); f.purgeCaptures.mockRejectedValueOnce(new Error('secure storage unavailable'));
    await (runInNewContext(compile(resumeCallback), f.env) as (session: unknown) => Promise<void>)(f.session);
    await flush();
    expect(f.env.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(f.env.setSignOutError).toHaveBeenLastCalledWith(ACCOUNT_CLEANUP_MESSAGE);
  });
});

// BUG-UG-NATIVE-SIGN-IN-SILENT-DROP-20261104: a sign-in whose new
// session was lost, or a revalidation Auth refused, returned to the form with
// no word. These run the real auth callback and resume against the real tracker.
describe('a sign-in that does not complete says so', () => {
  const lose = (env: ReturnType<typeof environment>['env']) =>
    (runInNewContext(compile(authCallback), env) as (event: string, session: null) => void)('SIGNED_OUT', null);
  const resume = (f: ReturnType<typeof environment>) =>
    (runInNewContext(compile(resumeCallback), f.env) as (session: unknown) => Promise<void>)(f.session);

  it('shows the did-not-complete notice when a just-set session is dropped', async () => {
    const f = environment();
    f.env.signInCompletion.begin();
    lose(f.env);
    await flush();
    expect(f.env.setSignInNotice).toHaveBeenCalledWith(SIGN_IN_DID_NOT_COMPLETE_NOTICE);
    expect(f.env.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(f.env.signInCompletion.isPending()).toBe(false);
  });

  it('adds nothing to an ordinary session loss or the worker\'s own sign-out', async () => {
    const ordinary = environment();
    lose(ordinary.env);
    const deliberate = environment();
    deliberate.env.signInCompletion.begin();
    deliberate.env.signInCompletion.settle();
    lose(deliberate.env);
    await flush();
    expect(ordinary.env.setSignInNotice).not.toHaveBeenCalled();
    expect(deliberate.env.setSignInNotice).not.toHaveBeenCalled();
  });

  it('shows the not-confirmed notice when revalidation refuses the session', async () => {
    const f = environment();
    await resume(f);
    await flush();
    expect(f.env.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(f.env.setSignInNotice).toHaveBeenLastCalledWith(SESSION_NOT_CONFIRMED_NOTICE);
  });

  it('calls a refused revalidation during a pending sign-in a sign-in that did not complete', async () => {
    const f = environment();
    f.env.signInCompletion.begin();
    await resume(f);
    await flush();
    expect(f.env.setSignInNotice).toHaveBeenLastCalledWith(SIGN_IN_DID_NOT_COMPLETE_NOTICE);
  });

  it('leaves a proven sign-out elsewhere to its own notice', async () => {
    const f = environment();
    (f.env.revokedElsewhereSessionID as { current: string | null }).current = 'revoked-session';
    await resume(f);
    await flush();
    expect(f.env.setSignInNotice).toHaveBeenLastCalledWith(null);
  });
});
