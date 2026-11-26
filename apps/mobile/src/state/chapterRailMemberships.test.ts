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
import { beginNoticeSend, readPendingNoticeSend, retirePendingNoticeSends, updateNoticeSend } from '../features/noticePendingSend';
import * as readRefusal from '../lib/readRefusal';
import * as readDeadline from '../lib/readDeadline';
import type { useApp } from './AppProvider';
import { useSessionCheckRecovery } from './useSessionCheckRecovery';
import { useSharedDemoVisit } from './useSharedDemoVisit';

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
import * as standIn from '../testing/reactNativeStandIn';
import { loadMobileChapterMemberships, loadMobileStaffScope } from '../services/supabase';
import { resolveTheme, minimumTouchTarget } from '../theme/tokens';
import { typeface } from '../theme/typeface';

// Mount the actual provider, including its auth callback, effects and context.
// Native I/O is substituted at the CommonJS import boundary, as the existing
// provider tests substitute callback dependencies through node:vm. React and
// session ownership/revalidation are real; no backend URL can be contacted.
const backend = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: {
  backendConfigured: true, supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'test-key',
} }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

const source = readFileSync(resolve(process.cwd(), 'src/state/AppProvider.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
} }).outputText;
type Snapshot = ReturnType<typeof useApp>;
type ProviderModule = { AppProvider: ComponentType<PropsWithChildren>; useApp(): Snapshot };

