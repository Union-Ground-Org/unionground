// @vitest-environment jsdom
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { act, createElement as h, type ComponentType, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import * as resume from '../services/sessionResume';
import * as signOutFailure from '../services/signOutFailure';
import * as identity from '../lib/accountSessionIdentity';
import * as lineage from '../lib/sessionLineage';
import * as completion from '../lib/signInCompletion';
import * as authGate from '../lib/nativeAuthGate';
import * as hats from '../lib/hatFunctions';
import * as biometric from '../lib/biometricAvailability';
import * as privacy from '../lib/appStatePrivacyCover';
import * as unavailable from '../lib/sessionUnavailableCopy';
import * as resumeDraftHolder from '../lib/resumeDraftHolder';
import * as resumeDraftOwnership from '../lib/resumeDraftOwnership';
import * as readRefusal from '../lib/readRefusal';
import * as readDeadline from '../lib/readDeadline';
import type { useApp } from './AppProvider';
import { useSessionCheckRecovery } from './useSessionCheckRecovery';

// #9776 (BUG-UG-DEMO-SHELL-ROLE-MENU-STUCK-OPEN-AND-STEWARD-OPENS-IN-SPANISH-20261124):
// the demo walk of Nov 24, 2026 found the shared Steward demo account with
// Spanish saved, so every English visitor who switched to Steward got the
// whole app in Spanish, and a language chosen in the demo was saved on the
// shared account for the next visitor. The real provider and the REAL
// dashboard and profile adapters run here (harness of
// dashboardSiblingRefusal.test.ts); only the Supabase client is a stand-in.
const native = vi.hoisted(() => ({
  platform: 'android', currentState: 'active',
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return native.platform; } },
  AppState: {
    get currentState() { return native.currentState; },
    addEventListener: (_event: string, callback: (state: string) => void) => {
      native.listeners.add(callback);
      return { remove: () => native.listeners.delete(callback) };
    },
  },
}));
import * as reactNative from 'react-native';

type Reply = { data: unknown; error: unknown; status?: number };
const backend = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: {
  backendConfigured: true, supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'test-key',
} }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
// The visitor's phone speaks English.
vi.mock('../lib/storeDemoCopy', () => ({ deviceLanguage: () => 'en' }));
import { loadDashboard, loadMobileChapterMemberships, loadMobileStaffScope, updateMemberProfile } from '../services/supabase';
import { setNativeDirectAudience } from '../services/stewardDirectInbox';
import * as demoPersonaLanguage from '../lib/demoPersonaLanguage';

const source = readFileSync(resolve(process.cwd(), 'src/state/AppProvider.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
} }).outputText;
type Snapshot = ReturnType<typeof useApp>;
type ProviderModule = { AppProvider: ComponentType<PropsWithChildren>; useApp(): Snapshot };

