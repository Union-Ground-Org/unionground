import { createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoChannel } from '../data/demoChannels';
import type { MemberDashboard } from '../models/member';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};
const mocks = vi.hoisted(() => ({
  channels: [] as DemoChannel[],
  dashboard: null as MemberDashboard | null,
  presses: new Map<string, () => void>(),
  push: vi.fn(),
  select: vi.fn(),
  mentionSearch: false,
  platform: 'ios',
}));
type HostProps = { children?: ReactNode; accessibilityLabel?: string; onPress?: () => void };
type ReactModule = typeof import('react');
vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('react', async (original) => ({
  ...await original<ReactModule>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => number) => snapshot(),
}));
vi.mock('react-native', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children);
  return {
    Platform: { get OS() { return mocks.platform; } }, View: Host, ScrollView: Host,
    Text: ({ children }: HostProps) => createElement('span', null, children),
    TextInput: () => null,
    Pressable: ({ children, accessibilityLabel, onPress }: HostProps) => {
      if (accessibilityLabel && onPress) mocks.presses.set(accessibilityLabel, onPress);
      return createElement('button', { 'aria-label': accessibilityLabel }, children);
    },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('./SupportLink', () => ({ SupportLink: () => null }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ setParams: vi.fn() }), useIsFocused: () => true, useRouter: () => ({ push: mocks.push }), Redirect: () => null, useLocalSearchParams: () => ({}) }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({
  channels: () => mocks.channels, subscribe: () => () => undefined, getVersion: () => 0,
  status: () => 'ready', loadFault: () => null,
}) }));
vi.mock('../data/channelControls', () => ({ useChannelControls: () => ({
  controls: { switches: { channelPinning: false, mentionSearch: mocks.mentionSearch } },
}) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  dashboard: mocks.dashboard, mode: 'authenticated', session: null, authorizedRoles: [],
}) }));
vi.mock('../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../theme/tokens');
  return { useTheme: () => resolveTheme() };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null })); // the Messages organize sheet pads the window's safe area (#9608)
vi.mock('../lib/chrome', () => ({ useNativeTabContentInset: () => 0, screenBottomInset: () => 0 }));
vi.mock('./PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: HostProps) => createElement('div', null, children) }));
vi.mock('../services/haptics', () => ({ haptics: { select: mocks.select } }));
vi.mock('../services/supabase', () => ({ startMemberConversation: vi.fn() }));
vi.mock('../services/messageWorkflowPreference', () => ({}));
vi.mock('./MessageWorkflowPicker', () => ({ MessageWorkflowPicker: () => null }));
vi.mock('./FunctionDeck', () => ({ functionIcons: {} }));
vi.mock('./NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('./RowHighlight', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children);
  return { HighlightList: Host, HighlightRow: Host };
});
vi.mock('./ui', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children);
  return { Avatar: () => null,
    SearchField: ({ placeholder }: { placeholder: string }) => createElement('input', { placeholder }),
    Button: ({ label, onPress }: { label: string; onPress: () => void }) => {
      mocks.presses.set(label, onPress);
      return createElement('button', null, label);
    },
    Body: Host, Card: Host, Heading: Host, Notice: Host, Screen: Host, StateMessage: Host };
});

import MessagesScreen from '../../app/messages';
import { WorkWidgets } from './WorkWidgets';
import { buildMessageInbox } from '../lib/messageInbox';
import { MEMBER_WORK_WIDGETS } from '../lib/hatFunctions';

