import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-NATIVE-ANDROID-CHANNEL-NAME-BECOMES-GENERAL-AFTER-POSTING-20261111
// (#8236), executed on the shared stand-in (#8319): the first post in a
// channel created its thread titled "general", and the next refresh read
// that title back as the channel's name. The channel screen runs on the real
// live channel store over a backend stand-in that keeps what the post wrote.
// The same screen also runs the ledger 119 follow-up to #8304 below: the
// /remind text and the staff pin in the member's saved language.
const route = vi.hoisted(() => ({ id: 'space-1', post: undefined as string | undefined }));
const backend = vi.hoisted(() => ({ client: null as unknown }));
const app = vi.hoisted(() => ({
  language: 'en' as 'en' | 'es',
  session: { user: { id: 'member-a' } },
  remind: null as null | ((args: Record<string, unknown>) => { data: unknown; error: unknown }),
  setPinned: (async () => ({ pinnedAt: null })) as (threadID: string, pinned: boolean) => Promise<{ pinnedAt: string | null }>,
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', async () => ({ ...await import('../testing/uiStandIn'), Avatar: () => null }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => (route.post ? { id: route.id, post: route.post } : { id: route.id }), Redirect: () => null, useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => backend.client), getSupabaseClient: () => backend.client }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  mode: 'authenticated', session: app.session, organizationID: 'org-1', previewHat: null, authorizedRoles: ['member'],
  memberLanguage: app.language,
  dashboard: { member: { id: 'member-a', chapterID: 'chapter-1', name: 'Worker A', initials: 'MA', language: app.language } },
  chapterMemberships: [{ chapterID: 'chapter-1', organizationID: 'org-1', selected: true }],
}) }));
// Staff controls with the pin on; the pin call itself is the stand-in.
vi.mock('./channelControls', async () => {
  const actual = (await vi.importActual('./channelControls')) as typeof import('./channelControls');
  const shared = (await vi.importActual('../lib/channelControlsShared')) as typeof import('../lib/channelControlsShared');
  const controls = { ...shared.UNAVAILABLE_CHANNEL_CONTROLS, available: true, canPin: true,
    switches: { ...shared.UNAVAILABLE_CHANNEL_CONTROLS.switches, channelPinning: true, notificationLevels: true } };
  return { ...actual,
    useChannelControls: () => ({ controls, live: true, status: 'ready', applySetting: () => undefined, reload: async () => undefined }),
    channelControlsApi: { ...actual.channelControlsApi, setPinned: (_writer: unknown, threadID: string, pinned: boolean) => app.setPinned(threadID, pinned) },
  };
});
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), error: vi.fn(), impact: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/announce', () => ({ announceForAccessibility: vi.fn(), useAccessibilityAnnouncementQueue: () => () => undefined }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h(Fragment, null, children), useScreenNameAlreadySpoken: () => false }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowMessageActions: () => null }));
vi.mock('../components/MessageReactions', () => ({ AddReactionChip: () => null, MessageReactionButton: () => null, MessageReactionPicker: () => null }));
vi.mock('../components/NativeMessageActions', () => ({ NativeMessageActions: () => null }));
vi.mock('../components/ChannelPollCard', () => ({ ChannelPollCard: () => null }));
vi.mock('../components/MessageReplies', () => ({ MessageReplies: () => null, ParentMessageControl: () => null, ReplyCountControl: () => null, useMessageReplyCounts: () => ({}) }));
vi.mock('../features/SavedPulseCharts', () => ({ LiveChartMessage: () => null }));
// A web module that loads the root package's React copy; its signal is not under test.
vi.mock('../../../../src/features/learningPeriod/undoneSignal.js', () => ({ announceLearningUndone: vi.fn(), useLearningUndone: () => undefined }));

import { createChannelBackend } from '../testing/channelBackendStandIn';
import { announceForAccessibility } from '../lib/announce';
import { nativeUiSpanish } from '../lib/nativeUiCopy';
import { liveChannelStore } from './liveChannels';
import ChannelScreen from '../../app/channel/[id]';

