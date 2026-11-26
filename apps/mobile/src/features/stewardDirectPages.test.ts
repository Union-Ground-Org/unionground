// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberConversation } from '../models/member';
import type { DemoChannel } from '../data/demoChannels';
import { STAFF_HAT_FUNCTIONS } from '../lib/hatFunctions';
import type { PeerConversation } from '../lib/peerConversations';
import type { TaskDiscussion } from '../lib/taskDiscussions';
import type { AppMode } from '../state/AppProvider';

// BUG-UG-NATIVE-STEWARD-DIRECT-INBOX-STOPS-AT-100-20261109: the
// mounted Messages tab under a worn steward hat, with 101 fictional Tamarack
// conversations behind a stub of the server's cursor and search.

type Row = MemberConversation;
const UPDATED = '2026-11-09T15:00:00.000Z';
function row(number: number, updatedAt = UPDATED): Row {
  const label = String(number).padStart(3, '0');
  return {
    id: `00000000-0000-4000-8000-000000000${label}`,
    title: `Tamarack Worker ${label}`,
    initials: 'TM',
    createdAt: updatedAt,
    updatedAt,
    unreadCount: 1,
    latestMessage: `Question ${label}`,
  };
}

const runtime = vi.hoisted(() => ({
  userID: 'steward-1',
  chapterID: 'north',
  language: 'en',
  hat: 'steward' as string | null,
  mode: 'authenticated' as AppMode,
  dashboardReady: true,
  sessionRestricted: false,
  catalog: [] as MemberConversation[],
  firstPage: [] as MemberConversation[],
  failLater: false,
  refuse: false,
  calls: [] as { search: string | null; after: { updatedAt: string; id: string } | null }[],
  pending: [] as (() => void)[],
  hold: false,
  push: vi.fn(),
  setParams: vi.fn(),
  show: undefined as string | undefined,
  focused: true,
  channels: [] as DemoChannel[],
  peers: [] as PeerConversation[],
  tasks: [] as TaskDiscussion[],
}));

vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    dashboard: runtime.dashboardReady
      ? { member: { id: runtime.userID, chapterID: runtime.chapterID, language: runtime.language }, conversations: runtime.firstPage }
      : null,
    mode: runtime.mode,
    session: { user: { id: runtime.userID } },
    previewHat: null,
    authorizedRoles: ['steward'],
    error: null,
    refreshing: false,
    refresh: async () => undefined,
    startPreviewConversation: () => null,
    sessionRestricted: runtime.sessionRestricted,
    sampleHat: runtime.hat,
    chosenStaffRole: null,
    organizationID: 'tamarack',
  }),
}));
vi.mock('../services/supabase', async () => {
  const inbox = await import('../services/stewardDirectInbox');
  return {
    startMemberConversation: vi.fn(),
    loadStewardDirectPage: (options: { search?: string | null; after?: { updatedAt: string; id: string } | null }) => {
      runtime.calls.push({ search: options.search ?? null, after: options.after ?? null });
      const settle = () => {
        if (runtime.refuse) {
          // The real data layer advances the refusal epoch on every 42501.
          inbox.noteStewardDirectRefusal();
          return Promise.resolve({ rows: [], next: null, total: 0, refused: true });
        }
        if (runtime.failLater && options.after) return Promise.reject(new Error('Worker conversations did not load. Try again.'));
        const needle = options.search?.trim().toLowerCase() ?? null;
        const ordered = [...runtime.catalog].sort((a, b) => (a.updatedAt === b.updatedAt ? b.id.localeCompare(a.id) : b.updatedAt.localeCompare(a.updatedAt)));
        const matching = needle ? ordered.filter((item) => item.title.toLowerCase().includes(needle)) : ordered;
        const after = options.after;
        const rest = after ? matching.filter((item) => item.updatedAt < after.updatedAt || (item.updatedAt === after.updatedAt && item.id < after.id)) : matching;
        const rows = rest.slice(0, 100);
        const last = rows[rows.length - 1];
        return Promise.resolve({ rows, next: rows.length === 100 && last ? { updatedAt: last.updatedAt, id: last.id } : null, total: matching.length });
      };
      if (!runtime.hold) return settle();
      return new Promise((resolve, reject) => { runtime.pending.push(() => { settle().then(resolve, reject); }); });
    },
  };
});
vi.mock('expo-router', () => ({
  useIsFocused: () => runtime.focused,
  Redirect: () => null,
  useLocalSearchParams: () => ({ show: runtime.show }),
  useNavigation: () => ({ setParams: runtime.setParams }),
  useRouter: () => ({
    push: runtime.push,
    replace: runtime.push,
    setParams: (params: { show?: string }) => {
      // The global router targets the focused route.
      if (runtime.focused) runtime.setParams(params);
    },
  }),
}));
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
  useChannelStore: () => ({ subscribe: () => () => undefined, getVersion: () => 0, channels: () => runtime.channels, status: () => 'ready', loadFault: () => null, refresh: async () => undefined }),
}));
vi.mock('../features/NativePlatformAnnouncements', () => ({ NativeAnnouncementToggle: () => null }));
vi.mock('../features/usePeerConversations', () => ({ usePeerConversations: () => ({ items: runtime.peers, failed: false }) }));
vi.mock('../features/useTaskDiscussions', () => ({ useTaskDiscussions: () => ({ items: runtime.tasks, failed: false }) }));
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
import { projectStewardDirectInbox, stewardDirectRefusalEpoch } from '../services/stewardDirectInbox';

