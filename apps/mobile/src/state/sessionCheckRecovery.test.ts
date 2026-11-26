import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { act, createElement as h, type ComponentType, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { MobileStaffScope } from '../services/supabase';
import * as resume from '../services/sessionResume';
import * as identity from '../lib/accountSessionIdentity';
import * as lineage from '../lib/sessionLineage';
import * as completion from '../lib/signInCompletion';
import * as authGate from '../lib/nativeAuthGate';
import * as hats from '../lib/hatFunctions';
import * as biometric from '../lib/biometricAvailability';
import * as privacy from '../lib/appStatePrivacyCover';
import * as unavailable from '../lib/sessionUnavailableCopy';
import * as offlinePolicy from '../lib/offlineAvailability';
import * as resumeDraftHolder from '../lib/resumeDraftHolder';
import * as readRefusal from '../lib/readRefusal';
import * as readDeadline from '../lib/readDeadline';
import type { useApp } from './AppProvider';
import * as resumeDraftOwnership from '../lib/resumeDraftOwnership';
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

// Mount the actual provider, including its auth callback, effects and context.
// Native I/O is substituted at the CommonJS import boundary, as the existing
// provider tests substitute callback dependencies through node:vm. React and
// session ownership/revalidation are real; no backend URL can be contacted.
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
  offline?: OfflineModule;
};

type OfflineModule = Pick<typeof import('../services/offlineAvailability'),
  'activateOfflineScope' | 'suspendOfflineAvailability' | 'readOfflineAvailability' | 'setOfflineAvailability' | 'saveOfflineLearningDraft'>;

