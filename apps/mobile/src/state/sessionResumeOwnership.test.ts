import { stubSessionWriter } from '../testing/stubSessionWriter';
import type { Session } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
import { createAccountLocalTeardown, ACCOUNT_CLEANUP_MESSAGE } from '../services/accountLocalTeardown';
import {
  createSessionResumeAttemptCoordinator,
  createSessionResumeGuard,
  exactSessionIdentity,
  exactSessionIdentityMatches,
  resumeProtectedSession,
  SESSION_BOOTSTRAP_DEADLINE_MS,
} from '../services/sessionResume';
import { replacesAuthenticatedLineage, sessionIDFromAccessToken } from '../lib/sessionLineage';
import { SESSION_UNAVAILABLE_ERROR } from '../lib/sessionUnavailableCopy';
import { createResumeRefreshProvenance, createSignInCompletion } from '../lib/signInCompletion';

// SEC-UG-MOBILE-SESSION-LINEAGE-RACE-20260903. The resume helper checked
// its guard only after the provider's bootstrap callback settled, so a resume
// replaced while share recovery awaited still entered the dashboard, wrote its
// recovery diagnosis and marker, and restored a diagnosis in its finally.
//
// These cases run the provider's real resume callback and its real auth-state
// callback (extracted from AppProvider.tsx, as signOutHandler.test.ts does)
// against the real resume helper, guard and attempt coordinator. The
// replacement is a real auth event that runs its own real resume or
// establishment, so the late continuation races actual replacement work
// rather than a modelled one.
const provider = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('AppProvider.tsx', provider, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let resumeCallback = '';
let errorCallback = '';
let authCallback = '';
let establishCallback = '';
const identityHelpers: string[] = [];
(function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    const name = node.name.getText(tree);
    if (name === 'revalidateAuthenticatedSession') resumeCallback = node.initializer.arguments[0]!.getText(tree);
    if (name === 'setSignOutError') errorCallback = node.initializer.arguments[0]!.getText(tree);
    if (name === 'establishSession') establishCallback = node.initializer.arguments[0]!.getText(tree);
  }
  if (ts.isCallExpression(node) && node.expression.getText(tree).endsWith('.onAuthStateChange')) {
    authCallback = node.arguments[0]!.getText(tree);
  }
  if (ts.isFunctionDeclaration(node) && ['authIdentityFor', 'authIdentityMatches'].includes(node.name?.text ?? '')) {
    identityHelpers.push(node.getText(tree));
  }
  ts.forEachChild(node, visit);
})(tree);
if (!resumeCallback || !errorCallback || !authCallback || !establishCallback || identityHelpers.length !== 2) {
  throw new Error('Provider resume, establishment, diagnosis, auth-event or identity code was not found');
}
const compile = (source: string) => ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
const resumeSource = compile(`(${resumeCallback})`);
const errorSource = compile(`(${errorCallback})`);
const authSource = compile(`(${authCallback})`);
const establishSource = compile(`(${establishCallback})`);
const identitySource = compile(`${identityHelpers.join('\n')}\n({ authIdentityFor, authIdentityMatches });`);

const SID_A1 = '11111111-1111-4111-8111-111111111111';
const SID_A2 = '33333333-3333-4333-8333-333333333333';
const SID_B = '22222222-2222-4222-8222-222222222222';

function session(userID: string, tokenVersion: string, sessionID: string): Session {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionID, tokenVersion })).toString('base64url');
  return {
    access_token: `header.${payload}.signature`,
    refresh_token: `redacted-refresh-${tokenVersion}`,
    expires_in: 3_600,
    token_type: 'bearer',
    user: { id: userID, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-12T00:00:00.000Z' },
  } as Session;
}

type Held = { resolve(): void; reject(error: Error): void };

