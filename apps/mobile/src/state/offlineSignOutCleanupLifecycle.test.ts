import type { Session } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  purgeNotes: vi.fn(async (): Promise<void> => undefined),
  purgePublic: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock('../services/offlineAvailability', () => ({
  purgeOfflineAvailability: stores.purgeNotes, suspendOfflineAvailability: vi.fn(),
}));
vi.mock('../services/publicLearningDownloads', () => ({ purgePublicLearningForSignOut: stores.purgePublic }));
vi.mock('../services/optionalFileSystem', () => ({ loadFileSystem: () => null }));

// Run the provider's actual bootstrap, signed-out effect and foreground
// callback with the real cleanup queue. In particular, a failed device read
// must not turn a still-persisted session into permission to erase its notes.
const provider = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('AppProvider.tsx', provider, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let bootstrapSource = '';
let signedOutSource = '';
let foregroundSource = '';
(function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect') {
    const callback = node.arguments[0]?.getText(tree) ?? '';
    if (callback.includes('const coldSessionRead =')) bootstrapSource = callback;
    if (callback.includes("if (mode !== 'signedOut') return;")) signedOutSource = callback;
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'onAppState' && node.initializer) {
    foregroundSource = node.initializer.getText(tree);
  }
  ts.forEachChild(node, visit);
})(tree);
if (!bootstrapSource || !signedOutSource || !foregroundSource) throw new Error('Provider cleanup lifecycle was not found');
const compile = (source: string) => ts.transpile(`(${source})`, { target: ts.ScriptTarget.ES2022 });

type BootstrapOutcome = 'absent' | 'biometric preference error' | 'biometric availability error' | 'auth read error' | 'unavailable storage';
type RetryEntry = 'signed-out effect' | 'foreground';

async function harness(outcome: BootstrapOutcome) {
  const cleanup = await import('../services/offlineSignOutCleanup');
  const storedSession = { user: { id: 'member-with-saved-notes' } } as Session;
  const sessionRead = Promise.resolve({
    data: { session: outcome === 'absent' ? null : storedSession },
    error: outcome === 'auth read error' ? new Error('secure storage unavailable') : null,
  });
  const sessionTransition = { current: 0 };
  const env: Record<string, unknown> = {
    ...cleanup,
    mode: 'booting', session: null, sessionTransition,
    confirmedAbsentSessionTransition: { current: null as number | null },
    activeUserID: { current: null as string | null }, observedAuthIdentity: { current: null },
    biometricLockEnabledRef: { current: false },
    getSupabaseClient: () => ({ auth: {
      getSession: () => sessionRead,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    } }),
    sessionResumeAttempts: { begin: vi.fn(), finish: vi.fn() },
    sessionResumeGuard: { invalidate: vi.fn() }, dashboardRequest: { current: 0 },
    pendingAuthTransition: { current: null }, sessionRetryOwner: { current: null },
    startSupabaseAuthRefreshLifecycle: () => vi.fn(),
    readBiometricLockPreference: async () => {
      if (outcome === 'biometric preference error') throw new Error('biometric preference unavailable');
      return false;
    },
    biometricsAvailable: async () => {
      if (outcome === 'biometric availability error') throw new Error('biometric hardware unavailable');
      return false;
    },
    boundColdSessionRead: async () => outcome === 'unavailable storage'
      ? { status: 'unavailable' } : { status: 'settled', value: await sessionRead },
    readPersistedMobileSession: vi.fn(async () => { throw new Error('secure storage unavailable'); }),
    authIdentityFor: (value: Session) => ({ userID: value.user.id }),
    revalidateAuthenticatedSession: vi.fn(async () => undefined),
    setMode: (value: string) => { env.mode = value; },
    setBiometricAvailable: vi.fn(), setBiometricLockEnabled: vi.fn(), setLocked: vi.fn(),
    setSession: vi.fn(), setError: vi.fn(), setAssuranceUnavailable: vi.fn(),
    setSignOutError: vi.fn(),
    accountLocalTeardown: { retry: async () => true },
    // Unprotected foreground work is unrelated to offline note deletion.
    observedAppState: { current: 'active' }, deletionReceipt: { current: false },
    backgroundedAt: { current: null },
    refreshLowDataSignals: async () => undefined,
    purgeAttachmentCache: async () => true,
    isSecureShareStagingCleanupRequired: () => false,
    biometricAvailabilityRefreshDue: () => false,
    biometricLockEnabled: false,
  };
  const bootstrap = runInNewContext(compile(bootstrapSource), env) as () => () => void;
  const stop = bootstrap();
  await vi.waitFor(() => expect(env.mode).toBe('signedOut'));
  return {
    sessionTransition, stop,
    async retry(entry: RetryEntry) {
      if (entry === 'signed-out effect') {
        const effect = runInNewContext(compile(signedOutSource), env) as () => () => void;
        effect();
      } else {
        const foreground = runInNewContext(compile(foregroundSource), env) as (next: string) => void;
        foreground('active');
      }
      // A default retry queues behind the provider's retry and exposes its
      // settlement, without itself authorizing a marker-free purge.
      await cleanup.retryPendingOfflineSignOutCleanup();
    },
  };
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe('marker-free cleanup requires confirmed session absence', () => {
  const entries: RetryEntry[] = ['signed-out effect', 'foreground'];
  const failures: BootstrapOutcome[] = [
    'biometric preference error', 'biometric availability error', 'auth read error', 'unavailable storage',
  ];
  for (const entry of entries) {
    it.each(failures)(`preserves notes after %s through ${entry}`, async (outcome) => {
      const h = await harness(outcome);
      await h.retry(entry);
      expect(stores.purgeNotes).not.toHaveBeenCalled();
      expect(stores.purgePublic).not.toHaveBeenCalled();
      h.stop();
    });
    it(`cleans a confirmed session-free cold launch through ${entry}`, async () => {
      const h = await harness('absent');
      await h.retry(entry);
      expect(stores.purgeNotes).toHaveBeenCalledOnce();
      expect(stores.purgePublic).toHaveBeenCalledOnce();
      h.stop();
    });
    it(`retires cold absence authority after a newer transition through ${entry}`, async () => {
      const h = await harness('absent');
      h.sessionTransition.current += 1;
      await h.retry(entry);
      expect(stores.purgeNotes).not.toHaveBeenCalled();
      h.stop();
    });
  }
});
