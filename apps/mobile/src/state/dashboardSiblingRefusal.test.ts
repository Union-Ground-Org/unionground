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
import * as readRefusal from '../lib/readRefusal';
import * as readDeadline from '../lib/readDeadline';
import type { useApp } from './AppProvider';
import { useSessionCheckRecovery } from './useSessionCheckRecovery';
import { useSharedDemoVisit } from './useSharedDemoVisit';

// BUG-UG-NATIVE-STALLED-PROVIDER-REREAD-HIDES-HELD-DRAFTS-20261120
// (#9358, the final of pull request #9359, r3s1 and r4s1): the real provider,
// the real resume-draft holder and the REAL dashboard, membership and staff
// adapters. Only the Supabase client is a stand-in, answering each table and
// RPC on a timer the test controls, so one dashboard query can hang or fail
// while a sibling query refuses, early or late.
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
import { loadDashboard, loadMobileChapterMemberships, loadMobileStaffScope } from '../services/supabase';
import { setNativeDirectAudience } from '../services/stewardDirectInbox';

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

const PROFILE = { id: 'a', first_name: 'Ada', full_name: 'Ada Worker', initials: 'AM', role_line: 'Worker',
  member_since: '2026-01-01', chapter_id: 'chapter-a', language: 'en' };
const settledReply = (table: string): Reply => ({ data: table === 'member_profiles' ? PROFILE : [], error: null, status: 200 });

// Each dashboard table answers through `answers`; a test replaces one entry
// for the next read only. A query builder is a thenable, as in postgrest-js.
const answers = new Map<string, () => Promise<Reply>>();
// RPC answers for the next call only, and the staff scope every other call returns.
const rpcAnswers = new Map<string, () => Promise<Reply>>();
const staffDefault: { value: unknown } = { value: null };
function query(table: string) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'gte', 'in', 'range', 'single']) builder[method] = () => builder;
  builder.then = (resolve: (value: Reply) => unknown, reject: (error: unknown) => unknown) => {
    const next = answers.get(table);
    answers.delete(table);
    return (next ? next() : Promise.resolve(settledReply(table))).then(resolve, reject);
  };
  return builder;
}
const after = (ms: number, reply: Reply) => () => new Promise<Reply>(done => { setTimeout(() => done(reply), ms); });
const never = () => () => new Promise<Reply>(() => undefined);

function harness() {
  const ok = vi.fn(async () => undefined);
  const stop = () => undefined;
  const reset = vi.fn();
  let authEvent: (event: string, next: Session | null) => void = () => undefined;
  const client = { auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    refreshSession: async () => { authEvent('TOKEN_REFRESHED', session); return { data: { session }, error: null }; },
    getUser: async () => ({ data: { user: session.user }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    onAuthStateChange: (callback: typeof authEvent) => { authEvent = callback; return { data: { subscription: { unsubscribe: stop } } }; },
    startAutoRefresh: stop, stopAutoRefresh: stop,
  } };
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
      getSupabaseClient: () => client, sessionNeedsMfa: async () => false,
      loadDashboard, loadMobileChapterMemberships, loadMobileStaffScope,
      setMobileChapterPin: ok, switchMobileChapter: ok,
      loadMobileDuesContext: async () => null, readPersistedMobileSession: async () => session,
      clearCapturedMobileSessionLocally: async () => true,
    },
    '../lib/duesNavigation': { loadMobileOrganizationRunsDues: async () => false },
    '../services/sampleSession': { isLiveSampleBackend: () => false, sampleHatForSession: () => null },
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
  return { provider, Probe, snapshot: () => snapshot!, authEvent: (event: string, next: Session | null) => authEvent(event, next) };
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

async function signedInWithHeldWork(platform: string) {
  native.platform = platform;
  const f = harness();
  await act(async () => root.render(h(f.provider.AppProvider, null, h(f.Probe))));
  await act(async () => { f.authEvent('SIGNED_IN', session); await vi.advanceTimersByTimeAsync(0); });
  expect(f.snapshot().dashboard?.member.id).toBe('a');
  const key = resumeDraftHolder.resumeDraftKey(f.snapshot(), 'notice', 'chapter-notices');
  const work: resumeDraftHolder.NoticeResumeDraft = { title: 'Held notice', body: 'Protected body', locale: 'en', audienceValue: 'chapter', warning: null,
    attempt: { title: 'Held notice', body: 'Protected body', locale: 'en', operationKey: 'unknown-outcome-send' } };
  const ticket = resumeDraftHolder.writeResumeDraft(key, work)!;
  expect(resumeDraftHolder.readResumeDraft(key)?.value).toEqual(work);
  // Starts a refresh and lets it run up to its first wait; the test then
  // moves time itself. The refresh promise is never awaited here.
  const refresh = async () => {
    await act(async () => { void f.snapshot().refresh().catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0); });
  };
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const visible = () => resumeDraftHolder.readResumeDraft(key)?.value ?? null;
  // Concealed means the body is gone AND no new work can be written over it.
  const concealed = () => resumeDraftHolder.readResumeDraft(key) === null && resumeDraftHolder.writeResumeDraft(key, work) === null;
  return { f, work, ticket, refresh, advance, visible, concealed, kept: () => resumeDraftHolder.resumeDraftIsCurrent(ticket) };
}