function session(userID: string, sid = userID === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'): Session {
  return {
    access_token: `header.${btoa(JSON.stringify({ session_id: sid }))}.signature`,
    refresh_token: `test-refresh-${sid}`, token_type: 'bearer', expires_in: 3600,
    user: { id: userID, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01' },
  } as Session;
}

type HarnessOptions = {
  conversations?: unknown[];
  activateOfflineScope?: () => Promise<unknown>;
  refusalEpoch?: () => number;
  realStaff?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const ok = vi.fn(async () => undefined);
  const stop = () => undefined;
  const reset = vi.fn();
  const server = { session: session('a'), available: false };
  let authEvent: (event: string, next: Session | null) => void = () => undefined;
  const oldChecks: Array<(requiresMfa: boolean) => void> = [];
  const sessionNeedsMfa = vi.fn(() => new Promise<boolean>((resolve) => { oldChecks.push(resolve); }));
  const refreshSession = vi.fn(async () => {
    if (!server.available) throw new TypeError('Local simulated outage');
    authEvent('TOKEN_REFRESHED', server.session);
    return { data: { session: server.session }, error: null };
  });
  const getUser = vi.fn(async () => ({ data: { user: server.session.user }, error: null }));
  const client = { auth: {
    getSession: async () => ({ data: { session: null }, error: null }), refreshSession,
    getUser,
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    onAuthStateChange: (callback: typeof authEvent) => { authEvent = callback; return { data: { subscription: { unsubscribe: stop } } }; },
    startAutoRefresh: stop, stopAutoRefresh: stop,
  } };
  const loadDashboard = vi.fn(async (userID: string) => ({
    member: { id: userID, language: 'en', chapterId: `chapter-${userID}` }, conversations: options.conversations ?? [],
    notifications: [], cases: [], actionLog: [],
  }));
  const loadStaffScope = vi.fn(async () => ({ organizationID: `org-${server.session.user.id}`, roles: [], chapterRoles: [], staffAuthorized: false }));
  const activateOfflineScope = vi.fn(async () => undefined);
  const noIO = Object.fromEntries([
    'purgeHomeWidgets', 'suspendHomeWidgets', 'activateOfflineScope', 'purgeOfflineAvailability', 'suspendOfflineAvailability',
    'requestOfflineSignOutCleanup', 'retryPendingOfflineSignOutCleanup', 'refreshLowDataSignals',
    'purgeAttachmentCache', 'purgeAttachmentCacheForSessionLoss', 'purgeAttachmentCacheForSignOut',
    'saveBiometricLockPreference', 'preparePendingSharedAttachmentUploadForSessionEstablishment',
    'preparePendingSharedAttachmentUploadForSessionLoss', 'discardAllPendingSharedAttachments',
    'retryPendingSharedAttachmentCleanup', 'purgeQuickCaptureForUser', 'setNativeAnalyticsMember',
    'syncNativePushRegistration', 'clearLocalNotificationPreference',
    'clearNativePushPreferenceForSignOut', 'recordLifecycleEvent',
  ].map(name => [name, ok]));
  noIO.activateOfflineScope = activateOfflineScope;
  const modules: Record<string, object> = {
    react: React, 'react-native': reactNative,
    'expo-crypto': { randomUUID: () => 'test-id' },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: ok },
    '../services/sessionResume': resume,
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
    './useSharedDemoVisit': { useSharedDemoVisit },
    '../lib/lowDataPolicy': { pollIntervalMsFor: () => 120_000 },
    '../services/lowData': { ...noIO, startLowDataMonitoring: () => stop },
    '../services/authRefreshLifecycle': { startSupabaseAuthRefreshLifecycle: () => stop },
    '../services/accountLocalTeardown': { createAccountLocalTeardown: () => ({ retry: async () => true, request: async () => true }) },
    '../services/secureShareIntake': {
      ...noIO, ShareIntakeError: class extends Error {}, captureSecureShareCleanupBoundary: () => ({}),
      isSecureShareStagingCleanupRequired: () => false, subscribeSecureShareStagingCleanup: () => stop,
    },
    '../services/biometrics': { ...noIO, readBiometricLockPreference: async () => false, biometricsAvailable: async () => false },
    '../services/notifications': { ...noIO, startNativePushTokenRotationListener: () => ({ remove: stop }) },
    '../services/supabase': {
      captureSessionWriter: (session: Session | null) => stubSessionWriter(() => client, session?.user.id),
      getSupabaseClient: () => client, sessionNeedsMfa, loadDashboard,
      loadMobileChapterMemberships,
      loadMobileStaffScope: options.realStaff ? loadMobileStaffScope : loadStaffScope,
      setMobileChapterPin: ok, switchMobileChapter: ok,
      loadMobileDuesContext: async () => null, readPersistedMobileSession: async () => server.session,
      clearCapturedMobileSessionLocally: async () => true,
    },
    '../lib/duesNavigation': { loadMobileOrganizationRunsDues: async () => false },
    '../services/sampleSession': { isLiveSampleBackend: () => false, sampleHatForSession: () => null },
    '../lib/storeDemo': { isStoreDemo: () => false, endStoreDemo: async () => undefined },
    '../lib/conversationUnread': { conversationUnreadStore: { reset, publish: reset, conversations: () => [] },
      createConversationUnreadPoller: () => ({ start: stop, stop, invalidate: stop, dispose: stop, setPolicy: stop }) },
    '../lib/foregroundSessionRevocationWatch': { createForegroundSessionRevocationWatch: () => ({ start: stop, stop }) },
    '../services/stewardDirectInbox': { nativeDirectAudience: () => 'member', setNativeDirectAudience: () => false, replaceDirectRows: (rows: unknown) => rows, stewardDirectRefusalEpoch: () => options.refusalEpoch?.() ?? 0 },
    ...(options.activateOfflineScope ? { '../services/offlineAvailability': { ...noIO, activateOfflineScope: options.activateOfflineScope } } : {}),
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
  const railExports: Record<string, unknown> = {};
  const railSource = readFileSync(resolve(process.cwd(), 'src/components/ChapterRail.tsx'), 'utf8');
  const railModules: Record<string, object> = {
    react: React, 'react-native': standIn,
    './Text': { Text: standIn.Text, TextInput: standIn.TextInput },
    '../theme/typeface': { typeface },
    '@expo/vector-icons': { Ionicons: () => null },
    'expo-router': { useRouter: () => ({ push: stop }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '../data/demoChannels': { channelStore: { subscribe: () => stop, getVersion: () => 0, channels: () => [] } },
    '../lib/chapterIdentity': { NO_CHAPTER_SUBTITLE: 'No campaign' },
    '../lib/reduceMotion': { useReduceMotion: () => true },
    '../services/haptics': { haptics: { select: ok } },
    '../state/AppProvider': provider,
    '../theme/ThemeProvider': { useTheme: () => resolveTheme() },
    '../theme/tokens': { minimumTouchTarget },
    './SwipeDownKeyboardDismiss': { SwipeDownKeyboardDismiss: ({ children }: PropsWithChildren) => children },
  };
  runInNewContext(ts.transpileModule(railSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  } }).outputText, {
    exports: railExports, React,
    require: (path: string) => { if (!(path in railModules)) throw new Error(`Unmodelled rail import: ${path}`); return railModules[path]; },
  });
  const { ChapterRail } = railExports as { ChapterRail: ComponentType<{ open: boolean; onClose: () => void }> };
  let snapshot: Snapshot;
  function Probe() {
    snapshot = provider.useApp();
    const key = resumeDraftHolder.useResumeDraftKey(snapshot, 'notice', 'chapter-notices');
    const held = resumeDraftHolder.useResumeDraft(key, true);
    return h('output', null, `${snapshot.mode}:${snapshot.privacyCovered}:${snapshot.dashboard?.member.id ?? 'empty'}`,
      held && h('section', null, held.value.body,
        h('button', { onClick: () => resumeDraftHolder.writeResumeDraft(key, { ...held.value, body: 'Continued work' }) }, 'Continue held draft'),
        h('button', { onClick: () => resumeDraftHolder.retireResumeDraft(key) }, 'Discard held draft')));
  }
  return { provider, Probe, ChapterRail, server, refreshSession, getUser, loadDashboard, loadStaffScope, activateOfflineScope, sessionNeedsMfa,
    snapshot: () => snapshot!, authEvent: (event: string, next: Session | null) => authEvent(event, next),
    finishOldCheck: () => oldChecks[0]!(false),
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  backend.rpc.mockReset();
  backend.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_my_mobile_staff_scope') return { data: { organizationId: 'org-a', roles: [], chapterRoles: [], staffAuthorized: false }, error: null };
    if (name !== 'get_my_chapter_memberships') throw new Error(`Unexpected RPC: ${name}`);
    // Network latency bounds a broken read loop so a failing test can finish.
    await new Promise(resolve => setTimeout(resolve, 10));
    return { data: [{ chapterId: 'chapter-a', organizationId: 'org-a', name: 'Campaign A', joinedAt: '2026-01-01', selected: true, pinned: false, roles: [] }], error: null };
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.listeners.clear(); native.currentState = 'active';
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); retirePendingNoticeSends('a'); container.remove(); vi.useRealTimers(); });