function harness(initial: Session) {
  const effects: Array<[string, unknown]> = [];
  const record = (name: string) => vi.fn((value?: unknown) => { effects.push([name, value]); });
  const refs = {
    signOutErrorRef: { current: null as string | null },
    shareRecoveryErrorRef: { current: null as symbol | null },
    observedAuthIdentity: { current: exactSessionIdentity(initial) as unknown },
    activeUserID: { current: initial.user.id as string | null },
    sessionTransition: { current: 0 },
    pendingAuthTransition: { current: null as unknown },
    providerMounted: { current: true },
    dashboardRequest: { current: 0 },
  };
  let shownDiagnosis: string | null = null;
  const setSignOutErrorState = vi.fn((message: string | null) => {
    shownDiagnosis = message;
    effects.push(['setSignOutErrorState', message]);
  });
  const writeDiagnosis = runInNewContext(errorSource, { ...refs, setSignOutErrorState }) as (next: string | null) => void;
  const setSignOutError = vi.fn((next: string | null) => {
    effects.push(['setSignOutError', next]);
    writeDiagnosis(next);
  });
  // The first establishment recovery for the original account is held; every
  // later one (the replacement's own resume) completes at once.
  const held: Held[] = [];
  let holdNext = true;
  const establishmentRecovery = vi.fn((userID: string) => {
    effects.push(['shareRecovery', userID]);
    if (!holdNext) return Promise.resolve();
    holdNext = false;
    return new Promise<void>((resolve, reject) => { held.push({ resolve, reject }); });
  });
  const fetchDashboard = vi.fn(async (nextSession: Session) => {
    effects.push(['fetchDashboard', nextSession.user.id]);
  });
  // Auth answers with whichever session the server would now return.
  let serverSession = initial;
  const guard = createSessionResumeGuard();
  const env: Record<string, unknown> = {
    captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'signed-out'),
    ...refs,
    ...(runInNewContext(identitySource, { exactSessionIdentity, exactSessionIdentityMatches }) as object),
    setTimeout, clearTimeout, SESSION_BOOTSTRAP_DEADLINE_MS,
    sessionBootstrapDeadline: { current: SESSION_BOOTSTRAP_DEADLINE_MS },
    sessionRetryOwner: { current: null }, setSessionRetryInFlight: vi.fn(),
    active: true,
    resumeProtectedSession,
    sessionResumeGuard: guard,
    sessionResumeAttempts: createSessionResumeAttemptCoordinator(),
    sessionSignOutAttempts: { observe: () => ({ status: 'handle', interrupted: false }) },
    nativeAuthGate: { observe: () => true, isStaged: () => false },
    deletionReceipt: { current: false }, deletedUserID: { current: null }, deletedSessionID: { current: null },
    deletionSession: { current: null }, deletionCleanupAction: { current: async () => undefined },
    setDeletionOutcome: record('setDeletionOutcome'), sessionIDFromAccessToken,
    // Not recorded: the authenticated commit lowers the signed-out warning
    // flag, which is no part of the ownership sequences these cases read.
    setGlobalSignOutIncompleteSignedOut: vi.fn(),
    signInCompletion: createSignInCompletion(), resumeRefreshProvenance: createResumeRefreshProvenance(),
    globalSignOutIncompleteRef: { current: false },
    lastAuthenticatedUserIDRef: { current: null as string | null },
    lastAuthenticatedSessionIDRef: { current: null as string | null }, replacesAuthenticatedLineage,
    blockedShareIsolation: { current: null }, shareIsolationBlocked: { current: false },
    previewStore: { current: {} },
    mobileConfig: { supabaseUrl: '' },
    getSupabaseClient: () => ({ auth: {
      refreshSession: async () => ({ data: { session: serverSession }, error: null }),
      getUser: async () => ({ data: { user: { id: serverSession.user.id } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    } }),
    clearCapturedMobileSessionLocally: vi.fn(async () => true),
    captureSecureShareCleanupBoundary: () => ({}),
    preparePendingSharedAttachmentUploadForSessionEstablishment: establishmentRecovery,
    preparePendingSharedAttachmentUploadForSessionLoss: vi.fn(async (userID: string) => {
      effects.push(['shareIsolation', userID]);
      return 'clear';
    }),
    secureShareRecoveryNotice: () => 'Attachment recovery for the original account failed',
    ShareIntakeError: class extends Error {},
    fetchDashboard,
    sessionNeedsMfa: vi.fn(async () => false),
    purgeOfflineAvailability: vi.fn(async () => { effects.push(['purgeOfflineAvailability', null]); }),
    setSignOutError, setSignOutErrorState,
    purgeSecureShareStaging: vi.fn(async () => { effects.push(['purgeSecureShareStaging', null]); }),
    clearProtectedState: record('clearProtectedState'),
    setPrivacyCovered: record('setPrivacyCovered'),
    setSession: vi.fn((next: Session | null) => { effects.push(['setSession', next?.user.id ?? null]); }),
    setMode: record('setMode'), setError: record('setError'), setAssuranceUnavailable: record('setAssuranceUnavailable'),
    setLocked: record('setLocked'), setPreviewHat: record('setPreviewHat'), setPreviewShellState: record('setPreviewShellState'),
    setPreviewDesk: record('setPreviewDesk'), setPreviewThreads: record('setPreviewThreads'), setWidgetLayouts: record('setWidgetLayouts'),
    setDashboard: record('setDashboard'), setMemberLanguage: record('setMemberLanguage'),
    setChapterMemberships: record('setChapterMemberships'), setOrganizationStaffScope: record('setOrganizationStaffScope'),
    setDuesContext: record('setDuesContext'), setOfflineDraftsReady: record('setOfflineDraftsReady'),
    suspendOfflineAvailability: record('suspendOfflineAvailability'),
    liveChannelStore: { resetForSession: record('resetLiveChannels') },
    conversationUnreadStore: { reset: record('resetUnread') },
    requestOfflineSignOutCleanup: vi.fn(async () => undefined), OFFLINE_CLEANUP_MESSAGE: 'offline cleanup pending',
    SESSION_UNAVAILABLE_ERROR,
    ACCOUNT_CLEANUP_MESSAGE,
    accountLocalTeardown: createAccountLocalTeardown({
      readPending: async () => null, writePending: async () => undefined,
      clearPush: async () => undefined, purgeCaptures: async () => undefined,
    }),
    clearLocalNotificationPreference: vi.fn(async () => undefined),
    purgeAttachmentCacheForSessionLoss: vi.fn(async () => true),
  };
  const resume = runInNewContext(resumeSource, env) as (covered: Session) => Promise<void>;
  env.revalidateAuthenticatedSession = resume;
  const establish = runInNewContext(establishSource, env) as (next: Session) => Promise<void>;
  env.establishSession = establish;
  const onAuthEvent = runInNewContext(authSource, env) as (event: string, next: Session | null) => void;
  return {
    effects, refs, held, fetchDashboard, setSignOutError,
    shownDiagnosis: () => shownDiagnosis,
    resume: (covered: Session) => resume(covered),
    // Native-link adoption establishes its staged session directly, without
    // an auth event or a replacement resume.
    establish: (next: Session) => { serverSession = next; return establish(next); },
    // Supabase installs the replacement, then notifies the provider.
    signIn: (next: Session) => { serverSession = next; onAuthEvent('SIGNED_IN', next); },
    background: () => guard.invalidate(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function untilIdle() { for (let i = 0; i < 10; i += 1) await settle(); }

type Replacement = 'different account' | 'same user, new SID' | 'A to B to A';

async function replaceWhileRecoveryHeld(replacement: Replacement) {
  const accountA = session('member-a', 'a1', SID_A1);
  const h = harness(accountA);
  const late = h.resume(accountA);
  await vi.waitFor(() => expect(h.held).toHaveLength(1));
  expect(h.fetchDashboard).not.toHaveBeenCalled();

  const replacements: Session[] = replacement === 'different account'
    ? [session('member-b', 'b1', SID_B)]
    : replacement === 'same user, new SID'
      ? [session('member-a', 'a2', SID_A2)]
      : [session('member-b', 'b1', SID_B), session('member-a', 'a2', SID_A2)];
  for (const next of replacements) {
    h.signIn(next);
    await vi.waitFor(() => expect(h.fetchDashboard).toHaveBeenLastCalledWith(next, 'automatic', true));
    await untilIdle();
  }
  const current = replacements.at(-1)!;
  // The replacement's own resume completed: it owns the dashboard, the
  // revealed surface and the diagnosis. It now records its own diagnosis.
  expect(h.effects).toContainEqual(['setMode', 'authenticated']);
  expect(h.effects.at(-1)).toEqual(['setPrivacyCovered', false]);
  h.setSignOutError('Replacement session diagnosis');
  const replacementMarker = Symbol('replacement-recovery');
  h.refs.shareRecoveryErrorRef.current = replacementMarker;
  return { h, late, current, replacementMarker, mark: h.effects.length };
}

describe('a superseded resume never acts on its replacement', () => {
  const replacements: Replacement[] = ['different account', 'same user, new SID', 'A to B to A'];

  it.each(replacements)('late recovery success after %s: no dashboard entry, diagnosis, reveal or cleanup', async (replacement) => {
    const { h, late, current, replacementMarker, mark } = await replaceWhileRecoveryHeld(replacement);
    const dashboards = h.fetchDashboard.mock.calls.length;
    h.held[0]!.resolve();
    await expect(late).resolves.toBeUndefined();
    await untilIdle();

    expect(h.effects.slice(mark)).toEqual([]);
    expect(h.fetchDashboard).toHaveBeenCalledTimes(dashboards);
    expect(h.fetchDashboard).toHaveBeenLastCalledWith(current, 'automatic', true);
    expect(h.refs.signOutErrorRef.current).toBe('Replacement session diagnosis');
    expect(h.shownDiagnosis()).toBe('Replacement session diagnosis');
    expect(h.refs.shareRecoveryErrorRef.current).toBe(replacementMarker);
    expect(h.refs.activeUserID.current).toBe(current.user.id);
  });

  it.each(replacements)('late recovery failure after %s: no diagnosis, marker, retry surface or cleanup', async (replacement) => {
    const { h, late, current, replacementMarker, mark } = await replaceWhileRecoveryHeld(replacement);
    h.held[0]!.reject(new Error('original account recovery rejected'));
    await expect(late).resolves.toBeUndefined();
    await untilIdle();

    expect(h.effects.slice(mark)).toEqual([]);
    expect(h.refs.signOutErrorRef.current).toBe('Replacement session diagnosis');
    expect(h.shownDiagnosis()).toBe('Replacement session diagnosis');
    expect(h.refs.shareRecoveryErrorRef.current).toBe(replacementMarker);
    expect(h.refs.activeUserID.current).toBe(current.user.id);
  });

  const settlements: Array<'resolve' | 'reject'> = ['resolve', 'reject'];
  it.each(settlements)('a backgrounded attempt does nothing when recovery later settles (%s)', async (outcome) => {
    const accountA = session('member-a', 'a1', SID_A1);
    const h = harness(accountA);
    h.setSignOutError('Retained diagnosis');
    const late = h.resume(accountA);
    await vi.waitFor(() => expect(h.held).toHaveLength(1));
    h.background();
    const mark = h.effects.length;
    if (outcome === 'resolve') h.held[0]!.resolve();
    else h.held[0]!.reject(new Error('recovery rejected'));
    await expect(late).resolves.toBeUndefined();
    await untilIdle();

    // The attempt's coordinator slot was still its own, so finish() succeeds;
    // ownership of the surface had already passed to the next foreground.
    expect(h.effects.slice(mark)).toEqual([]);
    expect(h.refs.signOutErrorRef.current).toBe('Retained diagnosis');
    // Nothing hid it, so it is still shown with no owner left to settle it.
    expect(h.shownDiagnosis()).toBe('Retained diagnosis');
  });


  it('a direct same-account establishment that replaces it keeps the retained diagnosis shown', async () => {
    const accountA = session('member-a', 'a1', SID_A1);
    const h = harness(accountA);
    h.setSignOutError('Sign out everywhere may be incomplete');
    const late = h.resume(accountA);
    await vi.waitFor(() => expect(h.held).toHaveLength(1));
    // The resume never hides the retained diagnosis, so no later owner has to
    // show it again when this attempt is superseded (gate round 2, Grok).
    expect(h.effects).not.toContainEqual(['setSignOutErrorState', null]);
    expect(h.shownDiagnosis()).toBe('Sign out everywhere may be incomplete');
    const linked = session('member-a', 'a2', SID_A2);
    await h.establish(linked);
    expect(h.shownDiagnosis()).toBe('Sign out everywhere may be incomplete');
    const mark = h.effects.length;
    h.held[0]!.resolve();
    await expect(late).resolves.toBeUndefined();
    await untilIdle();

    expect(h.effects.slice(mark)).toEqual([]);
    expect(h.fetchDashboard).toHaveBeenCalledTimes(1);
    expect(h.fetchDashboard).toHaveBeenLastCalledWith(linked, 'automatic', true);
    expect(h.shownDiagnosis()).toBe('Sign out everywhere may be incomplete');
    expect(h.refs.signOutErrorRef.current).toBe('Sign out everywhere may be incomplete');
  });
});

describe('a current resume still completes', () => {
  // BUG-UG-NATIVE-FORM-EDITOR-CLOSES-WHEN-THE-MEMBER-RETURNS-FROM-THE-FILE-PICKER-20261114
  // (#8724): the cause, confirmed on the provider's real resume. An ordinary
  // return to the foreground for the same member (as after the file picker or
  // a share sheet) clears the protected state, which empties the dashboard,
  // before it reads the dashboard again. For that moment no member is known.
  it('clears the protected state before reading the dashboard again for the same worker', async () => {
    const accountA = session('member-a', 'a1', SID_A1);
    const h = harness(accountA);
    const resumed = h.resume(accountA);
    await vi.waitFor(() => expect(h.held).toHaveLength(1));
    h.held[0]!.resolve();
    await resumed;
    const names = h.effects.map(([name]) => name);
    expect(names).toContain('clearProtectedState');
    expect(names.indexOf('clearProtectedState')).toBeLessThan(names.indexOf('fetchDashboard'));
    expect(h.fetchDashboard).toHaveBeenCalledWith(accountA, 'automatic', true);
  });

  it('enters the dashboard, restores the retained diagnosis and reveals', async () => {
    const accountA = session('member-a', 'a1', SID_A1);
    const h = harness(accountA);
    h.refs.signOutErrorRef.current = 'Sign out everywhere may be incomplete';
    const resumed = h.resume(accountA);
    await vi.waitFor(() => expect(h.held).toHaveLength(1));
    h.held[0]!.resolve();
    await resumed;

    expect(h.fetchDashboard).toHaveBeenCalledWith(accountA, 'automatic', true);
    const tail = h.effects.slice(h.effects.findIndex(([name]) => name === 'fetchDashboard'));
    expect(tail).toEqual([
      ['fetchDashboard', 'member-a'],
      ['setError', null], ['setAssuranceUnavailable', false], ['setMode', 'authenticated'],
      ['setSignOutErrorState', 'Sign out everywhere may be incomplete'],
      ['setPrivacyCovered', false],
    ]);
  });

  it('publishes its own recovery failure and the fail-closed retry surface', async () => {
    const accountA = session('member-a', 'a1', SID_A1);
    const h = harness(accountA);
    const resumed = h.resume(accountA);
    await vi.waitFor(() => expect(h.held).toHaveLength(1));
    h.held[0]!.reject(new Error('recovery rejected'));
    await resumed;

    expect(h.fetchDashboard).not.toHaveBeenCalled();
    expect(h.refs.signOutErrorRef.current).toBe('Attachment recovery for the original account failed');
    expect(h.refs.shareRecoveryErrorRef.current).toBeTypeOf('symbol');
    expect(h.effects).toContainEqual(['setMode', 'mfaRequired']);
    expect(h.effects).toContainEqual(['purgeSecureShareStaging', null]);
    expect(h.effects.slice(-2)).toEqual([
      ['setSignOutErrorState', 'Attachment recovery for the original account failed'],
      ['setPrivacyCovered', false],
    ]);
  });
});