// Exercise the actual encrypted-note service; substitute only device keychain
// and UUID I/O so a retired authorization really would delete stored notes.
function offlineHarness() {
  const store = new Map<string, string>();
  const exports: Record<string, unknown> = {};
  const source = readFileSync(resolve(process.cwd(), 'src/services/offlineAvailability.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules: Record<string, object> = {
    'react-native': reactNative,
    'expo-crypto': { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
    'expo-secure-store': {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only', isAvailableAsync: async () => true,
      getItemAsync: async (key: string) => store.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => { store.set(key, value); },
      deleteItemAsync: async (key: string) => { store.delete(key); },
    },
    '../lib/offlineAvailability': offlinePolicy,
  };
  runInNewContext(compiled, { exports, Date, require: (path: string) => {
    if (!(path in modules)) throw new Error(`Unmodelled offline I/O: ${path}`);
    return modules[path];
  } });
  return { service: exports as OfflineModule, store };
}

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
  const loadMemberships = vi.fn(async (_onReadAvailability?: (available: boolean) => void): Promise<{ chapterID: string; organizationID: string | null; selected: boolean; pinned?: boolean }[]> => [
    { chapterID: `chapter-${server.session.user.id}`, organizationID: `org-${server.session.user.id}`, selected: true },
  ]);
  const loadStaffScope = vi.fn(async (_onReadAvailability?: (available: boolean) => void): Promise<MobileStaffScope> => ({
    organizationID: `org-${server.session.user.id}`, roles: [], chapterRoles: [], staffAuthorized: false,
  }));
  const activateOfflineScope = vi.fn(async () => undefined);
  const retryOfflineCleanup = vi.fn(async () => undefined);
  const loadRunsDues = vi.fn(async () => false);
  const setMobileChapterPin = vi.fn(async (_chapterID: string, _pinned: boolean): Promise<void> => undefined);
  const switchMobileChapter = vi.fn(async (_chapterID: string): Promise<void> => undefined);
  const verifyMfaCode = vi.fn(async (_code: string): Promise<Session> => server.session);
  type NativeSignedIn = (next: Session) => void;
  const runNativeSignIn = vi.fn(async (_action: unknown, _link: Session | null, _signedIn: NativeSignedIn): Promise<unknown> => ({ status: 'cancelled' }));
  const loadDuesContext = vi.fn(async (): Promise<unknown> => null);
  const channelRows: string[] = [];
  const resetChannels = vi.fn(() => { channelRows.length = 0; });
  const purgeHomeWidgets = vi.fn(async () => undefined);
  const noIO = Object.fromEntries([
    'purgeHomeWidgets', 'suspendHomeWidgets', 'activateOfflineScope', 'purgeOfflineAvailability', 'suspendOfflineAvailability',
    'requestOfflineSignOutCleanup', 'retryPendingOfflineSignOutCleanup', 'refreshLowDataSignals',
    'purgeAttachmentCache', 'purgeAttachmentCacheForSessionLoss', 'purgeAttachmentCacheForSignOut',
    'saveBiometricLockPreference', 'preparePendingSharedAttachmentUploadForSessionEstablishment',
    'preparePendingSharedAttachmentUploadForSessionLoss', 'discardAllPendingSharedAttachments',
    'retryPendingSharedAttachmentCleanup', 'purgeQuickCaptureForUser', 'setNativeAnalyticsMember',
    'syncNativePushRegistration', 'clearLocalNotificationPreference',
    'clearNativePushPreferenceForSignOut', 'recordLifecycleEvent', 'resetPreviewHandoffs',
  ].map(name => [name, ok]));
  noIO.activateOfflineScope = activateOfflineScope;
  noIO.retryPendingOfflineSignOutCleanup = retryOfflineCleanup;
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
    '../services/haptics': { haptics: { select: ok, success: ok, warning: ok } },
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
      loadMobileChapterMemberships: async (onSelection?: (selected: { chapterID: string; organizationID: string | null }[]) => void, onReadAvailability?: (available: boolean) => void) => {
        const rows = await loadMemberships(onReadAvailability);
        onSelection?.(rows.filter(row => row.selected).map(row => ({ chapterID: row.chapterID, organizationID: row.organizationID })));
        return rows;
      },
      loadMobileStaffScope: loadStaffScope,
      // The provider's new C binding is checked here; Main's existing semantic
      // pin mock and every assertion continue to observe chapter and value.
      setMobileChapterPin: (writer: ReturnType<typeof stubSessionWriter>, chapterID: string, pinned: boolean) => {
        expect(writer.userId).toBeTruthy();
        return setMobileChapterPin(chapterID, pinned);
      }, switchMobileChapter, verifyMfaCode,
      loadMobileDuesContext: loadDuesContext, readPersistedMobileSession: async () => server.session,
      clearCapturedMobileSessionLocally: async () => true,
    },
    '../lib/duesNavigation': { loadMobileOrganizationRunsDues: loadRunsDues },
    '../services/sampleSession': { isLiveSampleBackend: () => false, sampleHatForSession: () => null },
    '../lib/storeDemo': { isStoreDemo: () => false, endStoreDemo: async () => undefined },
    '../lib/conversationUnread': { conversationUnreadStore: { reset, publish: reset, conversations: () => [] },
      createConversationUnreadPoller: () => ({ start: stop, stop, invalidate: stop, dispose: stop, setPolicy: stop }) },
    '../lib/foregroundSessionRevocationWatch': { createForegroundSessionRevocationWatch: () => ({ start: stop, stop }) },
    '../services/stewardDirectInbox': { nativeDirectAudience: () => 'member', setNativeDirectAudience: () => false, replaceDirectRows: (rows: unknown) => rows, stewardDirectRefusalEpoch: () => options.refusalEpoch?.() ?? 0 },
    ...(options.activateOfflineScope || options.offline ? { '../services/offlineAvailability': {
      ...noIO, ...options.offline, ...(options.activateOfflineScope ? { activateOfflineScope: options.activateOfflineScope } : {}),
    } } : {}),
    '../data/liveChannels': { liveChannelStore: { resetForSession: resetChannels } },
    '../services/nativeAuth': { runNativeSignIn, enrollNativeSecurityKey: ok },
    '../services/homeWidgets': { purgeHomeWidgets, suspendHomeWidgets: ok },
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
    return h('output', null, `${snapshot.mode}:${snapshot.privacyCovered}:${snapshot.dashboard?.member.id ?? 'empty'}`);
  }
  return { provider, Probe, server, refreshSession, getUser, loadDashboard, loadMemberships, loadStaffScope, activateOfflineScope, sessionNeedsMfa, setMobileChapterPin, switchMobileChapter,
    loadDuesContext, loadRunsDues, retryOfflineCleanup, channelRows, resetChannels, verifyMfaCode, runNativeSignIn, purgeHomeWidgets,
    snapshot: () => snapshot!, authEvent: (event: string, next: Session | null) => authEvent(event, next),
    finishOldCheck: () => oldChecks[0]!(false),
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.listeners.clear(); native.currentState = 'active';
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe.each(['android', 'ios'])('draft scope input provenance on %s', platform => {
  for (const source of ['staff', 'memberships', 'dashboard', 'rail', 'pin']) {
    for (const failure of ['authoritative', 'bearer', 'malformed', ...(source === 'dashboard' ? [] : ['availability false'])]) {
      it(`cross-read probe: late ${source} ${failure} remains concealed after the second deadline`, async () => {
        native.platform = platform;
        const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
        await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
        await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
        const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
        const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Probe', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
        const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
        let finish!: () => void;
        const first = new Promise<void>(done => { finish = done; });
        const error = failure === 'authoritative' ? { code: '42501' } : failure === 'bearer' ? { status: 401 } : new Error('Invalid authorization payload');
        const rejectAfter = async () => { await first; throw error; };
        const never = () => new Promise<never>(() => undefined);
        //  round 1 (r2s2): the stand-in below hands the availability
        // callback first; this proves the availability-false answer ran
        // through it without a throw, not through a rejection.
        let availabilityReported = false;
        if (source === 'dashboard') f.loadDashboard.mockImplementationOnce(rejectAfter).mockImplementationOnce(never);
        else if (source === 'staff') {
          f.loadStaffScope.mockImplementationOnce(async onReadAvailability => {
            if (failure !== 'availability false') return rejectAfter();
            await first; onReadAvailability!(false); availabilityReported = true;
            return { organizationID: null, roles: [], chapterRoles: [], staffAuthorized: false };
          }).mockImplementationOnce(never);
        } else {
          f.loadMemberships.mockImplementationOnce(async onReadAvailability => {
            if (failure !== 'availability false') return rejectAfter();
            await first; onReadAvailability!(false); availabilityReported = true; return [];
          });
          if (source === 'memberships') f.loadMemberships.mockImplementationOnce(never);
          else f.loadStaffScope.mockImplementationOnce(never);
        }
        let a!: Promise<unknown>;
        await act(async () => {
          a = (source === 'rail' ? f.snapshot().refreshChapterMemberships() : source === 'pin' ? f.snapshot().setChapterPinned('chapter-a', true) : f.snapshot().refresh()).catch((error: unknown) => error);
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await a; });
        //: a deadline restores no earlier fact; the work is concealed and kept.
        expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
        expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
        let b!: Promise<void>;
        await act(async () => { b = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { finish(); await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await b; });
        expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
        expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(failure !== 'authoritative');
        expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
        expect(availabilityReported).toBe(failure === 'availability false');
      });
    }
  }
  it('conceals an old campaign refusal without retiring for the newer campaign; its own refusal still retires', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let rejectOld!: (error: unknown) => void;
    let rejectNew!: (error: unknown) => void;
    f.loadStaffScope.mockReturnValueOnce(new Promise<never>((_resolve, reject) => { rejectOld = reject; }))
      .mockReturnValueOnce(new Promise<never>((_resolve, reject) => { rejectNew = reject; }));
    let a!: Promise<void>;
    await act(async () => { a = f.snapshot().refresh(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await a; });
    f.loadMemberships.mockResolvedValueOnce([{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }]);
    let b!: Promise<void>;
    await act(async () => { b = f.snapshot().switchChapter('chapter-b').catch(() => undefined); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().confirmedMembershipScope).toEqual([{ chapterID: 'chapter-b', organizationID: 'org-a' }]);
    const retire = vi.spyOn(resumeDraftHolder, 'retireRefusedResumeDraftScope');
    try {
      const oldRefusal = { code: '42501', message: 'Old campaign' };
      await act(async () => { rejectOld(oldRefusal); await vi.advanceTimersByTimeAsync(0); });
      expect(f.snapshot().resumeDraftReads?.staff).toBe(false);
      expect(retire).not.toHaveBeenCalledWith('a', oldRefusal);
      await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await b; });
      const currentRefusal = { code: '42501', message: 'Current campaign' };
      await act(async () => { rejectNew(currentRefusal); await vi.advanceTimersByTimeAsync(0); });
      expect(retire).toHaveBeenCalledWith('a', currentRefusal);
      expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(false);
    } finally { retire.mockRestore(); }
  });
  it('a newer full answer with unavailable staff cannot supersede an older permission refusal', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const ticket = resumeDraftHolder.writeResumeDraft(key, { title: 'Kept', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })!;
    let rejectOld!: (error: unknown) => void;
    f.loadStaffScope.mockReturnValueOnce(new Promise<never>((_resolve, reject) => { rejectOld = reject; }));
    let a!: Promise<void>;
    await act(async () => { a = f.snapshot().refresh(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await a; });
    f.loadStaffScope.mockRejectedValueOnce(new Error('Unavailable authorization'));
    await act(async () => { await f.snapshot().refresh(); });
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
    await act(async () => { rejectOld({ code: '42501' }); await vi.advanceTimersByTimeAsync(0); });
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
  });
  for (const source of ['offline cleanup', 'offline activation']) {
    for (const outcome of ['valid', 'deadline', 'transport', 'bearer', 'authoritative', 'malformed', 'unknown']) {
      it.each(outcome === 'deadline' ? [true] : [false, true])(`incidental outcome matrix: ${source}, ${outcome} (late=%s)`, async late => {
        native.platform = platform;
        const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
        await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
        await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
        const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
        const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Online authorization', body: 'Kept', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
        const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
        let release!: () => void;
        const gate = new Promise<void>(done => { release = done; });
        const wait = async () => {
          await gate;
          if (outcome === 'transport') throw new TypeError('Network request failed');
          if (outcome === 'bearer') throw { status: 401 };
          if (outcome === 'authoritative') throw { code: '42501' };
          if (outcome === 'malformed') throw new Error('Invalid local projection');
          if (outcome === 'unknown') throw { status: 500 };
          return undefined;
        };
        if (source === 'dues') f.loadDuesContext.mockImplementationOnce(async () => { await wait(); return null; });
        else if (source === 'runs dues') f.loadRunsDues.mockImplementationOnce(async () => { await wait(); return false; });
        else if (source === 'offline cleanup') f.retryOfflineCleanup.mockImplementationOnce(wait);
        else f.activateOfflineScope.mockImplementationOnce(wait);
        let pending!: Promise<void>;
        await act(async () => { pending = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
        expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
        if (late) {
          await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
          //: past the deadline the refresh ends as a failed read does.
          expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
          expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
          expect(f.snapshot().refreshing).toBe(false);
        }
        await act(async () => { release(); await pending; await vi.advanceTimersByTimeAsync(0); });
        if (late) {
          // The expired read's late answer publishes nothing: the work stays
          // concealed and kept until the next confirmed full answer.
          expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
          expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
          expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(false);
          await act(async () => { await f.snapshot().refresh(); });
        }
        // These waits cannot authorize/deny resume scope: Main soft-fails
        // them, while independent successful online authorization owns it.
        expect(resumeDraftHolder.readResumeDraft(key)).toBe(ticket);
        expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
        expect(f.snapshot().refreshing).toBe(false);
      });
    }
  }
  const outcomes = [
    // RULING 9359-DEADLINE-ONLY: a transport-looking failure conceals as on Main.
    { name: 'transport', error: () => new TypeError('Network request failed'), conceal: true, retire: false },
    { name: 'transport-looking PostgREST body', error: () => ({ code: '', message: 'TypeError: Failed to fetch' }), conceal: true, retire: false },
    { name: 'bearer 401', error: () => ({ status: 401 }), conceal: true, retire: false },
    { name: 'bearer PGRST301', error: () => ({ code: 'PGRST301' }), conceal: true, retire: false },
    { name: 'bearer PGRST302', error: () => ({ code: 'PGRST302' }), conceal: true, retire: false },
    { name: 'bearer PGRST303', error: () => ({ code: 'PGRST303' }), conceal: true, retire: false },
    { name: 'authoritative 403', error: () => ({ status: 403 }), conceal: true, retire: true },
    { name: 'authoritative 42501', error: () => ({ code: '42501' }), conceal: true, retire: true },
    { name: 'malformed rejection', error: () => new Error('Campaign authorization could not be confirmed.'), conceal: true, retire: false },
    { name: 'unknown 500', error: () => ({ status: 500, message: 'Server unavailable' }), conceal: true, retire: false },
    { name: 'unknown TypeError', error: () => new TypeError('Programming error'), conceal: true, retire: false },
    { name: 'unknown timeout name', error: () => Object.assign(new Error('Read timed out'), { name: 'TimeoutError' }), conceal: true, retire: false },
    { name: 'refusal takes precedence over deadline', error: () => Object.assign(new readDeadline.ReadDeadlineError(), { status: 403 }), conceal: true, retire: true },
  ];
  for (const source of ['dashboard', 'memberships', 'staff', 'rail', 'pin', 'switch']) {
    for (const outcome of outcomes) {
      it.each([false, true])(`provider outcome matrix: ${source}, ${outcome.name} (late=%s)`, async late => {
        native.platform = platform;
        const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
        await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
        await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
        const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
        const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Outcome work', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
        const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
        let reject!: (error: unknown) => void;
        const answer = new Promise<never>((_resolve, fail) => { reject = fail; });
        if (source === 'dashboard') f.loadDashboard.mockReturnValueOnce(answer);
        else if (source === 'staff') f.loadStaffScope.mockReturnValueOnce(answer);
        else f.loadMemberships.mockReturnValueOnce(answer);
        let pending!: Promise<unknown>;
        await act(async () => {
          pending = (source === 'rail' ? f.snapshot().refreshChapterMemberships()
            : source === 'pin' ? f.snapshot().setChapterPinned('chapter-a', true)
              : source === 'switch' ? f.snapshot().switchChapter('chapter-a') : f.snapshot().refresh()).catch((error: unknown) => error);
          await vi.advanceTimersByTimeAsync(0);
        });
        if (late) {
          await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
          //: a deadline conceals and keeps, exactly like a failed read.
          expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
          if (source !== 'switch') expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
        }
        await act(async () => { reject(outcome.error()); await pending; await vi.advanceTimersByTimeAsync(0); });
        const concealed = outcome.conceal || source === 'switch';
        expect(resumeDraftHolder.readResumeDraft(key)?.value).toEqual(concealed ? undefined : work);
        expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(!outcome.retire);
        expect(f.snapshot().refreshing).toBe(false);
        if (concealed) expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
        // A later valid reauthorization can reveal retained work, never a
        // retired attempt. No error is allowed to manufacture a new draft.
        await act(async () => { await f.snapshot().refresh(); });
        expect(resumeDraftHolder.readResumeDraft(key)?.value).toEqual(outcome.retire ? undefined : work);
      });
    }
  }
  it.each([
    { error: { status: 401 }, retire: false }, { error: { code: 'PGRST301' }, retire: false },
    { error: { code: '42501' }, retire: true }, { error: { status: 500 }, retire: false },
    { error: new Error('Invalid staff payload'), retire: false },
  ])('does not roll back an early staff failure when its sibling times out: %j', async ({ error, retire }) => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'No rollback', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
    const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
    f.loadDashboard.mockImplementationOnce(() => new Promise(() => undefined));
    f.loadStaffScope.mockRejectedValueOnce(error);
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(!retire);
  });
  for (const source of ['dashboard', 'memberships', 'staff', 'rail', 'pin']) {
    //  round 1 (r1s1, r2s1): 'remount' (a render error remounts the
    // provider and the new instance confirms the same person) and 'new login'
    // (the same person signs out and in again) end the old read's lifetime.
    const guards = [...(source === 'rail' || source === 'pin' ? ['account', 'generation', 'newer membership'] : ['account', 'generation']), 'remount', 'new login'];
    it.each(guards)(`keeps replacement authorization after a timed-out ${source} refusal (%s guard)`, async guard => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const originalKey = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
      const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Original', body: 'A only', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
      resumeDraftHolder.writeResumeDraft(originalKey, work);
      let reject!: (error: unknown) => void;
      const held = new Promise<never>((_resolve, fail) => { reject = fail; });
      if (source === 'dashboard') f.loadDashboard.mockReturnValueOnce(held);
      else if (source === 'staff') f.loadStaffScope.mockReturnValueOnce(held);
      else f.loadMemberships.mockReturnValueOnce(held);
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = (source === 'rail' ? f.snapshot().refreshChapterMemberships() : source === 'pin' ? f.snapshot().setChapterPinned('chapter-a', true) : f.snapshot().refresh()).catch((error: unknown) => error);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
      if (guard === 'account') {
        f.server.session = session('b');
        await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      } else if (guard === 'generation') await act(async () => { await f.snapshot().refresh(); });
      else if (guard === 'remount') {
        await act(async () => root.render(h('div')));
        await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
        await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      } else if (guard === 'new login') {
        await act(async () => { f.authEvent('SIGNED_OUT', null); await vi.advanceTimersByTimeAsync(0); });
        f.server.session = session('a', '33333333-3333-4333-8333-333333333333');
        let availabilityReported = false;
        f.loadMemberships.mockImplementationOnce(async onReadAvailability => {
          onReadAvailability!(false); availabilityReported = true;
          return [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }];
        });
        await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
        expect(availabilityReported).toBe(true);
        expect(f.snapshot().resumeDraftReads?.memberships).toBe(false);
        await act(async () => { await f.snapshot().refreshChapterMemberships(); });
      } else await act(async () => { await f.snapshot().refreshChapterMemberships(); });
      expect(f.snapshot().mode).toBe('authenticated');
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
      const replacement = resumeDraftHolder.writeResumeDraft(key, { ...work, body: 'Replacement authorization only' });
      expect(replacement).not.toBeNull();
      await act(async () => { reject({ code: '42501' }); await vi.advanceTimersByTimeAsync(0); });
      expect(resumeDraftHolder.readResumeDraft(key)).toBe(replacement);
      expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
      expect(f.snapshot().session?.user.id).toBe(guard === 'account' ? 'b' : 'a');
    });
  }
  //  gate final (r3s1, r4s1): a pin write that returns after the provider
  // unmounted, or after its login ended, starts no read and no deadline and
  // leaves the replacement's held draft alone, even when the next answer would
  // have moved the selected chapter.
  it.each(['unmount', 'new login'])('a pin write that returns after %s starts no read or deadline and keeps the replacement draft', async end => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let finish!: () => void;
    f.setMobileChapterPin.mockImplementationOnce(() => new Promise<void>(done => { finish = done; }));
    let pending!: Promise<unknown>;
    await act(async () => { pending = f.snapshot().setChapterPinned('chapter-a', true).catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0); });
    if (end === 'unmount') {
      await act(async () => root.render(h('div')));
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    } else {
      await act(async () => { f.authEvent('SIGNED_OUT', null); await vi.advanceTimersByTimeAsync(0); });
      f.server.session = session('a', '33333333-3333-4333-8333-333333333333');
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    }
    expect(f.snapshot().mode).toBe('authenticated');
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const draft = resumeDraftHolder.writeResumeDraft(key, { title: 'Replacement', body: 'Campaign A work', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })!;
    expect(draft).not.toBeNull();
    // Had the old instance read again, this answer would move the chapter.
    f.loadMemberships.mockResolvedValue([{ chapterID: 'chapter-c', organizationID: 'org-a', selected: true }]);
    const reads = f.loadMemberships.mock.calls.length;
    const timers = vi.getTimerCount();
    await act(async () => { finish(); await pending; });
    expect(vi.getTimerCount()).toBe(timers);
    expect(f.loadMemberships.mock.calls.length).toBe(reads);
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS * 2); });
    expect(f.loadMemberships.mock.calls.length).toBe(reads);
    expect(resumeDraftHolder.resumeDraftIsCurrent(draft)).toBe(true);
    expect(resumeDraftHolder.readResumeDraft(key)).toBe(draft);
  });
  //  read R-9381F: the context hands actions to screens whose closures
  // can outlive the provider. A pin or switch write REJECTED after a remount
  // runs ChapterRail's catch, which calls the gone provider's rail read; a
  // late MFA code or native sign-in callback would establish a session on the
  // gone instance; a stale refresh() after a new login would conceal the new
  // login's work. Each refuses at the door now.
  async function remountedWithDraft(f: ReturnType<typeof harness>) {
    await act(async () => root.render(h('div')));
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().mode).toBe('authenticated');
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const draft = resumeDraftHolder.writeResumeDraft(key, { title: 'Replacement', body: 'Campaign A work', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })!;
    expect(draft).not.toBeNull();
    // Had the gone instance read again, this answer would move the chapter.
    f.loadMemberships.mockResolvedValue([{ chapterID: 'chapter-c', organizationID: 'org-a', selected: true }]);
    return { key, draft };
  }
  it.each(['pin', 'switch'])('a %s write rejected after a remount, then the rail catch, starts no read and keeps the replacement draft', async write => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const old = f.snapshot();
    let fail!: (error: unknown) => void;
    const rejected = new Promise<void>((_done, reject) => { fail = reject; });
    if (write === 'pin') f.setMobileChapterPin.mockImplementationOnce(() => rejected);
    else f.switchMobileChapter.mockImplementationOnce(() => rejected);
    let pending!: Promise<unknown>;
    await act(async () => {
      // As ChapterRail.tsx does: a rejected write re-reads through the rail.
      const action = write === 'pin' ? old.setChapterPinned('chapter-a', true) : old.switchChapter('chapter-b');
      pending = action.catch(() => old.refreshChapterMemberships().catch((error: unknown) => error));
      await vi.advanceTimersByTimeAsync(0);
    });
    const { key, draft } = await remountedWithDraft(f);
    const reads = f.loadMemberships.mock.calls.length;
    const resets = f.resetChannels.mock.calls.length;
    await act(async () => { fail({ status: 403 }); await pending; await vi.advanceTimersByTimeAsync(0); });
    expect(f.loadMemberships.mock.calls.length).toBe(reads);
    expect(f.resetChannels.mock.calls.length).toBe(resets);
    expect(resumeDraftHolder.resumeDraftIsCurrent(draft)).toBe(true);
    expect(resumeDraftHolder.readResumeDraft(key)).toBe(draft);
  });
  it('a late MFA code after a remount establishes nothing on the gone instance', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const old = f.snapshot();
    let verified!: (next: Session) => void;
    f.verifyMfaCode.mockImplementationOnce(() => new Promise<Session>(done => { verified = done; }));
    let pending!: Promise<unknown>;
    await act(async () => { pending = old.verifyMfa('123456').catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0); });
    const { key, draft } = await remountedWithDraft(f);
    const checks = f.sessionNeedsMfa.mock.calls.length;
    const resets = f.resetChannels.mock.calls.length;
    const loads = f.loadDashboard.mock.calls.length;
    await act(async () => { verified(f.server.session); await pending; await vi.advanceTimersByTimeAsync(0); });
    expect(f.sessionNeedsMfa.mock.calls.length).toBe(checks);
    expect(f.resetChannels.mock.calls.length).toBe(resets);
    expect(f.loadDashboard.mock.calls.length).toBe(loads);
    expect(resumeDraftHolder.readResumeDraft(key)).toBe(draft);
    expect(f.snapshot().mode).toBe('authenticated');
  });
  //  round 1 (r1s1): the whole staff-role choice is behind the door. A
  // callback of an earlier login saves no role for the current login and so
  // cannot change its draft scope or remove its held drafts.
  it.each(['admin', null])('a stale staff-role choice (%s) from the previous login keeps the new login\'s role and held draft', async staleRole => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    f.loadStaffScope.mockResolvedValue({ organizationID: 'org-a', roles: ['admin', 'vp'], chapterRoles: ['admin', 'vp'], staffAuthorized: true });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const old = f.snapshot();
    await act(async () => { f.authEvent('SIGNED_OUT', null); await vi.advanceTimersByTimeAsync(0); });
    f.server.session = session('a', '33333333-3333-4333-8333-333333333333');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => f.snapshot().chooseStaffRole('vp'));
    expect(f.snapshot().chosenStaffRole).toBe('vp');
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const draft = resumeDraftHolder.writeResumeDraft(key, { title: 'New login, vp', body: 'Kept', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })!;
    expect(draft).not.toBeNull();
    await act(async () => old.chooseStaffRole(staleRole as 'admin' | null));
    expect(f.snapshot().chosenStaffRole).toBe('vp');
    expect(resumeDraftHolder.resumeDraftIsCurrent(draft)).toBe(true);
    expect(resumeDraftHolder.readResumeDraft(key)).toBe(draft);
  });
  //  round 1 class walk: the three other door-shut side effects.
  it('a campaign switch with no session in its closure purges no shared widgets', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().session).toBeNull();
    const purges = f.purgeHomeWidgets.mock.calls.length;
    const refused = await f.snapshot().switchChapter('chapter-b').catch((error: unknown) => error);
    expect((refused as { message?: string } | undefined)?.message).toBe('Sign in to switch campaigns.');
    expect(f.purgeHomeWidgets.mock.calls.length).toBe(purges);
  });
  it('a gone instance sends no MFA code', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const old = f.snapshot();
    await act(async () => root.render(h('div')));
    const checks = f.verifyMfaCode.mock.calls.length;
    await act(async () => { await old.verifyMfa('123456').catch((error: unknown) => error); });
    expect(f.verifyMfaCode.mock.calls.length).toBe(checks);
  });
  it('a stale refresh() from the previous login starts no read and leaves the new login\'s work visible', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const old = f.snapshot();
    await act(async () => { f.authEvent('SIGNED_OUT', null); await vi.advanceTimersByTimeAsync(0); });
    f.server.session = session('a', '33333333-3333-4333-8333-333333333333');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const draft = resumeDraftHolder.writeResumeDraft(key, { title: 'New login', body: 'Kept', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })!;
    expect(draft).not.toBeNull();
    const loads = f.loadDashboard.mock.calls.length;
    await act(async () => { await old.refresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(f.loadDashboard.mock.calls.length).toBe(loads);
    expect(resumeDraftHolder.readResumeDraft(key)).toBe(draft);
    expect(f.snapshot().refreshing).toBe(false);
  });
  //  read R-9381D (7): a chapter switch whose server call finishes after a
  // remount belongs to the gone instance: it confirms nothing on the shared
  // holder, so the new instance's draft is kept, and it starts no read.
  it('an old instance\'s campaign switch that finishes after a remount retires nothing and starts no read', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let finish!: () => void;
    f.switchMobileChapter.mockImplementationOnce(() => new Promise<void>(done => { finish = done; }));
    let pending!: Promise<unknown>;
    await act(async () => { pending = f.snapshot().switchChapter('chapter-b').catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => root.render(h('div')));
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().mode).toBe('authenticated');
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const draft = resumeDraftHolder.writeResumeDraft(key, { title: 'After remount', body: 'Campaign A work', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })!;
    expect(draft).not.toBeNull();
    const loads = f.loadDashboard.mock.calls.length;
    await act(async () => { finish(); await pending; await vi.advanceTimersByTimeAsync(0); });
    expect(resumeDraftHolder.resumeDraftIsCurrent(draft)).toBe(true);
    expect(resumeDraftHolder.readResumeDraft(key)).toBe(draft);
    expect(f.loadDashboard.mock.calls.length).toBe(loads);
  });
  //  round 1: a read's deadline belongs to its provider and login. After
  // unmount or sign-out it never fires; the read settles only when its own
  // request answers, and that late refusal retires nothing.
  for (const source of ['full', 'rail', 'pin']) {
    it.each(['unmount', 'sign-out'])(`cancels the ${source} read deadline on %s`, async end => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
      expect(resumeDraftHolder.writeResumeDraft(key, { title: 'Held', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })).not.toBeNull();
      let reject!: (error: unknown) => void;
      const held = new Promise<never>((_resolve, fail) => { reject = fail; });
      if (source === 'full') f.loadStaffScope.mockReturnValueOnce(held);
      else f.loadMemberships.mockReturnValueOnce(held);
      let settled = false;
      await act(async () => {
        const pending = source === 'rail' ? f.snapshot().refreshChapterMemberships()
          : source === 'pin' ? f.snapshot().setChapterPinned('chapter-a', true) : f.snapshot().refresh();
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
      });
      if (end === 'unmount') await act(async () => root.render(h('div')));
      else await act(async () => { f.authEvent('SIGNED_OUT', null); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS * 2); });
      expect(settled).toBe(false);
      await act(async () => { reject({ code: '42501' }); await vi.advanceTimersByTimeAsync(0); });
      expect(settled).toBe(true);
      // Its late refusal retires nothing for the next login: the 'remount'
      // and 'new login' guards above prove that with a replacement draft.
    });
  }
  it.each([new Error('Invalid payload'), { status: 401 }, { code: 'PGRST301' }])('does not let a newer unavailable answer suppress a late original permission refusal: %j', async newerError => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Refused', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
    const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
    let reject!: (error: unknown) => void;
    f.loadMemberships.mockReturnValueOnce(new Promise<never>((_resolve, fail) => { reject = fail; }));
    let pending!: Promise<unknown>;
    await act(async () => { pending = f.snapshot().refreshChapterMemberships().catch((error: unknown) => error); });
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
    f.loadMemberships.mockRejectedValueOnce(newerError);
    await act(async () => { await expect(f.snapshot().setChapterPinned('chapter-a', true)).rejects.toEqual(newerError); });
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
    await act(async () => { reject({ code: '42501' }); await vi.advanceTimersByTimeAsync(0); });
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
  });
  it.each(['rail', 'pin'])('a failed %s read during a full-load timeout stays concealed after the deadline and keeps the work', async source => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Before overlap', body: 'Held', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
    const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
    f.loadDashboard.mockImplementationOnce(() => new Promise(() => undefined));
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
    f.loadMemberships.mockRejectedValueOnce(new TypeError('Network request failed'));
    await act(async () => { await expect(source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true)).rejects.toThrow('Network request failed'); });
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
    // Only the full read timed out; the failed membership read settled false.
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
    await act(async () => { await f.snapshot().refresh(); });
    expect(resumeDraftHolder.readResumeDraft(key)?.value).toEqual(work);
  });
  it.each(['membership removal', 'chapter', 'staff roles', 'staff organization', 'malformed staff', 'malformed memberships'])('does not revive an old scope after a confirmed %s and sibling timeout', async change => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    f.loadStaffScope.mockResolvedValue({ organizationID: 'org-a', roles: ['admin'], chapterRoles: ['admin'], staffAuthorized: true });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const ticket = resumeDraftHolder.writeResumeDraft(key, { title: 'Old scope', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })!;
    f.loadDashboard.mockImplementationOnce(() => new Promise(() => undefined));
    if (change === 'membership removal') f.loadMemberships.mockResolvedValueOnce([]);
    if (change === 'chapter') f.loadMemberships.mockResolvedValueOnce([{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }]);
    if (change === 'staff roles') f.loadStaffScope.mockResolvedValueOnce({ organizationID: 'org-a', roles: [], chapterRoles: [], staffAuthorized: false });
    if (change === 'staff organization') f.loadStaffScope.mockResolvedValueOnce({ organizationID: 'org-b', roles: ['admin'], chapterRoles: ['admin'], staffAuthorized: true });
    let availabilityReported = false;
    if (change === 'malformed staff') f.loadStaffScope.mockImplementationOnce(async onReadAvailability => { onReadAvailability!(false); availabilityReported = true; return { organizationID: null, roles: [], chapterRoles: [], staffAuthorized: false }; });
    if (change === 'malformed memberships') f.loadMemberships.mockImplementationOnce(async onReadAvailability => { onReadAvailability!(false); availabilityReported = true; return []; });
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
    if (change === 'chapter') expect(f.snapshot().confirmedMembershipScope).toEqual([{ chapterID: 'chapter-b', organizationID: 'org-a' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
    if (change === 'chapter') expect(f.snapshot().confirmedMembershipScope).toEqual([{ chapterID: 'chapter-b', organizationID: 'org-a' }]);
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    expect(availabilityReported).toBe(change.startsWith('malformed'));
    //: nothing is restored, so a confirmed staff change only conceals
    // here; the next confirmed full answer with the new roles retires it.
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(change.startsWith('malformed') || change.startsWith('staff'));
    expect(resumeDraftHolder.writeResumeDraft(key, ticket.value)).toBeNull();
    if (change.startsWith('staff')) {
      f.loadStaffScope.mockResolvedValueOnce(change === 'staff roles'
        ? { organizationID: 'org-a', roles: [], chapterRoles: [], staffAuthorized: false }
        : { organizationID: 'org-b', roles: ['admin'], chapterRoles: ['admin'], staffAuthorized: true });
      await act(async () => { await f.snapshot().refresh(); });
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    }
  });
  it.each(['rail', 'full'])('ignores a timed-out %s read after another account signs in', async source => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const a = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Account A', body: 'A only', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
    const old = resumeDraftHolder.writeResumeDraft(a, work)!;
    let release!: () => void;
    f.loadMemberships.mockImplementationOnce(async () => {
      await new Promise<void>(done => { release = done; });
      return [{ chapterID: 'old-chapter', organizationID: 'old-org', selected: true }];
    });
    let pending!: Promise<unknown>;
    await act(async () => { pending = (source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().refresh()).catch((error: unknown) => error); });
    f.server.session = session('b');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const b = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const replacement = resumeDraftHolder.writeResumeDraft(b, { ...work, body: 'B only' });
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; release(); await vi.advanceTimersByTimeAsync(0); });
    expect(resumeDraftHolder.readResumeDraft(a)).toBeNull();
    expect(resumeDraftHolder.resumeDraftIsCurrent(old)).toBe(false);
    expect(resumeDraftHolder.readResumeDraft(b)).toBe(replacement);
    expect(f.snapshot().organizationID).toBe('org-b');
  });
  it('does not promote an unavailable staff fact when a later read times out', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const ticket = resumeDraftHolder.writeResumeDraft(key, { title: 'Unavailable scope', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null })!;
    f.loadStaffScope.mockRejectedValueOnce(new TypeError('Unavailable'));
    await act(async () => { await f.snapshot().refresh(); });
    f.loadStaffScope.mockImplementationOnce(() => new Promise(() => undefined));
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().refresh(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
    expect(f.snapshot().resumeDraftReads?.staff).toBe(false);
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
  });
  it.each(['rail', 'staff'])('keeps an authoritative %s refusal through the full-load timeout', async refused => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Refused', body: 'Protected', locale: 'en', audienceValue: 'chapter', warning: null, attempt: null };
    const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
    f.loadDashboard.mockImplementationOnce(() => new Promise(() => undefined));
    if (refused === 'staff') f.loadStaffScope.mockRejectedValueOnce({ status: 403 });
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
    if (refused === 'rail') {
      f.loadMemberships.mockRejectedValueOnce({ status: 403 });
      await act(async () => { await expect(f.snapshot().refreshChapterMemberships()).rejects.toEqual({ status: 403 }); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); await pending; });
    expect(refused === 'rail' ? f.snapshot().resumeDraftReads?.memberships : f.snapshot().resumeDraftReads?.staff).toBe(false);
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
    expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
  });
  for (const read of ['rail', 'pin', 'dashboard', 'memberships', 'staff', 'offline']) {
    it(`keeps held work concealed after a stalled ${read} read until the next confirmed full answer, retiring only a late confirmed removal`, async () => {
      native.platform = platform;
      let release!: () => void;
      const gate = new Promise<void>(done => { release = done; });
      let offlineStalled = false;
      const f = harness({ activateOfflineScope: async () => { if (offlineStalled) await gate; } });
      f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const attempt: resumeDraftHolder.NoticeResumeAttempt = { title: 'Keep my unknown send', body: 'Protected held body', locale: 'en', operationKey: 'unknown-send' };
      const work: resumeDraftHolder.NoticeResumeDraft = { ...attempt, audienceValue: 'chapter', attempt, warning: null };
      const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
      expect(ticket).not.toBeNull();
      const before = f.snapshot();
      if (['rail', 'pin', 'memberships'].includes(read)) f.loadMemberships.mockImplementationOnce(async () => {
        await gate;
        return [{ chapterID: 'late-chapter', organizationID: 'late-org', selected: true }];
      });
      if (read === 'dashboard') {
        const original = f.loadDashboard.getMockImplementation()!;
        f.loadDashboard.mockImplementationOnce(async id => {
          await gate;
          return { ...await original(id), member: { id, language: 'es', chapterId: 'late-chapter' } };
        });
      }
      if (read === 'staff') f.loadStaffScope.mockImplementationOnce(async () => {
        await gate;
        return { organizationID: 'late-org', roles: ['admin'], chapterRoles: ['admin'], staffAuthorized: true };
      });
      if (read === 'dues') f.loadDuesContext.mockImplementationOnce(async () => { await gate; return null; });
      if (read === 'offline') offlineStalled = true;
      let outcome: Promise<unknown>;
      await act(async () => {
        const pending = read === 'rail' ? f.snapshot().refreshChapterMemberships()
          : read === 'pin' ? f.snapshot().setChapterPinned('chapter-a', true) : f.snapshot().refresh();
        outcome = pending.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(readDeadline.READ_DEADLINE_MS); });
      //: the read ends at its deadline with the read error and restores
      // nothing: the held work stays concealed and kept.
      const ended = await outcome!;
      if (read === 'rail' || read === 'pin') expect(ended).toBeInstanceOf(readDeadline.ReadDeadlineError);
      else expect(f.snapshot().error).toContain('could not be loaded securely');
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      expect(f.snapshot().refreshing).toBe(false);
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
      expect(f.snapshot().chapterMemberships).toEqual(before.chapterMemberships);
      expect(f.snapshot().organizationID).toBe(before.organizationID);
      expect(f.snapshot().authorizedRoles).toEqual(before.authorizedRoles);
      expect(f.snapshot().confirmedMembershipScope).toEqual(before.confirmedMembershipScope);
      expect(f.snapshot().dashboard).toBe(before.dashboard);
      if (['rail', 'pin', 'memberships'].includes(read)) {
        expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
        expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
        expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
        return;
      }
      // The late answer publishes nothing and the work is still concealed and
      // kept; the next confirmed full answer brings it back.
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      await act(async () => { await f.snapshot().refresh(); });
      expect(resumeDraftHolder.readResumeDraft(key)?.value.attempt?.operationKey).toBe('unknown-send');
      // The same holder lookup used by the resume/discard owners is active
      // again. Continuing and explicitly discarding the held work both work.
      expect(resumeDraftHolder.writeResumeDraft(key, { ...work, body: 'Continued' })).not.toBeNull();
      resumeDraftHolder.retireResumeDraft(key);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    });
  }
  it.each(['write', 'read'])('preserves replacement offline notes when a retired login pin %s completes', async stage => {
    native.platform = platform;
    const offline = offlineHarness();
    const f = harness({ offline: offline.service });
    f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    if (stage === 'write') f.setMobileChapterPin.mockImplementationOnce(async () => { await held; });
    else f.loadMemberships.mockImplementationOnce(async () => {
      await held;
      return [{ chapterID: 'chapter-c', organizationID: 'org-a', selected: true }];
    });
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().setChapterPinned('chapter-b', true); });
    await act(async () => { f.authEvent('SIGNED_OUT', null); await vi.advanceTimersByTimeAsync(0); });
    f.server.session = session('a', '33333333-3333-4333-8333-333333333333');
    f.loadMemberships.mockResolvedValue([{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }]);
    const dashboard = f.loadDashboard.getMockImplementation()!;
    f.loadDashboard.mockImplementation(async userID => ({ ...await dashboard(userID), member: { id: userID, language: 'en', chapterId: 'chapter-b' } }));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const scope = { accountID: 'a', organizationID: 'org-a' };
    await offline.service.setOfflineAvailability(scope, true);
    const saved = await offline.service.saveOfflineLearningDraft(scope, { body: 'New login note: keep my work' });
    const authorizationKey = `${offlinePolicy.OFFLINE_STORAGE_PREFIX}.authorization`;
    expect(offline.store.get(authorizationKey)).toBe('33333333-3333-4333-8333-333333333333');
    expect(f.snapshot().offlineDraftsReady).toBe(true);
    f.channelRows.push('new-login-channel');
    const loads = f.loadDashboard.mock.calls.length;
    await act(async () => { release(); await pending; });
    const retained = await offline.service.readOfflineAvailability(scope);
    expect(retained.drafts).toEqual([saved.draft]);
    expect(retained.enabled).toBe(true);
    expect(offline.store.get(authorizationKey)).toBe('33333333-3333-4333-8333-333333333333');
    expect(f.loadDashboard).toHaveBeenCalledTimes(loads);
    expect(f.snapshot().chapterMemberships[0]?.chapterID).toBe('chapter-b');
    expect(f.snapshot().offlineDraftsReady).toBe(true);
    expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
    expect(f.channelRows).toEqual(['new-login-channel']);
  });
  it('keeps an already reconciled promoted workspace when a held pin write finishes', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let release!: () => void;
    f.setMobileChapterPin.mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().setChapterPinned('chapter-b', true); });
    f.loadMemberships.mockResolvedValue([{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }]);
    const original = f.loadDashboard.getMockImplementation()!;
    f.loadDashboard.mockImplementation(async userID => ({ ...await original(userID), member: { id: userID, language: 'en', chapterId: 'chapter-b' } }));
    f.loadStaffScope.mockResolvedValue({ organizationID: 'org-a', roles: ['admin'], chapterRoles: [], staffAuthorized: true });
    f.loadDuesContext.mockResolvedValue({ organizationId: 'org-a', chapterId: 'chapter-b', activeFinancialHat: 'admin' });
    await act(async () => { await f.snapshot().refresh(); });
    const reconciled = f.snapshot();
    f.channelRows.push('chapter-b-channel');
    const loads = f.loadDashboard.mock.calls.length;
    f.loadDashboard.mockRejectedValueOnce(new TypeError('Unnecessary reload must not run'));
    const settled = pending.then(() => null, (error: unknown) => error);
    let outcome: unknown;
    await act(async () => { release(); outcome = await settled; });
    expect(outcome).toBeNull();
    expect(f.loadDashboard).toHaveBeenCalledTimes(loads);
    expect(f.channelRows).toEqual(['chapter-b-channel']);
    expect(f.snapshot().dashboard).toBe(reconciled.dashboard);
    expect(f.snapshot().staffScopeAvailable).toBe(true);
    expect(f.snapshot().duesContext).toBe(reconciled.duesContext);
    expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
  });
  it.each([false, true])('reconciles the workspace when post-pin refresh promotes another campaign (reload failure=%s)', async failure => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    const initialDashboard = f.loadDashboard.getMockImplementation()!;
    f.loadDashboard.mockImplementation(async userID => {
      const dashboard = await initialDashboard(userID);
      return { ...dashboard, member: { ...dashboard.member, chapterID: 'chapter-a' } };
    });
    f.loadMemberships.mockResolvedValue([
      { chapterID: 'chapter-a', organizationID: 'org-a', selected: true },
      { chapterID: 'chapter-b', organizationID: 'org-a', selected: false },
    ]);
    f.loadStaffScope.mockResolvedValue({ organizationID: 'org-a', roles: ['admin'], chapterRoles: ['admin'], staffAuthorized: true });
    f.loadDuesContext.mockResolvedValue({ organizationId: 'org-a', chapterId: 'chapter-a', activeFinancialHat: 'admin' });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().dashboard?.member.chapterID).toBe('chapter-a');
    expect(f.snapshot().staffScopeAvailable).toBe(true);
    f.channelRows.push('chapter-a-channel');
    let finishWrite!: () => void;
    f.setMobileChapterPin.mockImplementationOnce(() => new Promise<void>(done => { finishWrite = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().setChapterPinned('chapter-b', true); });
    expect(f.setMobileChapterPin).toHaveBeenCalledWith('chapter-b', true);
    // The pin succeeded; an administrator revokes A before its follow-up read.
    f.loadMemberships.mockResolvedValue([{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true, pinned: true }]);
    f.loadStaffScope.mockResolvedValue({ organizationID: 'org-a', roles: ['admin'], chapterRoles: [], staffAuthorized: true });
    f.loadDuesContext.mockResolvedValue({ organizationId: 'org-a', chapterId: 'chapter-b', activeFinancialHat: 'admin' });
    let finishReload!: () => void;
    const reload = new Promise<void>(done => { finishReload = done; });
    const original = f.loadDashboard.getMockImplementation()!;
    f.loadDashboard.mockImplementationOnce(async userID => {
      await reload;
      if (failure) throw new TypeError('Promoted campaign reload failed');
      const dashboard = await original(userID);
      return { ...dashboard, member: { ...dashboard.member, chapterID: 'chapter-b' } };
    });
    // Attach the rejection handler before releasing the simulated network.
    const settled = pending.then(() => null, (error: unknown) => error);
    await act(async () => { finishWrite(); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().chapterMemberships.find(row => row.selected)?.chapterID).toBe('chapter-b');
    expect(f.snapshot().dashboard).toBeNull();
    expect(f.snapshot().staffScopeAvailable).toBe(false);
    expect(f.snapshot().chapterRoles).toEqual([]);
    expect(f.snapshot().duesContext).toBeNull();
    expect(f.channelRows).toEqual([]);
    expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(false);
    let outcome: unknown;
    await act(async () => { finishReload(); outcome = await settled; });
    if (failure) {
      expect(outcome).toBeInstanceOf(TypeError);
      expect(f.snapshot().dashboard).toBeNull();
      expect(f.snapshot().error).toContain('could not be loaded securely');
      expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(false);
      expect(resumeDraftHolder.writeResumeDraft(resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices'), {
        title: 'Cannot compose before reload', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null,
      })).toBeNull();
    } else {
      expect(outcome).toBeNull();
      expect(f.snapshot().dashboard?.member.chapterID).toBe('chapter-b');
      expect(f.snapshot().staffScopeAvailable).toBe(true);
      expect(f.snapshot().chapterRoles).toEqual([]);
        expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
      expect(resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')).not.toBeNull();
    }
  });
  const inputs = ['authorizedRoles', 'chapterRoles', 'organizationRoles', 'organizationID', 'chapterMemberships', 'chosenStaffRole', 'dashboard', 'assurance', 'session', 'mode', 'refreshing', 'staff fallback', 'membership fallback', 'organization fallback null'];
  for (const input of inputs) {
    it.each([false, true])(`waits for a confirmed ${input} answer (pending=%s)`, async pending => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      const staff: MobileStaffScope = { organizationID: input === 'organizationID' || input === 'organization fallback null' ? 'staff-org-a' : 'org-a', roles: ['admin', 'vp'], chapterRoles: ['admin', 'vp'], staffAuthorized: true };
      f.loadStaffScope.mockResolvedValue(staff);
      if (input === 'organization fallback null') f.loadMemberships.mockResolvedValue([{ chapterID: 'chapter-a', organizationID: null, selected: true }]);
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      if (input === 'chosenStaffRole') await act(async () => f.snapshot().chooseStaffRole('admin'));
      if (input === 'authorizedRoles') expect(f.snapshot().authorizedRoles).toContain('admin');
      if (input === 'chapterRoles') expect(f.snapshot().chapterRoles).toContain('admin');
      if (input === 'organizationRoles') expect(f.snapshot().organizationRoles).toContain('admin');
      if (input === 'organizationID' || input === 'organization fallback null') expect(f.snapshot().organizationID).toBe('staff-org-a');
      if (input === 'chosenStaffRole') expect(f.snapshot().chosenStaffRole).toBe('admin');
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      expect(key).not.toBeNull();
      const attempt: resumeDraftHolder.NoticeResumeAttempt = { title: 'Held scope draft', body: 'Unsent work', locale: 'en', operationKey: 'scope-operation' };
      const ticket = resumeDraftHolder.writeResumeDraft(key, { ...attempt, audienceValue: 'chapter', attempt, warning: null }, pending)!;
      let release: (() => void) | undefined;
      if (input === 'dashboard') f.loadDashboard.mockRejectedValueOnce(new TypeError('Dashboard unavailable'));
      else if (input === 'chapterMemberships' || input === 'refreshing') f.loadMemberships.mockRejectedValueOnce(new TypeError('Memberships unavailable'));
      else if (input === 'staff fallback') f.loadStaffScope.mockImplementationOnce(async onRead => {
        onRead?.(false); return { organizationID: null, roles: [], chapterRoles: [], staffAuthorized: false };
      });
      else if (input === 'membership fallback') f.loadMemberships.mockImplementationOnce(async onRead => { onRead?.(false); return []; });
      else if (input === 'assurance') f.sessionNeedsMfa.mockRejectedValueOnce(new TypeError('Assurance unavailable'));
      else if (input === 'session') f.getUser.mockRejectedValueOnce(new TypeError('Identity unavailable'));
      else if (input === 'mode') f.sessionNeedsMfa.mockImplementationOnce(() => new Promise<boolean>(done => { release = () => done(false); }));
      else f.loadStaffScope.mockRejectedValueOnce(new TypeError('Staff scope unavailable'));
      if (input === 'refreshing') await act(async () => { await f.snapshot().refresh(); });
      else if (input === 'session') {
        await act(async () => {
          native.currentState = 'background'; for (const listener of [...native.listeners]) listener('background');
        });
        await act(async () => {
          native.currentState = 'active'; for (const listener of [...native.listeners]) listener('active');
          await vi.advanceTimersByTimeAsync(0);
        });
      } else await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      if (['authorizedRoles', 'chapterRoles', 'organizationRoles', 'organizationID', 'chosenStaffRole', 'staff fallback', 'organization fallback null'].includes(input)) {
        expect(f.snapshot().dashboard).not.toBeNull();
        expect(f.snapshot().authorizedRoles).toEqual([]);
        expect(f.snapshot().staffScopeAvailable).toBe(false);
        expect(f.snapshot().resumeDraftReads?.staff).toBe(false);
        expect(f.snapshot().confirmedMembershipScope).toEqual([{
          chapterID: 'chapter-a', organizationID: input === 'organization fallback null' ? null : 'org-a',
        }]);
      }
      if (input === 'organizationID' || input === 'organization fallback null') {
        expect(f.snapshot().organizationID).toBe(input === 'organization fallback null' ? null : 'org-a');
        expect(f.snapshot().resumeDraftReads?.staff).toBe(false);
      }
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      expect(resumeDraftHolder.writeResumeDraft(key, { ...ticket.value, title: 'Must stay concealed' })).toBeNull();
      if (release) await act(async () => { release!(); await vi.advanceTimersByTimeAsync(0); });
      else await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      expect(resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')?.id).toBe(key.id);
      expect(f.snapshot().staffScopeAvailable).toBe(true);
      expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe('Held scope draft');
      expect(resumeDraftHolder.readResumeDraft(key)?.value.attempt?.operationKey).toBe('scope-operation');
      expect(resumeDraftHolder.readResumeDraft(key)?.pending).toBe(pending);
      expect(resumeDraftHolder.settleResumeDraft(ticket, null)).toBe(true);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    });
  }
  for (const loss of ['authorizedRoles', 'chapterRoles', 'organizationRoles', 'organizationID', 'chapterMemberships', 'chosenStaffRole', 'assurance', 'session', 'mode', 'missing memberships', 'missing organization', 'choice while unavailable', 'campaign while unavailable']) {
    it(`retires work and continuations for a confirmed ${loss} change`, async () => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      const staff: MobileStaffScope = { organizationID: 'org-a', roles: ['admin', 'vp'], chapterRoles: ['admin', 'vp'], staffAuthorized: true };
      f.loadStaffScope.mockResolvedValue(staff);
      // The profile still names A after membership revocation. A successful
      // empty membership read must win over this stale profile fallback.
      f.loadDashboard.mockImplementation(async userID => ({ member: { id: userID, language: 'en', chapterId: `chapter-${userID}`, chapterID: `chapter-${userID}` }, conversations: [], notifications: [], cases: [], actionLog: [] }));
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      if (loss === 'chosenStaffRole' || loss === 'choice while unavailable') await act(async () => f.snapshot().chooseStaffRole('admin'));
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const attempt: resumeDraftHolder.NoticeResumeAttempt = { title: 'Must be retired', body: 'Unsent work', locale: 'en', operationKey: 'retired-operation' };
      const ticket = resumeDraftHolder.writeResumeDraft(key, { ...attempt, audienceValue: 'chapter', attempt, warning: null }, true)!;
      expect(ticket).not.toBeNull();
      if (loss === 'choice while unavailable' || loss === 'campaign while unavailable') {
        f.loadStaffScope.mockRejectedValueOnce(new TypeError('Staff scope unavailable'));
        await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
        expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      }
      if (loss === 'chosenStaffRole' || loss === 'choice while unavailable') await act(async () => f.snapshot().chooseStaffRole('vp'));
      else if (loss === 'campaign while unavailable') {
        f.loadMemberships.mockResolvedValueOnce([{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }]);
        await act(async () => { await f.snapshot().refreshChapterMemberships(); });
      } else {
        if (loss === 'authorizedRoles') f.loadStaffScope.mockResolvedValueOnce({ ...staff, roles: [], chapterRoles: [], staffAuthorized: false });
        if (loss === 'chapterRoles') f.loadStaffScope.mockResolvedValueOnce({ ...staff, chapterRoles: [] });
        if (loss === 'organizationRoles') f.loadStaffScope.mockResolvedValueOnce({ ...staff, roles: [] });
        if (loss === 'organizationID') f.loadStaffScope.mockResolvedValueOnce({ ...staff, organizationID: 'org-b' });
        if (loss === 'chapterMemberships') f.loadMemberships.mockResolvedValueOnce([{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }]);
        if (loss === 'missing memberships') f.loadMemberships.mockResolvedValueOnce([]);
        if (loss === 'missing organization') {
          f.loadStaffScope.mockResolvedValueOnce({ ...staff, organizationID: null });
          f.loadMemberships.mockResolvedValueOnce([{ chapterID: 'chapter-a', organizationID: null, selected: true }]);
        }
        if (loss === 'assurance') f.sessionNeedsMfa.mockResolvedValueOnce(true);
        if (loss === 'session') f.server.session = session('b');
        await act(async () => { f.authEvent(loss === 'mode' ? 'SIGNED_OUT' : 'TOKEN_REFRESHED', loss === 'mode' ? null : f.server.session); await vi.advanceTimersByTimeAsync(0); });
      }
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      f.server.session = session('a');
      await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => f.snapshot().chooseStaffRole(null));
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.settleResumeDraft(ticket, ticket.value)).toBe(false);
    });
  }
  for (const read of ['dashboard', 'memberships', 'staff']) {
    it.each([false, true])(`keeps the ${read} read pending without binding old projections (manual=%s)`, async manual => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const attempt: resumeDraftHolder.NoticeResumeAttempt = { title: 'Pending scope read', body: 'Unsent work', locale: 'en', operationKey: 'pending-read-operation' };
      const ticket = resumeDraftHolder.writeResumeDraft(key, { ...attempt, audienceValue: 'chapter', attempt, warning: null }, true)!;
      let release!: () => void;
      const gate = new Promise<void>(done => { release = done; });
      if (read === 'dashboard') {
        const original = f.loadDashboard.getMockImplementation()!;
        f.loadDashboard.mockImplementationOnce(async id => { await gate; return original(id); });
      } else if (read === 'memberships') {
        const original = f.loadMemberships.getMockImplementation()!;
        f.loadMemberships.mockImplementationOnce(async available => { await gate; return original(available); });
      } else {
        const original = f.loadStaffScope.getMockImplementation()!;
        f.loadStaffScope.mockImplementationOnce(async available => { await gate; return original(available); });
      }
      let pending: Promise<void> | undefined;
      await act(async () => {
        if (manual) pending = f.snapshot().refresh();
        else f.authEvent('TOKEN_REFRESHED', f.server.session);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(f.snapshot().refreshing).toBe(true);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      await act(async () => { release(); await pending; await vi.advanceTimersByTimeAsync(0); });
      expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe('Pending scope read');
      expect(resumeDraftHolder.readResumeDraft(key)?.pending).toBe(true);
      expect(resumeDraftHolder.settleResumeDraft(ticket, null)).toBe(true);
    });
  }
  for (const load of ['cold', 'manual', 'token']) {
    for (const source of ['rail', 'pin']) {
      it.each([false, true])(`finishes a same-scope ${source} overlap during ${load} loading (full first=%s)`, async fullFirst => {
        native.platform = platform;
        const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
        await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
        if (load !== 'cold') await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
        const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Overlapping read', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
        const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
        const ticket = key ? resumeDraftHolder.writeResumeDraft(key, work) : null;
        if (load !== 'cold') expect(ticket).not.toBeNull();
        let releaseFull!: () => void;
        const fullGate = new Promise<void>(done => { releaseFull = done; });
        const dashboard = f.loadDashboard.getMockImplementation()!;
        f.loadDashboard.mockImplementationOnce(async id => { await fullGate; return dashboard(id); });
        let full: Promise<void> | undefined;
        await act(async () => {
          if (load === 'manual') full = f.snapshot().refresh();
          else f.authEvent(load === 'cold' ? 'SIGNED_IN' : 'TOKEN_REFRESHED', f.server.session);
          await vi.advanceTimersByTimeAsync(0);
        });
        let releaseMemberships!: () => void;
        const membershipGate = new Promise<void>(done => { releaseMemberships = done; });
        const memberships = f.loadMemberships.getMockImplementation()!;
        f.loadMemberships.mockImplementationOnce(async available => { await membershipGate; return memberships(available); });
        let standalone!: Promise<void>;
        await act(async () => {
          standalone = source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true);
          await vi.advanceTimersByTimeAsync(0);
        });
        if (fullFirst) {
          await act(async () => { releaseFull(); await full; await vi.advanceTimersByTimeAsync(0); });
          await act(async () => { releaseMemberships(); await standalone; });
        } else {
          await act(async () => { releaseMemberships(); await standalone; });
          await act(async () => { releaseFull(); await full; await vi.advanceTimersByTimeAsync(0); });
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(f.snapshot().refreshing).toBe(false);
        expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
        const restored = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
        expect(restored).not.toBeNull();
        if (ticket) {
          expect(restored?.id).toBe(key?.id);
          expect(resumeDraftHolder.readResumeDraft(restored)?.value.title).toBe(work.title);
          expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
        }
        expect(resumeDraftHolder.writeResumeDraft(restored, { ...work, title: 'Still editable' })).not.toBeNull();
      });
    }
  }
  it('rereads an acknowledged pin after a full reload overtakes its write', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    let pinned = false;
    f.loadMemberships.mockImplementation(async () => [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true, pinned }]);
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    f.setMobileChapterPin.mockImplementationOnce(async () => { await gate; pinned = true; });
    let write!: Promise<void>;
    await act(async () => { write = f.snapshot().setChapterPinned('chapter-a', true); });
    await act(async () => { await f.snapshot().refresh(); });
    expect(f.snapshot().chapterMemberships[0]?.pinned).toBe(false);
    const reads = f.loadMemberships.mock.calls.length;
    await act(async () => { release(); await write; });
    expect(f.loadMemberships).toHaveBeenCalledTimes(reads + 1);
    expect(f.snapshot().chapterMemberships[0]?.pinned).toBe(true);
    expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
  });
  it.each<[string, boolean]>([['write', false], ['write', true], ['read', false], ['read', true]])('keeps a replacement account intact when an old pin %s finishes (read fails=%s)', async (stage, fails) => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    if (stage === 'write') f.setMobileChapterPin.mockImplementationOnce(async () => { await gate; });
    else f.loadMemberships.mockImplementationOnce(async () => {
      await gate;
      if (fails) throw { status: 403 };
      return [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }];
    });
    let write!: Promise<void>;
    await act(async () => { write = f.snapshot().setChapterPinned('chapter-a', true); });
    f.server.session = session('b');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Replacement work', body: 'B only', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
    const ticket = resumeDraftHolder.writeResumeDraft(key, work, true)!;
    const reads = f.loadMemberships.mock.calls.length;
    await act(async () => { release(); if (fails && stage === 'read') await expect(write).rejects.toEqual({ status: 403 }); else await write; });
    //  final (r3s1, r4s1): an old login's pin write that returns after
    // the replacement signed in starts no read and arms no deadline (Main read
    // once and published nothing). A read already under way finishes as before.
    expect(f.loadMemberships).toHaveBeenCalledTimes(reads);
    expect(f.snapshot().chapterMemberships[0]?.chapterID).toBe('chapter-b');
    expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
    expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe(work.title);
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
  });
  it.each([false, true])('uses confirmed ownership for chapter-switch intent after a fallback (changed=%s)', async changed => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Held through fallback', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
    const ticket = resumeDraftHolder.writeResumeDraft(key, work, true)!;
    f.loadMemberships.mockImplementationOnce(async available => { available?.(false); return []; });
    await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().chapterMemberships).toEqual([]);
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
    f.loadDashboard.mockRejectedValueOnce(new TypeError('Refresh unavailable'));
    await act(async () => { await expect(f.snapshot().switchChapter(changed ? 'chapter-b' : 'chapter-a')).rejects.toThrow('could not refresh'); });
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(!changed);
    await act(async () => { await f.snapshot().refresh(); });
    expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe(changed ? undefined : work.title);
  });
  for (const source of ['rail', 'pin']) {
    //: no read restores; a failed rail or pin read conceals and keeps
    // the work until the next settled answer (Main restored the last settled
    // membership fact after any non-authoritative failure).
    it.each([false, true])(`conceals and keeps work after a failed ${source} read until the next settled answer (pending=%s)`, async pending => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Standalone read', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
      const ticket = resumeDraftHolder.writeResumeDraft(key, work, pending)!;
      const refresh = () => source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true);
      f.loadMemberships.mockRejectedValueOnce(new TypeError('Network request failed'));
      await act(async () => { await expect(refresh()).rejects.toThrow('Network request failed'); });
      expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(false);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      expect(resumeDraftHolder.writeResumeDraft(key, { ...work, title: 'Must stay concealed' })).toBeNull();
      await act(async () => { await refresh(); });
      expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe(work.title);
      expect(resumeDraftHolder.readResumeDraft(key)?.pending).toBe(pending);
      if (!pending) expect(resumeDraftHolder.writeResumeDraft(key, { ...work, title: 'Still editable' })).not.toBeNull();
    });
    it.each([{ code: '42501' }, { status: 403 }])(`retires a current authoritative ${source} refusal: %j`, async refusal => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Refused work', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
      const ticket = resumeDraftHolder.writeResumeDraft(key, work, true)!;
      f.loadMemberships.mockRejectedValueOnce(refusal);
      await act(async () => { await expect(source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true)).rejects.toEqual(refusal); });
      expect(f.snapshot().resumeDraftReads?.memberships).toBe(false);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
      await act(async () => { await f.snapshot().refresh(); });
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.settleResumeDraft(ticket, work)).toBe(false);
    });
    it(`does not publish a stale account's ${source} blip`, async () => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      let release!: () => void;
      const gate = new Promise<void>(done => { release = done; });
      f.loadMemberships.mockImplementationOnce(async () => { await gate; throw new TypeError('Stale network blip'); });
      let read!: Promise<void>;
      await act(async () => { read = source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true); });
      f.server.session = session('b');
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Replacement work', body: 'B only', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
      const ticket = resumeDraftHolder.writeResumeDraft(key, work, true)!;
      const facts = f.snapshot().resumeDraftReads;
      await act(async () => { release(); await expect(read).rejects.toThrow('Stale network blip'); });
      expect(f.snapshot().resumeDraftReads).toBe(facts);
      expect(f.snapshot().chapterMemberships[0]?.chapterID).toBe('chapter-b');
      expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe(work.title);
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
    });
    it(`does not promote an unknown membership fact after a ${source} blip`, async () => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Unknown membership', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
      const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
      f.loadMemberships.mockImplementationOnce(async available => { available?.(false); return []; });
      await act(async () => { await f.snapshot().refresh(); });
      expect(f.snapshot().resumeDraftReads?.memberships).toBe(false);
      f.loadMemberships.mockRejectedValueOnce(new TypeError('Network request failed'));
      await act(async () => { await expect(source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true)).rejects.toThrow('Network request failed'); });
      expect(f.snapshot().resumeDraftReads?.memberships).toBe(false);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
    });
    // RULING 9359-DEADLINE-ONLY: the failure is the latest answer; it conceals and keeps.
    it(`conceals and keeps work when a pending ${source} read fails after a full answer`, async () => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Fresh full answer', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
      const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
      let releaseFull!: () => void;
      const fullGate = new Promise<void>(done => { releaseFull = done; });
      const dashboard = f.loadDashboard.getMockImplementation()!;
      f.loadDashboard.mockImplementationOnce(async id => { await fullGate; return dashboard(id); });
      let full!: Promise<void>;
      await act(async () => { full = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
      let releaseRead!: () => void;
      const readGate = new Promise<void>(done => { releaseRead = done; });
      f.loadMemberships.mockImplementationOnce(async () => { await readGate; throw new TypeError('Network request failed'); });
      let read!: Promise<void>;
      await act(async () => { read = source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true); });
      await act(async () => { releaseFull(); await full; });
      expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
      await act(async () => { releaseRead(); await expect(read).rejects.toThrow('Network request failed'); });
      expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(false);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      await act(async () => { await f.snapshot().refresh(); });
      expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe(work.title);
    });
  }
  it.each<[boolean, boolean]>([[false, false], [true, false], [false, true], [true, true]])('keeps the latest overlapping rail/pin result (latest first=%s, refused=%s)', async (latestFirst, refused) => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Overlapping blips', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
    const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
    let releaseRail!: () => void; let releasePin!: () => void;
    const railGate = new Promise<void>(done => { releaseRail = done; });
    const pinGate = new Promise<void>(done => { releasePin = done; });
    f.loadMemberships.mockImplementationOnce(async () => { await railGate; throw new TypeError('Network request failed'); });
    let rail!: Promise<void>; let pin!: Promise<void>;
    await act(async () => { rail = f.snapshot().refreshChapterMemberships(); });
    f.loadMemberships.mockImplementationOnce(async () => { await pinGate; throw Object.assign(new TypeError('Network request failed'), refused ? { status: 403 } : {}); });
    await act(async () => { pin = f.snapshot().setChapterPinned('chapter-a', true); });
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    if (latestFirst) {
      await act(async () => { releasePin(); await expect(pin).rejects.toThrow('Network request failed'); });
      await act(async () => { releaseRail(); await expect(rail).rejects.toThrow('Network request failed'); });
    } else {
      await act(async () => { releaseRail(); await expect(rail).rejects.toThrow('Network request failed'); });
      await act(async () => { releasePin(); await expect(pin).rejects.toThrow('Network request failed'); });
    }
    // RULING 9359-DEADLINE-ONLY: failed reads conceal (Main restored after
    // non-authoritative ones); only the authoritative refusal retires.
    expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(false);
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(!refused);
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
    await act(async () => { await f.snapshot().refresh(); });
    expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe(refused ? undefined : work.title);
  });
  const membershipPair = async (olderSource: string, kind: string, newerSucceeds: boolean, fullPending = false) => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    f.loadStaffScope.mockResolvedValue({ organizationID: 'org-a', roles: ['admin'], chapterRoles: ['admin'], staffAuthorized: true });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Superseded work', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
    const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
    expect(ticket).not.toBeNull();
    let releaseFull!: () => void; let full: Promise<void> | undefined;
    if (fullPending) {
      const gate = new Promise<void>(done => { releaseFull = done; });
      const dashboard = f.loadDashboard.getMockImplementation()!;
      f.loadDashboard.mockImplementationOnce(async id => { await gate; return dashboard(id); });
      await act(async () => { full = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
    }
    let releaseOlder!: () => void; let releaseNewer!: () => void;
    const olderGate = new Promise<void>(done => { releaseOlder = done; });
    const newerGate = new Promise<void>(done => { releaseNewer = done; });
    const refusal = kind === '403' ? { status: 403 } : { code: '42501' };
    f.loadMemberships.mockImplementationOnce(async () => {
      await olderGate;
      if (kind === '403' || kind === '42501') throw refusal;
      return [{ chapterID: kind === 'chapter' ? 'chapter-b' : 'chapter-a', organizationID: kind === 'organization' ? 'org-b' : 'org-a', selected: true }];
    });
    const read = (source: string) => source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true);
    let older!: Promise<void>; let newer!: Promise<void>;
    await act(async () => { older = read(olderSource); });
    f.loadMemberships.mockImplementationOnce(async () => {
      await newerGate;
      if (!newerSucceeds) throw new TypeError('Network request failed');
      return [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }];
    });
    await act(async () => { newer = read(olderSource === 'rail' ? 'pin' : 'rail'); });
    const olderDone = () => act(async () => {
      releaseOlder();
      if (kind === '403' || kind === '42501') await expect(older).rejects.toEqual(refusal);
      else await older;
    });
    const newerDone = () => act(async () => {
      releaseNewer();
      if (newerSucceeds) await newer;
      else await expect(newer).rejects.toThrow('Network request failed');
    });
    const fullDone = () => act(async () => { releaseFull(); await full; });
    const retired = () => {
      expect(f.snapshot().resumeDraftReads?.memberships).toBe(false);
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
      expect(resumeDraftHolder.settleResumeDraft(ticket, work)).toBe(false);
    };
    const usable = () => {
      expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(true);
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe(work.title);
      expect(resumeDraftHolder.writeResumeDraft(key, { ...work, title: 'Still editable' })).not.toBeNull();
    };
    return { f, key, olderDone, newerDone, fullDone, retired, usable };
  };
  for (const olderSource of ['rail', 'pin']) {
    for (const kind of ['403', '42501', 'chapter', 'organization']) {
      it.each([true, false])(`honors a superseded ${olderSource} ${kind} before a newer blip (older first=%s)`, async olderFirst => {
        const pair = await membershipPair(olderSource, kind, false);
        if (olderFirst) { await pair.olderDone(); await pair.newerDone(); }
        else { await pair.newerDone(); await pair.olderDone(); }
        pair.retired();
        await act(async () => { await pair.f.snapshot().refresh(); });
        expect(resumeDraftHolder.readResumeDraft(pair.key)).toBeNull();
      });
      it(`keeps a newer successful answer over a late ${olderSource} ${kind}`, async () => {
        const pair = await membershipPair(olderSource, kind, true);
        await pair.newerDone(); await pair.olderDone(); pair.usable();
      });
      it(`does not count an older full read as the newer answer over ${olderSource} ${kind}`, async () => {
        const pair = await membershipPair(olderSource, kind, false, true);
        await pair.fullDone(); await pair.olderDone(); await pair.newerDone(); pair.retired();
      });
      it(`keeps a newer success valid through an older full answer and late ${olderSource} ${kind}`, async () => {
        const pair = await membershipPair(olderSource, kind, true, true);
        await pair.newerDone(); await pair.fullDone(); await pair.olderDone(); pair.usable();
      });
    }
  }
  for (const source of ['rail', 'pin']) {
    it.each([{ status: 403 }, { code: '42501' }])(`does not republish an older full scope over a current ${source} refusal: %j`, async refusal => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      f.loadStaffScope.mockResolvedValue({ organizationID: 'org-a', roles: ['admin'], chapterRoles: ['admin'], staffAuthorized: true });
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Refused during full read', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
      const ticket = resumeDraftHolder.writeResumeDraft(key, work, true)!;
      let release!: () => void;
      const gate = new Promise<void>(done => { release = done; });
      const dashboard = f.loadDashboard.getMockImplementation()!;
      f.loadDashboard.mockImplementationOnce(async id => { await gate; return dashboard(id); });
      let full!: Promise<void>;
      await act(async () => { full = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
      f.loadMemberships.mockRejectedValueOnce(refusal);
      await act(async () => { await expect(source === 'rail' ? f.snapshot().refreshChapterMemberships() : f.snapshot().setChapterPinned('chapter-a', true)).rejects.toEqual(refusal); });
      await act(async () => { release(); await full; });
      expect(resumeDraftHolder.resumeDraftReadsConfirmed(f.snapshot())).toBe(false);
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.writeResumeDraft(key, work)).toBeNull();
    });
  }
  it.each<[string, string]>([['pin', 'chapter'], ['pin', 'organization'], ['rail', 'organization']])(
    'does not use previous sibling reads after a confirmed %s %s change before a successful full reload', async (source, changed) => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Previous scope work', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
      const ticket = resumeDraftHolder.writeResumeDraft(key, work, true)!;
      f.loadMemberships.mockResolvedValueOnce([{ chapterID: changed === 'chapter' ? 'chapter-b' : 'chapter-a', organizationID: 'org-b', selected: true }]);
      if (source === 'pin' && changed === 'chapter') f.loadDashboard.mockRejectedValueOnce(new TypeError('New campaign temporarily unavailable'));
      await act(async () => {
        if (source === 'pin' && changed === 'chapter') await expect(f.snapshot().setChapterPinned('chapter-a', true)).rejects.toThrow('New campaign temporarily unavailable');
        else if (source === 'pin') await f.snapshot().setChapterPinned('chapter-a', true);
        else await f.snapshot().refreshChapterMemberships();
      });
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
      expect(f.snapshot().resumeDraftReads?.dashboard).toBe(false);
      expect(f.snapshot().resumeDraftReads?.staff).toBe(false);
      expect(resumeDraftHolder.writeResumeDraft(resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices'), work)).toBeNull();
      await act(async () => { await f.snapshot().refresh(); });
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.settleResumeDraft(ticket, work)).toBe(false);
    },
  );
  it('does not publish an older full read over a newer standalone membership answer', async () => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const original = f.loadDashboard.getMockImplementation()!;
    f.loadDashboard.mockImplementationOnce(async id => { await gate; return original(id); });
    let pending!: Promise<void>;
    await act(async () => { pending = f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
    f.loadMemberships.mockResolvedValueOnce([{ chapterID: 'chapter-a', organizationID: 'org-b', selected: true }]);
    await act(async () => { await f.snapshot().setChapterPinned('chapter-a', true); });
    await act(async () => { release(); await pending; });
    expect(f.snapshot().resumeDraftReads?.dashboard).toBe(false);
    expect(f.snapshot().resumeDraftReads?.memberships).toBe(false);
    expect(f.snapshot().resumeDraftReads?.staff).toBe(false);
    const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Mixed reads', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null };
    expect(resumeDraftHolder.writeResumeDraft(resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices'), work)).toBeNull();
  });
  it.each([false, true])('ignores an old account scope completion after replacement (failure=%s)', async failure => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    f.loadStaffScope.mockImplementationOnce(async () => {
      await gate; if (failure) throw new TypeError('Old scope failure');
      return { organizationID: 'org-a', roles: [], chapterRoles: [], staffAuthorized: false };
    });
    await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    f.server.session = session('b');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
    expect(key).not.toBeNull();
    const ticket = resumeDraftHolder.writeResumeDraft(key, { title: 'Replacement work', body: 'B only', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null }, true)!;
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().session?.user.id).toBe('b');
    expect(f.snapshot().organizationID).toBe('org-b');
    expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe('Replacement work');
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
  });
  for (const read of ['dashboard', 'memberships', 'staff']) {
    it.each([{ code: '42501' }, { status: 403 }])(`retires an authoritative ${read} refusal permanently: %j`, async refusal => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      const ticket = resumeDraftHolder.writeResumeDraft(key, { title: 'Retire refused work', body: 'Unsent', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null }, true)!;
      if (read === 'dashboard') f.loadDashboard.mockRejectedValueOnce(refusal);
      else if (read === 'memberships') f.loadMemberships.mockRejectedValueOnce(refusal);
      else f.loadStaffScope.mockRejectedValueOnce(refusal);
      await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(false);
      await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    });
  }
});