const spaces = [
  { id: 'space-1', chapter_id: 'chapter-1', name: 'Welcome to Quillmere', name_es: 'Bienvenida a Quillmere', description: 'Welcome', visibility: 'chapter', archived_at: null },
  { id: 'space-2', chapter_id: 'chapter-1', name: 'Branch nominations', name_es: 'Nominaciones de la sección', description: 'Nominations', visibility: 'chapter', archived_at: null },
];

let screen: Rendered | null = null;
// Ledger 80: wait on what the screen shows, one task turn at a time, instead
// of a fixed number of turns.
const until = (check: () => void) => vi.waitFor(async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  check();
}, { timeout: 3000, interval: 1 });
beforeEach(() => { backend.client = createChannelBackend({ chapter_spaces: spaces }).client; });
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); app.language = 'en'; });

describe.each(['ios', 'android'] as const)('channel name after the first post on %s', (os) => {
  it('keeps each of two channels named as it was after posting and a refresh', async () => {
    setPlatform(os);
    for (const space of spaces) {
      route.id = space.id;
      screen = await render(h(ChannelScreen));
      const header = () => Array.from(screen!.container.querySelectorAll('[role=heading]')).map((node) => node.textContent);
      const posted = () => liveChannelStore.channel(space.id)?.messages.map((message) => message.body);
      await until(() => {
        expect(header()).toEqual([space.name]);
        getExposed(screen!.container, `Message ${space.name}`);
      });
      await type(getExposed(screen.container, `Message ${space.name}`), `First post in ${space.name}`);
      await press(getExposed(screen.container, 'Send message'));
      await until(() => expect(posted()).toEqual([`First post in ${space.name}`]));
      await act(async () => { await liveChannelStore.refresh(); });
      await until(() => {
        expect(header()).toEqual([space.name]);
        expect(exposedNames(screen!.container).join(' ')).not.toMatch(/\bgeneral\b/);
        expect(posted()).toEqual([`First post in ${space.name}`]);
        expect(liveChannelStore.channels().map((channel) => channel.name).sort()).toEqual(spaces.map((entry) => entry.name).sort());
      });
      await screen.unmount(); screen = null;
    }
  });
});

// Ledger 119 (#8304 follow-up): a member who saved Spanish still got the
// channel's /remind usage, errors, refusals and confirmation, and the staff pin
// button and its notices, in English.
const threads = [{ id: 'thread-a', space_id: 'space-1', title: 'Welcome to Quillmere', status: 'open', created_at: '2026-11-11T12:00:00.000Z', pinned_at: null }];
const text = () => screen!.container.textContent ?? '';
const composer = () => exposedNames(screen!.container).find((name) => name.startsWith(app.language === 'es' ? 'Mensaje para ' : 'Message '));
// Sends once the composer is on screen; the caller waits on the reply it expects.
async function sendDraft(draft: string) {
  await until(() => expect(composer()).toBeDefined());
  await type(getExposed(screen!.container, composer()!), draft);
  await press(getExposed(screen!.container, app.language === 'es' ? 'Enviar mensaje' : 'Send message'));
}
const shows = (expected: string) => until(() => expect(text()).toContain(expected));

