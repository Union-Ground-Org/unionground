// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberConversation } from '../models/member';

// G4-7900 (Muse): a steward whose role is revoked while Messages is open.
// Nothing here mocks the Steward Direct read: the real loadStewardDirectPage
// and loadConversationSummaries run against a stubbed backend that answers
// 42501, and the real summary poller publishes into the mounted screen the
// way AppProvider does. The next poll must clear the first and older pages.

type Row = { id: string; member_name: string; member_initials: string; updated_at: string; last_body: string; last_sender_kind: string };
const UPDATED = '2026-11-09T15:00:00.000Z';

const runtime = vi.hoisted(() => ({
  firstPage: [] as MemberConversation[],
  revoked: false,
  push: vi.fn(),
}));
const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
// This suite exercises the real Steward Direct transport; peer-list realtime
// has its own real-adapter regressions in usePeerConversations.test.ts.
vi.mock('../features/usePeerConversations', () => ({ usePeerConversations: () => ({ items: [], failed: false }) }));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    dashboard: { member: { id: 'steward-1', chapterID: 'north' }, conversations: runtime.firstPage },
    mode: 'authenticated',
    session: { user: { id: 'steward-1' } },
    previewHat: null,
    authorizedRoles: ['steward'],
    organizationRoles: [],
    chapterRoles: ['steward'],
    error: null,
    refreshing: false,
    refresh: async () => undefined,
    startPreviewConversation: () => null,
    sessionRestricted: false,
    sampleHat: 'steward',
    chosenStaffRole: null,
    organizationID: 'tamarack',
  }),
}));
vi.mock('expo-router', () => ({ useNavigation: () => ({ setParams: vi.fn() }), useIsFocused: () => true, Redirect: () => null, useLocalSearchParams: () => ({}), useRouter: () => ({ push: runtime.push, replace: runtime.push }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    View: box,
    ScrollView: box,
    Text: ({ children }: { children?: ReactNode }) => h('span', null, children),
    TextInput: () => null,
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode | ((state: { pressed: boolean }) => ReactNode); onPress?: () => void; accessibilityLabel?: string }) => (
      h('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, typeof children === 'function' ? children({ pressed: false }) : children)
    ),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Platform: { OS: 'android' },
    AccessibilityInfo: { announceForAccessibility: () => undefined },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock('../components/ui', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Avatar: () => null,
    Body: box,
    Heading: box,
    Card: box,
    Screen: box,
    Notice: ({ children }: { children: string }) => h('p', { role: 'alert' }, children),
    StateMessage: ({ title }: { title: string }) => h('div', null, title),
    Button: ({ label, onPress, disabled, busy }: { label: string; onPress?: () => void; disabled?: boolean; busy?: boolean }) => (
      h('button', { type: 'button', onClick: onPress, disabled: disabled || busy, 'aria-busy': busy ? 'true' : undefined, 'aria-label': label }, label)
    ),
    SearchField: ({ value, onChangeText, placeholder }: { value: string; onChangeText: (text: string) => void; placeholder: string }) => (
      h('input', { 'aria-label': placeholder, value, onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) })
    ),
  };
});
vi.mock('../components/MessageWorkflowPicker', () => ({ MessageWorkflowPicker: () => null }));
vi.mock('../components/RowHighlight', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { HighlightList: box, HighlightRow: box };
});
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../data/useChannels', () => ({
  useChannelStore: () => ({ subscribe: () => () => undefined, getVersion: () => 0, channels: () => [], status: () => 'ready', loadFault: () => null, refresh: async () => undefined }),
}));
vi.mock('../features/NativePlatformAnnouncements', () => ({ NativeAnnouncementToggle: () => null }));
vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('../data/channelControls', () => ({ useChannelControls: () => ({ controls: { switches: { channelPinning: false, mentionSearch: false } } }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null })); // the Messages organize sheet pads the window's safe area (#9608)
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0 }));
// Public Messages is a pushed screen inside the pinned header, whose frosted
// chrome loads a native module; these cases render only the inbox body.
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children: unknown }) => children }));
vi.mock('../services/haptics', () => ({ haptics: { select: async () => undefined, success: async () => undefined, warning: async () => undefined } }));
vi.mock('../services/messageWorkflowPreference', () => ({
  latestMessageWorkflowRequest: () => 0,
  readMessageWorkflowOnboarded: async () => true,
  readMessageWorkflowPreference: async () => 'inbox',
  saveMessageWorkflowPreference: async () => undefined,
  subscribeMessageWorkflowPreference: () => () => undefined,
}));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#000000' }) }));

