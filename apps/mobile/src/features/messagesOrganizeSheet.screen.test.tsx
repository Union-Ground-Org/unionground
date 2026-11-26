// @vitest-environment jsdom
import { act, createContext, createElement as h, useContext } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HatKey } from '../lib/hatFunctions';
import type { AppMode } from '../state/AppProvider';
import { useSharedDemoVisit } from '../state/useSharedDemoVisit';
import { getExposed, press, render, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

// BUG-UG-NATIVE-MESSAGES-ORGANIZE-SHEET-CUTS-OFF-BUTTONS-AND-HAS-NO-CLOSE-20261122:
// the first visit to Messages renders the real screen with the organize sheet
// open. The stand-in computes no layout, so this pins the structure the device
// screenshots on the record show: the actions sit outside the scrolling part,
// the sheet pads only the safe area, and a close control and the scrim both
// do what Skip does.
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  saved: [] as string[],
  insetsBottom: 34,
  // false: the startup snapshot is missing (null), as before native layout.
  startupMetrics: true,
  tabInset: 120,
}));
const VisitContext = createContext<ReturnType<typeof useSharedDemoVisit>>(null);
vi.mock('react-native', async () => {
  const rn = await import('../testing/reactNativeStandIn');
  // The shared stand-in drops styles and marks no scroll view: record both.
  const View = (props: { style?: unknown }) => h('div', { 'data-style': JSON.stringify(rn.StyleSheet.flatten(props.style) ?? {}) }, h(rn.View, props as never));
  const ScrollView = (props: object) => h('div', { 'data-scroll': 'true' }, h(rn.ScrollView, props as never));
  return { ...rn, View, ScrollView, Animated: { ...rn.Animated, View, ScrollView } };
});
vi.mock('react-native-safe-area-context', () => ({
  // A tab scene's hook over-reports the bottom by the tab bar: the sheets must not use it.
  useSafeAreaInsets: () => ({ top: 47, bottom: port.insetsBottom + 49, left: 0, right: 0 }),
  // The window's own insets, which the sheets pad.
  get initialWindowMetrics() { return port.startupMetrics ? { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, bottom: port.insetsBottom, left: 0, right: 0 } } : null; },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ setParams: vi.fn() }), useIsFocused: () => true, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), setParams: vi.fn() }), useLocalSearchParams: () => ({}), Redirect: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ ...port.app, sharedDemoVisit: useContext(VisitContext) }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('../lib/screenReader', () => ({ useScreenReader: () => false, useScreenReaderKnownOff: () => true }));
type ChromeModule = typeof import('../lib/chrome');
vi.mock('../lib/chrome', async (original) => ({ ...await original<ChromeModule>(), useNativeTabContentInset: () => port.tabInset }));
// Public Messages is a pushed screen inside the pinned header, whose frosted
// chrome loads a native module; these cases render only the inbox body.
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children: unknown }) => children }));
vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('../features/useResultCountAnnouncement', () => ({ useResultCountAnnouncement: () => 'off' }));
vi.mock('../features/useTaskDiscussions', () => ({ useTaskDiscussions: () => ({ items: [], failed: false }) }));
vi.mock('../features/usePeerConversations', () => ({ usePeerConversations: () => ({ items: [], failed: false }) }));
vi.mock('../features/useStewardDirectPages', () => ({ stewardDirectStaleAfterMs: () => 60000, useStewardDirectPages: () => ({ conversations: [], state: 'ready', notice: null }) }));
vi.mock('../components/TaskDiscussionsSection', () => ({ TaskDiscussionsSection: () => null }));
vi.mock('../components/MessageWorkflowPicker', () => ({ MessageWorkflowPicker: () => null }));
vi.mock('../components/RowHighlight', () => ({ HighlightList: () => null, HighlightRow: () => null }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../data/useChannels', () => {
  const store = { channels: () => [], status: () => 'ready', loadFault: () => null, subscribe: () => () => undefined, getVersion: () => 0 };
  return { useChannelStore: () => store };
});
vi.mock('../data/channelControls', () => ({ useChannelControls: () => ({ controls: { switches: { channelPinning: false } } }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(), warning: vi.fn(), select: vi.fn() } }));
vi.mock('../services/messageWorkflowPreference', () => ({
  latestMessageWorkflowRequest: () => port.saved.length,
  readMessageWorkflowOnboarded: async () => false,
  readMessageWorkflowPreference: async () => 'people-spaces-work',
  saveMessageWorkflowPreference: async (value: string) => { port.saved.push(value); return value; },
  subscribeMessageWorkflowPreference: () => () => undefined,
}));
vi.mock('../components/ui', async () => ({
  ...await import('../testing/uiStandIn'), Avatar: () => null,
  StateMessage: ({ title, body }: { title: string; body?: string }) => h('section', null, title, body),
}));
vi.mock('../services/supabase', () => ({
  captureSessionWriter: () => ({}), startMemberConversation: vi.fn(), getSupabaseClient: () => ({}),
  loadMobileMemberChapterStewards: async () => [], loadMobileMemberOrganizationStructure: vi.fn(),
}));