describe('real campaign rail on the real app provider', () => {
  it.each(['android', 'ios'])('9258S G1: consumes confirmed departure before a failed staff read and a pending dashboard join on %s', async platform => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false);
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(20); });
    expect(f.snapshot().mode).toBe('authenticated');
    const originalDashboard = { member: { id: 'a', language: 'en', chapterId: 'chapter-a' }, conversations: [], notifications: [], cases: [], actionLog: [] };
    const held = beginNoticeSend('a|chapter-a', { title: 'Held before refresh', body: 'Body', locale: 'en', postingRole: 'admin', organizationID: 'org-a' },
      { value: 'chapter', kind: 'chapter', chapterId: 'chapter-a', name: '' },
      { title: 'Held before refresh', body: 'Body', locale: 'en', operationKey: 'original-key' },
      { userID: 'a', isCurrent: f.snapshot().captureAccountSessionGuard('a') })!;
    updateNoticeSend(held, { busy: false });
    expect(readPendingNoticeSend('a|chapter-a')?.attempt?.operationKey).toBe('original-key');
    let finishDashboard!: (value: typeof originalDashboard) => void;
    f.loadDashboard.mockImplementationOnce(() => new Promise(resolve => { finishDashboard = resolve; }));
    f.loadStaffScope.mockRejectedValueOnce(new TypeError('Staff read unavailable'));
    backend.rpc.mockResolvedValueOnce({ data: [{ chapterId: 'chapter-b', organizationId: 'org-b', name: 'Campaign B', joinedAt: '2026-01-01', selected: true, pinned: false, roles: [] }], error: null });
    let refresh!: Promise<void>;
    await act(async () => { refresh = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(20); });
    expect(f.loadStaffScope).toHaveBeenCalledTimes(2);
    expect(f.snapshot().refreshing).toBe(true);
    // No successful join or render-time memberships projection can explain
    // this removal: the real provider must consume the membership reply now.
    expect(readPendingNoticeSend('a|chapter-a')).toBeNull();
    await act(async () => { finishDashboard(originalDashboard); await refresh; });
    expect(readPendingNoticeSend('a|chapter-a')).toBeNull();
  });
  for (const source of ['full', 'rail', 'pin', 'switch', 'staff']) {
    for (const malformed of [null, {}, 'invalid', [null]]) {
      it.each(['android', 'ios'].flatMap(platform => [false, true].map(late => ({ platform, late }))))('actual authorization outcome matrix: ' + source + ' rejects malformed ' + JSON.stringify(malformed) + ' on $platform (late=$late)', async ({ platform, late }) => {
        native.platform = platform;
        const f = harness({ realStaff: true }); f.sessionNeedsMfa.mockResolvedValue(false);
        await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
        await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(20); });
        const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
        const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Real adapter', body: 'Keep protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
        const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
        const original = backend.rpc.getMockImplementation()!;
        const target = source === 'staff' ? 'get_my_mobile_staff_scope' : 'get_my_chapter_memberships';
        let release!: (reply: { data: unknown; error: null }) => void;
        let intercepted = false;
        backend.rpc.mockImplementation((name: string) => {
          if (name !== target || intercepted) return original(name);
          intercepted = true;
          return new Promise(done => { release = done; });
        });
        let pending!: Promise<unknown>;
        await act(async () => {
          pending = (source === 'rail' ? f.snapshot().refreshChapterMemberships()
            : source === 'pin' ? f.snapshot().setChapterPinned('chapter-a', true)
              : source === 'switch' ? f.snapshot().switchChapter('chapter-a') : f.snapshot().refresh()).catch((error: unknown) => error);
          await vi.advanceTimersByTimeAsync(20);
        });
        if (late) {
          await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
          // #9358: a deadline conceals and keeps, exactly like a failed read.
          expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
          expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
        }
        await act(async () => { release({ data: malformed, error: null }); await pending; await vi.advanceTimersByTimeAsync(0); });
        expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
        expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
        expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
      });
    }
  }
  it.each(['android', 'ios'])('keeps held work concealed after a stalled rail opening until the next confirmed full answer on %s', async platform => {
    native.platform = platform;
    standIn.setPlatform(platform as 'android' | 'ios');
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false);
    const show = (open: boolean) => h(f.provider.AppProvider, null, h(f.Probe), h(f.ChapterRail, { open, onClose: () => undefined }));
    await act(async () => root.render(show(false)));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(20); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    await act(async () => { resumeDraftHolder.writeResumeDraft(key, {
      title: 'Held draft', body: 'My protected work', locale: 'en', audienceValue: 'chapter', warning: null,
      attempt: { title: 'Held draft', body: 'My protected work', locale: 'en', operationKey: 'unknown-send' },
    }); });
    expect(container.textContent).toContain('My protected work');
    let release!: (answer: unknown) => void;
    backend.rpc.mockImplementationOnce(() => new Promise(done => { release = done; }));
    await act(async () => root.render(show(true)));
    expect(container.textContent).not.toContain('My protected work');
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Discard held draft')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); });
    // #9358: the rail read ends at its deadline and restores nothing; the held
    // draft and its actions stay concealed, and the draft is kept.
    expect(container.textContent).not.toContain('My protected work');
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Discard held draft')).toBe(false);
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    await act(async () => { release({ data: [{ chapterId: 'chapter-a', organizationId: 'org-a', name: 'Campaign A', joinedAt: '2026-01-01', selected: true }], error: null }); await vi.advanceTimersByTimeAsync(0); });
    // The expired read's late answer publishes nothing.
    expect(f.snapshot().organizationID).toBe('org-a');
    expect(f.snapshot().confirmedMembershipScope).toEqual([{ chapterID: 'chapter-a', organizationID: 'org-a' }]);
    expect(container.textContent).not.toContain('My protected work');
    // The next confirmed full answer brings the work and its actions back.
    await act(async () => { void f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(20); });
    expect(container.textContent).toContain('My protected work');
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Continue held draft')!.click(); });
    expect(container.textContent).toContain('Continued work');
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Discard held draft')!.click(); });
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
  });
  // #9361 read R-9361R section 5: a CONFIRMED rail or pin membership answer
  // that arrives after the read deadline still retires the held notice sends
  // of a departed chapter, and keeps them when the chapter is still joined.
  for (const source of ['rail', 'pin']) {
    it.each(['android', 'ios'].flatMap(platform => [true, false].map(departed => ({ platform, departed }))))(`retires a held notice on a late confirmed ${source} answer only after departure on $platform (departed=$departed)`, async ({ platform, departed }) => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false);
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(20); });
      expect(f.snapshot().mode).toBe('authenticated');
      const held = beginNoticeSend('a|chapter-a', { title: 'Held before departure', body: 'Body', locale: 'en', postingRole: 'admin', organizationID: 'org-a' },
        { value: 'chapter', kind: 'chapter', chapterId: 'chapter-a', name: '' },
        { title: 'Held before departure', body: 'Body', locale: 'en', operationKey: 'original-key' },
        { userID: 'a', isCurrent: f.snapshot().captureAccountSessionGuard('a') })!;
      updateNoticeSend(held, { busy: false });
      let release!: (answer: unknown) => void;
      backend.rpc.mockImplementationOnce(() => new Promise(done => { release = done; }));
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = (source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true)).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(20);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
      expect(readPendingNoticeSend('a|chapter-a')?.attempt?.operationKey).toBe('original-key');
      const row = departed
        ? { chapterId: 'chapter-b', organizationId: 'org-b', name: 'Campaign B', joinedAt: '2026-01-01', selected: true, pinned: false, roles: [] }
        : { chapterId: 'chapter-a', organizationId: 'org-a', name: 'Campaign A', joinedAt: '2026-01-01', selected: true, pinned: false, roles: [] };
      await act(async () => { release({ data: [row], error: null }); await vi.advanceTimersByTimeAsync(0); });
      if (departed) expect(readPendingNoticeSend('a|chapter-a')).toBeNull();
      else expect(readPendingNoticeSend('a|chapter-a')?.attempt?.operationKey).toBe('original-key');
    });
  }
  it.each(['android', 'ios'])('does not read while signed out, and refreshes after authenticating with the rail open on %s', async platform => {
    native.platform = platform;
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe), h(f.ChapterRail, { open: true, onClose: () => undefined }))));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(f.snapshot().mode).toBe('signedOut');
    expect(backend.rpc).not.toHaveBeenCalled();
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(20); });
    expect(f.snapshot().mode).toBe('authenticated');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(backend.rpc).toHaveBeenCalledTimes(2); // Bootstrap and opening.
    expect(container.textContent).toContain('Campaign A');
  });

  it.each(['android', 'ios'])('contains a failed opening read and retries on reopening on %s', async platform => {
    native.platform = platform;
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    const show = (open: boolean) => h(f.provider.AppProvider, null, h(f.Probe), h(f.ChapterRail, { open, onClose: () => undefined }));
    await act(async () => root.render(show(false)));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(20); });
    backend.rpc.mockRejectedValueOnce(new Error('Simulated read failure'));
    await act(async () => root.render(show(true)));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    await act(async () => root.render(show(false)));
    await act(async () => root.render(show(true)));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(backend.rpc).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('Campaign A');
  });

  it.each(['android', 'ios'])('reads once per opening and settles while open on %s', async platform => {
    native.platform = platform;
    standIn.setPlatform(platform as 'android' | 'ios');
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    const show = (open: boolean) => h(f.provider.AppProvider, null, h(f.Probe), h(f.ChapterRail, { open, onClose: () => undefined }));
    await act(async () => root.render(show(false)));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(20); });
    expect(f.snapshot().mode).toBe('authenticated');
    expect(backend.rpc).toHaveBeenCalledTimes(1); // Dashboard bootstrap.
    await act(async () => root.render(show(true)));
    // Flush each response in its own act: the provider's new array is
    // committed before the next response. This exposes callback/effect loops.
    for (let i = 0; i < 20; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    }
    console.info(`${platform}: get_my_chapter_memberships calls after opening = ${backend.rpc.mock.calls.length - 1}`);
    expect(container.textContent).toContain('Campaign A');
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    await act(async () => root.render(show(false)));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    await act(async () => root.render(show(true)));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(backend.rpc).toHaveBeenCalledTimes(3);
  });
});