describe.each(['ios', 'android'] as const)('channel /remind and pin text in the saved language on %s', (os) => {
  beforeEach(() => {
    route.id = 'thread-a';
    app.remind = null;
    app.setPinned = vi.fn(async (_threadID: string, pinned: boolean) => ({ pinnedAt: pinned ? '2026-11-12T15:00:00.000Z' : null }));
    const stand = createChannelBackend({ chapter_spaces: spaces, chapter_threads: threads }).client;
    backend.client = { ...stand, rpc: async (name: string, args: Record<string, unknown>) => (
      name === 'create_channel_here_reminder' && app.remind ? app.remind(args) : { data: null, error: null }) };
    vi.mocked(announceForAccessibility).mockClear();
    setPlatform(os);
  });

  it('gives a Spanish worker the usage, errors, refusals and confirmation in Spanish', async () => {
    app.language = 'es';
    screen = await render(h(ChannelScreen));

    await sendDraft('/remind');
    await shows('Recuérdale algo al equipo de este canal:');
    expect(text()).toContain('/remind here in 20m <qué>');
    expect(text()).not.toContain("Remind this channel's staff");

    await sendDraft('/remind here');
    await shows(nativeUiSpanish['Add a time: "in 20m", "tomorrow 9am" or "on 2026-07-01".']);
    await sendDraft('/remind me in 20m Revisar la agenda');
    await shows('En un canal, “/remind here” le recuerda al equipo del canal.');

    app.remind = () => ({ data: null, error: { code: '54000' } });
    await sendDraft('/remind here in 20m Revisar la agenda');
    await shows('Llegaste al límite de recordatorios de este canal.');

    app.remind = (args) => ({ data: { id: 'reminder-1', remindAt: args.p_remind_at }, error: null });
    await sendDraft('/remind here in 20m Revisar la agenda');
    await shows('Se le recordará al equipo de este canal ');
    expect(text()).toContain(': Revisar la agenda');
    expect(text()).not.toMatch(/will be reminded|reached the reminder limit|Add a time/);
    expect(vi.mocked(announceForAccessibility)).toHaveBeenLastCalledWith(expect.stringMatching(/^Se le recordará al equipo de este canal .+: Revisar la agenda$/));

    // Without a backend client the screen refuses before any request.
    backend.client = null;
    await sendDraft('/remind here in 20m Revisar la agenda');
    await shows(nativeUiSpanish['Channel staff reminders need a signed-in staff account. Preview does not set one.']);
  });

  it('names the pin button and its notices in Spanish', async () => {
    app.language = 'es';
    screen = await render(h(ChannelScreen));
    await until(() => getExposed(screen!.container, 'Acciones del canal'));
    await press(getExposed(screen.container, 'Acciones del canal'));
    getExposed(screen.container, 'Fijar hilo');
    await press(getExposed(screen.container, 'Fijar hilo'));
    await shows('Hilo fijado.');
    expect(app.setPinned).toHaveBeenCalledWith('thread-a', true);

    app.setPinned = vi.fn(async () => { throw new Error('refused'); });
    await press(getExposed(screen.container, 'Fijar hilo'));
    await shows('El hilo no cambió. Inténtalo de nuevo.');
    expect(text()).not.toMatch(/Thread pinned|pin did not change/);
  });

  it('keeps the English text for an English worker', async () => {
    screen = await render(h(ChannelScreen));
    await sendDraft('/remind');
    await shows("Remind this channel's staff:");
    expect(text()).toContain('/remind here in 20m <what>');
    app.remind = () => ({ data: null, error: { code: '42501', details: 'staff-required' } });
    await sendDraft('/remind here in 20m Check the agenda');
    await shows("Only campaign staff can remind this channel's staff.");
    await press(getExposed(screen.container, 'Channel actions'));
    await press(getExposed(screen.container, 'Pin thread'));
    await shows('Thread pinned.');
  });
});

// BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115
// (#8769), the same pattern on the channel screen: a linked message is
// checked every 30 seconds, and one failed check replaced the open channel
// with "removed or your access changed". A failed check now keeps a message
// already confirmed; the server's answer that it is gone still hides it.
describe.each<'ios' | 'android'>(['ios', 'android'])('a linked channel message through a failed check on %s', (os) => {
  beforeEach(() => {
    route.id = 'thread-a'; route.post = 'post-1';
    backend.client = createChannelBackend({ chapter_spaces: spaces, chapter_threads: threads }).client;
    // Only the interval timers are fake: the 30-second check runs on demand.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setPlatform(os);
  });
  afterEach(() => { route.post = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
  const check = async () => { await act(async () => { vi.advanceTimersByTime(30000); }); };

  it('keeps a confirmed message on a failed or timed-out check and hides it when the server says it is gone', async () => {
    const hydrate = vi.spyOn(liveChannelStore, 'hydrateSource').mockResolvedValue(true);
    screen = await render(h(ChannelScreen));
    await until(() => expect(composer()).toBeDefined());
    hydrate.mockRejectedValueOnce(new Error('fetch failed')).mockRejectedValueOnce(Object.assign(new Error('Read timed out'), { name: 'TimeoutError' }));
    await check(); await until(() => expect(composer()).toBeDefined());
    expect(text()).not.toContain('Selected message unavailable');
    await check(); await until(() => expect(composer()).toBeDefined());
    expect(text()).not.toContain('Selected message unavailable');
    hydrate.mockResolvedValueOnce(false);
    await check(); await shows('Selected message unavailable');
  });

  // Review P1-1 on #8798: a permission error or a refused session hides it.
  it('hides a confirmed message when a check is refused with a permission error', async () => {
    const hydrate = vi.spyOn(liveChannelStore, 'hydrateSource').mockResolvedValue(true);
    screen = await render(h(ChannelScreen));
    await until(() => expect(composer()).toBeDefined());
    hydrate.mockRejectedValueOnce({ code: '42501', message: 'authentication required' });
    await check(); await shows('Selected message unavailable');
  });

  it('shows a first check that fails as unavailable', async () => {
    vi.spyOn(liveChannelStore, 'hydrateSource').mockRejectedValue(new Error('fetch failed'));
    screen = await render(h(ChannelScreen));
    await shows('Selected message unavailable');
  });
});


describe.each<'ios' | 'android'>(['ios', 'android'])('K7 channel presentation on %s', (os) => {
  beforeEach(() => { route.id = 'thread-a'; setPlatform(os); backend.client = createChannelBackend({ chapter_spaces: spaces, chapter_threads: threads }).client; });
  it.each<'en' | 'es'>(['en', 'es'])('offers Reply in %s instead of treating a thread title as a channel', async (language) => {
    app.language = language;
    screen = await render(h(ChannelScreen));
    await until(() => expect(composer()).toBeDefined());
    expect(screen.container.querySelector('input')?.placeholder).toBe(language === 'es' ? 'Responder' : 'Reply');
  });
  it.each<'en' | 'es'>(['en', 'es'])('opens and closes notification settings through the %s menu', async (language) => {
    app.language = language;
    screen = await render(h(ChannelScreen));
    await until(() => expect(composer()).toBeDefined());
    const words = (key: keyof typeof nativeUiSpanish) => language === 'es' ? nativeUiSpanish[key] : key;
    await press(getExposed(screen.container, words('Channel actions')));
    await press(getExposed(screen.container, words('Channel notifications')));
    expect(text()).toContain(words('Notify me about'));
    await press(getExposed(screen.container, words('Channel actions')));
    await press(getExposed(screen.container, words('Hide channel notifications')));
    expect(text()).not.toContain(words('Notify me about'));
  });
  it.each<'en' | 'es'>(['en', 'es'])('keeps pin reachable through the labelled %s header menu', async (language) => {
    app.language = language;
    screen = await render(h(ChannelScreen));
    await until(() => expect(composer()).toBeDefined());
    const pin = language === 'es' ? 'Fijar hilo' : 'Pin thread';
    const actions = language === 'es' ? 'Acciones del canal' : 'Channel actions';
    expect(exposedNames(screen.container)).not.toContain(pin);
    const menu = getExposed(screen.container, actions);
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    await press(menu);
    expect(getExposed(screen.container, actions).getAttribute('aria-expanded')).toBe('true');
    getExposed(screen.container, pin);
    await press(getExposed(screen.container, actions));
    expect(exposedNames(screen.container)).not.toContain(pin);
  });
});