const { default: MessagesScreen } = await import('../../app/messages');
const { StewardFinderSheet } = await import('./StewardFinderSheet');
const { publishWindowBottomInset, resetWindowBottomInsetForTests } = await import('../lib/windowInsets');

const session = { user: { id: 'member-a', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-19T12:00:00Z' }, access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, token_type: 'bearer' };

function MessagesPage() {
  const signedIn = port.app.session as typeof session | null;
  const visit = useSharedDemoVisit(port.app.mode as AppMode, signedIn?.user.id, port.app.sampleHat as HatKey | null);
  return <VisitContext.Provider value={visit}><MessagesScreen /></VisitContext.Provider>;
}
let screen: Rendered | null = null;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const styleOf = (element: Element | null | undefined) => JSON.parse(element?.closest('[data-style]')?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  port.saved = [];
  port.insetsBottom = 34;
  port.startupMetrics = true;
  resetWindowBottomInsetForTests();
  port.app = { mode: 'authenticated', session, sampleHat: null, liveSampleBackend: false, organizationID: 'org-a', authorizedRoles: [], organizationRoles: [], chapterRoles: [],
    dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, conversations: [] }, refresh: vi.fn(), refreshing: false };
});
afterEach(async () => { await screen?.unmount(); screen = null; });

async function openSheet(language: 'en' | 'es' = 'en') {
  (port.app.dashboard as { member: { language: string } }).member.language = language;
  screen = await render(<MessagesPage />);
  await settle();
  // Found by its modal flag, which Main's sheet carries too.
  const sheet = screen.container.querySelector('[role="dialog"] [aria-modal="true"]');
  expect(sheet, 'the organize sheet opens on the first visit').not.toBeNull();
  return sheet!;
}