// #9375 final (r3s2): a chapterless officer's first chapter retires their
// organization drafts in the holder without reporting a change the provider
// would only answer by clearing its read facts (it reloads only from a chapter).
describe('a first campaign on the real app provider', () => {
  it.each(['android', 'ios'])('retires chapterless drafts and leaves every read confirmed on %s', async platform => {
    native.platform = platform;
    standIn.setPlatform(platform as 'android' | 'ios');
    let rows: unknown[] = [];
    backend.rpc.mockImplementation(async (name: string) => {
      if (name !== 'get_my_chapter_memberships') throw new Error(`Unexpected RPC: ${name}`);
      await new Promise(resolve => setTimeout(resolve, 10));
      return { data: rows, error: null };
    });
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    // A chapterless officer's profile names no chapter.
    const dashboard = f.loadDashboard.getMockImplementation()!;
    f.loadDashboard.mockImplementation(async (userID: string) => {
      const row = await dashboard(userID);
      Object.assign(row.member, { chapterId: null });
      return row;
    });
    const show = (open: boolean) => h(f.provider.AppProvider, null, h(f.Probe), h(f.ChapterRail, { open, onClose: () => undefined }));
    await act(async () => root.render(show(false)));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(50); });
    expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
    const surface = resumeDraftHolder.defineRetainedSurface<{ text: string }>('first-chapter-probe');
    const key = resumeDraftHolder.retainedDraftKey(f.snapshot(), surface, 'note', 'organization');
    expect(key).not.toBeNull();
    expect(resumeDraftHolder.writeRetainedDraft(key, { text: 'Chapterless note' })).not.toBeNull();
    rows = [{ chapterId: 'chapter-a', organizationId: 'org-a', name: 'Campaign A', joinedAt: '2026-01-01', selected: true, pinned: false, roles: [] }];
    await act(async () => root.render(show(true)));
    for (let i = 0; i < 10; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(f.snapshot().chapterMemberships.find(row => row.selected)?.chapterID).toBe('chapter-a');
    expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
    expect(resumeDraftHolder.readRetainedDraft(key)).toBeNull();
    const next = resumeDraftHolder.retainedDraftKey(f.snapshot(), surface, 'note', 'organization');
    expect(resumeDraftHolder.writeRetainedDraft(next, { text: 'Under the new campaign' })).not.toBeNull();
  });
});
