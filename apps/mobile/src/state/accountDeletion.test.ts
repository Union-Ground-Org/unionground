import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createNativeAuthGate } from '../lib/nativeAuthGate';

const source = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('AppProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = '';
let authCallback = '';
let appStateCallback = '';
let acknowledgeCallback = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'deleteAccount' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]!.getText(tree);
  if (ts.isCallExpression(node) && node.expression.getText(tree).endsWith('.onAuthStateChange')) authCallback = node.arguments[0]!.getText(tree);
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'onAppState' && node.initializer) appStateCallback = node.initializer.getText(tree);
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'acknowledgeDeletion' && node.initializer && ts.isCallExpression(node.initializer)) acknowledgeCallback = node.initializer.arguments[0]!.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
const compiled = ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 });
function fixture() {
  const session = { user: { id: 'departing' }, access_token: 'token', refresh_token: 'refresh' };
  const env = {
    sessionBootstrapDeadline: { current: 10_000 }, SESSION_BOOTSTRAP_DEADLINE_MS: 10_000,
    sessionRetryOwner: { current: null }, setSessionRetryInFlight: vi.fn(),
    Error, mode: 'authenticated', session, mobileConfig: {}, sampleHatForSession: () => null,
    sessionRestricted: false, memberLanguage: 'en', deletedSessionID: { current: null }, sessionIDFromAccessToken: () => null, deletedUserID: { current: null as string | null }, deletionSession: { current: null }, deletionReceipt: { current: false },
    signOutInFlight: { current: false }, deletionCleanupAction: { current: async () => {} },
    observedAuthIdentity: { current: { userID: 'departing', accessToken: 'token' } as { userID: string; accessToken: string } | null },
    deleteMobileAccount: vi.fn(async () => ({ deleted: true, audited: true })), accessTokensShareSessionLineage: () => false,
    setDeletionOutcome: vi.fn(), setDeletionCleanup: vi.fn(), sessionTransition: { current: 1 },
    sessionResumeGuard: { invalidate: vi.fn() }, nativeAuthGate: { cancel: vi.fn(), observe: vi.fn(() => true), isStaged: vi.fn(() => false), isBusy: () => false }, pendingAuthTransition: { current: null },
    observedAppState: { current: 'active' }, backgroundedAt: { current: null }, dashboardRequest: { current: 0 },
    shouldCoverOnAppState: () => true,
    clearProtectedState: vi.fn(), activeUserID: { current: 'departing' as string | null },
    setSession: vi.fn(), setPreviewHat: vi.fn(), setPreviewShellState: vi.fn(), setPreviewDesk: vi.fn(), setPreviewThreads: vi.fn(), previewStore: { current: {} },
    setWidgetLayouts: vi.fn(), setLocked: vi.fn(), setPrivacyCovered: vi.fn(), setMode: vi.fn(),
    getSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
    clearCapturedMobileSessionLocally: vi.fn(async () => true), accountLocalTeardown: { request: vi.fn(async (_userID: string, _isCurrent: () => boolean) => true) },
    requestOfflineSignOutCleanup: vi.fn(async () => {}), purgeAttachmentCacheForSessionLoss: vi.fn(async () => true),
    discardAllPendingSharedAttachments: vi.fn(async () => {}), clearLocalNotificationPreference: vi.fn(async () => {}),
    sessionSignOutAttempts: { observe: () => ({ status: 'handle' }) },
    sessionResumeAttempts: { observe: () => ({ status: 'handle', interrupted: false }) },
    captureSecureShareCleanupBoundary: vi.fn(), authIdentityFor: (value: unknown) => value,
    liveChannelStore: { resetForSession: vi.fn() }, conversationUnreadStore: { reset: vi.fn() },
    purgeSecureShareStaging: vi.fn(async () => {}), suspendOfflineAvailability: vi.fn(), setOfflineDraftsReady: vi.fn(),
    shareIsolationBlocked: { current: false }, blockedShareIsolation: { current: null },
    setDashboard: vi.fn(), setMemberLanguage: vi.fn(), setChapterMemberships: vi.fn(), setOrganizationStaffScope: vi.fn(), setDuesContext: vi.fn(),
    setAssuranceUnavailable: vi.fn(), setSignOutError: vi.fn(), setError: vi.fn(),
  };
  return { env, run: runInNewContext(compiled, env) as (confirmation: string) => Promise<void> };
}

