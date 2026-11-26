import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from '../services/supabase';
const testWriter = stubSessionWriter(protocolTestClient);
import { createElement, type ReactNode } from 'react';
vi.mock('../features/SavedPulseCharts', () => ({ LiveChartMessage: ({ body }: { body: string }) => createElement('section', { 'data-chart-reference': body }, 'Open shared chart') }));
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoChannel } from '../data/demoChannels';
import type { ChannelStoreLike } from '../data/useChannels';
import type { MemberDashboard } from '../models/member';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};
const mocks = vi.hoisted(() => ({
  channels: [] as DemoChannel[], version: 0, locale: 'en-US',
  mode: 'authenticated' as 'authenticated' | 'preview',
  dashboard: null as MemberDashboard | null,
  fontScale: 1, reach: [] as Array<number | undefined>,
  platform: 'ios' as 'ios' | 'android', routeID: 'thread-1', realStore: false, client: null as unknown,
}));
type HostProps = { children?: ReactNode; accessibilityLabel?: string; footer?: ReactNode; aboveFooter?: ReactNode; reachAbove?: number };
type ReactModule = typeof import('react');
type PostingQuery = {
  select: () => PostingQuery; is: () => PostingQuery; in: () => PostingQuery;
  eq: () => PostingQuery; order: () => PostingQuery; limit: () => PostingQuery;
  insert: (row: Record<string, unknown>) => PostingQuery;
  single: () => Promise<{ data: Record<string, unknown>; error: null }>;
  then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) => Promise<unknown>;
};
type PostingRealtime = { on: () => PostingRealtime; subscribe: () => PostingRealtime };
vi.mock('react', async (original) => ({
  ...await original<ReactModule>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => number) => snapshot(),
}));
vi.mock('react-native', () => {
  const Host = ({ children, accessibilityLabel }: HostProps) => createElement('div', { 'aria-label': accessibilityLabel }, children);
  return {
    Platform: { get OS() { return mocks.platform; } }, View: Host, ScrollView: Host, Pressable: Host,
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: mocks.fontScale }),
    Text: ({ children }: HostProps) => createElement('span', null, children),
    TextInput: ({ accessibilityLabel, placeholder }: HostProps & { placeholder?: string }) => createElement('input', { 'aria-label': accessibilityLabel, placeholder }),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ setParams: vi.fn() }), useIsFocused: () => true,
  useRouter: () => ({ push: vi.fn() }), useLocalSearchParams: () => ({ id: mocks.routeID }), Redirect: () => null,
}));
vi.mock('../data/liveChannels', async (original) => {
  const actual = (await original()) as typeof import('../data/liveChannels');
  return { ...actual, liveChannelStore: {
    ...actual.liveChannelStore,
    channels: () => mocks.realStore ? actual.liveChannelStore.channels() : mocks.channels,
    channel: (id: string) => mocks.realStore ? actual.liveChannelStore.channel(id) : mocks.channels.find((row) => row.id === id || row.spaceID === id) ?? null,
    getVersion: () => mocks.realStore ? actual.liveChannelStore.getVersion() : mocks.version, subscribe: () => () => undefined,
    status: () => mocks.realStore ? actual.liveChannelStore.status() : 'ready', actionDiagnosis: () => null, markReadFault: () => null,
  } };
});
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  dashboard: mocks.dashboard, mode: mocks.mode, session: null, authorizedRoles: [],
}) }));
vi.mock('../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../theme/tokens');
  return { useTheme: () => resolveTheme() };
});
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => testWriter, getSupabaseClient: () => mocks.client }));
vi.mock('../services/haptics', () => ({ haptics: {} }));
vi.mock('../services/messageWorkflowPreference', () => ({}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null })); // the Messages organize sheet pads the window's safe area (#9608)
vi.mock('../lib/chrome', () => ({ useNativeTabContentInset: () => 0, screenBottomInset: () => 0 }));
vi.mock('../data/channelControls', () => ({ useChannelControls: () => ({
  controls: { switches: { channelPinning: false } }, live: false,
}) }));
vi.mock('./ChannelControls', () => ({
  CHANNEL_BODY_LINE_HEIGHT: 21,
  ChannelHighlightedBody: ({ body }: { body: string }) => createElement('p', null, body),
  channelHasAnyControl: () => false,
}));
vi.mock('./WorkflowActions', () => ({ WorkflowMessageActions: ({ children, accessibilityLabel, footer, aboveFooter, reachAbove }: HostProps) => {
  mocks.reach.push(reachAbove);
  return createElement('article', { 'aria-label': accessibilityLabel }, children, aboveFooter, footer);
} }));
vi.mock('./MessageReactions', () => ({
  AddReactionChip: ({ accessibilityLabel }: HostProps) => createElement('button', { 'aria-label': accessibilityLabel }),
  MessageReactionButton: () => null,
  MessageReactionPicker: () => null,
}));
vi.mock('./MessageReplies', () => ({ useMessageReplyCounts: () => ({}), ParentMessageControl: () => null, ReplyCountControl: () => null }));
vi.mock('./NativeMessageActions', () => ({ NativeMessageActions: () => null }));
vi.mock('./SupportLink', () => ({ SupportLink: () => null }));
vi.mock('./MessageWorkflowPicker', () => ({ MessageWorkflowPicker: () => null }));
vi.mock('./NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('./RowHighlight', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children);
  return { HighlightList: Host, HighlightRow: Host };
});
vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('./PinnedHeader', () => ({
  PinnedHeaderScreen: ({ children }: HostProps) => createElement('div', null, children),
  useScreenNameAlreadySpoken: () => ({ duplicate: false, hiddenProps: {} }),
}));
vi.mock('./ui', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children);
  return { Avatar: () => null, Body: Host, Card: Host, Heading: Host, Notice: Host, Screen: Host, StateMessage: Host,
    SearchField: () => null, Button: ({ label }: { label: string }) => createElement('button', null, label) };
});