describe('Messages organize sheet (#9608)', () => {
  it('opens the inbox on a shared demo account without saving an onboarding choice', async () => {
    port.app.sampleHat = 'member';
    port.app.liveSampleBackend = true;
    screen = await render(<MessagesPage />);
    await settle();

    expect(screen.container.textContent).toContain('Messages');
    expect(screen.container.querySelector('[role="dialog"] [aria-modal="true"]')).toBeNull();
    expect(port.saved).toEqual([]);
  });

  it('keeps the chooser closed when the demo dashboard returns before authentication', async () => {
    port.app.sampleHat = 'member';
    port.app.liveSampleBackend = true;
    screen = await render(<MessagesPage />);
    await settle();
    expect(screen.container.querySelector('[role="dialog"] [aria-modal="true"]')).toBeNull();

    const dashboard = port.app.dashboard;
    port.app = { ...port.app, mode: 'booting', sampleHat: null, dashboard: null };
    await screen.rerender(<MessagesPage />);
    port.app = { ...port.app, dashboard };
    await screen.rerender(<MessagesPage />);

    expect(screen.container.textContent).toContain('Messages');
    expect(screen.container.querySelector('[role="dialog"] [aria-modal="true"]')).toBeNull();
    expect(port.saved).toEqual([]);
  });

  it.each([false, true])('keeps first-open onboarding for an ordinary account (SAMPLE backend: %s)', async (liveSampleBackend) => {
    port.app.liveSampleBackend = liveSampleBackend;
    const sheet = await openSheet();

    await press(getExposed(sheet, 'Use this workflow'));
    expect(port.saved).toEqual(['people-spaces-work']);
    expect(screen!.container.querySelector('[role="dialog"] [aria-modal="true"]')).toBeNull();
  });

  it('keeps both actions outside the scrolling choices, so they are always whole', async () => {
    const sheet = await openSheet();
    for (const name of ['Use this workflow', 'Skip and use the default']) {
      const action = getExposed(screen!.container, name);
      expect(sheet.contains(action), name).toBe(true);
      expect(action.closest('[data-scroll]'), `${name} must not scroll away with the choices`).toBeNull();
    }
    expect(sheet.querySelector('[data-scroll]')?.textContent).toContain('Start with the view that fits your day');
  });

  it.each([[34, 46], [0, 12]])('pads the sheet for a %spt home indicator only (%spt), never for the tab bar it covers', async (inset, padding) => {
    port.insetsBottom = inset;
    const sheet = await openSheet();
    // Before the tab layout publishes, the startup snapshot plus a 12pt gap;
    // never the 120pt tab-screen inset that left a blank strip under the cut
    // buttons, nor the tab scene's inset, which counts the 49pt tab bar too.
    expect(styleOf(sheet).paddingBottom).toBe(padding);
  });

  it('follows the live window inset when the startup snapshot is missing, and when it arrives or changes later (#9638 round 1, r2g2)', async () => {
    port.startupMetrics = false;
    let sheet = await openSheet();
    // No startup metrics (Android edge-to-edge, or before native layout): 12pt only, for now.
    expect(styleOf(sheet).paddingBottom).toBe(12);
    // The tab layout publishes the window's inset once measured: the sheet follows.
    await act(async () => { publishWindowBottomInset(48); });
    sheet = screen!.container.querySelector('[role="dialog"] [aria-modal="true"]')!;
    expect(styleOf(sheet).paddingBottom).toBe(60);
    // A later change (navigation mode, split screen) follows too, and wins over the snapshot.
    port.startupMetrics = true;
    await act(async () => { publishWindowBottomInset(24); });
    sheet = screen!.container.querySelector('[role="dialog"] [aria-modal="true"]')!;
    expect(styleOf(sheet).paddingBottom).toBe(36);
  });

  it('closes with a visible control and with a tap outside, the same as Skip', async () => {
    const sheet = await openSheet();
    const closers = [...screen!.container.querySelectorAll('[aria-label="Close and use the default"]')];
    expect(closers).toHaveLength(2);
    expect(closers.filter((closer) => sheet.contains(closer))).toHaveLength(1);
    const scrim = closers.find((closer) => !sheet.contains(closer));
    expect(scrim, 'a tap outside the sheet closes it').toBeDefined();
    await press(scrim!);
    await settle();
    expect(port.saved).toEqual(['people-spaces-work']);
    expect(screen!.container.querySelector('[role="dialog"] [aria-modal="true"]')).toBeNull();
  });

  it('closes from the close control in Spanish too', async () => {
    const sheet = await openSheet('es');
    const close = [...sheet.querySelectorAll('[aria-label="Cerrar y usar el predeterminado"]')];
    expect(close).toHaveLength(1);
    await press(close[0]!);
    await settle();
    expect(port.saved).toEqual(['people-spaces-work']);
  });

  it('pads the committee member finder from the live window inset too, with the startup snapshot missing', async () => {
    port.startupMetrics = false;
    screen = await render(h(StewardFinderSheet, { open: true, onClose: vi.fn() }));
    await settle();
    const frame = () => [...screen!.container.querySelectorAll('[data-style]')].find((node) => styleOf(node).maxHeight === '80%');
    expect(styleOf(frame())).toMatchObject({ paddingBottom: 16 });
    await act(async () => { publishWindowBottomInset(48); });
    expect(styleOf(frame())).toMatchObject({ paddingBottom: 64 });
  });

  it.each([[34, 50], [0, 16]])('pads the committee member finder, built the same way, for a %spt home indicator only (%spt)', async (inset, padding) => {
    port.insetsBottom = inset;
    screen = await render(h(StewardFinderSheet, { open: true, onClose: vi.fn() }));
    await settle();
    // The window's inset plus a 16pt gap, never the tab scene's inset.
    const frame = [...screen.container.querySelectorAll('[data-style]')].find((node) => styleOf(node).maxHeight === '80%');
    expect(styleOf(frame)).toMatchObject({ paddingBottom: padding });
    // The title takes the room left beside the close control, so at the
    // largest text size it wraps instead of pushing the control off the sheet.
    const close = screen.container.querySelector('[aria-label="Close Find my committee contact"]:not([data-testid])');
    const title = [...screen.container.querySelectorAll('[data-style]')].find((node) => node.textContent === 'Find my committee contact' && styleOf(node).flex === 1);
    expect(close).not.toBeNull();
    expect(title, 'the title wrapper shrinks beside the close control').toBeDefined();
  });
});