beforeEach(() => {
  mocks.channels = [];
  mocks.mentionSearch = false;
  mocks.presses.clear();
  mocks.push.mockClear();
  mocks.select.mockClear();
  mocks.dashboard = {
    member: { id: 'member', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Worker', memberSince: 2022, chapterID: null, language: 'en' },
    cases: [], weeklyActions: [], notifications: [],
    conversations: [{ id: 'direct', title: '# Real contact', initials: 'RC', createdAt: '2026-10-16T20:00:00-04:00', updatedAt: '2026-10-16T20:00:00-04:00', unreadCount: 0, latestMessage: 'Direct reply' }],
  };
});

describe('native Messages follows the saved language on either platform', () => {
  const platforms: Array<'ios' | 'android'> = ['ios', 'android'];
  const languages: Array<MemberDashboard['member']['language']> = ['en', 'es'];
  const cases = platforms.flatMap((platform) => languages.map((language) => ({ platform, language })));
  it.each(cases)('uses the saved $language profile on $platform and preserves message content', ({ language, platform }) => {
    mocks.platform = platform;
    const dashboard = mocks.dashboard!;
    dashboard.member.language = language;
    dashboard.conversations[0]!.latestMessage = 'Nos vemos mañana';
    dashboard.conversations[0]!.updatedAt = '2026-01-02T12:00:00-05:00';
    mocks.channels = [{ id: 'channel-id', name: 'Anuncios', topic: 'Reunión de la campaña', unread: 2, messages: [] }];
    mocks.mentionSearch = true;
    const input = JSON.stringify({ dashboard, channels: mocks.channels });

    const html = renderToStaticMarkup(createElement(MessagesScreen));
    for (const text of language === 'es'
      ? ['Mensajes', 'Buscar mensajes', 'Recordatorios', 'RECIENTES', 'Conversación privada']
      : ['Messages', 'Search messages', 'Reminders', 'Your mentions', 'RECENT',
        'Private conversation', 'Filter inbox', 'All', 'Unread', 'Direct', 'Channels', 'Jan 2']) {
      expect(html).toContain(text);
    }
    expect(mocks.presses.has(language === 'es'
      ? 'Anuncios, Canal de la campaña, Reunión de la campaña, 2 mensajes no leídos'
      : 'Anuncios, Campaign channel, Reunión de la campaña, 2 unread messages')).toBe(true);
    expect(html).toContain('Nos vemos mañana');
    expect(html).toContain('Reunión de la campaña');
    mocks.presses.get(language === 'es' ? 'Recordatorios' : 'Reminders')?.();
    expect(mocks.push).toHaveBeenLastCalledWith('/reminders');
    mocks.presses.get(language === 'es' ? 'Sus menciones' : 'Your mentions')?.();
    expect(mocks.push).toHaveBeenLastCalledWith('/mentions');
    expect(JSON.stringify({ dashboard, channels: mocks.channels })).toBe(input);
  });
});

describe('authenticated channel row labels', () => {
  // Equivalent to the retained a3.json inbox shape: channel title, preview,
  // unread count, and separate recent/list buttons. Keep the real name's #21.
  it.each([
    ['Welcome, new workers · #21', 'Channel reply', 2],
    ['Questions & answers!', 'Meeting update', 0],
    ['#general', 'Latest post', 1],
  ] as const)('preserves %s while removing only the added display prefix', (name, preview, unread) => {
    const dashboard = mocks.dashboard!;
    mocks.channels = [{ id: 'channel-id', name, topic: preview, unread, messages: [] }];
    const input = JSON.stringify(mocks.channels);
    const [channel] = buildMessageInbox([], mocks.channels);
    expect(channel?.title).toBe(`# ${name}`);

    const html = renderToStaticMarkup(createElement(MessagesScreen));
    const unreadSuffix = unread ? `, ${unread} unread ${unread === 1 ? 'message' : 'messages'}` : '';
    const recentLabel = `${name}, ${preview}${unreadSuffix}`;
    const rowLabel = `${name}, Campaign channel, ${preview}${unreadSuffix}`;
    expect([...mocks.presses.keys()]).toContain(recentLabel);
    expect(mocks.presses.has(rowLabel)).toBe(true);
    expect(mocks.presses.has(`# ${name}, Campaign channel, ${preview}${unreadSuffix}`)).toBe(false);
    expect(html).toContain(`<span># ${name.replaceAll('&', '&amp;')}</span>`);
    for (const label of [recentLabel, rowLabel]) {
      mocks.presses.get(label)?.();
      expect(mocks.push).toHaveBeenLastCalledWith('/channel/channel-id');
    }
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(mocks.presses.has('# Real contact, Private conversation, Direct reply')).toBe(true);

    mocks.presses.clear();
    const messages = MEMBER_WORK_WIDGETS.find((item) => item.key === 'messages');
    if (!messages) throw new Error('Missing Messages widget');
    const widgetHtml = renderToStaticMarkup(createElement(WorkWidgets, {
      dashboard, channels: mocks.channels, desk: null, items: [messages],
    }));
    expect(mocks.presses.has(`${name}. Channel. ${preview}`)).toBe(true);
    expect(mocks.presses.has(`# ${name}. Channel. ${preview}`)).toBe(false);
    expect(mocks.presses.has('# Real contact. Private conversation. Direct reply')).toBe(true);
    expect(widgetHtml).toContain(`<span>${name.replaceAll('&', '&amp;')}</span>`);
    expect(widgetHtml).not.toContain(`<span># ${name.replaceAll('&', '&amp;')}</span>`);
    mocks.presses.get(`${name}. Channel. ${preview}`)?.();
    expect(mocks.push).toHaveBeenLastCalledWith('/channel/channel-id');
    expect(JSON.stringify(mocks.channels)).toBe(input);
  });
});