import ChannelScreen from '../../app/channel/[id]';
import MessagesScreen from '../../app/messages';
import { useChannelStore } from '../data/useChannels';
import { channelContentLanguage, channelReaderLanguage } from '../lib/channelContent';
import { liveChannelStore } from '../data/liveChannels';
import { messageInboxCopy } from '../lib/messageInboxCopy';

beforeEach(() => {
  mocks.mode = 'authenticated'; mocks.version = 0; mocks.locale = 'en-US'; mocks.fontScale = 1; mocks.reach = [];
  mocks.platform = 'ios'; mocks.routeID = 'thread-1'; mocks.realStore = false; mocks.client = null;
  mocks.channels = [{
    id: 'thread-1', spaceID: 'space-1', name: 'Campaign news', nameEs: 'Noticias de la campaña',
    topic: 'Campaign updates', topicEs: 'Actualizaciones de la campaña', unread: 0,
    messages: [{ id: 'post-1', body: 'Meeting tomorrow', bodyEs: 'Reunión mañana', author: 'Worker A', initials: 'MA', time: '10:00 AM' }],
  }];
  mocks.dashboard = {
    member: { id: 'member', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Worker', memberSince: 2022, chapterID: null, language: 'en' },
    cases: [], weeklyActions: [], notifications: [], conversations: [],
  };
  const original = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...original.call(this), locale: mocks.locale };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

// A one-line body centred in its 48 pt target had a band of space above and
// below its words; its target reaches up over the plain author line by the
// space one line leaves (over an "@ Mentions you" line too), and not at all
// under a "Replying to" chip, whose own target is above.
describe('campaign post body target', () => {
  const reachAt = (fontScale: number, row: Record<string, unknown> = {}) => {
    mocks.fontScale = fontScale; mocks.reach = [];
    Object.assign(mocks.channels[0]!.messages[0]!, row);
    renderToStaticMarkup(createElement(ChannelScreen));
    return [...new Set(mocks.reach)];
  };
  it('reaches up by the space one line leaves, shrinking to nothing as the text grows', () => {
    expect(reachAt(1)).toEqual([19]);
    expect(reachAt(1.5)).toEqual([8]);
    expect(reachAt(2.5)).toEqual([0]);
  });
  it('keeps a centred target under a Replying to chip, and reaches over a Mentions you line', () => {
    expect(reachAt(1, { parentMessageID: 'post-0' })).toEqual([undefined]);
    expect(reachAt(1, { parentMessageID: null, mentionsMe: true })).toEqual([19]);
  });
});

describe('native reader language for campaign content (#6643)', () => {
  it.each<['ios' | 'android', 'en-US' | 'es-MX']>([
    ['android', 'en-US'], ['ios', 'en-US'], ['android', 'es-MX'], ['ios', 'es-MX'],
  ])('keeps two posted channel names in the header and list on %s in %s', async (platform, locale) => {
    mocks.platform = platform; mocks.locale = locale; mocks.realStore = true;
    mocks.dashboard!.member.language = locale.startsWith('es') ? 'es' : 'en';
    const rows: Record<string, Record<string, unknown>[]> = {
      chapter_spaces: [
        { id: 'first', chapter_id: 'same-chapter', name: 'Welcome to Quillmere', name_es: 'Bienvenida a Quillmere', description: 'Welcome', visibility: 'chapter' },
        { id: 'second', chapter_id: 'same-chapter', name: 'Branch nominations', name_es: 'Nominaciones de la sección', description: 'Nominations', visibility: 'chapter' },
      ],
      chapter_threads: [], chapter_thread_posts: [], chapter_space_reads: [], chapter_channel_polls: [], member_message_reactions: [],
    };
    const realtime: PostingRealtime = { on: () => realtime, subscribe: () => realtime };
    let postSequence = 0;
    mocks.client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'member' } } } }) },
      channel: () => realtime, removeChannel: async () => undefined,
      from: (table: string) => {
        let inserted: Record<string, unknown> | null = null;
        const query: PostingQuery = {
          select: () => query, is: () => query, in: () => query, eq: () => query, order: () => query, limit: () => query,
          insert: (value: Record<string, unknown>) => { inserted = value; return query; },
          single: async () => {
            const row = table === 'chapter_threads'
              ? { ...inserted, id: `thread-${inserted?.space_id}`, created_at: '2026-11-11T12:00:00Z', status: 'open' }
              : { ...inserted, id: `post-${++postSequence}`, created_at: '2026-11-11T12:01:00Z', author_name: 'Worker', author_initials: 'M' };
            rows[table]!.push(row);
            return { data: row, error: null };
          },
          then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
        };
        return query;
      },
    };
    const names = locale.startsWith('es') ? ['Bienvenida a Quillmere', 'Nominaciones de la sección'] : ['Welcome to Quillmere', 'Branch nominations'];
    const expectScreens = () => {
      const inbox = renderToStaticMarkup(createElement(MessagesScreen));
      for (const [index, id] of ['first', 'second'].entries()) {
        mocks.routeID = id;
        expect(renderToStaticMarkup(createElement(ChannelScreen))).toContain(`${locale.startsWith('es') ? 'Mensajes en' : 'Messages in'} ${names[index]}`);
        expect(inbox).toContain(`# ${names[index]}`);
      }
    };
    try {
      liveChannelStore.acquire();
      await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
      expectScreens();
      for (const id of ['first', 'second']) {
        expect(await liveChannelStore.send(testWriter, id, `First post in ${id}`, 'Worker', 'M')).toBe(true);
        expectScreens();
        await liveChannelStore.refresh();
        expect(liveChannelStore.status()).toBe('ready');
        expectScreens();
      }
    } finally {
      liveChannelStore.release(); mocks.realStore = false; mocks.client = null;
    }
  });

  it('keeps a shared chart inside the same message-action boundary as ordinary campaign posts', () => {
    mocks.channels[0]!.messages[0]!.body = '[pulse-chart:123e4567-e89b-42d3-a456-426614174000]';
    const html = renderToStaticMarkup(createElement(ChannelScreen));
    // The chart is the message body inside the action boundary; the footer row
    // (reactions and Actions) follows it inside the same boundary.
    expect(html).toMatch(/<article[^>]*><section data-chart-reference="[^"]+">Open shared chart<\/section>(<button[^>]*><\/button>)?<\/article>/);
  });
  it.each([
    ['es', 'es'], ['es-MX', 'es'], ['ES-ES', 'es'], ['en-US', 'en'], ['fr-CA', 'en'], ['esperanto', 'en'],
  ] as const)('maps device locale %s to content language %s', (locale, language) => {
    expect(channelContentLanguage(locale)).toBe(language);
  });

  // UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (tooling
  // ledger 81, from the #8291 review): earlier history pages took their
  // language from the device locale while the newest posts used the saved
  // language. Both now read channelReaderLanguage.
  it('reads the saved language, then the dashboard language, before the device locale', () => {
    expect(channelReaderLanguage('es', 'en', 'en-US')).toBe('es');
    expect(channelReaderLanguage('en', 'es', 'es-MX')).toBe('en');
    expect(channelReaderLanguage(null, 'es', 'en-US')).toBe('es');
    expect(channelReaderLanguage(undefined, 'en', 'es-MX')).toBe('en');
    expect(channelReaderLanguage(null, null, 'es-MX')).toBe('es');
    expect(channelReaderLanguage(null, undefined, 'fr-CA')).toBe('en');
  });

  it('gives earlier history pages and the newest posts the same reader language', () => {
    const screen = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    const store = readFileSync(fileURLToPath(new URL('../data/useChannels.ts', import.meta.url)), 'utf8');
    for (const source of [screen, store]) {
      expect(source).toContain('channelReaderLanguage(memberLanguage, dashboard?.member.language, Intl.DateTimeFormat().resolvedOptions().locale)');
      expect(source).not.toMatch(/channelContentLanguage\(/);
    }
    expect(screen).toMatch(/channelMessageInReaderLanguage\(row, contentLanguage\)/);
  });

  it.each([
    ['es-MX', 'en', 'Campaign news', 'Campaign updates', 'Meeting tomorrow'],
    ['en-US', 'es', 'Noticias de la campaña', 'Actualizaciones de la campaña', 'Reunión mañana'],
    ['fr-CA', 'es', 'Noticias de la campaña', 'Actualizaciones de la campaña', 'Reunión mañana'],
  ] as const)('uses saved preference %s/%s for content before the device language', (locale, profile, name, topic, body) => {
    mocks.locale = locale; mocks.dashboard!.member.language = profile;
    const input = JSON.stringify(mocks.channels);
    const html = renderToStaticMarkup(createElement(ChannelScreen));
    expect(html).toContain(`>${name}</span>`);
    expect(html).toContain(topic);
    expect(html).toContain(`aria-label="Worker A: ${body}"`);
    expect(html).toContain(`<p>${body}</p>`);
    // #8304: the screen's own words follow the saved profile language too;
    // the channel name, topic and post stay as published above.
    const chrome = profile === 'es'
      ? ['Mensajes en', 'Enviar mensaje', 'Reaccionar al mensaje de', 'Los canales que ves dependen de tu rol y tu campaña actuales.']
      : ['Messages in', 'Send message', 'React to the message from', 'The channels you see depend on your current role and campaign.'];
    for (const label of chrome) expect(html).toContain(label);
    expect(JSON.stringify(mocks.channels)).toBe(input);
    const inbox = renderToStaticMarkup(createElement(MessagesScreen));
    expect(inbox).toContain(`# ${name}`);
    expect(inbox).toContain(body);
    expect(inbox).toContain(profile === 'es' ? 'Mensajes' : 'Messages');
    expect(inbox).not.toContain(profile === 'es' ? '>Messages<' : '>Mensajes<');
  });

  it.each([undefined, null, '', '  \n '])('renders the original when Spanish content is %s', (spanish) => {
    mocks.locale = 'es-ES';
    mocks.dashboard!.member.language = 'es';
    const row = mocks.channels[0]!;
    row.nameEs = spanish; row.topicEs = spanish; row.messages[0]!.bodyEs = spanish;
    const html = renderToStaticMarkup(createElement(ChannelScreen));
    for (const text of ['>Campaign news</span>', 'Campaign updates', '<p>Meeting tomorrow</p>']) expect(html).toContain(text);
  });

  it('uses each available Spanish field independently and preserves its whitespace', () => {
    mocks.locale = 'es-MX';
    mocks.dashboard!.member.language = 'es';
    mocks.channels[0]!.topicEs = null;
    mocks.channels[0]!.messages[0]!.bodyEs = '  Reunión mañana  ';
    const html = renderToStaticMarkup(createElement(ChannelScreen));
    for (const text of ['>Noticias de la campaña</span>', 'Campaign updates', '<p>  Reunión mañana  </p>']) expect(html).toContain(text);
  });

  it('uses Spanish channel notices with the saved Spanish preference', () => {
    mocks.locale = 'es-MX'; mocks.dashboard!.member.language = 'es';
    mocks.channels[0]!.closed = true;
    mocks.channels[0]!.messages[0]!.poll = true;
    const html = renderToStaticMarkup(createElement(ChannelScreen));
    expect(html).toContain('Reunión mañana');
    expect(html).toContain(messageInboxCopy.es.pollUnavailable);
    expect(html).toContain(messageInboxCopy.es.channelActionError.closed);
    expect(html).not.toContain(messageInboxCopy.en.pollUnavailable);
    expect(html).not.toContain(messageInboxCopy.en.channelActionError.closed);
  });

  it('keeps row identity between emissions, resolves space aliases, and refreshes or clears content on a new version', () => {
    mocks.locale = 'es-MX';
    mocks.dashboard!.member.language = 'es';
    let store: ChannelStoreLike | undefined;
    function Probe() { store = useChannelStore(); return null; }
    renderToStaticMarkup(createElement(Probe));
    const view = store!;
    const first = view.channel('thread-1');
    expect(view.channel('space-1')).toBe(first);
    expect(view.channels()[0]).toBe(first);
    expect(view.channel('missing')).toBeNull();
    mocks.channels[0]!.messages[0]!.bodyEs = 'Nueva noticia'; mocks.version += 1;
    expect(view.channel('thread-1')).not.toBe(first);
    expect(view.channel('thread-1')?.messages[0]?.body).toBe('Nueva noticia');
    mocks.channels = []; mocks.version += 1;
    expect(view.channels()).toEqual([]);
    expect(view.channel('thread-1')).toBeNull();
  });

  it('leaves preview content alone on a Spanish device', () => {
    mocks.mode = 'preview'; mocks.locale = 'es-MX';
    let store: ChannelStoreLike | undefined;
    function Probe() { store = useChannelStore(); return null; }
    renderToStaticMarkup(createElement(Probe));
    // The fictional PREVIEW channels stay as seeded: nothing is translated.
    const channels = store?.channels() ?? [];
    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) expect(channel.name).toMatch(/^[a-z0-9-]+$/);
  });
});