describe('mounted shared native session outage recovery', () => {
  it.each<[string, boolean]>([['android', false], ['ios', false], ['android', true], ['ios', true]])(
    'keeps same-person work concealed after a fast failed token reload on %s (pending=%s)', async (platform, pending) => {
      native.platform = platform;
      const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
      await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
      expect(key).not.toBeNull();
      const attempt: resumeDraftHolder.NoticeResumeAttempt = { title: 'Held provider draft', body: 'Unsent work', locale: 'en', operationKey: 'provider-operation' };
      const ticket = resumeDraftHolder.writeResumeDraft(key, { ...attempt, audienceValue: 'chapter', attempt, warning: null }, pending)!;
      expect(ticket).not.toBeNull();
      f.loadDashboard.mockRejectedValueOnce(new TypeError('Transient network failure'));
      await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
      expect(f.snapshot().mode).toBe('authenticated'); expect(f.snapshot().refreshing).toBe(false);
      expect(f.snapshot().dashboard).toBeNull(); expect(f.snapshot().organizationID).toBeNull();
      expect(f.snapshot().error).toBe('Your worker workspace could not be loaded securely. Check your connection and try again.');
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
      expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
      expect(resumeDraftHolder.writeResumeDraft(key, { ...ticket.value, title: 'Cannot overwrite concealed work' })).toBeNull();
      await act(async () => { await f.snapshot().refresh(); await vi.advanceTimersByTimeAsync(0); });
      expect(resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')?.id).toBe(key.id);
      expect(resumeDraftHolder.readResumeDraft(key)?.value.title).toBe('Held provider draft');
      expect(resumeDraftHolder.readResumeDraft(key)?.value.attempt?.operationKey).toBe('provider-operation');
      expect(resumeDraftHolder.readResumeDraft(key)?.pending).toBe(pending);
      expect(resumeDraftHolder.settleResumeDraft(ticket, null)).toBe(true);
      expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    },
  );
  it.each(['android', 'ios'])('R1 bootstrap: preserves a pending draft through actual incomplete establishment on %s', async platform => {
    native.platform = platform;
    const f = harness(); f.sessionNeedsMfa.mockResolvedValue(false); f.server.available = true;
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices')!;
    expect(key).not.toBeNull();
    const attempt: resumeDraftHolder.NoticeResumeAttempt = { title: 'Held provider draft', body: 'Unsent work', locale: 'en', operationKey: 'provider-operation' };
    const ticket = resumeDraftHolder.writeResumeDraft(key, { ...attempt, audienceValue: 'chapter', attempt, warning: null }, true)!;
    f.loadDashboard.mockImplementationOnce(async userID => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return { member: { id: userID, language: 'en', chapterId: `chapter-${userID}` }, conversations: [], notifications: [], cases: [], actionLog: [] };
    });
    await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().mode).toBe('authenticated'); expect(f.snapshot().dashboard).toBeNull();
    expect(f.snapshot().refreshing).toBe(true);
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
    expect(resumeDraftHolder.resumeDraftIsCurrent(ticket)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(resumeDraftHolder.readResumeDraft(key)?.pending).toBe(true);
    expect(resumeDraftHolder.readResumeDraft(key)?.value.attempt?.operationKey).toBe('provider-operation');
    expect(resumeDraftHolder.settleResumeDraft(ticket, null)).toBe(true);
    expect(resumeDraftHolder.readResumeDraft(key)).toBeNull();
  });
  it.each<[string, string, number]>([
    ['android', 'dashboard', 11_000], ['ios', 'dashboard', 11_000],
    ['android', 'offline scope', 11_000], ['ios', 'offline scope', 11_000],
    ['android', 'dashboard', 41_000], ['ios', 'dashboard', 41_000],
  ])('eventually opens a persistently slow %s %s (%i ms), including token rotations', async (platform, stage, delay) => {
    native.platform = platform;
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    f.server.available = true;
    if (stage === 'dashboard') {
      f.loadDashboard.mockImplementation(async userID => {
        await new Promise(resolve => setTimeout(resolve, delay));
        return { member: { id: userID, language: 'en', chapterId: `chapter-${userID}` }, conversations: [], notifications: [], cases: [], actionLog: [] };
      });
    } else {
      f.activateOfflineScope.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, delay));
      });
    }
    let rotation = 0;
    f.refreshSession.mockImplementation(async () => {
      f.server.session = { ...f.server.session,
        access_token: `header.${btoa(JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', rotation: ++rotation }))}.signature`,
        refresh_token: `test-rotation-${rotation}`,
      };
      f.authEvent('TOKEN_REFRESHED', f.server.session);
      return { data: { session: f.server.session }, error: null };
    });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(f.snapshot().mode).toBe('mfaRequired');
    expect(f.snapshot().privacyCovered).toBe(false);
    expect(f.snapshot().dashboard).toBeNull();
    for (let elapsed = 10_000; elapsed < 240_000 && !f.snapshot().dashboard; elapsed += 10_000) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    }
    expect(f.snapshot().dashboard?.member.id).toBe('a');
    expect(f.snapshot().organizationID).toBe('org-a');
    expect(f.snapshot().mode).toBe('authenticated');
    expect(f.snapshot().privacyCovered).toBe(false);
    expect(f.snapshot().sessionRetryBusy).toBe(false);
    const attempts = f.refreshSession.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(f.refreshSession).toHaveBeenCalledTimes(attempts);
  });

  it.each(['b', 'a'])('rejects a persistently slow previous account/session after replacement by %s', async userID => {
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    f.server.available = true;
    f.loadDashboard.mockImplementation(async userID => {
      await new Promise(resolve => setTimeout(resolve, 11_000));
      return { member: { id: userID, language: 'en', chapterId: `chapter-${userID}` }, conversations: [], notifications: [], cases: [], actionLog: [] };
    });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    f.server.session = session(userID, '33333333-3333-4333-8333-333333333333');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    // The old recovery finishes while the replacement is still loading.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(f.snapshot().dashboard).toBeNull();
    expect(f.snapshot().organizationID).toBeNull();
    expect(f.snapshot().sessionRetryBusy).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    // A replacement login receives its own initial ten-second budget.
    expect(f.snapshot().mode).toBe('mfaRequired');
    expect(f.snapshot().dashboard).toBeNull();
    for (let elapsed = 0; elapsed < 100_000 && !f.snapshot().dashboard; elapsed += 10_000) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    }
    expect(f.snapshot().dashboard?.member.id).toBe(userID);
    expect(f.snapshot().organizationID).toBe(`org-${userID}`);
    expect(f.snapshot().mode).toBe('authenticated');
  });

  it.each(['background', 'inactive', 'sign-out'])('releases a held automatic retry immediately on %s and protects its replacement owner', async boundary => {
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const held: Array<() => void> = [];
    f.getUser.mockImplementation(() => new Promise(resolve => {
      const user = f.server.session.user;
      held.push(() => resolve({ data: { user }, error: null }));
    }));
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.snapshot().sessionRetryBusy).toBe(true);
    await act(async () => {
      if (boundary === 'sign-out') f.authEvent('SIGNED_OUT', null);
      else {
        native.currentState = boundary;
        for (const listener of [...native.listeners]) listener(boundary);
      }
    });
    expect(f.snapshot().sessionRetryBusy).toBe(false);
    await act(async () => {
      if (boundary === 'sign-out') {
        // Same tuple deliberately: a stale ref must not become busy again.
        f.authEvent('SIGNED_IN', f.server.session);
        await vi.advanceTimersByTimeAsync(0);
      } else {
        native.currentState = 'active';
        for (const listener of [...native.listeners]) listener('active');
      }
    });
    expect(f.snapshot().sessionRetryBusy).toBe(false);
    let replacement!: Promise<boolean>;
    await act(async () => { replacement = f.snapshot().retrySessionAuthentication(); });
    expect(f.snapshot().sessionRetryBusy).toBe(true);
    await act(async () => held[0]!());
    expect(f.snapshot().sessionRetryBusy).toBe(true);
    expect(f.snapshot().dashboard).toBeNull();
    await act(async () => { held.at(-1)!(); await replacement; });
    expect(f.snapshot().sessionRetryBusy).toBe(false);
    expect(f.snapshot().dashboard?.member.id).toBe('a');
  });

  it.each(['android', 'ios'])('publishes the automatic retry busy state through token rotation on %s', async platform => {
    native.platform = platform;
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    let finish!: () => void;
    f.getUser.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ data: { user: f.server.session.user }, error: null });
    }));
    f.server.session = { ...f.server.session,
      access_token: `header.${btoa(JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', rotation: 1 }))}.signature`,
      refresh_token: 'test-rotated-refresh',
    };
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.snapshot().sessionRetryBusy).toBe(true);
    expect(f.snapshot().privacyCovered).toBe(true);
    await act(async () => finish());
    expect(f.snapshot().sessionRetryBusy).toBe(false);
    expect(f.snapshot().mode).toBe('authenticated');
  });

  it.each(['android', 'ios'])('bounds the first dashboard before automatic recovery and rejects its late data on %s', async platform => {
    native.platform = platform;
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    const firstDashboard = { member: { id: 'a', language: 'en', chapterId: 'chapter-a' }, conversations: [], notifications: [], cases: [], actionLog: [] };
    let finish!: () => void;
    f.loadDashboard.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(firstDashboard); }));
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(f.snapshot().privacyCovered).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(f.snapshot().privacyCovered).toBe(false);
    expect(f.snapshot().assuranceUnavailable).toBe(true);
    expect(f.snapshot().mode).toBe('mfaRequired');
    expect(f.snapshot().dashboard).toBeNull();
    expect(f.snapshot().organizationID).toBeNull();
    expect(f.refreshSession).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(f.snapshot().dashboard).toBeNull();
    expect(f.snapshot().organizationID).toBeNull();
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(f.refreshSession).toHaveBeenCalledOnce();
    expect(f.snapshot().dashboard?.member.id).toBe('a');
  });

  it('keeps a first dashboard that completes within the deadline and stops recovery', async () => {
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    let finish!: () => void;
    f.loadDashboard.mockImplementationOnce(async userID => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { member: { id: userID, language: 'en', chapterId: `chapter-${userID}` }, conversations: [], notifications: [], cases: [], actionLog: [] };
    });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); finish(); });
    expect(f.snapshot().mode).toBe('authenticated');
    expect(f.snapshot().privacyCovered).toBe(false);
    expect(f.snapshot().dashboard?.member.id).toBe('a');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(f.refreshSession).not.toHaveBeenCalled();
  });

  it.each(['b', 'a'])('does not expire or mark a replacement session busy (next user %s)', async userID => {
    const f = harness();
    f.sessionNeedsMfa.mockResolvedValue(false);
    let finish!: () => void;
    f.loadDashboard.mockImplementationOnce(async userID => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { member: { id: userID, language: 'en', chapterId: `chapter-${userID}` }, conversations: [], notifications: [], cases: [], actionLog: [] };
    });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    f.server.session = session(userID, '33333333-3333-4333-8333-333333333333');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); finish(); });
    expect(f.snapshot().mode).toBe('authenticated');
    expect(f.snapshot().sessionRetryBusy).toBe(false);
    expect(f.snapshot().dashboard?.member.id).toBe(userID);
    expect(f.snapshot().organizationID).toBe(`org-${userID}`);
    expect(f.snapshot().assuranceUnavailable).toBe(false);
  });

  it.each(['android', 'ios'])('recovers a hung session check without a relaunch on %s', async platform => {
    native.platform = platform;
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    expect(f.snapshot().privacyCovered).toBe(true);
    expect(f.snapshot().dashboard).toBeNull();
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.refreshSession).toHaveBeenCalledOnce();
    expect(f.snapshot().privacyCovered).toBe(false);
    expect(f.snapshot().dashboard?.member.id).toBe('a');
    await act(async () => f.finishOldCheck());
    expect(f.loadDashboard).toHaveBeenCalledOnce();
  });

  it.each(['android', 'ios'])('paces retries while unavailable and recovers when service returns on %s', async platform => {
    native.platform = platform;
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(f.refreshSession).toHaveBeenCalledTimes(2);
    expect(f.snapshot().assuranceUnavailable).toBe(true);
    expect(f.snapshot().dashboard).toBeNull();
    expect(f.snapshot().organizationID).toBeNull();
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.snapshot().mode).toBe('authenticated');
    expect(f.snapshot().organizationID).toBe('org-a');
    expect(f.loadDashboard).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(f.refreshSession).toHaveBeenCalledTimes(3);
  });

  it.each(['android', 'ios'])('stops retrying in the background and revalidates on foreground on %s', async platform => {
    native.platform = platform;
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => {
      native.currentState = 'background';
      for (const listener of [...native.listeners]) listener('background');
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(f.refreshSession).not.toHaveBeenCalled();
    expect(f.snapshot().dashboard).toBeNull();
    f.server.available = true;
    await act(async () => {
      native.currentState = 'active';
      for (const listener of [...native.listeners]) listener('active');
    });
    expect(f.snapshot().mode).toBe('authenticated');
    expect(f.snapshot().dashboard?.member.id).toBe('a');
  });

  it.each(['android', 'ios'])('cancels scheduled and late establishment work on unmount on %s', async platform => {
    native.platform = platform;
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => root.unmount());
    root = createRoot(container);
    f.server.available = true;
    await act(async () => { f.finishOldCheck(); await vi.advanceTimersByTimeAsync(120_000); });
    expect(f.refreshSession).not.toHaveBeenCalled();
    expect(f.loadDashboard).not.toHaveBeenCalled();
  });

  it.each(['b', 'a'])('does not restore a replaced account/session when its old check finishes (next user %s)', async userID => {
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const oldOwner = f.snapshot().captureAccountSessionGuard('a');
    f.server.session = session(userID, '33333333-3333-4333-8333-333333333333');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    expect(oldOwner()).toBe(false);
    expect(f.snapshot().dashboard).toBeNull();
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await act(async () => f.finishOldCheck());
    expect(f.loadDashboard).toHaveBeenCalledOnce();
    expect(f.loadDashboard).toHaveBeenCalledWith(userID, expect.any(Function), 'automatic', expect.any(Function));
    expect(f.snapshot().dashboard?.member.id).toBe(userID);
    expect(f.snapshot().organizationID).toBe(`org-${userID}`);
  });

  it('admits only one simultaneous manual retry for the exact current session', async () => {
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    f.server.available = true;
    let results: boolean[] = [];
    await act(async () => { results = await Promise.all([f.snapshot().retrySessionAuthentication(), f.snapshot().retrySessionAuthentication()]); });
    expect(results).toEqual([true, false]);
    expect(f.refreshSession).toHaveBeenCalledOnce();
    expect(f.snapshot().privacyCovered).toBe(false);
  });

  it.each(['b', 'a'])('cancels a late in-flight retry after replacement (next user %s)', async userID => {
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const oldUser = f.server.session.user;
    let finish!: () => void;
    f.getUser.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ data: { user: oldUser }, error: null }); }));
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.getUser).toHaveBeenCalledOnce();
    expect(f.snapshot().dashboard).toBeNull();
    f.server.session = session(userID, '33333333-3333-4333-8333-333333333333');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => finish());
    expect(f.loadDashboard).toHaveBeenCalledOnce();
    expect(f.loadDashboard).toHaveBeenCalledWith(userID, expect.any(Function), 'automatic', expect.any(Function));
    expect(f.snapshot().dashboard?.member.id).toBe(userID);
    expect(f.snapshot().organizationID).toBe(`org-${userID}`);
  });

  it.each(['sign-out', 'unmount'])('cancels late in-flight retries on %s', async cancellation => {
    const f = harness();
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    const oldUser = f.server.session.user;
    let finish!: () => void;
    f.getUser.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ data: { user: oldUser }, error: null }); }));
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.getUser).toHaveBeenCalledOnce();
    await act(async () => {
      if (cancellation === 'sign-out') f.authEvent('SIGNED_OUT', null);
      else root.unmount();
    });
    if (cancellation === 'unmount') root = createRoot(container);
    await act(async () => { finish(); f.finishOldCheck(); await vi.advanceTimersByTimeAsync(120_000); });
    expect(f.refreshSession).toHaveBeenCalledOnce();
    expect(f.loadDashboard).not.toHaveBeenCalled();
    if (cancellation === 'sign-out') {
      expect(f.snapshot().mode).toBe('signedOut');
      expect(f.snapshot().organizationID).toBeNull();
    }
  });
});