describe('native account deletion lifecycle', () => {
  it.each([true, false])('retains completion after early auth loss; audited=%s', async audited => {
    const f = fixture();
    f.env.deleteMobileAccount.mockImplementation(async () => { f.env.observedAuthIdentity.current = null; return { deleted: true, audited }; });
    await f.run('DELETE MY ACCOUNT');
    expect(f.env.setDeletionOutcome).toHaveBeenCalledWith({ audited, uncertain: false, language: 'en' });
    expect(f.env.clearProtectedState).toHaveBeenCalledOnce();
    expect(f.env.setSession).toHaveBeenCalledWith(null);
    expect(f.env.clearCapturedMobileSessionLocally).toHaveBeenCalledWith(f.env.session);
    expect(f.env.setDeletionCleanup).toHaveBeenLastCalledWith('done');
    expect(f.env.setMode).toHaveBeenLastCalledWith('signedOut');
  });
  it('does not turn an indeterminate response into deletion success', async () => {
    const f = fixture(); f.env.deleteMobileAccount.mockRejectedValue(new Error('account-delete-indeterminate'));
    await f.run('DELETE MY ACCOUNT');
    expect(f.env.setDeletionOutcome).toHaveBeenCalledWith({ audited: false, uncertain: true, language: 'en' });
  });
  it('does not clear a replacement account or publish stale completion', async () => {
    const f = fixture(); f.env.deleteMobileAccount.mockImplementation(async () => {
      f.env.observedAuthIdentity.current = { userID: 'replacement', accessToken: 'new' }; return { deleted: true, audited: true };
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.env.setDeletionOutcome).not.toHaveBeenCalled(); expect(f.env.clearCapturedMobileSessionLocally).not.toHaveBeenCalled();
  });
  it('retains a local cleanup failure and retries without deleting again', async () => {
    const f = fixture(); f.env.clearCapturedMobileSessionLocally.mockRejectedValueOnce(new Error('storage'));
    await f.run('DELETE MY ACCOUNT');
    expect(f.env.setDeletionCleanup).toHaveBeenLastCalledWith('failed');
    await f.env.deletionCleanupAction.current();
    expect(f.env.deleteMobileAccount).toHaveBeenCalledOnce(); expect(f.env.setDeletionCleanup).toHaveBeenLastCalledWith('done');
  });
  it.each(['inactive', 'background'])('finishes credential cleanup after the app becomes %s', async next => {
    const f = fixture();
    let finish!: (clean: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.env.clearCapturedMobileSessionLocally.mockImplementation(() => {
      entered();
      return new Promise<boolean>(resolve => { finish = resolve; });
    });
    const pending = f.run('DELETE MY ACCOUNT');
    await started;
    const onAppState = runInNewContext(ts.transpile(`(${appStateCallback})`, { target: ts.ScriptTarget.ES2022 }), f.env) as (state: string) => void;
    onAppState(next);
    finish(true);
    await pending;
    expect(f.env.setDeletionCleanup).toHaveBeenLastCalledWith('done');
    expect(f.env.accountLocalTeardown.request).toHaveBeenCalledOnce();
    expect(f.env.purgeAttachmentCacheForSessionLoss).toHaveBeenCalledOnce();
    expect(f.env.deleteMobileAccount).toHaveBeenCalledOnce();
    expect(f.env.setPrivacyCovered).not.toHaveBeenCalledWith(true);
    expect(f.env.setLocked).not.toHaveBeenCalledWith(true);
  });
  it('does not cover or lock completion on foreground even through a stale signed-in AppState handler', async () => {
    const f = fixture();
    await f.run('DELETE MY ACCOUNT');
    const env = {
      ...f.env, biometricLockEnabled: true, lockAfterMilliseconds: 0,
      refreshLowDataSignals: vi.fn(), retryPendingOfflineSignOutCleanup: vi.fn(async () => {}),
      purgeAttachmentCache: vi.fn(async () => {}), isSecureShareStagingCleanupRequired: () => false,
      biometricAvailabilityRefreshDue: () => false, resumeAuthenticatedSession: vi.fn(),
      deferredForegroundResume: { current: false },
    };
    const onAppState = runInNewContext(ts.transpile(`(${appStateCallback})`, { target: ts.ScriptTarget.ES2022 }), env) as (state: string) => void;
    onAppState('background');
    onAppState('active');
    expect(f.env.setPrivacyCovered).not.toHaveBeenCalledWith(true);
    expect(f.env.setLocked).not.toHaveBeenCalledWith(true);
    expect(env.resumeAuthenticatedSession).not.toHaveBeenCalled();
  });
  it('retires acknowledged deletion and accepts an explicit same-session sign-in after an uncertain result', async () => {
    const f = fixture();
    f.env.deleteMobileAccount.mockRejectedValue(new Error('account-delete-indeterminate'));
    let staleCleanup: (() => Promise<void>) | undefined;
    f.env.accountLocalTeardown.request.mockImplementation(async () => {
      staleCleanup = f.env.deletionCleanupAction.current;
      return true;
    });
    await f.run('DELETE MY ACCOUNT');
    const acknowledge = runInNewContext(ts.transpile(`(${acknowledgeCallback})`, { target: ts.ScriptTarget.ES2022 }), {
      ...f.env, deletionCleanup: 'done',
    }) as () => void;
    acknowledge();
    expect(f.env.deletionReceipt.current).toBe(false);
    expect(f.env.deletedUserID.current).toBeNull();
    expect(f.env.deletedSessionID.current).toBeNull();
    expect(f.env.deletionSession.current).toBeNull();
    const cleanupCalls = f.env.clearCapturedMobileSessionLocally.mock.calls.length;
    await f.env.deletionCleanupAction.current();
    await staleCleanup?.();
    expect(f.env.clearCapturedMobileSessionLocally).toHaveBeenCalledTimes(cleanupCalls);
    const schedule = vi.fn();
    const listener = runInNewContext(ts.transpile(`(${authCallback})`, { target: ts.ScriptTarget.ES2022 }), {
      ...f.env, active: true, setTimeout: schedule,
    }) as (event: string, session: typeof f.env.session) => void;
    listener('SIGNED_IN', f.env.session);
    expect(schedule).toHaveBeenCalledOnce();
    expect(f.env.observedAuthIdentity.current).toEqual(f.env.session);
  });
  it('ignores a biometric lock decision that finishes after deletion is published', async () => {
    const f = fixture();
    let finish!: () => void;
    const probe = new Promise<void>(resolve => { finish = resolve; });
    f.env.observedAppState.current = 'background';
    const env = {
      ...f.env, biometricLockEnabled: false, lockAfterMilliseconds: 0,
      refreshLowDataSignals: vi.fn(), retryPendingOfflineSignOutCleanup: vi.fn(async () => {}),
      purgeAttachmentCache: vi.fn(async () => {}), isSecureShareStagingCleanupRequired: () => false,
      biometricAvailabilityRefreshDue: () => true, refreshBiometricAvailability: () => probe,
      foregroundLockAfterRefresh: () => 'lock', resumeAuthenticatedSession: vi.fn(),
      deferredForegroundResume: { current: false },
    };
    const onAppState = runInNewContext(ts.transpile(`(${appStateCallback})`, { target: ts.ScriptTarget.ES2022 }), env) as (state: string) => void;
    onAppState('active');
    await f.run('DELETE MY ACCOUNT');
    finish();
    await probe;
    expect(f.env.setLocked).not.toHaveBeenCalledWith(true);
  });
  it.each(['pending', 'failed'])('keeps the deletion fence when acknowledging %s cleanup', async deletionCleanup => {
    const f = fixture();
    await f.run('DELETE MY ACCOUNT');
    const acknowledge = runInNewContext(ts.transpile(`(${acknowledgeCallback})`, { target: ts.ScriptTarget.ES2022 }), {
      ...f.env, deletionCleanup,
    }) as () => void;
    acknowledge();
    expect(f.env.deletionReceipt.current).toBe(true);
    expect(f.env.deletedUserID.current).toBe('departing');
    expect(f.env.setDeletionOutcome).not.toHaveBeenCalledWith(null);
  });
  it('finishes cleanup after a null-session auth meeting and a later transition', async () => {
    const f = fixture();
    let finish!: (clean: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.env.clearCapturedMobileSessionLocally.mockImplementation(() => {
      entered();
      return new Promise<boolean>(resolve => { finish = resolve; });
    });
    const pending = f.run('DELETE MY ACCOUNT');
    await started;
    const listener = runInNewContext(ts.transpile(`(${authCallback})`, { target: ts.ScriptTarget.ES2022 }), { ...f.env, active: true }) as (event: string, session: null) => void;
    listener('SIGNED_OUT', null);
    f.env.sessionTransition.current += 1;
    finish(true);
    await pending;
    expect(f.env.setDeletionCleanup).toHaveBeenLastCalledWith('done');
    expect(f.env.setDeletionOutcome).not.toHaveBeenCalledWith(null);
  });
  it('retries a cleanup failure after backgrounding without another deletion', async () => {
    const f = fixture();
    f.env.clearCapturedMobileSessionLocally.mockRejectedValueOnce(new Error('storage'));
    await f.run('DELETE MY ACCOUNT');
    const onAppState = runInNewContext(ts.transpile(`(${appStateCallback})`, { target: ts.ScriptTarget.ES2022 }), f.env) as (state: string) => void;
    onAppState('background');
    await f.env.deletionCleanupAction.current();
    expect(f.env.clearCapturedMobileSessionLocally).toHaveBeenCalledTimes(2);
    expect(f.env.setDeletionCleanup).toHaveBeenLastCalledWith('done');
    expect(f.env.deleteMobileAccount).toHaveBeenCalledOnce();
  });
  it('keeps cache cleanup owned across a later background transition', async () => {
    const f = fixture();
    f.env.accountLocalTeardown.request.mockImplementation(async () => {
      f.env.sessionTransition.current += 1;
      return true;
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.env.setDeletionCleanup).toHaveBeenLastCalledWith('done');
    const isCurrent = f.env.accountLocalTeardown.request.mock.calls[0]?.[1] as (() => boolean) | undefined;
    expect(isCurrent?.()).toBe(true);
  });
  it('stops local cache cleanup as soon as an accepted replacement retires the deletion receipt', async () => {
    const f = fixture();
    f.env.clearCapturedMobileSessionLocally.mockImplementation(async () => {
      const listener = runInNewContext(ts.transpile(`(${authCallback})`, { target: ts.ScriptTarget.ES2022 }), {
        ...f.env, active: true, setTimeout: vi.fn(),
      }) as (event: string, session: { user: { id: string }; access_token: string }) => void;
      listener('SIGNED_IN', { user: { id: 'replacement' }, access_token: 'new-token' });
      // Adoption is deferred until Auth's lock is released. The receipt must
      // already cancel stale cleanup while activeUserID is still null.
      expect(f.env.activeUserID.current).toBeNull();
      expect(f.env.setDeletionOutcome).toHaveBeenLastCalledWith(null);
      return false;
    });
    await f.run('DELETE MY ACCOUNT');
    expect(f.env.accountLocalTeardown.request).not.toHaveBeenCalled();
    expect(f.env.setDeletionCleanup).not.toHaveBeenCalledWith('done');
  });
  it('preserves the account after a definite refusal', async () => {
    const f = fixture(); f.env.deleteMobileAccount.mockRejectedValue(new Error('not-permitted'));
    await expect(f.run('DELETE MY ACCOUNT')).rejects.toThrow('not-permitted');
    expect(f.env.clearProtectedState).not.toHaveBeenCalled(); expect(f.env.setDeletionOutcome).not.toHaveBeenCalled();
  });
  it('refuses a duplicate submit while the first request is pending', async () => {
    const f = fixture(); let release!: () => void;
    f.env.deleteMobileAccount.mockImplementation(() => new Promise(resolve => { release = () => resolve({ deleted: true, audited: true }); }));
    const pending = f.run('DELETE MY ACCOUNT'); await expect(f.run('DELETE MY ACCOUNT')).rejects.toThrow('not-permitted');
    release(); await pending; expect(f.env.deleteMobileAccount).toHaveBeenCalledOnce();
  });
  it('ignores late auth refreshes for the deleted identity', () => {
    const f = fixture(); f.env.deletionReceipt.current = true; f.env.deletedUserID.current = 'departing';
    Object.assign(f.env.deletionSession, { current: f.env.session });
    const env = { ...f.env, active: true };
    const listener = runInNewContext(ts.transpile(`(${authCallback})`, { target: ts.ScriptTarget.ES2022 }), env);
    listener('TOKEN_REFRESHED', f.env.session);
    expect(f.env.setSession).not.toHaveBeenCalled(); expect(f.env.setDeletionOutcome).not.toHaveBeenCalled();
  });
  it.each(['rejected', 'staged'])('keeps the deletion fence for a %s native auth meeting', kind => {
    const f = fixture();
    const gate = createNativeAuthGate();
    const replacement = { user: { id: 'replacement' }, access_token: `e30.${Buffer.from(JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111' })).toString('base64url')}.test` };
    const operation = gate.begin(null);
    operation.stage(replacement);
    if (kind === 'rejected') { gate.cancel(); operation.finish(); }
    f.env.deletionReceipt.current = true;
    f.env.deletedUserID.current = 'departing';
    const listener = runInNewContext(ts.transpile(`(${authCallback})`, { target: ts.ScriptTarget.ES2022 }), { ...f.env, active: true, nativeAuthGate: gate }) as (event: string, session: typeof replacement) => void;
    listener('SIGNED_IN', replacement);
    expect(f.env.deletionReceipt.current).toBe(true);
    expect(f.env.deletedUserID.current).toBe('departing');
    expect(f.env.setDeletionOutcome).not.toHaveBeenCalled();
    expect(f.env.setSession).not.toHaveBeenCalled();
  });
});
