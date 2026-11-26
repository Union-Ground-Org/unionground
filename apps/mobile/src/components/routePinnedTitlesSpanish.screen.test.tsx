// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessibilityInfo, exposedNames, getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { MentionHit } from '../data/channelControls';
import { normalizeChannelControls, type ChannelControls } from '../lib/channelControlsShared';
import palette from '../theme/palette.json';

type ChannelControlsModule = typeof import('../data/channelControls');
const port = vi.hoisted(() => ({
  language: 'es' as 'en' | 'es',
  dashboardLanguage: null as 'en' | 'es' | null,
  canGoBack: true,
  memberId: 'member-a',
  loadControls: vi.fn<() => Promise<ChannelControls>>(),
  searchMentions: vi.fn<(query: string) => Promise<MentionHit[]>>(),
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children?: ReactNode }) => h('div', null, children),
}));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn(), canGoBack: () => port.canGoBack }),
  useLocalSearchParams: () => ({ id: 'task-a', key: 'unknown-workspace', page: 'unknown-page' }),
  Redirect: () => null,
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./TopChrome', () => ({ FrostedCapsule: ({ children }: { children?: ReactNode }) => h('div', null, children), TopRamp: () => null, withAlpha: (hex: string) => hex }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  mode: 'authenticated', memberLanguage: port.language, authorizedRoles: [], organizationID: 'org-a', chapterMemberships: [],
  session: { user: { id: port.memberId } },
  dashboard: { member: { id: port.memberId, chapterID: 'chapter-a', language: port.dashboardLanguage ?? port.language }, notifications: [] },
}) }));
vi.mock('./ChapterLeadershipCard', () => ({ ChapterLeadershipCard: () => null }));
vi.mock('./MemberInvitationCard', () => ({ MemberInvitationCard: () => null }));
vi.mock('./FunctionDeck', () => ({ functionIcons: {} }));
vi.mock('../services/unionCatalog', () => ({}));
vi.mock('../features/onboardingGuide/OnboardingGuideCard', () => ({ GuidedListToggle: () => null, OnboardingGuideCard: () => null, OnboardingGuideLoadFailedCard: () => null }));
vi.mock('../features/onboardingGuide/useOnboardingGuide', () => ({ useOnboardingGuide: () => ({ guide: { progressiveDisclosureActive: false }, loadFailed: false, showAll: true, setShowAll: vi.fn() }) }));
vi.mock('../data/channelControls', async (original) => {
  const actual = await original<ChannelControlsModule>();
  actual.channelControlsApi.load = port.loadControls;
  actual.channelControlsApi.searchMentions = port.searchMentions;
  return actual;
});
vi.mock('./WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => null }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => null), getSupabaseClient: () => null }));
vi.mock('../lib/taskConversationLoad', () => ({ loadTaskConversation: async () => ({ messages: [], more: false, canReply: false }), isTaskConversationRefusal: () => false }));

vi.mock('../state/useLowData', () => ({ useLowData: () => ({ signals: { connected: true } }) }));
vi.mock('../services/offlineAvailability', () => ({}));
vi.mock('../services/publicLearningDownloads', () => ({
  readPublicLearningLibrary: async () => ({ enabled: false, downloads: [], bytes: 0 }),
}));
vi.mock('../features/FeatureScreen', () => ({ FeatureScreen: () => null }));
vi.mock('../features/TaskDocumentHandoffProvider', () => ({ TaskDocumentHandoffProvider: () => null }));
vi.mock('expo-linking', () => ({ openURL: vi.fn() }));

import NotificationsScreen from '../../app/notifications';
import { OfflineAvailabilityScreen } from '../features/OfflineAvailabilityScreen';
import MentionsRoute from '../../app/mentions';
import TaskConversationRoute from '../../app/task-conversation/[id]';
import FeatureRoute from '../../app/feature/[key]';
import LegalRoute from '../../app/legal/[page]';

let screen: Rendered | null = null;
const controlsOn = normalizeChannelControls({ available: true, switches: { mentionSearch: true } });
port.loadControls.mockResolvedValue(controlsOn);
port.searchMentions.mockResolvedValue([]);
afterEach(async () => {
  await screen?.unmount();
  screen = null;
  setPlatform('ios');
  port.language = 'es';
  port.canGoBack = true;
  port.dashboardLanguage = null;
  port.memberId = 'member-a';
  vi.restoreAllMocks();
  port.loadControls.mockReset().mockResolvedValue(controlsOn);
  port.searchMentions.mockReset().mockResolvedValue([]);
});

// Keep the real PinnedHeaderScreen and Heading: their exact-name suppression
// must work together, including the painted title hidden from screen readers.
describe.each<'ios' | 'android'>(['ios', 'android'])('route titles on %s', (platform) => {
  describe.each<'en' | 'es'>(['en', 'es'])('%s', (language) => {
    it.each([
      { Route: MentionsRoute, english: 'Your mentions', spanish: 'Sus menciones' },
      { Route: TaskConversationRoute, english: 'Task conversation', spanish: 'Conversación de la tarea' },
    ])('paints and announces $english once', async ({ Route, english, spanish }) => {
      setPlatform(platform); port.language = language;
      screen = await render(h(Route));
      const expected = language === 'es' ? spanish : english;
      const isPageTitle = (text: string | null) => text === english || text === spanish;
      const painted = [...screen.container.querySelectorAll('span')].filter((span) => isPageTitle(span.textContent));
      expect(painted.map((span) => span.textContent)).toEqual([expected]);
      expect(exposedNames(screen.container).filter(isPageTitle)).toEqual([expected]);
      expect(getExposed(screen.container, expected).getAttribute('role')).toBe('header');
    });
  });
});

describe('Spanish labels on the icon-only pinned header', () => {
  it.each([
    { name: 'Activity', Route: NotificationsScreen },
    { name: 'Saved guides and notes', Route: OfflineAvailabilityScreen },
  ])('names Home in Spanish on a cold entry to $name', async ({ Route }) => {
    port.language = 'es';
    port.canGoBack = false;
    screen = await render(h(Route));
    expect(screen.container.querySelector('[role="button"][aria-label="Inicio"]')).not.toBeNull();
    expect(screen.container.querySelector('[aria-label="Home"]')).toBeNull();
  });
});

it.each([
  { Route: FeatureRoute, heading: 'Ese espacio no está en la app', body: 'Union Ground solo abre espacios de trabajo disponibles en el producto.' },
  { Route: LegalRoute, heading: 'No se encontró el documento', body: 'Esa página legal no forma parte de Union Ground.' },
])('shows $heading and a Spanish Home control', async ({ Route, heading, body }) => {
  port.language = 'es';
  port.canGoBack = false;
  screen = await render(h(Route));
  expect(screen.container.textContent).toContain(heading);
  expect(screen.container.textContent).toContain(body);
  expect(getExposed(screen.container, 'Inicio')).toBeTruthy();
  expect(screen.container.querySelector('[aria-label="Home"]')).toBeNull();
});

describe('Your mentions channel settings', () => {
  it.each<['en' | 'es', string, string, string]>([
    ['en', 'Loading your mentions. Checking your campaign channels.', 'Could not check mention search.', 'Try again'],
    ['es', 'Cargando sus menciones. Consultando los canales de su campaña.', 'No se pudo revisar la búsqueda de menciones.', 'Reintentar'],
  ])('offers one retry after a failed settings read in %s', async (language, loading, warning, retry) => {
    port.language = language;
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    let failInitialRead!: (error: Error) => void;
    const initialRead = new Promise<ChannelControls>((_resolve, reject) => { failInitialRead = reject; });
    let finishRetry!: (controls: ChannelControls) => void;
    const pending = new Promise<ChannelControls>((resolve) => { finishRetry = resolve; });
    port.loadControls.mockReturnValueOnce(initialRead).mockReturnValueOnce(pending);
    screen = await render(h(MentionsRoute));
    await vi.waitFor(() => expect(announce).toHaveBeenNthCalledWith(1, loading, { queue: true }));

    await act(async () => { failInitialRead(new Error('Settings read failed')); });
    expect(screen.container.textContent).toContain(warning);
    await vi.waitFor(() => expect(announce).toHaveBeenNthCalledWith(2, warning, { queue: true }));
    expect(screen.container.querySelector('input')).toBeNull();
    expect(port.searchMentions).not.toHaveBeenCalled();

    await press(getExposed(screen.container, retry));
    const retryButton = getExposed(screen.container, retry);
    expect(retryButton.getAttribute('aria-busy')).toBe('true');
    await press(retryButton);
    expect(port.loadControls).toHaveBeenCalledTimes(2);

    await act(async () => { finishRetry(controlsOn); });
    expect(screen.container.textContent).not.toContain(warning);
    expect(screen.container.querySelector('input')).not.toBeNull();
  });

  it('makes retry actionable again after a second settings read fails', async () => {
    port.loadControls
      .mockRejectedValueOnce(new Error('Initial settings read failed'))
      .mockRejectedValueOnce(new Error('Retried settings read failed'));
    screen = await render(h(MentionsRoute));
    await press(getExposed(screen.container, 'Reintentar'));
    expect(port.loadControls).toHaveBeenCalledTimes(2);
    expect(port.searchMentions).not.toHaveBeenCalled();
    expect(screen.container.querySelector('input')).toBeNull();
    expect(screen.container.textContent).toContain('No se pudo revisar la búsqueda de menciones.');

    await press(getExposed(screen.container, 'Reintentar'));
    expect(port.loadControls).toHaveBeenCalledTimes(3);
    expect(screen.container.querySelector('input')).not.toBeNull();
  });

  it('ignores the previous account’s successful settings retry after an account change', async () => {
    let finishOldRetry!: (controls: ChannelControls) => void;
    let finishCurrentRead!: (controls: ChannelControls) => void;
    const oldRetry = new Promise<ChannelControls>((resolve) => { finishOldRetry = resolve; });
    const currentRead = new Promise<ChannelControls>((resolve) => { finishCurrentRead = resolve; });
    port.loadControls.mockRejectedValueOnce(new Error('Initial settings read failed'))
      .mockReturnValueOnce(oldRetry).mockReturnValueOnce(currentRead);
    screen = await render(h(MentionsRoute));
    await press(getExposed(screen.container, 'Reintentar'));
    expect(getExposed(screen.container, 'Reintentar').getAttribute('aria-busy')).toBe('true');

    port.memberId = 'member-b';
    await screen.rerender(h(MentionsRoute));
    expect(port.loadControls).toHaveBeenCalledTimes(3);
    await act(async () => { finishOldRetry(controlsOn); });
    expect(screen.container.textContent).toContain('Cargando sus menciones');
    expect(screen.container.querySelector('input')).toBeNull();
    expect(port.searchMentions).not.toHaveBeenCalled();

    const controlsOff = normalizeChannelControls({ available: true, switches: { mentionSearch: false } });
    await act(async () => { finishCurrentRead(controlsOff); });
    expect(screen.container.textContent).toContain('La búsqueda de menciones no está activa.');
    expect(screen.container.querySelector('input')).toBeNull();
  });

  it('explains a confirmed disabled setting without offering a retry or search', async () => {
    port.language = 'es';
    port.loadControls.mockResolvedValueOnce(normalizeChannelControls({ available: true, switches: { mentionSearch: false } }));
    screen = await render(h(MentionsRoute));
    expect(screen.container.textContent).toContain('La búsqueda de menciones no está activa.');
    expect(exposedNames(screen.container)).not.toContain('Reintentar');
    expect(screen.container.querySelector('input')).toBeNull();
    expect(port.searchMentions).not.toHaveBeenCalled();
  });
});