const TRANSPORT_LOOKING = { code: '', message: 'TypeError: Failed to fetch', details: '', hint: '' };
const AUTHORITATIVE = { code: '42501', message: 'permission denied for table', details: null, hint: null };
const BEARER = { code: 'PGRST301', message: 'JWT expired', details: null, hint: null };

describe.each(['android', 'ios'])('dashboard sibling queries on the real adapter on %s', platform => {
  // r3s1, word for word: member_profiles answers HTTP 401 with the code-less
  // plain-text body 'Failed to fetch'; membership and staff are unchanged.
  it.each([false, true])('r3s1: a refused profile request whose body says Failed to fetch conceals and keeps the held work (late=%s)', async late => {
    const t = await signedInWithHeldWork(platform);
    const refusal: Reply = { data: null, error: { code: '', message: 'Failed to fetch', details: '', hint: '' }, status: 401 };
    answers.set('member_profiles', late ? after(readDeadline.READ_DEADLINE_MS + 1_000, refusal) : after(1, refusal));
    await t.refresh();
    if (late) {
      await t.advance(readDeadline.READ_DEADLINE_MS);
      // #9358: the deadline restores nothing.
      expect(t.concealed()).toBe(true);
      expect(t.kept()).toBe(true);
      expect(t.f.snapshot().refreshing).toBe(false);
    }
    await t.advance(late ? 1_000 : 1);
    expect(t.concealed()).toBe(true);
    expect(t.kept()).toBe(true);
    expect(t.f.snapshot().refreshing).toBe(false);
  });

  // r4s1, first order, word for word: the profile fails as transport at one
  // second, then the already-started member_cases read refuses at 21 seconds.
  it('r4s1: a transport-looking profile error at 1 s cannot hide a member_cases refusal at 21 s', async () => {
    const t = await signedInWithHeldWork(platform);
    answers.set('member_profiles', after(1_000, { data: null, error: TRANSPORT_LOOKING, status: 0 }));
    answers.set('member_cases', after(21_000, { data: null, error: AUTHORITATIVE, status: 403 }));
    await t.refresh();
    await t.advance(1_000);
    expect(t.concealed()).toBe(true);
    expect(t.kept()).toBe(true);
    await t.advance(20_000);
    expect(t.concealed()).toBe(true);
    expect(t.kept()).toBe(false);
  });

  // r4s1, second order: the profile succeeds, notifications fail as transport
  // and cases refuse; the old error selector chose notifications first.
  it.each([1, 21_000])('r4s1: a notifications transport error cannot mask a member_cases refusal arriving at %i ms', async at => {
    const t = await signedInWithHeldWork(platform);
    answers.set('member_notifications', after(1, { data: null, error: TRANSPORT_LOOKING, status: 0 }));
    answers.set('member_cases', after(at, { data: null, error: AUTHORITATIVE, status: 403 }));
    await t.refresh();
    await t.advance(at);
    expect(t.concealed()).toBe(true);
    expect(t.kept()).toBe(false);
  });

  // The deadline form of r4s1: one query hangs past the deadline, which ends
  // the read and restores nothing; a sibling then refuses at 21 seconds.
  for (const hang of ['member_profiles', 'member_notifications']) {
    for (const refuser of ['member_notifications', 'member_cases', 'member_action_log', 'member_conversations'].filter(table => table !== hang)) {
      for (const [kind, error, retire] of [['authoritative', AUTHORITATIVE, true], ['bearer', BEARER, false]] as const) {
        it(`deadline form: ${hang} hangs, ${refuser} answers ${kind} at 21 s`, async () => {
          const t = await signedInWithHeldWork(platform);
          answers.set(hang, never());
          answers.set(refuser, after(21_000, { data: null, error, status: retire ? 403 : 401 }));
          await t.refresh();
          await t.advance(readDeadline.READ_DEADLINE_MS);
          expect(t.concealed()).toBe(true);
          expect(t.kept()).toBe(true);
          expect(t.f.snapshot().refreshing).toBe(false);
          await t.advance(1_000);
          expect(t.concealed()).toBe(true);
          expect(t.kept()).toBe(!retire);
          // Only the next confirmed full answer brings kept work back.
          await t.refresh();
          await t.advance(0);
          expect(t.visible()).toEqual(retire ? null : t.work);
        });
        it(`early refusal: ${refuser} answers ${kind} at 1 s while ${hang} hangs; the deadline restores nothing`, async () => {
          const t = await signedInWithHeldWork(platform);
          answers.set(hang, never());
          answers.set(refuser, after(1_000, { data: null, error, status: retire ? 403 : 401 }));
          await t.refresh();
          await t.advance(1_000);
          expect(t.concealed()).toBe(true);
          await t.advance(readDeadline.READ_DEADLINE_MS);
          expect(t.concealed()).toBe(true);
          expect(t.kept()).toBe(!retire);
        });
      }
    }
  }

  it('a failed sibling query while another hangs conceals as a failed read does on Main; the deadline restores nothing', async () => {
    const t = await signedInWithHeldWork(platform);
    answers.set('member_profiles', never());
    answers.set('member_action_log', after(1_000, { data: null, error: { code: '', message: 'Internal server error', details: null, hint: null }, status: 500 }));
    await t.refresh();
    await t.advance(readDeadline.READ_DEADLINE_MS + 1_000);
    expect(t.concealed()).toBe(true);
    expect(t.kept()).toBe(true);
  });

  it('a newer confirmed full answer still supersedes an older read\'s late sibling refusal', async () => {
    const t = await signedInWithHeldWork(platform);
    answers.set('member_profiles', never());
    answers.set('member_cases', after(30_000, { data: null, error: AUTHORITATIVE, status: 403 }));
    await t.refresh();
    await t.advance(readDeadline.READ_DEADLINE_MS);
    await t.refresh();
    await t.advance(0);
    expect(t.visible()).toEqual(t.work);
    await t.advance(10_000);
    expect(t.visible()).toEqual(t.work);
    expect(t.kept()).toBe(true);
  });

  // Gate stage 456, r5s1 and r6s1: the steward list turned a 42501 into an
  // empty page, so the provider never saw the refusal. It still keeps the
  // empty page, but the refusal reaches the provider early, in time or late.
  const stewardCases: Array<[string, string | null, number]> = [['in time', null, 1_000],
    ['while the profile hangs', 'member_profiles', 1_000], ['after the deadline while the profile hangs', 'member_profiles', 21_000]];
  for (const [label, hang, at] of stewardCases) {
    it(`r5s1: a committee member list 42501 ${label} conceals and retires the held work`, async () => {
      setNativeDirectAudience('steward');
      const t = await signedInWithHeldWork(platform);
      if (hang) answers.set(hang, never());
      rpcAnswers.set('list_steward_conversations', after(at, { data: null, error: AUTHORITATIVE, status: 403 }));
      await t.refresh();
      if (at > readDeadline.READ_DEADLINE_MS) {
        await t.advance(readDeadline.READ_DEADLINE_MS);
        expect(t.concealed()).toBe(true);
        expect(t.kept()).toBe(true);
        expect(t.f.snapshot().refreshing).toBe(false);
        await t.advance(at - readDeadline.READ_DEADLINE_MS);
      } else await t.advance(at);
      // In time, the full answer still publishes after the retirement, so the
      // composer is open again with nothing held; with a hanging sibling the
      // work stays concealed.
      if (hang) expect(t.concealed()).toBe(true);
      expect(t.kept()).toBe(false);
      await t.advance(readDeadline.READ_DEADLINE_MS);
      expect(t.kept()).toBe(false);
      expect(t.visible()).toBeNull();
    });
  }

  // Gate stage 456, r6s2: a confirmed membership answer removes the admin
  // grant while the staff-scope read hangs. The deadline keeps no staff fact,
  // and the next confirmed answer with the new roles retires the admin work.
  it('r6s2: a stalled staff-scope read after an admin grant is revoked restores no staff access', async () => {
    staffDefault.value = { organizationId: 'org-a', roles: ['admin'], chapterRoles: ['admin'], staffAuthorized: true };
    const t = await signedInWithHeldWork(platform);
    expect(t.f.snapshot().authorizedRoles).toContain('admin');
    staffDefault.value = { organizationId: 'org-a', roles: [], chapterRoles: [], staffAuthorized: false };
    rpcAnswers.set('get_my_mobile_staff_scope', never());
    await t.refresh();
    await t.advance(readDeadline.READ_DEADLINE_MS);
    expect(t.f.snapshot().refreshing).toBe(false);
    expect(t.f.snapshot().resumeDraftReads).toEqual({ dashboard: false, memberships: false, staff: false });
    expect(t.concealed()).toBe(true);
    expect(t.kept()).toBe(true);
    await t.refresh();
    await t.advance(0);
    expect(t.f.snapshot().authorizedRoles).not.toContain('admin');
    expect(t.kept()).toBe(false);
    expect(t.visible()).toBeNull();
  });

  // #9381 round 1 (r1s1, r2s1): a render error remounts the provider after a
  // stall; the new instance confirms the same person, who starts a new draft.
  // A late 42501 from the old instance's request retires nothing.
  it('a late dashboard refusal from an unmounted provider keeps the new instance\'s draft', async () => {
    const t = await signedInWithHeldWork(platform);
    answers.set('member_profiles', never());
    answers.set('member_cases', after(25_000, { data: null, error: AUTHORITATIVE, status: 403 }));
    await t.refresh();
    await t.advance(readDeadline.READ_DEADLINE_MS);
    await act(async () => root.render(h('div')));
    await act(async () => root.render(h(t.f.provider.AppProvider, null, h(t.f.Probe))));
    await act(async () => { t.f.authEvent('SIGNED_IN', session); await vi.advanceTimersByTimeAsync(0); });
    expect(t.f.snapshot().dashboard?.member.id).toBe('a');
    const key = resumeDraftHolder.resumeDraftKey(t.f.snapshot(), 'notice', 'chapter-notices');
    const replacement = resumeDraftHolder.writeResumeDraft(key, { ...t.work, body: 'Started after the remount' });
    expect(replacement).not.toBeNull();
    await t.advance(5_000);
    expect(resumeDraftHolder.readResumeDraft(key)).toBe(replacement);
    expect(resumeDraftHolder.resumeDraftIsCurrent(replacement!)).toBe(true);
  });

  // #9369: a no-answer failure (status 0 on an adapter that keeps its status,
  // or our own deadline) lets the same person read and discard only the words
  // they typed. The composer's facts stay false and no Send returns.
  it('9369: a membership read that fails with status 0 shows the person\u2019s own words, discardable, with reads still false', async () => {
    const t = await signedInWithHeldWork(platform);
    rpcAnswers.set('get_my_chapter_memberships', after(1, { data: null, error: { code: '', message: 'TypeError: Failed to fetch', details: '', hint: '' }, status: 0 }));
    await t.refresh();
    await t.advance(1);
    expect(t.concealed()).toBe(true);
    expect(t.kept()).toBe(true);
    expect(t.f.snapshot().resumeDraftReads).toEqual({ dashboard: false, memberships: false, staff: false });
    const shown = resumeDraftHolder.readOwnHeldText('a');
    expect(shown.map(row => row.lines)).toEqual([['Held notice', 'Protected body']]);
    expect(shown[0]!.uncertain).toBe(true);
    expect(resumeDraftHolder.discardOwnHeldText(shown[0]!.entry)).toBe(true);
    expect(resumeDraftHolder.readOwnHeldText('a')).toEqual([]);
    await t.refresh();
    await t.advance(0);
    expect(t.visible()).toBeNull();
  });

  it('9369: a membership read that fails with status 500 keeps the own words hidden', async () => {
    const t = await signedInWithHeldWork(platform);
    rpcAnswers.set('get_my_chapter_memberships', after(1, { data: null, error: { code: '', message: 'Internal server error', details: '', hint: '' }, status: 500 }));
    await t.refresh();
    await t.advance(1);
    expect(t.concealed()).toBe(true);
    expect(t.kept()).toBe(true);
    expect(resumeDraftHolder.readOwnHeldText('a')).toEqual([]);
  });

  it('9369: the deadline shows the own words; a sibling refusal at 21 s hides and retires them', async () => {
    const t = await signedInWithHeldWork(platform);
    answers.set('member_profiles', never());
    answers.set('member_cases', after(21_000, { data: null, error: AUTHORITATIVE, status: 403 }));
    await t.refresh();
    await t.advance(readDeadline.READ_DEADLINE_MS);
    expect(t.concealed()).toBe(true);
    expect(t.f.snapshot().resumeDraftReads).toEqual({ dashboard: false, memberships: false, staff: false });
    expect(resumeDraftHolder.readOwnHeldText('a').map(row => row.lines)).toEqual([['Held notice', 'Protected body']]);
    await t.advance(1_000);
    expect(resumeDraftHolder.readOwnHeldText('a')).toEqual([]);
    expect(t.kept()).toBe(false);
  });

  it('9369: a soft dashboard read refusal decides no access and retires nothing (ledger 628)', async () => {
    const t = await signedInWithHeldWork(platform);
    rpcAnswers.set('get_my_case_ulp_summary', after(1, { data: null, error: AUTHORITATIVE, status: 403 }));
    await t.refresh();
    await t.advance(1);
    expect(t.visible()).toEqual(t.work);
    expect(t.kept()).toBe(true);
  });

  it('an unchanged in-time dashboard keeps held work visible and current', async () => {
    const t = await signedInWithHeldWork(platform);
    answers.set('member_cases', after(5_000, settledReply('member_cases')));
    await t.refresh();
    await t.advance(5_000);
    expect(t.visible()).toEqual(t.work);
    expect(t.kept()).toBe(true);
  });
});
