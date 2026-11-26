import { createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberDashboard } from '../models/member';
import { activityCopy } from '../lib/activityCopy';
import { messageInboxCopy } from '../lib/messageInboxCopy';

// BUG-UG-NATIVE-MESSAGES-ACTIVITY-LOADING-FOREVER-20261018: Messages
// and Activity used to render the loading StateMessage whenever the dashboard
// was absent, with no error state, no Try again and no pull-to-refresh, even
// though AppProvider had recorded the failure. These tests render both shipped
// screens (the mobile lane has no React Native renderer, so native hosts and
// unrelated features are replaced) and drive the recovery controls.

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};

type ButtonCapture = { onPress: () => void; disabled?: boolean; busy?: boolean; variant?: string };
type ScreenCapture = { onRefresh?: () => void; refreshing?: boolean };

const mocks = vi.hoisted(() => ({
  app: {
    mode: 'authenticated' as 'booting' | 'signedOut' | 'mfaRequired' | 'authenticated' | 'preview',
    dashboard: null as MemberDashboard | null,
    error: null as string | null,
    refreshing: false,
    session: null,
    previewHat: null,
    authorizedRoles: [] as string[],
    sessionRestricted: false,
    refresh: vi.fn(async (_reason?: 'automatic' | 'user-refresh') => undefined),
    startPreviewConversation: vi.fn(() => null),
    setNotificationRead: vi.fn(async () => undefined),
  },
  buttons: new Map<string, ButtonCapture>(),
  screens: [] as ScreenCapture[],
}));

type HostProps = { children?: ReactNode; accessibilityLabel?: string; onPress?: () => void };
type ReactModule = typeof import('react');
vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => createElement('aside', null, 'Optional feature guide'), NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('react', async (original) => ({
  ...await original<ReactModule>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => number) => snapshot(),
}));
vi.mock('react-native', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children);
  return {
    AccessibilityInfo: { announceForAccessibility: () => undefined },
    Platform: { OS: 'ios', select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default },
    View: Host, ScrollView: Host,
    Text: ({ children }: HostProps) => createElement('span', null, children),
    TextInput: () => null,
    Pressable: ({ children, accessibilityLabel }: HostProps) => createElement('button', { 'aria-label': accessibilityLabel }, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ setParams: vi.fn() }), useIsFocused: () => true, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), Redirect: () => null, useLocalSearchParams: () => ({}) }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({
  channels: () => [], subscribe: () => () => undefined, getVersion: () => 0,
  status: () => 'ready', loadFault: () => null, refresh: async () => undefined,
}) }));
vi.mock('../data/channelControls', () => ({ useChannelControls: () => ({
  controls: { switches: { channelPinning: false, mentionSearch: false } },
}) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => mocks.app }));
vi.mock('../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../theme/tokens');
  return { useTheme: () => resolveTheme() };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null })); // the Messages organize sheet pads the window's safe area (#9608)
vi.mock('../lib/chrome', () => ({ useNativeTabContentInset: () => 0, screenBottomInset: () => 0 }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('../services/supabase', () => ({ startMemberConversation: vi.fn() }));
vi.mock('../services/messageWorkflowPreference', () => ({}));
vi.mock('./MessageWorkflowPicker', () => ({ MessageWorkflowPicker: () => null }));
vi.mock('./FunctionDeck', () => ({ functionIcons: {} }));
vi.mock('./NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('./RowHighlight', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children);
  return { HighlightList: Host, HighlightRow: Host };
});
vi.mock('./PinnedHeader', () => ({
  PinnedHeaderScreen: ({ children }: HostProps) => createElement('div', null, children),
  useScreenNameAlreadySpoken: () => ({ duplicate: false, hiddenProps: {} }),
}));
vi.mock('./ui', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children);
  return {
    Avatar: () => null,
    SearchField: ({ placeholder }: { placeholder: string }) => createElement('input', { placeholder }),
    Button: ({ label, onPress, disabled, busy, variant }: { label: string } & ButtonCapture) => {
      mocks.buttons.set(label, { onPress, disabled, busy, variant });
      return createElement('button', { disabled: disabled || busy }, label);
    },
    Screen: ({ children, onRefresh, refreshing }: HostProps & ScreenCapture) => {
      mocks.screens.push({ onRefresh, refreshing });
      return createElement('div', null, children);
    },
    StateMessage: ({ title, body, action }: { title: string; body: string; action?: ReactNode }) =>
      createElement('section', null, createElement('h2', null, title), createElement('p', null, body), action),
    Body: Host, Card: Host, Group: Host, GroupRow: Host, Heading: Host, Notice: Host,
  };
});

import MessagesScreen from '../../app/messages';
import NotificationsScreen from '../../app/notifications';

const LOAD_ERROR = 'Your worker workspace could not be loaded securely. Check your connection and try again.';