// G7-7900 final: a Steward Direct refusal that lands while the
// dashboard load waits on the offline scope, after its reads resolved, must
// not let the pre-refusal conversation rows reach the dashboard.
describe('mounted dashboard load and a Committee Direct refusal', () => {
  const privateRow = { id: 'private-thread', title: 'Private Worker', initials: 'PM', createdAt: '2026-11-09T15:00:00.000Z', updatedAt: '2026-11-09T15:00:00.000Z', unreadCount: 1, latestMessage: 'Private before the refusal' };

  async function loadWithHeldOfflineScope(refuseDuringHold: boolean) {
    let epoch = 0;
    let release: () => void = () => undefined;
    const f = harness({
      conversations: [privateRow],
      refusalEpoch: () => epoch,
      activateOfflineScope: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); await vi.advanceTimersByTimeAsync(0); });
    f.server.available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.loadDashboard).toHaveBeenCalledOnce();
    if (refuseDuringHold) epoch += 1;
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    return f;
  }

  it('drops the pre-refusal rows when the refusal lands during the offline scope', async () => {
    const f = await loadWithHeldOfflineScope(true);
    expect(f.snapshot().dashboard?.member.id).toBe('a');
    expect(f.snapshot().dashboard?.conversations).toEqual([]);
  });

  it('keeps the rows when no refusal lands', async () => {
    const f = await loadWithHeldOfflineScope(false);
    expect(f.snapshot().dashboard?.conversations).toEqual([privateRow]);
  });
});
