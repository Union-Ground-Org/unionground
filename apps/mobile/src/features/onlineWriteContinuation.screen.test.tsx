// @vitest-environment jsdom
import * as React from 'react';
import { act, createElement as h, type ReactNode, type ComponentType, type PropsWithChildren } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
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
import type { useApp } from '../state/AppProvider';
import { useSessionCheckRecovery } from '../state/useSessionCheckRecovery';
import { useSharedDemoVisit } from '../state/useSharedDemoVisit';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionBoundWriter } from '../../../../src/lib/sessionBoundWriter.js';
import { notificationDestination } from '../lib/notificationKinds';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';
import type { Session } from '@supabase/supabase-js';
import type { MemberConversationThread, MemberNotification } from '../models/member';
import type { MobileStaffRole } from '../services/supabase';

const port = vi.hoisted(() => ({
  params: {} as Record<string, string>, loadThread: vi.fn(), sendThread: vi.fn(),
  providerUseApp: null as (() => ReturnType<typeof useApp>) | null,
  app: {} as Record<string, unknown>, user: 'member-a', read: vi.fn(), rpc: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: Record<string, unknown> | null; error: unknown }>>(),
  refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), close: vi.fn(), confirmed: vi.fn(),
  success: vi.fn(), warning: vi.fn(), setting: vi.fn(), saved: vi.fn(),
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ setParams: vi.fn() }), useIsFocused: () => true, useRouter: () => ({ push: port.push, replace: port.replace, setParams: vi.fn() }), useLocalSearchParams: () => port.params, Redirect: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.providerUseApp ? port.providerUseApp() : port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('../lib/screenReader', () => ({ useScreenReader: () => false, useScreenReaderKnownOff: () => true }));
type ChromeModule = typeof import('../lib/chrome');
vi.mock('../lib/chrome', async (original) => ({ ...await original<ChromeModule>(), useNativeTabContentInset: () => 0 }));
vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('../features/useResultCountAnnouncement', () => ({ useResultCountAnnouncement: () => 'off' }));
vi.mock('../features/useTaskDiscussions', () => ({ useTaskDiscussions: () => ({ items: [], failed: false }) }));
vi.mock('../features/usePeerConversations', () => ({ usePeerConversations: () => ({ items: [], failed: false }) }));
vi.mock('../features/useStewardDirectPages', () => ({ stewardDirectStaleAfterMs: () => 60000, useStewardDirectPages: () => ({ conversations: [], state: 'ready', notice: null }) }));
vi.mock('../components/TaskDiscussionsSection', () => ({ TaskDiscussionsSection: () => null }));
vi.mock('../components/MessageWorkflowPicker', () => ({ MessageWorkflowPicker: () => null }));
vi.mock('../components/RowHighlight', () => ({ HighlightList: () => null, HighlightRow: () => null }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../components/ReminderPicker', () => ({ ReminderPicker: () => null }));
vi.mock('../components/MessageReactions', () => ({ MessageReactionPicker: () => null }));
vi.mock('../data/useChannels', () => {
  const store = { channels: () => [], status: () => 'ready', loadFault: () => null, subscribe: () => () => undefined, getVersion: () => 0 };
  return { useChannelStore: () => store };
});
vi.mock('../data/channelControls', () => ({ channelControlsApi: { setLevel: port.setting }, useChannelControls: () => ({ controls: { switches: { channelPinning: false } } }) }));
vi.mock('../services/compassSuggestions', () => ({ loadCompassSwitchConfiguration: async () => ({ switches: { 'features.ai_assistant.case_help': true } }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: port.success, warning: port.warning, select: vi.fn() } }));
vi.mock('../services/messageWorkflowPreference', () => ({
  latestMessageWorkflowRequest: () => 0, readMessageWorkflowOnboarded: async () => true,
  readMessageWorkflowPreference: async () => 'people-spaces-work', saveMessageWorkflowPreference: async () => undefined,
  subscribeMessageWorkflowPreference: () => () => undefined,
}));
vi.mock('../components/ui', async () => ({
  ...await import('../testing/uiStandIn'), Avatar: () => null,
  StateMessage: ({ title, body }: { title: string; body?: string }) => h('section', null, title, body),
}));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children), usePinnedHeaderChrome: () => null, useScreenNameAlreadySpoken: () => ({ duplicate: false, hiddenProps: {} }) }));
vi.mock('../components/TopChrome', () => ({ TopRamp: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowMessageActions: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('../components/MessageReplies', () => ({ MessageReplies: () => null, ParentMessageControl: () => null, ReplyCountControl: () => null, useMessageReplyCounts: () => ({}) }));
vi.mock('./SavedPulseCharts', () => ({ LiveChartMessage: () => null }));
vi.mock('./guideLayers/staffGuidesData', () => ({ finishStaffGuide: vi.fn(), liveStaffGuideHat: () => null }));
vi.mock('./useConversationHistory', () => ({ conversationHistoryCopy: {}, useConversationHistory: ({ thread }: { thread: MemberConversationThread | null }) => ({ messages: thread?.messages ?? [], status: 'idle', hasEarlier: false, started: false }) }));
vi.mock('./prependAnchor', () => ({ usePrependAnchor: () => ({ laidOut: () => 'unchanged', scrolled: () => undefined }) }));
vi.mock('../services/supabase', () => {
  const client = { auth: { getSession: port.read }, rpc: port.rpc };
  return {
    loadConversationThread: port.loadThread, sendMemberMessage: port.sendThread, sendStewardReply: port.sendThread,
    markConversationRead: async () => undefined,
    getSupabaseClient: () => client,
    captureSessionWriter: (session: unknown) => createSessionBoundWriter({ session, sharedClient: client, createSessionClient: () => client }),
    startMemberConversation: async (writer: { client: () => Promise<typeof client> }, body: string) => {
      const result = await (await writer.client()).rpc('start_member_conversation', { body });
      if (result.error || !result.data) throw result.error ?? new Error('Not confirmed');
      return result.data.conversationId as string;
    },
    startMobileMemberStewardConversation: async (writer: { client: () => Promise<typeof client> }, steward: string, body: string) => {
      const result = await (await writer.client()).rpc('start_member_steward_conversation', { steward, body });
      if (result.error) throw result.error;
      return result.data;
    },
    loadMobileMemberChapterStewards: async () => [{ id: 'steward-a', name: 'Dana Cole', roleLabel: 'steward' }],
    loadMobileMemberOrganizationStructure: vi.fn(),
  };
});

import ConversationScreen from '../../app/conversation/[id]';
import MessagesScreen from '../../app/messages';
import { StewardFinderSheet } from './StewardFinderSheet';
import { NativeMessageActions } from '../components/NativeMessageActions';
import { ChannelSettingsPanel } from '../components/ChannelControls';
import { UNAVAILABLE_CHANNEL_CONTROLS, type ChannelControls, type ChannelSetting } from '../lib/channelControlsShared';

const currentSession = (): Session => ({ user: { id: port.user, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-19T12:00:00Z' }, access_token: `synthetic-${port.user}`, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let screen: Rendered | null = null;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const result = () => ({ data: { conversationId: 'accepted-a', stewardUserId: 'steward-a', state: { saved: true, reminders: [], reactions: ['like'], canEdit: false } }, error: null });
beforeEach(() => {
  port.params = {}; port.loadThread.mockReset(); port.sendThread.mockReset();
  port.user = 'member-a';
  for (const mock of [port.read, port.rpc, port.refresh, port.push, port.replace, port.close, port.confirmed, port.success, port.warning, port.setting, port.saved]) mock.mockReset();
  port.read.mockImplementation(async () => ({ data: { session: currentSession() }, error: null }));
  port.rpc.mockImplementation(async () => result());
  port.refresh.mockResolvedValue(undefined);
  port.app = { mode: 'authenticated', session: currentSession(), organizationID: 'org-a', authorizedRoles: [], organizationRoles: [], chapterRoles: [],
    dashboard: { member: { id: port.user, chapterID: 'chapter-a', language: 'en' }, conversations: [] }, refresh: port.refresh, refreshing: false };
});
afterEach(async () => { await screen?.unmount(); screen = null; port.providerUseApp = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('online write continuations on %s (#9256 R1)', (os) => {
  beforeEach(() => setPlatform(os));
  describe.each<'inbox' | 'selected committee member'>(['inbox', 'selected committee member'])('%s first message', (entry) => {
    const tree = () => entry === 'inbox' ? h(MessagesScreen) : h(StewardFinderSheet, { open: true, onClose: port.close });
    async function send() {
      screen = await render(tree());
      await press(getExposed(screen.container, entry === 'inbox' ? 'Message the committee' : 'Contact Dana Cole'));
      const input = screen.container.querySelector<HTMLTextAreaElement>('textarea')!;
      await type(input, 'A first message');
      await press(getExposed(screen.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      await settle();
    }
    it.each<'replacement' | 'unmount'>(['replacement', 'unmount'])('discards a late accepted start after %s without refreshing or navigating', async (retirement) => {
      const answer = deferred<ReturnType<typeof result>>();
      port.rpc.mockReturnValueOnce(answer.promise);
      await send();
      expect(port.rpc).toHaveBeenCalledTimes(1);
      if (retirement === 'replacement') {
        port.user = 'member-b';
        port.app = { ...port.app, session: currentSession(), dashboard: { member: { id: port.user, chapterID: 'chapter-a' }, conversations: [] } };
        await screen!.rerender(tree());
      } else { await screen!.unmount(); screen = null; }
      await act(async () => { answer.resolve(result()); });
      await settle();
      expect(port.refresh).not.toHaveBeenCalled();
      expect(port.push).not.toHaveBeenCalled();
      expect(port.replace).not.toHaveBeenCalled();
      expect(port.success).not.toHaveBeenCalled();
      expect(port.warning).not.toHaveBeenCalled();
      expect(port.rpc).toHaveBeenCalledTimes(1);
      if (screen) expect(screen.container.textContent).not.toContain('A first message');
    });
    it('checks ownership again when replacement happens during the inbox refresh', async () => {
      const refresh = deferred<void>();
      port.refresh.mockReturnValueOnce(refresh.promise);
      await send();
      expect(port.refresh).toHaveBeenCalledTimes(1);
      port.user = 'member-b';
      port.app = { ...port.app, session: currentSession() };
      await screen!.rerender(tree());
      await act(async () => { refresh.resolve(); });
      expect(port.push).not.toHaveBeenCalled();
      expect(port.replace).not.toHaveBeenCalled();
      expect(port.rpc).toHaveBeenCalledTimes(1);
    });
    it('opens one acknowledged conversation for the same person', async () => {
      await send();
      expect(port.refresh).toHaveBeenCalledTimes(1);
      expect(entry === 'inbox' ? port.replace : port.push).toHaveBeenCalledExactlyOnceWith('/conversation/accepted-a');
      expect(port.rpc).toHaveBeenCalledTimes(1);
    });
    it('retires an accepted draft without offering a retry when later Auth proof is unavailable', async () => {
      port.rpc.mockImplementationOnce(async () => { port.read.mockRejectedValueOnce(new Error('Offline')); return result(); });
      await send();
      expect(port.refresh).not.toHaveBeenCalled();
      expect(port.push).not.toHaveBeenCalled();
      expect(port.replace).not.toHaveBeenCalled();
      expect(port.rpc).toHaveBeenCalledTimes(1);
      expect(screen!.container.textContent).not.toContain('A first message');
      expect(screen!.container.querySelector('textarea')).toBeNull();
    });
    it.each<'before refresh' | 'after refresh'>(['before refresh', 'after refresh'])('retires navigation when the scope changes during the %s proof', async (seam) => {
      const proof = deferred<{ data: { session: ReturnType<typeof currentSession> }; error: null }>();
      const captured = currentSession();
      const read = async () => ({ data: { session: captured }, error: null });
      port.read.mockImplementationOnce(read);
      if (seam === 'after refresh') port.read.mockImplementationOnce(read);
      port.read.mockReturnValueOnce(proof.promise);
      await send();
      port.user = 'member-b'; port.app = { ...port.app, session: currentSession() };
      await screen!.rerender(tree());
      await act(async () => { proof.resolve({ data: { session: captured }, error: null }); });
      expect(port.push).not.toHaveBeenCalled();
      expect(port.replace).not.toHaveBeenCalled();
      expect(port.refresh).toHaveBeenCalledTimes(seam === 'after refresh' ? 1 : 0);
    });
  });

  const actionTree = (id = 'post-a') => h(NativeMessageActions, { sourceKind: 'channel', messageID: id, accessibilityLabel: 'A message', onCompose: vi.fn(), onConfirmed: port.confirmed, children: h('p', null, 'Message body') });
  async function react() {
    screen = await render(actionTree());
    await press(getExposed(screen.container, 'A message'));
    await press(getExposed(screen.container, 'A message'));
    await settle();
  }
  it.each<'unmount' | 'another row'>(['unmount', 'another row'])('does not confirm a retired action after %s while Auth proof is pending', async (retirement) => {
    const proof = deferred<{ data: { session: ReturnType<typeof currentSession> }; error: null }>();
    port.rpc.mockImplementationOnce(async () => { port.read.mockReturnValueOnce(proof.promise); return result(); });
    await react();
    expect(port.read).toHaveBeenCalledTimes(2);
    if (retirement === 'unmount') { await screen!.unmount(); screen = null; }
    else await screen!.rerender(actionTree('post-b'));
    await act(async () => { proof.resolve({ data: { session: currentSession() }, error: null }); });
    expect(port.confirmed).not.toHaveBeenCalled();
    expect(port.success).not.toHaveBeenCalled();
  });
  it('shows an unacknowledged reaction failure when Auth proof is unavailable', async () => {
    port.rpc.mockImplementationOnce(async () => { port.read.mockRejectedValueOnce(new Error('Offline')); return { data: null, error: new Error('Offline') }; });
    await react();
    expect(screen!.container.textContent).toContain('Action not confirmed. Try again.');
    expect(port.warning).toHaveBeenCalledTimes(1);
    expect(port.confirmed).not.toHaveBeenCalled();
  });
  it('suppresses the old failure when Auth proves a replacement', async () => {
    port.rpc.mockImplementationOnce(async () => { port.user = 'member-b'; return { data: null, error: new Error('Offline') }; });
    await react();
    expect(screen!.container.textContent).not.toContain('Action not confirmed. Try again.');
    expect(port.warning).not.toHaveBeenCalled();
  });
  it('drops a channel-settings callback after account replacement', async () => {
    const setting: Required<ChannelSetting> = { spaceId: 'space-a', level: 'mentions', muted: false, mutedUntil: null, muteActive: false, keywords: [] };
    const answer = deferred<typeof setting>();
    port.setting.mockReturnValueOnce(answer.promise);
    const controls: ChannelControls = { ...UNAVAILABLE_CHANNEL_CONTROLS, available: true, spaces: { 'space-a': { level: 'all' } }, switches: { ...UNAVAILABLE_CHANNEL_CONTROLS.switches, notificationLevels: true } };
    const tree = () => h(ChannelSettingsPanel, { spaceID: 'space-a', controls, onSaved: port.saved });
    screen = await render(tree());
    await press(getExposed(screen.container, 'Mentions only'));
    expect(port.setting).toHaveBeenCalledTimes(1);
    port.user = 'member-b'; port.app = { ...port.app, session: currentSession() };
    await screen.rerender(tree());
    await act(async () => { answer.resolve(setting); });
    expect(port.saved).not.toHaveBeenCalled();
    expect(screen.container.textContent).not.toContain('Saved.');
  });
});

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

function providerHarness(platform: 'ios' | 'android') {
  const ok = vi.fn(async () => undefined);
  const stop = () => undefined;
  const reset = vi.fn();
  const server = { session: session('a') };
  const wire = { gate: null as Promise<void> | null, signedOut: false, published: false,
    attempts: [] as { kind: 'switch' | 'notification'; user: string; token: string; target: string }[] };
  let authEvent: (event: string, next: Session | null) => void = () => undefined;
  const sessionNeedsMfa = vi.fn(async () => false);
  const refreshSession = vi.fn(async () => {
    authEvent('TOKEN_REFRESHED', server.session);
    return { data: { session: server.session }, error: null };
  });
  const getUser = vi.fn(async () => ({ data: { user: server.session.user }, error: null }));
  const client = { auth: {
    getSession: async () => { if (wire.gate) await wire.gate; return { data: { session: wire.signedOut || !wire.published ? null : server.session }, error: null }; }, refreshSession,
    getUser,
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    onAuthStateChange: (callback: typeof authEvent) => { authEvent = callback; return { data: { subscription: { unsubscribe: stop } } }; },
    startAutoRefresh: stop, stopAutoRefresh: stop,
  }, rpc: (name: string, args: Record<string, unknown> = {}) => dispatchRpc(null, name, args),
    from: () => notificationQuery(null),
  };
  const loadDashboard = vi.fn(async (userID: string) => ({
    member: { id: userID, language: 'en', chapterID: `chapter-${userID}` as string | null }, conversations: [],
    notifications: [] as MemberNotification[], cases: [], actionLog: [],
  }));
  const loadStaffScope = vi.fn(async () => ({ organizationID: `org-${server.session.user.id}`, roles: [] as MobileStaffRole[], chapterRoles: [] as MobileStaffRole[], staffAuthorized: false }));
  const membershipRows = { current: [{ chapterId: 'chapter-a' as string | null, organizationId: 'org-a', name: 'Tamarack', joinedAt: '2026-01-01', selected: true }] };
  // Execute the production RPC adapter too: organization-only rows must not be
  // silently replaced with chapter fixtures by this provider integration test.
  const adapterSource = ts.createSourceFile('supabase.ts', readFileSync(resolve(process.cwd(), 'src/services/supabase.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const adapterFunctions = adapterSource.statements.filter((node) => ts.isFunctionDeclaration(node) && ['mobileStaffRoles', 'loadMobileChapterMemberships'].includes(node.name?.text ?? '')).map(node => node.getText(adapterSource)).join('\n');
  const adapterExports: { loadMobileChapterMemberships?: (...args: unknown[]) => Promise<unknown[]> } = {};
  runInNewContext(ts.transpileModule(adapterFunctions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: adapterExports, getSupabaseClient: () => ({ rpc: async () => ({ data: membershipRows.current, error: null }) }) });
  const readMemberships = async (...args: unknown[]) => await adapterExports.loadMobileChapterMemberships!(...args);
  const loadMemberships = vi.fn(readMemberships);
  const switchMobileChapter = vi.fn(async (chapterID: string) => { membershipRows.current = membershipRows.current.map(row => ({ ...row, selected: row.chapterId === chapterID })); });
  async function dispatchRpc(owner: Session | null, name: string, args: Record<string, unknown>) {
    if (wire.gate) await wire.gate;
    if (name !== 'switch_my_chapter') throw new Error('Unexpected provider business RPC: ' + name);
    const checked = owner ?? server.session;
    wire.attempts.push({ kind: 'switch', user: checked.user.id, token: checked.access_token, target: String(args.p_chapter_id) });
    await switchMobileChapter(String(args.p_chapter_id));
    return { data: null, error: null };
  }
  function notificationQuery(owner: Session | null) {
    const filters: Record<string, unknown> = {}; let readAt: unknown = null;
    type Query = {
      update(value: { read_at: string | null }): Query;
      eq(key: string, value: unknown): Query;
      select(): Query;
      maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { code: string; message: string } | null }>;
    };
    const query: Query = {
      update: (value: { read_at: string | null }) => { readAt = value.read_at; return query; },
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      select: () => query,
      maybeSingle: async () => {
        if (wire.gate) await wire.gate;
        const checked = owner ?? server.session;
        wire.attempts.push({ kind: 'notification', user: checked.user.id, token: checked.access_token, target: String(filters.id) });
        if (filters.user_id !== checked.user.id) return { data: null, error: { code: '42501', message: 'Not your notification' } };
        return { data: { id: String(filters.id), title: 'Fixture notice', body: 'Fixture body', kind: 'general',
          read_at: readAt, created_at: '2026-11-20T12:00:00Z' }, error: null };
      },
    };
    return query;
  }
  const businessSource = adapterSource.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['switchMobileChapter', 'setNotificationReadState', 'memberNotification'].includes(node.name?.text ?? '')).map(node => node.getText(adapterSource)).join('\n');
  const businessExports: Record<string, unknown> = {};
  runInNewContext(ts.transpileModule(businessSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: businessExports, getSupabaseClient: () => client, notificationDestination, Date });
  const activateOfflineScope = vi.fn(async (_scope: { accountID: string; organizationID: string }, _sessionID?: string) => undefined);
  const noIO: Record<string, unknown> = Object.fromEntries([
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
  const suspendOfflineAvailability = vi.fn(); noIO.suspendOfflineAvailability = suspendOfflineAvailability;
  const modules: Record<string, object> = {
    react: React, 'react-native': { Platform: { OS: platform }, AppState: { currentState: 'active', addEventListener: () => ({ remove: stop }) } },
    'expo-crypto': { randomUUID: () => 'test-id' },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: ok },
    '../services/haptics': { haptics: { success: ok, warning: ok, select: ok } },
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
      captureSessionWriter: (session: Session | null) => createSessionBoundWriter({ session, sharedClient: client,
        createSessionClient: (checked: unknown) => ({ rpc: (name: string, args: Record<string, unknown>) => dispatchRpc(checked as Session, name, args), from: () => notificationQuery(checked as Session) }) }),
      getSupabaseClient: () => client, sessionNeedsMfa, loadDashboard,
      loadMobileChapterMemberships: loadMemberships,
      switchMobileChapter: businessExports.switchMobileChapter, setNotificationReadState: businessExports.setNotificationReadState,
      loadMobileStaffScope: loadStaffScope,
      loadMobileDuesContext: async () => null, readPersistedMobileSession: async () => server.session,
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
      get: (target, key): unknown => {
        if (key in target) return Reflect.get(target, key) as unknown;
        if (key === '__esModule') return false;
        return () => { throw new Error(`Unmodelled native I/O: ${path}.${String(key)}`); };
      },
    }),
  });
  const provider = exports as ProviderModule;
  let snapshot: Snapshot;
  function Probe({ children }: PropsWithChildren) {
    snapshot = provider.useApp();
    return h(React.Fragment, null, h('output', null, `${snapshot.mode}:${snapshot.privacyCovered}:${snapshot.dashboard?.member.id ?? 'empty'}`), children);
  }
  return { provider, Probe, server, wire, refreshSession, getUser, loadDashboard, loadStaffScope, loadMemberships, readMemberships, membershipRows, switchMobileChapter, suspendOfflineAvailability, activateOfflineScope, sessionNeedsMfa,
    snapshot: () => snapshot!, authEvent: (event: string, next: Session | null) => { wire.signedOut = event === 'SIGNED_OUT'; wire.published = next !== null; authEvent(event, next); },
  };
}


describe.each<'ios' | 'android'>(['ios', 'android'])('real AppProvider first-message ownership on %s', (os) => {
  beforeEach(() => setPlatform(os));
  describe.each<'inbox' | 'selected committee member'>(['inbox', 'selected committee member'])('%s', (entry) => {
    async function compose(roles: MobileStaffRole[] = [], staffOrganization = 'org-a', membershipOrganization: string | null = 'org-a') {
      const f = providerHarness(os);
      f.loadStaffScope.mockImplementation(async () => ({ organizationID: staffOrganization, roles, chapterRoles: [], staffAuthorized: true }));
      f.membershipRows.current = membershipOrganization ? ['chapter-a', 'chapter-b'].map(chapterId => ({ chapterId, organizationId: membershipOrganization, name: 'Tamarack', joinedAt: '2026-01-01', selected: chapterId === 'chapter-a' })) : [];
      if (membershipOrganization === null) f.loadDashboard.mockImplementation(async (userID: string) => ({ member: { id: userID, language: 'en', chapterID: null }, conversations: [], notifications: [], cases: [], actionLog: [] }));
      f.sessionNeedsMfa.mockResolvedValue(false);
      port.providerUseApp = f.provider.useApp;
      port.read.mockImplementation(async () => ({ data: { session: f.server.session }, error: null }));
      screen = await render(h(f.provider.AppProvider, null, h(f.Probe, null,
        entry === 'inbox' ? h(MessagesScreen) : h(StewardFinderSheet, { open: true, onClose: port.close }))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); });
      await settle();
      expect(f.snapshot().dashboard?.member.id).toBe('a');
      await press(getExposed(screen.container, entry === 'inbox' ? 'Message the committee' : 'Contact Dana Cole'));
      await type(screen.container.querySelector<HTMLTextAreaElement>('textarea')!, 'A first message');
      return f;
    }
    async function beginRefresh(f: Awaited<ReturnType<typeof compose>>, user = 'a') {
      const dashboard = deferred<Awaited<ReturnType<typeof f.loadDashboard>>>();
      f.loadDashboard.mockReturnValueOnce(dashboard.promise);
      const assurance = deferred<boolean>();
      f.sessionNeedsMfa.mockReturnValueOnce(assurance.promise);
      f.server.session = { ...session(user), access_token: `${session(user).access_token}-rotated` };
      await act(async () => { f.authEvent(user === 'a' ? 'TOKEN_REFRESHED' : 'SIGNED_IN', f.server.session); });
      await settle();
      expect(f.snapshot().mode).toBe('booting');
      await act(async () => { assurance.resolve(false); });
      await settle();
      // This actual provider intermediate commit was absent from the old
      // manually staged screen fixture: authenticated precedes dashboard.
      expect(f.snapshot().mode).toBe('authenticated');
      expect(f.snapshot().dashboard).toBeNull();
      expect(f.snapshot().organizationID).toBeNull();
      return dashboard;
    }
    async function finishRefresh(f: Awaited<ReturnType<typeof compose>>, pending: Awaited<ReturnType<typeof beginRefresh>>, chapter: string | null = 'chapter-a') {
      await act(async () => { pending.resolve({ member: { id: f.server.session.user.id, language: 'en', chapterID: chapter }, conversations: [], notifications: [], cases: [], actionLog: [] }); });
      await settle();
      expect(f.snapshot().dashboard?.member.chapterID).toBe(chapter);
    }
    it.each<'unavailable' | 'confirmed removal' | 'server campaign change'>(['unavailable', 'confirmed removal', 'server campaign change'])('G14 treats %s membership as an independent answer', async (change) => {
      const f = await compose();
      if (change === 'unavailable') f.loadMemberships.mockRejectedValueOnce(new Error('Membership read unavailable'));
      else if (change === 'confirmed removal') f.membershipRows.current = [];
      else f.membershipRows.current = [{ chapterId: 'chapter-b', organizationId: 'org-a', name: 'Tamarack B', joinedAt: '2026-01-01', selected: true }];
      f.loadStaffScope.mockRejectedValueOnce(new Error('Staff unavailable'));
      await act(async () => { await f.snapshot().refresh(); });
      const draft = screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value;
      if (change === 'unavailable') expect(draft).toBe('A first message');
      else expect(draft).not.toBe('A first message');
    });

    it('G14 drops a late membership proof superseded by a campaign switch', async () => {
      const f = await compose();
      const oldMembership = deferred<unknown[]>();
      f.loadMemberships.mockImplementationOnce(async (onSelection: unknown) => {
        await oldMembership.promise;
        (onSelection as (value: { chapterID: string; organizationID: string }[]) => void)([{ chapterID: 'chapter-old', organizationID: 'org-old' }]);
        return [];
      });
      let oldRead!: Promise<void>;
      await act(async () => { oldRead = f.snapshot().refreshChapterMemberships(); });
      await act(async () => { await f.snapshot().switchChapter('chapter-b'); });
      const confirmed = f.snapshot().confirmedMembershipScope;
      await act(async () => { oldMembership.resolve([]); await oldRead; });
      expect(f.snapshot().confirmedMembershipScope).toEqual(confirmed);
      expect(confirmed).toEqual([{ chapterID: 'chapter-b', organizationID: 'org-a' }]);
    });

    if (entry === 'selected committee member') it('G14 keeps a new campaign composer created before its dashboard arrives', async () => {
      const f = await compose();
      const dashboard = deferred<Awaited<ReturnType<typeof f.loadDashboard>>>();
      f.loadDashboard.mockReturnValueOnce(dashboard.promise);
      let switched!: Promise<void>;
      await act(async () => { switched = f.snapshot().switchChapter('chapter-b'); });
      expect(f.snapshot().dashboard).toBeNull();
      await press(getExposed(screen!.container, 'Contact Dana Cole'));
      await type(screen!.container.querySelector<HTMLTextAreaElement>('textarea')!, 'New campaign draft');
      await act(async () => { dashboard.resolve({ member: { id: 'a', language: 'en', chapterID: 'chapter-b' }, conversations: [], notifications: [], cases: [], actionLog: [] }); await switched; });
      expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('New campaign draft');
    });

    it.each<'unsent' | 'accepted'>(['unsent', 'accepted'])('G14 retires an %s first start on a confirmed campaign switch before dashboard recovery', async (phase) => {
      const f = await compose();
      const answer = deferred<ReturnType<typeof result>>();
      if (phase === 'accepted') {
        port.rpc.mockReturnValueOnce(answer.promise);
        await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      }
      const dashboard = deferred<Awaited<ReturnType<typeof f.loadDashboard>>>();
      f.loadDashboard.mockReturnValueOnce(dashboard.promise);
      let switched!: Promise<void>;
      await act(async () => { switched = f.snapshot().switchChapter('chapter-b'); });
      expect(f.switchMobileChapter).toHaveBeenCalledExactlyOnceWith('chapter-b');
      expect(f.snapshot().dashboard).toBeNull();
      expect(f.snapshot().chapterMemberships.find(row => row.selected)?.chapterID).toBe('chapter-b');
      f.loadDashboard.mockRejectedValueOnce(new Error('Follow-up unavailable'));
      const reads = f.loadDashboard.mock.calls.length;
      if (phase === 'accepted') { await act(async () => { answer.resolve(result()); }); await settle(); }
      const observations = { reads: f.loadDashboard.mock.calls.length - reads, navigations: port.replace.mock.calls.length + port.push.mock.calls.length };
      await act(async () => { dashboard.resolve({ member: { id: 'a', language: 'en', chapterID: 'chapter-b' }, conversations: [], notifications: [], cases: [], actionLog: [] }); await switched; });
      expect(observations).toEqual({ reads: 0, navigations: 0 });
      expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).not.toBe('A first message');
    });

    it.each<'unsent' | 'accepted'>(['unsent', 'accepted'])('G14 retires an %s organization-only first start when membership confirms a new organization during a staff outage', async (phase) => {
      const f = await compose([], 'org-a', null);
      f.loadMemberships.mockImplementation(f.readMemberships);
      f.membershipRows.current = [{ chapterId: null, organizationId: 'org-a', name: 'Tamarack', joinedAt: '2026-01-01', selected: true }];
      await act(async () => { await f.snapshot().refresh(); });
      // Establish the draft after both reads confirm the starting organization.
      if (!screen!.container.querySelector('textarea')) await press(getExposed(screen!.container, entry === 'inbox' ? 'Message the committee' : 'Contact Dana Cole'));
      await type(screen!.container.querySelector<HTMLTextAreaElement>('textarea')!, 'A first message');
      expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('A first message');
      const answer = deferred<ReturnType<typeof result>>();
      if (phase === 'accepted') { port.rpc.mockReturnValueOnce(answer.promise); await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send')); }
      f.membershipRows.current = [{ chapterId: null, organizationId: 'org-new', name: 'Tamarack New', joinedAt: '2026-01-02', selected: true }];
      f.loadStaffScope.mockRejectedValueOnce(new Error('503 staff unavailable'));
      await act(async () => { await f.snapshot().refresh(); });
      expect(f.snapshot().authorizedRoles).toEqual([]);
      const reads = f.loadDashboard.mock.calls.length;
      if (phase === 'accepted') { await act(async () => { answer.resolve(result()); }); await settle(); }
      expect({ reads: f.loadDashboard.mock.calls.length - reads, navigations: port.replace.mock.calls.length + port.push.mock.calls.length }).toEqual({ reads: 0, navigations: 0 });
      expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).not.toBe('A first message');
    });

    it.each<'unsent' | 'accepted'>(['unsent', 'accepted'])('keeps an %s first message composed while the first staff-scope read was unavailable', async (phase) => {
      const f = providerHarness(os);
      f.loadStaffScope.mockImplementation(async () => ({ organizationID: 'org-a', roles: ['admin', 'advisor'] as MobileStaffRole[], chapterRoles: [], staffAuthorized: true }));
      f.loadStaffScope.mockRejectedValueOnce(new Error('503 staff scope unavailable'));
      f.sessionNeedsMfa.mockResolvedValue(false);
      port.providerUseApp = f.provider.useApp;
      port.read.mockImplementation(async () => ({ data: { session: f.server.session }, error: null }));
      screen = await render(h(f.provider.AppProvider, null, h(f.Probe, null,
        entry === 'inbox' ? h(MessagesScreen) : h(StewardFinderSheet, { open: true, onClose: port.close }))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); });
      await settle();
      expect(f.snapshot().dashboard?.member.id).toBe('a');
      expect(f.snapshot().staffScopeAvailable).toBe(false);
      expect(f.snapshot().authorizedRoles).toEqual([]);
      await press(getExposed(screen.container, entry === 'inbox' ? 'Message the committee' : 'Contact Dana Cole'));
      await type(screen.container.querySelector<HTMLTextAreaElement>('textarea')!, 'A first message');
      const answer = deferred<ReturnType<typeof result>>();
      if (phase === 'accepted') {
        port.rpc.mockReturnValueOnce(answer.promise);
        await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      }
      await act(async () => { await f.snapshot().refresh(); });
      expect(f.snapshot().staffScopeAvailable).toBe(true);
      expect(f.snapshot().authorizedRoles).toEqual(['admin', 'advisor']);
      if (phase === 'unsent') {
        expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('A first message');
      } else {
        await act(async () => { answer.resolve(result()); });
        await settle();
        expect(entry === 'inbox' ? port.replace : port.push).toHaveBeenCalledExactlyOnceWith('/conversation/accepted-a');
      }
    });

    it.each<'role loss' | 'organization change'>(['role loss', 'organization change'])('retires a confirmed %s after first-answer adoption', async (change) => {
      const f = providerHarness(os);
      f.loadStaffScope.mockImplementation(async () => ({ organizationID: 'org-a', roles: ['admin', 'advisor'] as MobileStaffRole[], chapterRoles: [], staffAuthorized: true }));
      f.loadStaffScope.mockRejectedValueOnce(new Error('503 staff scope unavailable'));
      port.providerUseApp = f.provider.useApp;
      port.read.mockImplementation(async () => ({ data: { session: f.server.session }, error: null }));
      screen = await render(h(f.provider.AppProvider, null, h(f.Probe, null,
        entry === 'inbox' ? h(MessagesScreen) : h(StewardFinderSheet, { open: true, onClose: port.close }))));
      await act(async () => { f.authEvent('SIGNED_IN', f.server.session); });
      await settle();
      expect(f.snapshot().staffScopeAvailable).toBe(false);
      await press(getExposed(screen.container, entry === 'inbox' ? 'Message the committee' : 'Contact Dana Cole'));
      await type(screen.container.querySelector<HTMLTextAreaElement>('textarea')!, 'A first message');
      const answer = deferred<ReturnType<typeof result>>();
      port.rpc.mockReturnValueOnce(answer.promise);
      await press(getExposed(screen.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      await act(async () => { await f.snapshot().refresh(); });
      expect(f.snapshot().staffScopeAvailable).toBe(true);
      expect(f.snapshot().authorizedRoles).toEqual(['admin', 'advisor']);
      f.loadStaffScope.mockResolvedValueOnce({ organizationID: change === 'role loss' ? 'org-a' : 'org-new', roles: change === 'role loss' ? [] : ['admin', 'advisor'], chapterRoles: [], staffAuthorized: change !== 'role loss' });
      await act(async () => { await f.snapshot().refresh(); });
      const reads = f.loadDashboard.mock.calls.length;
      await act(async () => { answer.resolve(result()); });
      await settle();
      expect(port.push).not.toHaveBeenCalled();
      expect(port.replace).not.toHaveBeenCalled();
      expect(port.success).not.toHaveBeenCalled();
      expect(f.loadDashboard).toHaveBeenCalledTimes(reads);
    });
    describe.each<{ label: string; membership: string | null }>([
      { label: 'different membership organization', membership: 'org-member' },
      { label: 'no selected membership', membership: null },
    ])('staff-organization fallback: $label', ({ membership }) => {
      it.each<'unsent' | 'accepted'>(['unsent', 'accepted'])('keeps an %s first message through an unavailable staff organization', async (phase) => {
        const f = await compose(['admin', 'advisor'], 'org-staff', membership);
        expect(f.snapshot().organizationID).toBe('org-staff');
        const answer = deferred<ReturnType<typeof result>>();
        if (phase === 'accepted') {
          port.rpc.mockReturnValueOnce(answer.promise);
          await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
        }
        f.loadStaffScope.mockRejectedValueOnce(new Error('503 staff scope unavailable'));
        const pending = await beginRefresh(f);
        await finishRefresh(f, pending, membership === null ? null : 'chapter-a');
        expect(f.snapshot().staffScopeAvailable).toBe(false);
        expect(f.snapshot().organizationID).toBe(membership);
        await act(async () => { await f.snapshot().refresh(); });
        expect(f.snapshot().organizationID).toBe('org-staff');
        if (phase === 'unsent') {
          expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('A first message');
          expect(port.rpc).not.toHaveBeenCalled();
        } else {
          await act(async () => { answer.resolve(result()); });
          await settle();
          expect(port.rpc).toHaveBeenCalledTimes(1);
          expect(entry === 'inbox' ? port.replace : port.push).toHaveBeenCalledExactlyOnceWith('/conversation/accepted-a');
          expect(port.success).toHaveBeenCalledTimes(1);
        }
      });
    });
    it('retires a pending first message after a confirmed staff organization change', async () => {
      const f = await compose(['admin', 'advisor'], 'org-staff', 'org-member');
      const answer = deferred<ReturnType<typeof result>>();
      port.rpc.mockReturnValueOnce(answer.promise);
      await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      f.loadStaffScope.mockRejectedValueOnce(new Error('503 staff scope unavailable'));
      const pending = await beginRefresh(f);
      await finishRefresh(f, pending);
      expect(f.snapshot().organizationID).toBe('org-member');
      f.loadStaffScope.mockResolvedValueOnce({ organizationID: 'org-confirmed-new', roles: ['admin', 'advisor'], chapterRoles: [], staffAuthorized: true });
      await act(async () => { await f.snapshot().refresh(); });
      expect(f.snapshot().staffScopeAvailable).toBe(true);
      expect(f.snapshot().organizationID).toBe('org-confirmed-new');
      const reads = f.loadDashboard.mock.calls.length;
      await act(async () => { answer.resolve(result()); });
      await settle();
      expect(port.push).not.toHaveBeenCalled();
      expect(port.replace).not.toHaveBeenCalled();
      expect(port.success).not.toHaveBeenCalled();
      expect(f.loadDashboard).toHaveBeenCalledTimes(reads);
    });
    it.each<'unsent' | 'accepted'>(['unsent', 'accepted'])('keeps an %s first message through a failed staff-scope read and successful retry', async (phase) => {
      // Multiple genuine grants with no chosen hat retain the member inbox.
      const f = await compose(['admin', 'advisor']);
      expect(f.snapshot().authorizedRoles).toEqual(['admin', 'advisor']);
      const answer = deferred<ReturnType<typeof result>>();
      if (phase === 'accepted') {
        port.rpc.mockReturnValueOnce(answer.promise);
        await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      }
      f.loadStaffScope.mockRejectedValueOnce(new Error('503 staff scope unavailable'));
      const pending = await beginRefresh(f);
      await finishRefresh(f, pending);
      expect(f.snapshot().authorizedRoles).toEqual([]);
      expect(f.snapshot().staffScopeAvailable).toBe(false);
      expect(f.snapshot().dashboard).not.toBeNull();
      await act(async () => { await f.snapshot().refresh(); });
      expect(f.snapshot().authorizedRoles).toEqual(['admin', 'advisor']);
      expect(f.snapshot().staffScopeAvailable).toBe(true);
      if (phase === 'unsent') {
        expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('A first message');
        expect(port.rpc).not.toHaveBeenCalled();
      } else {
        await act(async () => { answer.resolve(result()); });
        await settle();
        expect(port.rpc).toHaveBeenCalledTimes(1);
        expect(entry === 'inbox' ? port.replace : port.push).toHaveBeenCalledExactlyOnceWith('/conversation/accepted-a');
        expect(port.success).toHaveBeenCalledTimes(1);
      }
    });
    it.each<'confirmed role loss' | 'replacement during outage' | 'campaign change during outage'>(['confirmed role loss', 'replacement during outage', 'campaign change during outage'])('retires pending work after %s despite a prior failed staff read', async (change) => {
      const f = await compose(['admin', 'advisor']);
      const answer = deferred<ReturnType<typeof result>>();
      port.rpc.mockReturnValueOnce(answer.promise);
      await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      f.loadStaffScope.mockRejectedValueOnce(new Error('503 staff scope unavailable'));
      const pending = await beginRefresh(f);
      await finishRefresh(f, pending);
      expect(f.snapshot().staffScopeAvailable).toBe(false);
      if (change === 'confirmed role loss') {
        f.loadStaffScope.mockResolvedValueOnce({ organizationID: 'org-a', roles: [], chapterRoles: [], staffAuthorized: false });
        await act(async () => { await f.snapshot().refresh(); });
        expect(f.snapshot().staffScopeAvailable).toBe(true);
        expect(f.snapshot().authorizedRoles).toEqual([]);
      } else {
        f.loadStaffScope.mockRejectedValueOnce(new Error('503 replacement staff scope unavailable'));
        const replacement = await beginRefresh(f, change === 'replacement during outage' ? 'b' : 'a');
        await finishRefresh(f, replacement, change === 'replacement during outage' ? 'chapter-b' : 'chapter-new');
        expect(f.snapshot().staffScopeAvailable).toBe(false);
      }
      const reads = f.loadDashboard.mock.calls.length;
      await act(async () => { answer.resolve(result()); });
      await settle();
      expect(port.push).not.toHaveBeenCalled();
      expect(port.replace).not.toHaveBeenCalled();
      expect(port.success).not.toHaveBeenCalled();
      expect(port.warning).not.toHaveBeenCalled();
      expect(f.loadDashboard).toHaveBeenCalledTimes(reads);
      expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).not.toBe('A first message');
    });
    it('keeps an unsent composer through the real background token-refresh bootstrap', async () => {
      const f = await compose();
      const pending = await beginRefresh(f);
      await finishRefresh(f, pending);
      expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('A first message');
      expect(port.rpc).not.toHaveBeenCalled();
    });
    it('keeps the accepted first-start continuation and success cue through a same-person refresh', async () => {
      const f = await compose();
      const answer = deferred<ReturnType<typeof result>>();
      port.rpc.mockReturnValueOnce(answer.promise);
      await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      const pending = await beginRefresh(f);
      await finishRefresh(f, pending);
      await act(async () => { answer.resolve(result()); });
      await settle();
      expect(port.rpc).toHaveBeenCalledTimes(1);
      expect(entry === 'inbox' ? port.replace : port.push).toHaveBeenCalledExactlyOnceWith('/conversation/accepted-a');
      expect(port.success).toHaveBeenCalledTimes(1);
    });
    it.each<'replacement' | 'campaign change'>(['replacement', 'campaign change'])('retires a pending start on a real %s', async (change) => {
      const f = await compose();
      const answer = deferred<ReturnType<typeof result>>();
      port.rpc.mockReturnValueOnce(answer.promise);
      await press(getExposed(screen!.container, entry === 'inbox' ? 'Start conversation' : 'Send'));
      const pending = await beginRefresh(f, change === 'replacement' ? 'b' : 'a');
      if (change === 'campaign change') await finishRefresh(f, pending, 'chapter-new');
      const reads = f.loadDashboard.mock.calls.length;
      await act(async () => { answer.resolve(result()); });
      await settle();
      expect(port.push).not.toHaveBeenCalled();
      expect(port.replace).not.toHaveBeenCalled();
      expect(port.success).not.toHaveBeenCalled();
      expect(port.warning).not.toHaveBeenCalled();
      expect(f.loadDashboard).toHaveBeenCalledTimes(reads);
      if (change === 'replacement') await finishRefresh(f, pending, 'chapter-b');
      expect(screen!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).not.toBe('A first message');
    });
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('G14 real AppProvider reply retirement on %s', (os) => {
  it.each([false, true])('does not refresh the retired account after an acknowledged reply follow-up rejects (staff=%s)', async (staff) => {
    setPlatform(os); port.params = { id: 'conversation-1' };
    const f = providerHarness(os);
    if (staff) f.loadStaffScope.mockResolvedValue({ organizationID: 'org-a', roles: ['steward'], chapterRoles: [], staffAuthorized: true });
    port.providerUseApp = f.provider.useApp;
    port.read.mockImplementation(async () => ({ data: { session: f.server.session }, error: null }));
    const thread: MemberConversationThread = { conversation: { id: 'conversation-1', title: 'Tamarack committee member desk', initials: 'TS', createdAt: '2026-11-01', updatedAt: '2026-11-19', unreadCount: 0, latestMessage: 'Earlier message' }, readerIsStaff: staff, messages: [] };
    port.loadThread.mockResolvedValue(thread); port.sendThread.mockResolvedValue(undefined);
    screen = await render(h(f.provider.AppProvider, null, h(f.Probe, null, h(ConversationScreen))));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); }); await settle();
    expect(f.snapshot().dashboard?.member.id).toBe('a');
    await type(screen.container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Conversation reply"]')!, 'Acknowledged reply');
    const followUp = deferred<MemberConversationThread>();
    port.loadThread.mockReturnValueOnce(followUp.promise.then(() => { throw new Error('Read failed'); }));
    await press(getExposed(screen.container, 'Send message')); await settle();
    expect(port.sendThread).toHaveBeenCalledTimes(1);
    await act(async () => { f.authEvent('SIGNED_OUT', null); }); await settle();
    f.server.session = session('b');
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); }); await settle();
    expect(f.snapshot().dashboard?.member.id).toBe('b'); expect(f.snapshot().refreshing).toBe(false);
    const reads = f.loadDashboard.mock.calls.length; const suspends = f.suspendOfflineAvailability.mock.calls.length;
    await act(async () => { followUp.resolve(thread); }); await settle();
    expect({ reads: f.loadDashboard.mock.calls.length - reads, suspends: f.suspendOfflineAvailability.mock.calls.length - suspends, refreshing: f.snapshot().refreshing }).toEqual({ reads: 0, suspends: 0, refreshing: false });
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('R9256E real AppProvider chapter-switch ownership on %s', (os) => {
  it.each<'sign-out' | 'replacement' | 'same-person refresh'>(['sign-out', 'replacement', 'same-person refresh'])('fences the pending switch across %s', async (change) => {
    setPlatform(os);
    const f = providerHarness(os);
    f.membershipRows.current = ['chapter-a', 'chapter-b'].map(chapterId => ({ chapterId, organizationId: 'org-a', name: 'Tamarack', joinedAt: '2026-01-01', selected: chapterId === 'chapter-a' }));
    port.providerUseApp = f.provider.useApp;
    screen = await render(h(f.provider.AppProvider, null, h(f.Probe)));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); }); await settle();
    expect(f.snapshot().dashboard?.member.id).toBe('a');
    const held = deferred<void>();
    f.switchMobileChapter.mockImplementationOnce(async (chapterID) => {
      await held.promise;
      f.membershipRows.current = f.membershipRows.current.map(row => ({ ...row, selected: row.chapterId === chapterID }));
    });
    let switched!: Promise<void>;
    await act(async () => { switched = f.snapshot().switchChapter('chapter-b'); });
    if (change === 'same-person refresh') {
      f.server.session = { ...f.server.session, access_token: `${f.server.session.access_token}-rotated` };
      await act(async () => { f.authEvent('TOKEN_REFRESHED', f.server.session); }); await settle();
    } else {
      await act(async () => { f.authEvent('SIGNED_OUT', null); }); await settle();
      if (change === 'replacement') {
        f.server.session = session('b');
        await act(async () => { f.authEvent('SIGNED_IN', f.server.session); }); await settle();
        expect(f.snapshot().dashboard?.member.id).toBe('b');
      }
    }
    expect(f.snapshot().refreshing).toBe(false);
    const before = { dashboard: f.snapshot().dashboard, membership: f.snapshot().confirmedMembershipScope, chapters: f.snapshot().chapterMemberships, roles: f.snapshot().authorizedRoles, dues: f.snapshot().duesContext };
    const reads = f.loadDashboard.mock.calls.length, suspends = f.suspendOfflineAvailability.mock.calls.length;
    if (change === 'same-person refresh') f.loadDashboard.mockResolvedValueOnce({ member: { id: 'a', language: 'en', chapterID: 'chapter-b' }, conversations: [], notifications: [], cases: [], actionLog: [] });
    await act(async () => { held.resolve(); await switched; }); await settle();
    if (change === 'same-person refresh') {
      expect(f.loadDashboard.mock.calls.length - reads).toBe(1);
      expect(f.snapshot().dashboard?.member.chapterID).toBe('chapter-b');
      expect(f.snapshot().confirmedMembershipScope).toEqual([{ chapterID: 'chapter-b', organizationID: 'org-a' }]);
    } else {
      expect({ dashboard: f.snapshot().dashboard, membership: f.snapshot().confirmedMembershipScope, chapters: f.snapshot().chapterMemberships, roles: f.snapshot().authorizedRoles, dues: f.snapshot().duesContext }).toEqual(before);
      expect(f.loadDashboard.mock.calls.length - reads).toBe(0);
      expect(f.suspendOfflineAvailability.mock.calls.length - suspends).toBe(0);
    }
    expect(f.snapshot().refreshing).toBe(false);
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('R9256F own S1 probe on %s', (os) => {
  it('R9256F same person signing back in (new session id) during a pending switch: which session id the offline notes end up bound to', async () => {
    setPlatform(os);
    const f = providerHarness(os);
    f.membershipRows.current = ['chapter-a', 'chapter-b'].map(chapterId => ({ chapterId, organizationId: 'org-a', name: 'Tamarack', joinedAt: '2026-01-01', selected: chapterId === 'chapter-a' }));
    port.providerUseApp = f.provider.useApp;
    screen = await render(h(f.provider.AppProvider, null, h(f.Probe)));
    await act(async () => { f.authEvent('SIGNED_IN', f.server.session); }); await settle();
    const held = deferred<void>();
    f.switchMobileChapter.mockImplementationOnce(async () => { await held.promise; });
    let switched!: Promise<void>;
    await act(async () => { switched = f.snapshot().switchChapter('chapter-b'); });
    await act(async () => { f.authEvent('SIGNED_OUT', null); }); await settle();
    const fresh = session('a', '33333333-3333-4333-8333-333333333333');
    f.server.session = fresh;
    await act(async () => { f.authEvent('SIGNED_IN', fresh); }); await settle();
    expect(f.snapshot().dashboard?.member.id).toBe('a');
    const before = f.activateOfflineScope.mock.calls.length;
    await act(async () => { held.resolve(); await switched.catch(() => undefined); }); await settle();
    const after = f.activateOfflineScope.mock.calls.slice(before);
    // Report what happened rather than assert a policy: list the authorization ids used after release.
    expect({ activations: after.map(([, sid]) => sid) }).toEqual({ activations: [] });
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('family 3 real provider composing writer on %s', os => {
  it.each<'switch' | 'notification'>(['switch', 'notification'])('%s refuses a replacement account before dispatch', async kind => {
    setPlatform(os); const f = providerHarness(os);
    screen = await render(h(f.provider.AppProvider, null, h(f.Probe)));
    await act(async () => f.authEvent('SIGNED_IN', f.server.session)); await settle();
    const original = f.snapshot(); const gate = deferred<void>(); f.wire.gate = gate.promise;
    let pending: Promise<void> = Promise.resolve();
    await act(async () => { pending = (kind === 'switch' ? original.switchChapter('chapter-next') : original.setNotificationRead('notice-a', true)).catch(() => undefined); });
    f.server.session = session('b');
    await act(async () => f.authEvent('SIGNED_IN', f.server.session)); await settle();
    await act(async () => { gate.resolve(); await pending; }); await settle();
    expect(f.wire.attempts).toEqual([]);
    expect(f.snapshot().dashboard?.member.id).toBe('b');
    expect(f.snapshot().dashboard?.notifications.every(row => !row.readAt)).toBe(true);
  });
  it.each<'switch' | 'notification'>(['switch', 'notification'])('%s uses the renewed token after a same-person refresh', async kind => {
    setPlatform(os); const f = providerHarness(os);
    f.membershipRows.current = ['chapter-a', 'chapter-next'].map(chapterId => ({ chapterId, organizationId: 'org-a', name: 'Tamarack', joinedAt: '2026-01-01', selected: chapterId === 'chapter-a' }));
    f.loadDashboard.mockImplementation(async userID => ({ member: { id: userID, language: 'en', chapterID: f.membershipRows.current.find(row => row.selected)?.chapterId ?? 'chapter-a' },
      conversations: [], notifications: [{ id: 'notice-a', title: 'Fixture notice', body: 'Fixture body', kind: 'general', readAt: null, createdAt: '2026-11-20T12:00:00Z' }], cases: [], actionLog: [] }));
    screen = await render(h(f.provider.AppProvider, null, h(f.Probe)));
    await act(async () => f.authEvent('SIGNED_IN', f.server.session)); await settle();
    const original = f.snapshot(); const gate = deferred<void>(); f.wire.gate = gate.promise;
    let pending: Promise<void> = Promise.resolve();
    await act(async () => { pending = kind === 'switch' ? original.switchChapter('chapter-next') : original.setNotificationRead('notice-a', true); });
    f.server.session = { ...f.server.session, access_token: f.server.session.access_token + '-renewed' };
    await act(async () => f.authEvent('TOKEN_REFRESHED', f.server.session)); await settle();
    await act(async () => { gate.resolve(); await pending; }); await settle();
    expect(f.wire.attempts).toEqual([{ kind, user: 'a', token: f.server.session.access_token, target: kind === 'switch' ? 'chapter-next' : 'notice-a' }]);
    if (kind === 'switch') expect(f.snapshot().confirmedMembershipScope).toEqual([{ chapterID: 'chapter-next', organizationID: 'org-a' }]);
    else expect(f.snapshot().dashboard?.notifications.find(row => row.id === 'notice-a')?.readAt).toBeTruthy();
  });
});