import MessagesScreen from '../../app/messages';
import { createConversationUnreadPoller } from '../lib/conversationUnread';
import { loadConversationSummaries, loadStewardDirectPage } from '../services/supabase';
import { setNativeDirectAudience, stewardDirectRefusalEpoch } from '../services/stewardDirectInbox';

const catalog: Row[] = Array.from({ length: 250 }, (_, index) => {
  const label = String(index + 1).padStart(3, '0');
  return { id: `00000000-0000-4000-8000-000000000${label}`, member_name: `Tamarack Worker ${label}`, member_initials: 'TM', updated_at: UPDATED, last_body: `Question ${label}`, last_sender_kind: 'member' };
});

type Args = { p_search: string | null; p_after_updated: string | null; p_after_id: string | null; p_limit: number };
function serve(args: Args) {
  const ordered = [...catalog].sort((a, b) => b.id.localeCompare(a.id));
  const after = args.p_after_id ? ordered.filter((row) => row.id < args.p_after_id!) : ordered;
  return after.slice(0, Math.min(args.p_limit, 100)).map((row) => ({ ...row, total_count: catalog.length }));
}

let root: Root;
let host: HTMLDivElement;

function conversationNames(): string[] {
  return Array.from(host.querySelectorAll('button'))
    .map((button) => button.getAttribute('aria-label') ?? '')
    .filter((label) => label.startsWith('Tamarack Worker') && label.includes(', Private conversation, '))
    .map((label) => label.split(',')[0]!);
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === label);
}

async function render() {
  await act(async () => { root.render(createElement(MessagesScreen)); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setNativeDirectAudience('steward');
  runtime.revoked = false;
  backend.rpc.mockReset().mockImplementation((name: string, args: Args) => {
    if (name !== 'list_steward_conversations') return Promise.resolve({ data: null, error: null });
    if (runtime.revoked) return Promise.resolve({ data: null, error: { code: '42501', message: 'committee member role required' } });
    return Promise.resolve({ data: serve(args), error: null });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setNativeDirectAudience('member');
});

describe('Committee Direct after the committee member role is revoked on Messages', () => {
  it('clears the first and older pages on the next poll, through the real refusal path', async () => {
    runtime.firstPage = (await loadStewardDirectPage()).rows;
    await render();
    expect(conversationNames()).toHaveLength(100);
    await act(async () => { button('Show older conversations')?.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(conversationNames()).toHaveLength(200);

    const published: number[] = [];
    const poller = createConversationUnreadPoller('steward-1', {
      load: loadConversationSummaries,
      refusalEpoch: stewardDirectRefusalEpoch,
      onPublished: (rows) => { published.push(rows.length); runtime.firstPage = [...rows]; },
    });
    runtime.revoked = true;
    const epochBefore = stewardDirectRefusalEpoch();
    await act(async () => { await poller.tick(); });
    await render();

    // The poll's own read met the refusal (the epoch moved during it) and its
    // empty page was still published, clearing both streams.
    expect(stewardDirectRefusalEpoch()).toBe(epochBefore + 1);
    expect(published).toEqual([0]);
    expect(conversationNames()).toEqual([]);
    expect(button('Show older conversations')).toBeUndefined();
  });
});