function dashboardFixture(): MemberDashboard {
  return {
    member: { id: 'member', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Worker', memberSince: 2022, chapterID: null, language: 'en' },
    cases: [], weeklyActions: [], notifications: [], conversations: [],
  };
}

const screens = [
  {
    name: 'Messages',
    render: () => renderToStaticMarkup(createElement(MessagesScreen)),
    copy: messageInboxCopy.en,
    emptyTitle: messageInboxCopy.en.noKindTitle(messageInboxCopy.en.filters.all),
  },
  {
    name: 'Activity',
    render: () => renderToStaticMarkup(createElement(NotificationsScreen)),
    copy: activityCopy.en,
    emptyTitle: activityCopy.en.emptyTitle,
  },
] as const;

beforeEach(() => {
  mocks.app.mode = 'authenticated';
  mocks.app.dashboard = null;
  mocks.app.error = null;
  mocks.app.refreshing = false;
  mocks.app.refresh.mockClear();
  mocks.buttons.clear();
  mocks.screens.length = 0;
});

it('keeps the Messages inbox before its optional guide', () => {
  mocks.app.dashboard = dashboardFixture();
  const html = renderToStaticMarkup(createElement(MessagesScreen));
  expect(html.indexOf(messageInboxCopy.en.noKindTitle(messageInboxCopy.en.filters.all))).toBeGreaterThan(-1);
  expect(html.indexOf(messageInboxCopy.en.noKindTitle(messageInboxCopy.en.filters.all))).toBeLessThan(html.indexOf('Optional feature guide'));
});

describe.each(screens)('$name without a dashboard', ({ render, copy, emptyTitle }) => {
  it('shows the loading state with pull-to-refresh and no retry button while the workspace is still loading', () => {
    const html = render();
    expect(html).toContain(copy.loadingTitle);
    expect(html).toContain(copy.loadingBody);
    expect(html).not.toContain(copy.loadFailedTitle);
    expect(mocks.buttons.has(copy.tryAgain)).toBe(false);
    expect(mocks.screens).toHaveLength(1);
    expect(mocks.screens[0]?.onRefresh).toBeTypeOf('function');
    expect(mocks.screens[0]?.refreshing).toBe(false);
  });

  it('replaces the loading copy with the recorded failure and a Try again button that refreshes', () => {
    mocks.app.error = LOAD_ERROR;
    const html = render();
    expect(html).toContain(copy.loadFailedTitle);
    expect(html).toContain(LOAD_ERROR);
    expect(html).not.toContain(copy.loadingTitle);
    expect(html).not.toContain(copy.loadingBody);
    const retry = mocks.buttons.get(copy.tryAgain);
    expect(retry).toBeDefined();
    expect(retry?.variant).toBe('secondary');
    expect(retry?.disabled).toBe(false);
    expect(retry?.busy).toBe(false);
    retry?.onPress();
    expect(mocks.app.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.app.refresh).toHaveBeenCalledWith('user-refresh');
  });

  it('refreshes from pull-to-refresh in the failed state', () => {
    mocks.app.error = LOAD_ERROR;
    render();
    expect(mocks.screens).toHaveLength(1);
    mocks.screens[0]?.onRefresh?.();
    expect(mocks.app.refresh).toHaveBeenCalledWith('user-refresh');
  });

  it('keeps Try again on screen but inert while a retry is in flight', () => {
    mocks.app.error = LOAD_ERROR;
    mocks.app.refreshing = true;
    const html = render();
    expect(html).toContain(copy.loadFailedTitle);
    const retry = mocks.buttons.get(copy.tryAgain);
    expect(retry?.disabled).toBe(true);
    expect(retry?.busy).toBe(true);
    expect(mocks.screens[0]?.refreshing).toBe(true);
  });

  it('offers no dead recovery controls while the app is still booting', () => {
    mocks.app.mode = 'booting';
    mocks.app.error = LOAD_ERROR;
    const html = render();
    expect(html).toContain(copy.loadFailedTitle);
    expect(html).toContain(LOAD_ERROR);
    expect(mocks.buttons.has(copy.tryAgain)).toBe(false);
    expect(mocks.screens[0]?.onRefresh).toBeUndefined();
    expect(mocks.screens[0]?.refreshing).toBeUndefined();
  });

  it('renders the empty state, not the loading or failed state, once an empty workspace has loaded', () => {
    mocks.app.dashboard = dashboardFixture();
    const html = render();
    expect(html).toContain(emptyTitle);
    expect(html).not.toContain(copy.loadingTitle);
    expect(html).not.toContain(copy.loadFailedTitle);
    expect(mocks.buttons.has(copy.tryAgain)).toBe(false);
  });
});

describe('failed-state copy', () => {
  it('names the failure and the retry in both locales', () => {
    for (const table of [messageInboxCopy, activityCopy]) {
      for (const language of ['en', 'es'] as const) {
        const copy = table[language];
        expect(copy.loadFailedTitle).not.toBe(copy.loadingTitle);
        expect(copy.loadFailedTitle.length).toBeGreaterThan(0);
        expect(copy.tryAgain.length).toBeGreaterThan(0);
      }
    }
    expect(messageInboxCopy.en.tryAgain).toBe('Try again');
    expect(activityCopy.en.tryAgain).toBe('Try again');
  });
});