const session: Session = {
  access_token: `header.${btoa(JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111' }))}.signature`,
  refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600,
  user: { id: 'a', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01' },
} as Session;
const otherPersona: Session = { ...session, user: { ...session.user, id: 'demo-advisor' } };
const regularAccount: Session = { ...session, user: { ...session.user, id: 'regular' } };

// The account's saved language, as member_profiles answers it.
const saved = { language: 'es' };
const PROFILE = (id: string) => ({ id, first_name: 'Dylan', full_name: 'Dylan Kowalski', initials: 'DK', role_line: 'Committee',
  member_since: '2026-01-01', chapter_id: 'chapter-a', language: saved.language });
const settledReply = (table: string, id: string): Reply => ({ data: table === 'member_profiles' ? PROFILE(id) : [], error: null, status: 200 });

// Each dashboard table answers through `answers`; a test replaces one entry
// for the next read only. A query builder is a thenable, as in postgrest-js.
const answers = new Map<string, () => Promise<Reply>>();
// RPC answers for the next call only, and the staff scope every other call returns.
const rpcAnswers = new Map<string, () => Promise<Reply>>();
const staffDefault: { value: unknown } = { value: null };
function query(table: string) {
  const builder: Record<string, unknown> = {};
  let profileID = session.user.id;
  for (const method of ['select', 'order', 'limit', 'gte', 'in', 'range', 'single', 'maybeSingle']) builder[method] = () => builder;
  builder.eq = (column: string, value: string) => {
    if (table === 'member_profiles' && column === 'id') profileID = value;
    return builder;
  };
  builder.then = (resolve: (value: Reply) => unknown, reject: (error: unknown) => unknown) => {
    const next = answers.get(table);
    answers.delete(table);
    return (next ? next() : Promise.resolve(settledReply(table, profileID))).then(resolve, reject);
  };
  return builder;
}
const after = (ms: number, reply: Reply) => () => new Promise<Reply>(done => { setTimeout(() => done(reply), ms); });
const never = () => () => new Promise<Reply>(() => undefined);

function harness(sharedDemoPerson: boolean, options: { failSwitch?: boolean; lateSignOut?: boolean } = {}) {
  const ok = vi.fn(async () => undefined);
  const stop = () => undefined;
  const reset = vi.fn();
  const prepareMySignOut = vi.fn(async () => ({ data: { serverCleanupComplete: true }, error: null }));
  let authEvent: (event: string, next: Session | null) => void = () => undefined;
  let activeSession: Session | null = null;
  let switchingPersona = false;
  const emitAuth = (event: string, next: Session | null) => {
    activeSession = next;
    authEvent(event, next);
  };
  const client = { auth: {
    getSession: vi.fn(async () => ({ data: { session: activeSession }, error: null })),
    refreshSession: async () => { emitAuth('TOKEN_REFRESHED', activeSession); return { data: { session: activeSession }, error: null }; },
    getUser: async () => ({ data: { user: activeSession?.user ?? null }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    onAuthStateChange: (callback: typeof authEvent) => { authEvent = callback; return { data: { subscription: { unsubscribe: stop } } }; },
    startAutoRefresh: stop, stopAutoRefresh: stop,
  } };
  const noIO = Object.fromEntries([
    'purgeHomeWidgets', 'suspendHomeWidgets', 'activateOfflineScope', 'purgeOfflineAvailability', 'suspendOfflineAvailability',
    'requestOfflineSignOutCleanup', 'retryPendingOfflineSignOutCleanup', 'refreshLowDataSignals',
    'purgeAttachmentCache', 'purgeAttachmentCacheForSessionLoss', 'purgeAttachmentCacheForSignOut',
    'saveBiometricLockPreference', 'preparePendingSharedAttachmentUploadForSessionEstablishment',
    'preparePendingSharedAttachmentUploadForSessionLoss', 'preparePendingSharedAttachmentUploadForSignOut', 'discardAllPendingSharedAttachments',
    'retryPendingSharedAttachmentCleanup', 'purgeQuickCaptureForUser', 'setNativeAnalyticsMember',
    'syncNativePushRegistration', 'clearLocalNotificationPreference',
    'clearNativePushPreferenceForSignOut', 'recordLifecycleEvent',
  ].map(name => [name, ok]));
  const modules: Record<string, object> = {
    react: React, 'react-native': reactNative,
    'expo-crypto': { randomUUID: () => 'test-id' },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: ok },
    '../services/sessionResume': resume,
    '../services/signOutFailure': signOutFailure,
    '../services/sessionSignOut': { prepareMySignOut },
    '../lib/accountSessionIdentity': identity,
    '../lib/sessionLineage': lineage,
    '../lib/signInCompletion': completion,
    '../lib/nativeAuthGate': authGate,
    '../lib/hatFunctions': hats,
    '../lib/biometricAvailability': biometric,
    '../lib/appStatePrivacyCover': privacy,
    '../lib/sessionUnavailableCopy': unavailable,
    '../lib/resumeDraftHolder': resumeDraftHolder,
    '../lib/resumeDraftOwnership': resumeDraftOwnership,
    '../lib/readRefusal': readRefusal,
    '../lib/readDeadline': readDeadline,
    '../lib/config': { mobileConfig: { supabaseUrl: '', previewEnabled: false } },
    '../services/backendReachability': { backendReachable: async () => true },
    '../state/useLowData': { useLowData: () => ({ mode: 'off', signals: { connected: true } }) },
    './useLowData': { useLowData: () => ({ mode: 'off', signals: { connected: true } }) },
    './useSessionCheckRecovery': { useSessionCheckRecovery },
    './useSharedDemoVisit': { useSharedDemoVisit: () => null },
    '../lib/lowDataPolicy': { pollIntervalMsFor: () => 120_000 },
    '../services/lowData': { ...noIO, startLowDataMonitoring: () => stop },
    '../services/authRefreshLifecycle': { startSupabaseAuthRefreshLifecycle: () => stop },
    '../services/accountLocalTeardown': { createAccountLocalTeardown: () => ({ retry: async () => true, request: async () => true }) },
    '../services/secureShareIntake': {
      ...noIO, ShareIntakeError: class extends Error {}, captureSecureShareCleanupBoundary: () => ({}),
      isSecureShareStagingCleanupRequired: () => false, subscribeSecureShareStagingCleanup: () => stop,
    },
    '../services/biometrics': { ...noIO, readBiometricLockPreference: async () => false, biometricsAvailable: async () => false },
    '../services/notifications': {
      ...noIO, startNativePushTokenRotationListener: () => ({ remove: stop }),
      deleteNativePushInstallationForSignOut: ok, pauseNativePushRegistration: stop, resumeNativePushRegistration: stop,
    },
    '../services/supabase': {
      captureSessionWriter: (session: Session | null) => stubSessionWriter(() => client, session?.user.id),
      getSupabaseClient: () => client, sessionNeedsMfa: async () => false,
      loadDashboard, loadMobileChapterMemberships, loadMobileStaffScope, updateMemberProfile,
      setMobileChapterPin: ok, switchMobileChapter: ok,
      loadMobileDuesContext: async () => null, readPersistedMobileSession: async () => session,
      clearCapturedMobileSessionLocally: async () => true,
      createCapturedSessionRpcClient: () => client,
      revokeAndClearCapturedMobileSession: async () => {
        activeSession = null;
        if (switchingPersona && !options.lateSignOut) emitAuth('SIGNED_OUT', null);
        return true;
      },
    },
    '../lib/duesNavigation': { loadMobileOrganizationRunsDues: async () => false },
    '../services/sampleSession': {
      isLiveSampleBackend: () => sharedDemoPerson,
      sampleHatForSession: (_config: unknown, candidate: Session | null) => {
        if (!sharedDemoPerson) return null;
        if (candidate?.user.id === session.user.id) return 'steward';
        return candidate?.user.id === otherPersona.user.id ? 'advisor' : null;
      },
      switchSampleSession: async (_config: unknown, auth: typeof client.auth, _from: string, _to: string, signOut: () => Promise<void>) => {
        const { data } = await auth.getSession();
        if (!data.session) throw new Error('The old session is absent');
        switchingPersona = true;
        try {
          await signOut();
          if (activeSession) throw new Error('The old session stayed open');
          if (options.lateSignOut) emitAuth('SIGNED_OUT', null);
          if (options.failSwitch) throw new Error('Demo handoff failed');
          emitAuth('SIGNED_IN', otherPersona);
        } finally {
          switchingPersona = false;
        }
      },
    },
    '../lib/demoPersonaLanguage': demoPersonaLanguage,
    '../services/haptics': { haptics: { success: ok, warning: ok, select: ok } },
    '../lib/storeDemo': { isStoreDemo: () => false, endStoreDemo: async () => undefined },
    '../lib/conversationUnread': { conversationUnreadStore: { reset, publish: reset, conversations: () => [] },
      createConversationUnreadPoller: () => ({ start: stop, stop, invalidate: stop, dispose: stop, setPolicy: stop }) },
    '../lib/foregroundSessionRevocationWatch': { createForegroundSessionRevocationWatch: () => ({ start: stop, stop }) },
    '../services/stewardDirectInbox': { nativeDirectAudience: () => 'member', setNativeDirectAudience: () => false, replaceDirectRows: (rows: unknown) => rows, stewardDirectRefusalEpoch: () => 0 },
    '../data/liveChannels': { liveChannelStore: { resetForSession: reset } },
    '../lib/noBackendMode': { noBackendMode: () => 'signedOut' },
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled, {
    exports, React, setTimeout, clearTimeout, setInterval, clearInterval, Date, console,
    require: (path: string) => new Proxy(modules[path] ?? noIO, {
      get: (target, key) => {
        if (key in target) return Reflect.get(target, key);
        if (key === '__esModule') return false;
        return () => { throw new Error(`Unmodelled native I/O: ${path}.${String(key)}`); };
      },
    }),
  });
  const provider = exports as ProviderModule;
  let snapshot: Snapshot;
  function Probe() {
    snapshot = provider.useApp();
    return h('output', null, `${snapshot.mode}:${snapshot.dashboard?.member.id ?? 'empty'}`);
  }
  return { provider, Probe, snapshot: () => snapshot!, authEvent: emitAuth, prepareMySignOut, getSession: client.auth.getSession };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  answers.clear();
  rpcAnswers.clear();
  staffDefault.value = { organizationId: 'org-a', roles: [], chapterRoles: [], staffAuthorized: false };
  setNativeDirectAudience('member');
  backend.from.mockReset();
  backend.from.mockImplementation(query);
  backend.rpc.mockReset();
  backend.rpc.mockImplementation(async (name: string) => {
    const once = rpcAnswers.get(name);
    if (once) { rpcAnswers.delete(name); return once(); }
    if (name === 'get_my_mobile_staff_scope') return { data: staffDefault.value, error: null, status: 200 };
    if (name === 'list_steward_conversations') return { data: [], error: null, status: 200 };
    if (name === 'get_my_chapter_memberships') return { data: [{ chapterId: 'chapter-a', organizationId: 'org-a', name: 'Campaign A', joinedAt: '2026-01-01', selected: true, pinned: false, roles: [] }], error: null, status: 200 };
    if (name === 'get_my_case_ulp_summary') return { data: [], error: null, status: 200 };
    throw new Error(`Unexpected RPC: ${name}`);
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.listeners.clear(); native.currentState = 'active';
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });


beforeEach(() => { demoPersonaLanguage.resetDemoVisitorLanguage(); saved.language = 'es'; });

// The platform comes from the enclosing describe.each.
async function signedIn(sharedDemoPerson: boolean, options?: Parameters<typeof harness>[1]) {
  const f = harness(sharedDemoPerson, options);
  await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
  await act(async () => { f.authEvent('SIGNED_IN', session); await vi.advanceTimersByTimeAsync(0); });
  expect(f.snapshot().dashboard?.member.id).toBe('a');
  const refresh = async () => {
    await act(async () => { await f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
  };
  const profileWrites = () => backend.rpc.mock.calls.filter(([name]) => name === 'update_my_member_profile');
  const chooseSpanish = async () => {
    await act(async () => {
      await f.snapshot().saveProfile({ firstName: 'Dylan', fullName: 'Dylan Kowalski', language: 'es' });
    });
    expect(f.snapshot().memberLanguage).toBe('es');
  };
  const enter = (candidate: Session) => act(async () => {
    f.authEvent('SIGNED_IN', candidate);
    await vi.advanceTimersByTimeAsync(0);
  });
  return { f, refresh, profileWrites, chooseSpanish, enter };
}

describe.each(['ios', 'android'])('a shared demo person on %s', (platform) => {
  beforeEach(() => {
    native.platform = platform;
    rpcAnswers.set('update_my_member_profile', async () => ({ data: null, error: null, status: 200 }));
  });

  it('shows the visitor\'s language, not the Spanish the shared Committee account has saved', async () => {
    expect(reactNative.Platform.OS).toBe(platform);
    const t = await signedIn(true);
    expect(reactNative.Platform.OS).toBe(platform);
    expect(t.f.snapshot().memberLanguage).toBe('en');
    expect(t.f.snapshot().dashboard?.member.language).toBe('en');
  });

  it('keeps a language chosen in the demo on this phone, never on the shared account, across a fresh read', async () => {
    const t = await signedIn(true);
    let proof: unknown;
    await act(async () => { proof = await t.f.snapshot().saveProfile({ firstName: 'Dylan', fullName: 'Dylan Kowalski', language: 'es' }); });
    expect(proof).toBe('current');
    expect(t.profileWrites()).toHaveLength(0);
    expect(t.f.snapshot().memberLanguage).toBe('es');
    expect(t.f.snapshot().dashboard?.member.language).toBe('es');
    // The next persona read (a role switch reads the dashboard again) has
    // English saved; the visitor's Spanish carries over.
    saved.language = 'en';
    await t.refresh();
    expect(t.f.snapshot().memberLanguage).toBe('es');
    expect(t.f.snapshot().dashboard?.member.language).toBe('es');
  });

  it('forgets the chosen language after an in-app sign-out', async () => {
    const t = await signedIn(true);
    await t.chooseSpanish();
    await act(async () => { await t.f.snapshot().signOut(); });
    expect(t.f.snapshot().signOutError).toBeNull();
    expect(t.f.snapshot().mode).toBe('signedOut');
    await t.enter(otherPersona);
    expect(t.f.snapshot().sampleHat).toBe('advisor');
    expect(t.f.snapshot().memberLanguage).toBe('en');
  });

  it('forgets the choice after signing out everywhere', async () => {
    const t = await signedIn(true);
    await t.chooseSpanish();
    await act(async () => { await t.f.snapshot().signOut({ scope: 'global' }); });
    expect(t.f.snapshot().signOutError).toBeNull();
    expect(t.f.snapshot().mode).toBe('signedOut');
    await t.enter(otherPersona);
    expect(t.f.snapshot().memberLanguage).toBe('en');
  });

  it('forgets the chosen language after losing the session', async () => {
    const t = await signedIn(true);
    await t.chooseSpanish();
    await act(async () => { t.f.authEvent('SIGNED_OUT', null); });
    expect(t.f.snapshot().mode).toBe('signedOut');
    await t.enter(otherPersona);
    expect(t.f.snapshot().memberLanguage).toBe('en');
  });

  it('forgets the chosen language when a regular account replaces the demo', async () => {
    const t = await signedIn(true);
    await t.chooseSpanish();
    await t.enter(regularAccount);
    expect(t.f.snapshot().dashboard?.member.id).toBe(regularAccount.user.id);
    expect(t.f.snapshot().sampleHat).toBeNull();
    expect(t.f.snapshot().memberLanguage).toBe('es');
    await t.enter(otherPersona);
    expect(t.f.snapshot().memberLanguage).toBe('en');
  });

  it('keeps the choice across the sign-out gap in a demo persona switch', async () => {
    const t = await signedIn(true);
    await t.chooseSpanish();
    await act(async () => { await t.f.snapshot().switchSampleHat('advisor'); await vi.advanceTimersByTimeAsync(0); });
    expect(t.f.snapshot().sampleHat).toBe('advisor');
    expect(t.f.snapshot().memberLanguage).toBe('es');
    expect(t.profileWrites()).toHaveLength(0);
  });

  it('keeps the choice if Auth reports the old session gone after the switch sign-out resolves', async () => {
    const t = await signedIn(true, { lateSignOut: true });
    await t.chooseSpanish();
    await act(async () => { await t.f.snapshot().switchSampleHat('advisor'); await vi.advanceTimersByTimeAsync(0); });
    expect(t.f.snapshot().sampleHat).toBe('advisor');
    expect(t.f.snapshot().memberLanguage).toBe('es');
  });

  it.each(['before the role-switch tap', 'during the initial Auth read'])('stays silent when sign-out starts %s', async (timing) => {
    const t = await signedIn(true);
    await t.chooseSpanish();
    let switchError: unknown;
    const switchRole = () => t.f.snapshot().switchSampleHat('advisor').catch((error: unknown) => { switchError = error; });
    let switchAttempt: Promise<void> | undefined;
    let finishRead!: () => void;
    if (timing === 'during the initial Auth read') {
      t.f.getSession.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { finishRead = resolve; });
        return { data: { session: null }, error: null };
      });
      await act(async () => { switchAttempt = switchRole(); });
      expect(finishRead).toBeTypeOf('function');
    }
    let release!: () => void;
    t.f.prepareMySignOut.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { data: { serverCleanupComplete: true }, error: null };
    });
    let signOut!: Promise<void>;
    await act(async () => { signOut = t.f.snapshot().signOut(); });
    expect(t.f.prepareMySignOut).toHaveBeenCalledOnce();
    let visibleError: string | null = null;
    try {
      await act(async () => {
        if (switchAttempt) finishRead();
        await (switchAttempt ?? switchRole());
      });
      visibleError = t.f.snapshot().error;
    } finally {
      await act(async () => { release(); await signOut; });
    }
    expect(switchError).toBeUndefined();
    expect(visibleError).toBeNull();
    expect(t.f.snapshot().mode).toBe('signedOut');
    await t.enter(otherPersona);
    expect(t.f.snapshot().memberLanguage).toBe('en');
  });

  it('forgets the choice if the old demo session ends and the next persona cannot open', async () => {
    const t = await signedIn(true, { failSwitch: true });
    await t.chooseSpanish();
    await act(async () => { await expect(t.f.snapshot().switchSampleHat('advisor')).rejects.toThrow('The demo is unavailable.'); });
    expect(t.f.snapshot().mode).toBe('signedOut');
    await t.enter(otherPersona);
    expect(t.f.snapshot().memberLanguage).toBe('en');
  });

  it('saves a name change with the account\'s own language, and still shows the visitor\'s', async () => {
    const t = await signedIn(true);
    await act(async () => { await t.f.snapshot().saveProfile({ firstName: 'Dyl', fullName: 'Dylan Kowalski', language: 'en' }); });
    expect(t.profileWrites()).toHaveLength(1);
    expect(t.profileWrites()[0]?.[1]).toMatchObject({ p_fields: { first_name: 'Dyl', language: 'es' } });
    expect(t.f.snapshot().memberLanguage).toBe('en');
  });

  it('leaves an account of its own on its saved language and saves its choice', async () => {
    const t = await signedIn(false);
    expect(t.f.snapshot().memberLanguage).toBe('es');
    await act(async () => { await t.f.snapshot().saveProfile({ firstName: 'Dylan', fullName: 'Dylan Kowalski', language: 'en' }); });
    expect(t.profileWrites()).toHaveLength(1);
    expect(t.profileWrites()[0]?.[1]).toMatchObject({ p_fields: { language: 'en' } });
  });
});