let root: Root;
let host: HTMLDivElement;

function serverFirstPage() {
  return [...runtime.catalog].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 100);
}

function conversationNames(): string[] {
  return Array.from(host.querySelectorAll('button'))
    .map((button) => button.getAttribute('aria-label') ?? '')
    // Inbox rows only; the five RECENT shortcuts carry no "Private conversation".
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

async function press(label: string) {
  const target = button(label);
  expect(target, label).toBeTruthy();
  await act(async () => { target?.click(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.userID = 'steward-1';
  runtime.chapterID = 'north';
  runtime.language = 'en';
  runtime.hat = 'steward';
  runtime.mode = 'authenticated';
  runtime.dashboardReady = true;
  runtime.sessionRestricted = false;
  runtime.catalog = Array.from({ length: 101 }, (_, index) => row(index + 1));
  runtime.firstPage = serverFirstPage();
  runtime.failLater = false;
  runtime.refuse = false;
  runtime.hold = false;
  runtime.pending = [];
  runtime.calls = [];
  runtime.push.mockReset();
  runtime.setParams.mockReset().mockImplementation(({ show }: { show?: string }) => { runtime.show = show; });
  runtime.show = undefined;
  runtime.focused = true;
  runtime.channels = [];
  runtime.peers = [];
  runtime.tasks = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('the Committee messages shortcut', () => {
  const direct = 'Tamarack Worker 001';
  const peer = 'Fixture peer conversation';
  const channel = 'Fixture campaign space';
  const task = 'Fixture task discussion';

  beforeEach(() => {
    const newer = '2026-11-10T15:00:00.000Z';
    runtime.catalog = [row(1)];
    runtime.firstPage = serverFirstPage();
    runtime.peers = [{
      id: 'peer-a', peerName: peer, peerInitials: 'FP', updatedAt: newer,
      state: 'open', blockable: true, messages: [],
    }];
    runtime.channels = [{
      id: 'space-a', name: channel, topic: 'Campaign updates', unread: 1,
      messages: [{ id: 'post-a', author: 'Avery', initials: 'A', time: '3:00 PM', createdAt: newer, body: 'Update' }],
    }];
    runtime.tasks = [{
      taskID: 'task-a', title: task, reference: 'NORTH-1', latestAt: newer,
      latestPreview: 'Task update', latestFromYou: false,
    }];
  });

  function expectBefore(first: string, second: string) {
    const content = host.textContent ?? '';
    expect(content).toContain(first);
    expect(content).toContain(second);
    expect(content.indexOf(first)).toBeLessThan(content.indexOf(second));
  }

  async function typeSearch(query: string) {
    const field = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, query);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return field;
  }

  it.each([['en', 'Committee messages'], ['es', 'Mensajes del integrante del comité']])('puts Committee Direct first from the actual shortcut in %s', async (language, heading) => {
    const shortcut = STAFF_HAT_FUNCTIONS.steward.find((item) => item.key === 'steward-messages');
    const href = new URL(shortcut!.href, 'https://example.invalid');
    runtime.show = href.searchParams.get('show') ?? undefined;
    runtime.language = language;
    await render();

    expectBefore(direct, peer);
    expectBefore(direct, channel);
    expectBefore(direct, task);
    expect(host.textContent).toContain(heading);
    expect(runtime.setParams).toHaveBeenCalledExactlyOnceWith({ show: undefined });
    expect(runtime.calls).toEqual([]);

    // The last button for each inbox item is its row, after any Recent shortcut.
    const labels = Array.from(host.querySelectorAll('button'), (button) => button.getAttribute('aria-label') ?? '');
    const indexOfRow = (name: string) => labels.findLastIndex((label) => label.startsWith(`${name},`));
    expect(indexOfRow(direct)).toBeGreaterThanOrEqual(0);
    for (const later of [peer, channel, task]) expect(indexOfRow(later)).toBeGreaterThan(indexOfRow(direct));
  });

  it.each(['member', 'coordinator'])('keeps the regular inbox when %s receives the Committee intent', async (hat) => {
    runtime.show = 'steward';
    runtime.hat = hat;
    await render();

    expectBefore(peer, direct);
    expectBefore(task, 'Inbox');
    expect(host.textContent).not.toContain('Committee messages');
    expect(runtime.setParams).toHaveBeenCalledExactlyOnceWith({ show: undefined });
    expect(runtime.calls).toEqual([]);
  });

  it.each(['booting', 'signedOut', 'mfaRequired'] as const)('discards the intent in %s mode', async (mode) => {
    runtime.show = 'steward';
    runtime.mode = mode;
    runtime.dashboardReady = false;
    await render();

    expect(runtime.setParams).toHaveBeenCalledExactlyOnceWith({ show: undefined });

    runtime.mode = 'authenticated';
    runtime.dashboardReady = true;
    await render();
    expectBefore(peer, direct);
  });

  it('waits for the dashboard while the authenticated screen stays focused', async () => {
    runtime.show = 'steward';
    runtime.dashboardReady = false;
    await render();

    expect(host.textContent).toContain('Messages are loading');
    expect(runtime.setParams).not.toHaveBeenCalled();

    runtime.dashboardReady = true;
    await render();
    expectBefore(direct, peer);
    expect(runtime.setParams).toHaveBeenCalledExactlyOnceWith({ show: undefined });
  });

  it('clears the pending intent if Messages blurs before the dashboard is ready', async () => {
    runtime.show = 'steward';
    runtime.dashboardReady = false;
    await render();
    expect(runtime.setParams).not.toHaveBeenCalled();

    runtime.focused = false;
    await render();
    expect(runtime.setParams).toHaveBeenCalledExactlyOnceWith({ show: undefined });

    runtime.dashboardReady = true;
    runtime.focused = true;
    await render();
    expectBefore(peer, direct);
  });

  it('keeps ordinary Recent and task order when the Committee has no Direct rows', async () => {
    runtime.show = 'steward';
    runtime.catalog = [];
    runtime.firstPage = [];
    await render();

    expectBefore('RECENT', peer);
    expectBefore(peer, 'Inbox');
    expectBefore(channel, 'Inbox');
    expectBefore(task, 'Inbox');
  });

  it('keeps the signed-in Committee’s own thread reachable outside the priority group and strip', async () => {
    const own = 'Fixture own committee member thread';
    const ownID = row(2).id;
    runtime.catalog = projectStewardDirectInbox([
      { id: row(1).id, member_name: direct, user_id: 'other-member', updated_at: UPDATED },
      { id: ownID, member_name: own, user_id: runtime.userID, updated_at: '2026-11-10T16:00:00Z' },
    ]);
    runtime.firstPage = serverFirstPage();
    runtime.show = 'steward';
    await render();

    const section = (label: string) => [...host.querySelectorAll('span')]
      .find((span) => span.textContent === label)?.parentElement;
    expect(section('Committee messages')?.textContent).toContain(direct);
    expect(section('Committee messages')?.textContent).not.toContain(own);
    expect(section('RECENT')?.textContent).toContain(direct);
    expect(section('RECENT')?.textContent).not.toContain(own);
    const ownRow = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label')?.startsWith(`${own}, Private conversation`));
    expect(ownRow).toBeDefined();
    await act(async () => { ownRow?.click(); });
    expect(runtime.push).toHaveBeenCalledWith(`/conversation/${ownID}`);
  });

  it('clears an old search so the Committee Direct rows show in the inbox', async () => {
    await render();
    const field = await typeSearch('unmatched');
    expect(field.value).toBe('unmatched');
    expect(conversationNames()).toEqual([]);

    runtime.show = 'steward';
    await render();
    expect(field.value).toBe('');
    expect(conversationNames()).toEqual([direct]);
  });

  it('keeps the typed search when the shortcut is reopened on the focused landing', async () => {
    runtime.catalog = [row(1), row(2)];
    runtime.firstPage = serverFirstPage();
    runtime.show = 'steward';
    await render();
    const field = await typeSearch('worker 001');
    expect(field.value).toBe('worker 001');
    expect(conversationNames()).toEqual([direct]);

    runtime.show = 'steward';
    await render();
    expect(field.value).toBe('worker 001');
    expect(conversationNames()).toEqual([direct]);
    expect(runtime.setParams).toHaveBeenCalledTimes(2);
  });

  it('returns to regular Messages after opening a conversation from the landing', async () => {
    runtime.show = 'steward';
    await render();
    expectBefore(direct, peer);
    const conversation = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label')?.startsWith(`${direct}, Private conversation`));
    expect(conversation).toBeDefined();
    await act(async () => { conversation?.click(); });
    expect(runtime.push).toHaveBeenCalledWith(`/conversation/${row(1).id}`);
    runtime.focused = false;
    await render();
    runtime.focused = true;
    await render();
    expectBefore(peer, direct);
  });

  it('still clears filters and returns to regular ordering for a task alert', async () => {
    runtime.show = 'steward';
    await render();
    await press('Channels');
    expect(host.textContent).not.toContain(task);

    runtime.show = 'tasks';
    await render();

    expectBefore(task, 'Inbox');
    expectBefore(peer, direct);
    expect(runtime.setParams).toHaveBeenLastCalledWith({ show: undefined });
  });
});

describe('Committee Direct continuation on the mounted Messages tab', () => {
  it('shows the first 100, then loads conversation 101 in order and states the end', async () => {
    await render();
    expect(conversationNames()).toHaveLength(100);
    expect(button('Show older conversations')).toBeTruthy();
    runtime.hold = true;
    await press('Show older conversations');
    expect(button('Loading older conversations')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => { runtime.pending.shift()?.(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    const names = conversationNames();
    expect(names).toHaveLength(101);
    expect(new Set(names).size).toBe(101);
    // Equal update times: the inbox keeps its existing title tie-break.
    expect(names).toEqual(Array.from({ length: 101 }, (_, index) => `Tamarack Worker ${String(index + 1).padStart(3, '0')}`));
    expect(runtime.calls).toEqual([{ search: null, after: { updatedAt: UPDATED, id: row(2).id } }]);
    expect(host.textContent).toContain('All 101 worker conversations are shown.');
    expect(button('Show older conversations')).toBeUndefined();
  });

  it('keeps loaded rows when a later page fails and loads them on Try again', async () => {
    await render();
    runtime.failLater = true;
    await press('Show older conversations');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Older conversations did not load. The conversations shown stay here. Try again.');
    expect(conversationNames()).toHaveLength(100);
    runtime.failLater = false;
    await press('Try again');
    expect(conversationNames()).toHaveLength(101);
    expect(runtime.calls.map((call) => call.after?.id)).toEqual([row(2).id, row(2).id]);
  });

  it('finds the final conversation with a server search and opens it', async () => {
    await render();
    const field = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, 'worker 001');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(350); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(runtime.calls).toEqual([{ search: 'worker 001', after: null }]);
    expect(conversationNames()).toEqual(['Tamarack Worker 001']);
    expect(host.textContent).toContain('Every conversation whose worker name matches is shown.');
    const target = Array.from(host.querySelectorAll('button')).find((item) => item.getAttribute('aria-label')?.startsWith('Tamarack Worker 001, Private conversation'));
    await act(async () => { target?.click(); });
    expect(runtime.push).toHaveBeenCalledWith(`/conversation/${row(1).id}`);
  });

  it('keeps an opened older page across a first-page refresh with no duplicate', async () => {
    await render();
    await press('Show older conversations');
    // A reply moves conversation 050 to the top; the refreshed first page now
    // ends one row earlier, and conversation 001 is still on the older page.
    const moved = row(50, '2026-11-09T16:00:00.000Z');
    runtime.catalog = runtime.catalog.map((item) => (item.id === moved.id ? moved : item));
    runtime.firstPage = [moved, ...serverFirstPage().filter((item) => item.id !== moved.id)].slice(0, 100);
    await render();
    const names = conversationNames();
    expect(names).toHaveLength(101);
    expect(new Set(names).size).toBe(101);
    expect(names[0]).toBe('Tamarack Worker 050');
    expect(names).toContain('Tamarack Worker 001');
    expect(names).toContain('Tamarack Worker 002');
  });

  it('clears older rows and the cursor when the campaign or account changes', async () => {
    await render();
    await press('Show older conversations');
    expect(conversationNames()).toHaveLength(101);
    runtime.chapterID = 'south';
    await render();
    expect(conversationNames()).toHaveLength(100);
    expect(button('Show older conversations')).toBeTruthy();
    runtime.userID = 'steward-2';
    await render();
    expect(conversationNames()).toHaveLength(100);
    await press('Show older conversations');
    expect(runtime.calls.at(-1)).toEqual({ search: null, after: { updatedAt: UPDATED, id: row(2).id } });
  });

  // G6-7900-1: a role the server stops granting is not in the scope key (the
  // summary poll refreshes rows, not roles). No cached row may outlive the
  // refusal, the empty poll that follows it, or an empty first page.
  it('drops every row on a refused later page and through the empty poll that follows', async () => {
    runtime.catalog = Array.from({ length: 250 }, (_, index) => row(index + 1));
    runtime.firstPage = serverFirstPage();
    await render();
    await press('Show older conversations');
    expect(conversationNames()).toHaveLength(200);
    runtime.refuse = true;
    await press('Show older conversations');
    expect(conversationNames()).toEqual([]);
    expect(button('Show older conversations')).toBeUndefined();
    expect(host.textContent).not.toContain('worker conversations are shown');
    runtime.firstPage = [];
    await render();
    expect(conversationNames()).toEqual([]);
    // The role comes back: only the server's new first page is shown, and the
    // older pages read before the refusal stay gone.
    runtime.refuse = false;
    runtime.firstPage = serverFirstPage();
    await render();
    expect(conversationNames()).toHaveLength(100);
    expect(button('Show older conversations')).toBeTruthy();
  });

  // G7-7900 (Grok): a summary poll that began before the refusal resolves
  // after it with the old first page. It must not bring the rows back.
  it('drops a summary poll that began before the refusal and resolves after it', async () => {
    runtime.catalog = Array.from({ length: 250 }, (_, index) => row(index + 1));
    runtime.firstPage = serverFirstPage();
    await render();
    await press('Show older conversations');
    expect(conversationNames()).toHaveLength(200);
    let resolvePoll: (rows: MemberConversation[]) => void = () => undefined;
    const published: number[] = [];
    const poller = createConversationUnreadPoller('steward-1', {
      load: () => new Promise((resolve) => { resolvePoll = resolve; }),
      refusalEpoch: stewardDirectRefusalEpoch,
      onPublished: (rows) => { published.push(rows.length); runtime.firstPage = [...rows]; },
    });
    const stalePoll = poller.tick();
    runtime.refuse = true;
    await press('Show older conversations');
    await act(async () => { await Promise.resolve(); });
    expect(conversationNames()).toEqual([]);
    resolvePoll(serverFirstPage());
    await act(async () => { await stalePoll; });
    await render();
    expect(published).toEqual([]);
    expect(conversationNames()).toEqual([]);
    // A poll that begins after the refusal publishes what the server says now.
    const freshPoll = poller.tick();
    resolvePoll([]);
    await act(async () => { await freshPoll; });
    await render();
    expect(published).toEqual([0]);
    expect(conversationNames()).toEqual([]);
  });

  it('drops every row when a server search is refused', async () => {
    await render();
    runtime.refuse = true;
    const field = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Worker');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(350); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(runtime.calls.at(-1)).toEqual({ search: 'Worker', after: null });
    expect(conversationNames()).toEqual([]);
  });

  it('drops older pages when the first page comes back empty', async () => {
    await render();
    await press('Show older conversations');
    expect(conversationNames()).toHaveLength(101);
    runtime.firstPage = [];
    await render();
    expect(conversationNames()).toEqual([]);
    runtime.firstPage = serverFirstPage();
    await render();
    expect(conversationNames()).toHaveLength(100);
    expect(conversationNames()).not.toContain('Tamarack Worker 001');
  });

  // G6-7900-2: the server search matches names, not message text. It says so,
  // and older pages stay one press away, after which the text match shows.
  // G6-7900 final: a complete first page from the server is
  // authoritative. Two conversations the steward may no longer read leave the
  // screen, names and previews included, from both streams.
  it('drops conversations a complete authoritative refresh no longer returns', async () => {
    await render();
    await press('Show older conversations');
    expect(conversationNames()).toHaveLength(101);
    const removed = [row(101), row(50)];
    runtime.catalog = runtime.catalog.filter((item) => !removed.some((gone) => gone.id === item.id));
    for (let poll = 0; poll < 3; poll += 1) {
      runtime.firstPage = serverFirstPage();
      await render();
    }
    expect(runtime.firstPage).toHaveLength(99);
    const names = conversationNames();
    expect(names).toHaveLength(99);
    expect(names).not.toContain('Tamarack Worker 101');
    expect(names).not.toContain('Tamarack Worker 050');
    expect(host.textContent).not.toContain('Question 101');
    expect(host.textContent).not.toContain('Question 050');
    expect(host.textContent).toContain('All 99 worker conversations are shown.');
    expect(button('Show older conversations')).toBeUndefined();
  });

  it('drops a removed conversation that should be on a full first page, and keeps older pages', async () => {
    runtime.catalog = Array.from({ length: 250 }, (_, index) => row(index + 1));
    runtime.firstPage = serverFirstPage();
    await render();
    await press('Show older conversations');
    expect(conversationNames()).toHaveLength(200);
    runtime.catalog = runtime.catalog.filter((item) => item.id !== row(200).id);
    runtime.firstPage = serverFirstPage();
    await render();
    const names = conversationNames();
    expect(names).not.toContain('Tamarack Worker 200');
    // The older page is read again to the same depth, so the next row in
    // server order fills the gap at the bottom.
    expect(names).toHaveLength(200);
    expect(names).toContain('Tamarack Worker 051');
    expect(names).toContain('Tamarack Worker 050');
  });

  // G6-7900 final: after a refusal releases, the unchanged
  // query is asked of the server again; Show older keeps working.
  it('asks the same search again once a refusal releases', async () => {
    await render();
    const field = host.querySelector('input') as HTMLInputElement;
    runtime.refuse = true;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'worker 001');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(350); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(conversationNames()).toEqual([]);
    const callsWhileRefused = runtime.calls.length;
    await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
    expect(runtime.calls).toHaveLength(callsWhileRefused);
    runtime.refuse = false;
    runtime.firstPage = serverFirstPage();
    await render();
    await act(async () => { vi.advanceTimersByTime(350); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(runtime.calls.at(-1)).toEqual({ search: 'worker 001', after: null });
    expect(conversationNames()).toEqual(['Tamarack Worker 001']);
    expect(host.textContent).toContain('Every conversation whose worker name matches is shown.');
    await press('Show older conversations');
    expect(runtime.calls.at(-1)).toEqual({ search: null, after: { updatedAt: UPDATED, id: row(2).id } });
  });

  it('keeps older pages reachable when a name search cannot see message text', async () => {
    runtime.catalog = runtime.catalog.map((item) => (item.id === row(1).id ? { ...item, latestMessage: 'Payroll missed my step increase' } : item));
    runtime.firstPage = serverFirstPage();
    await render();
    const field = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'payroll');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(350); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(conversationNames()).toEqual([]);
    expect(host.textContent).toContain('Every conversation whose worker name matches is shown. Message text is searched only in the conversations shown, so show older conversations to include them.');
    await press('Show older conversations');
    expect(runtime.calls.at(-1)).toEqual({ search: null, after: { updatedAt: UPDATED, id: row(2).id } });
    expect(conversationNames()).toEqual(['Tamarack Worker 001']);
  });

  it('leaves a worker hat on its own rows with no Committee Direct paging', async () => {
    runtime.hat = 'member';
    runtime.firstPage = runtime.catalog.slice(0, 3);
    await render();
    expect(conversationNames()).toHaveLength(3);
    expect(button('Show older conversations')).toBeUndefined();
    expect(host.textContent).not.toContain('worker conversations are shown');
    expect(runtime.calls).toEqual([]);
  });
});

// G4-7900 final2 (Muse) and the invariant set: after any completed
// poll cycle, every row on screen was returned by a server read in that
// cycle, at every loaded depth. Property-style: for 1, 2 and 3 loaded pages,
// remove a row at depths across the page boundaries, with all update times
// tied or grouped so ties straddle the boundaries; plus refusal and shrink.
describe('Committee Direct shows only rows the latest cycle returned', () => {
  const TOTAL = 350;
  function catalogFor(mode: 'tied' | 'grouped'): MemberConversation[] {
    return Array.from({ length: TOTAL }, (_, index) => {
      const number = index + 1;
      // Grouped: seven rows share each minute, so ties cross page edges.
      const minute = Math.floor(number / 7);
      const updatedAt = mode === 'tied' ? UPDATED : new Date(Date.parse(UPDATED) + minute * 60_000).toISOString();
      return row(number, updatedAt);
    });
  }
  function serverOrder(): MemberConversation[] {
    return [...runtime.catalog].sort((a, b) => (a.updatedAt === b.updatedAt ? b.id.localeCompare(a.id) : b.updatedAt.localeCompare(a.updatedAt)));
  }
  async function cycle() {
    runtime.firstPage = runtime.refuse ? [] : serverOrder().slice(0, 100);
    await render();
    for (let turn = 0; turn < 12; turn += 1) {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
  }
  async function loadPages(count: number) {
    runtime.firstPage = serverOrder().slice(0, 100);
    await render();
    for (let page = 1; page < count; page += 1) await press('Show older conversations');
    expect(conversationNames()).toHaveLength(100 * count);
  }
  function expectOnlyCatalogRows() {
    const allowed = new Set(runtime.catalog.map((item) => item.title));
    for (const name of conversationNames()) expect(allowed.has(name), name).toBe(true);
  }

  const depths = [0, 1, 49, 98, 99, 100, 101, 150, 198, 199, 200, 201, 250, 298, 299];
  const modes: ('tied' | 'grouped')[] = ['tied', 'grouped'];
  const cases = modes.flatMap((mode) => [1, 2, 3].flatMap((pages) => (
    depths.filter((depth) => depth < pages * 100).map((depth) => ({ mode, pages, depth }))
  )));

  it.each(cases)('$mode times, $pages loaded pages: a row removed at depth $depth is gone after the next cycle', async ({ mode, pages, depth }) => {
    runtime.catalog = catalogFor(mode);
    await loadPages(pages);
    const removed = serverOrder()[depth]!;
    runtime.catalog = runtime.catalog.filter((item) => item.id !== removed.id);
    await cycle();
    expect(conversationNames()).not.toContain(removed.title);
    expect(host.textContent).not.toContain(`${removed.latestMessage}`);
    expectOnlyCatalogRows();
    // Grok G7 final: every still-authorized row survives, through tied times
    // and page boundaries, filling the loaded depth in server order.
    const names = new Set(conversationNames());
    for (const kept of serverOrder().slice(0, pages * 100)) expect(names.has(kept.title), kept.title).toBe(true);
    expect(conversationNames()).toHaveLength(pages * 100);
  });

  it.each([2, 3])('%i loaded pages: a deeper row that moves up stays on screen once', async (pages) => {
    runtime.catalog = catalogFor('grouped');
    await loadPages(pages);
    const mover = serverOrder()[pages * 100 - 50]!;
    const newest = new Date(Date.parse(serverOrder()[0]!.updatedAt) + 60_000).toISOString();
    runtime.catalog = runtime.catalog.map((item) => (item.id === mover.id ? { ...item, updatedAt: newest, createdAt: newest, latestMessage: 'Moved up' } : item));
    await cycle();
    const names = conversationNames();
    expect(names.filter((name) => name === mover.title)).toHaveLength(1);
    expectOnlyCatalogRows();
    expect(names).toHaveLength(pages * 100);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each([1, 2, 3])('%i loaded pages: a refusal shows nothing, and the release shows only returned rows', async (pages) => {
    runtime.catalog = catalogFor('grouped');
    await loadPages(pages);
    runtime.refuse = true;
    await cycle();
    expect(conversationNames()).toEqual([]);
    runtime.refuse = false;
    runtime.catalog = runtime.catalog.filter((_, index) => index % 3 !== 0);
    await cycle();
    expectOnlyCatalogRows();
    expect(conversationNames()).toHaveLength(100);
  });

  it.each([1, 2, 3])('%i loaded pages: a shrink to 50 shows exactly the 50 returned', async (pages) => {
    runtime.catalog = catalogFor('grouped');
    await loadPages(pages);
    runtime.catalog = serverOrder().slice(120, 170);
    await cycle();
    expectOnlyCatalogRows();
    expect(conversationNames()).toHaveLength(50);
  });

  it('removes rows at several depths in one cycle with three pages loaded', async () => {
    runtime.catalog = catalogFor('grouped');
    await loadPages(3);
    const order = serverOrder();
    const removed = [order[0]!, order[99]!, order[100]!, order[199]!, order[200]!, order[299]!];
    runtime.catalog = runtime.catalog.filter((item) => !removed.some((gone) => gone.id === item.id));
    await cycle();
    for (const gone of removed) expect(conversationNames()).not.toContain(gone.title);
    expectOnlyCatalogRows();
  });
});
