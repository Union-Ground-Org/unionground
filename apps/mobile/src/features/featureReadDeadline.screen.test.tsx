// @vitest-environment jsdom
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, Platform, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { READ_DEADLINE_MS } from '../lib/readDeadline';
import palette from '../theme/palette.json';

// Exercise the shipped screens and their load effects, not source text.
// Native hosts and network ports are fixtures; the deadline load
// hook remain real. No write is timed out or retried by this change.
const port = vi.hoisted(() => ({
  ballots: vi.fn(), rewards: vi.fn(), workload: vi.fn(), events: vi.fn(), directory: vi.fn(),
  campaigns: vi.fn(), orgs: vi.fn(), context: vi.fn(),
  api: null as unknown,
  app: {
    mode: 'authenticated', session: { user: { id: 'member-a' } }, memberLanguage: 'en',
    organizationID: 'org-a', dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' } },
    authorizedRoles: ['member'], chapterRoles: ['member'], organizationRoles: [], staffRoleChoices: [],
    chapterMemberships: [{ chapterID: 'chapter-a', selected: true }],
    captureAuthenticatedSessionGuard: () => () => true,
  },
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// The form signature pad (#8699) on the live Forms screen draws with react-native-svg.
vi.mock('react-native-svg', () => ({ default: () => null, Polyline: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, body, action) };
});
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({}), useRouter: () => ({ push: vi.fn(), dismissTo: vi.fn() }), Redirect: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-id' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
// Ledger 142: mocks of phone modules keep the module's real exports and
// replace only what the test drives, so the next export a screen starts using
// does not break this file. The supabase, calendar export, haptics, analytics
// and observability ports stay whole stand-ins: their real modules load native
// modules the React Native stand-in does not provide. So does
// mi1AnalyticsShared: its real module reaches a root package the Mobile
// application check does not install.
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'member-a'), getSupabaseClient: () => ({}), loadMobileBallots: port.ballots }));
vi.mock('../services/governance', async (original) => ({ ...(await original() as typeof import('../services/governance')), loadMobileOfficerRemovalDetails: async () => new Map() }));
vi.mock('../services/livedIn', async (original) => ({
  ...(await original() as typeof import('../services/livedIn')),
  loadMobileEventsHistory: port.events, loadMobileRewardsHistory: port.rewards, loadMobileWorkloadHistory: port.workload,
}));
vi.mock('../services/nativeCalendarExport', () => ({ isCalendarExportAvailable: () => false }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../services/analyticsPreference', () => ({ gatePageViewRecorder: (fn: unknown) => fn, useProductAnalyticsEnabled: () => false }));
vi.mock('../services/observability', () => ({ captureNativeScreen: vi.fn() }));
vi.mock('../services/ssoRelease', () => ({ useSsoReleased: () => false }));
vi.mock('../lib/announce', async (original) => ({ ...(await original() as typeof import('../lib/announce')), queueAccessibilityAnnouncement: vi.fn(), useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../lib/screenBack', async (original) => ({ ...(await original() as typeof import('../lib/screenBack')), useScreenBackInterceptor: () => {} }));
vi.mock('../lib/useFeaturePageView', async (original) => ({ ...(await original() as typeof import('../lib/useFeaturePageView')), useFeaturePageView: () => {} }));
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../lib/connectedWorkflows', async (original) => ({ ...(await original() as typeof import('../lib/connectedWorkflows')), connectedWorkflowApi: () => ({ context: port.context }) }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children), useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../data/useChannels', () => ({}));
vi.mock('../components/AskCompassButton', () => ({}));
vi.mock('../components/TransactionalAction', () => ({ TransactionalButton: () => null, useTransactionalAction: () => ({ done: false }) }));
vi.mock('../components/CaseRowPressable', () => ({}));
vi.mock('../components/PressableScale', () => ({}));
vi.mock('../components/ChapterVerificationControls', () => ({}));
vi.mock('../components/NumberFlow', () => ({}));
vi.mock('../components/StaffRolePicker', () => ({}));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../components/AttachmentPanel', () => ({}));
vi.mock('../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('./NativeUnitSettings', () => ({ NativeUnitWorkloadEntry: () => null }));
vi.mock('./LiveAppointmentsFeature', () => ({}));
vi.mock('./MemberSupportScreen', () => ({}));
vi.mock('./ChapterMembershipsScreen', () => ({}));
vi.mock('./ChapterInvitationsScreen', () => ({}));
vi.mock('./OrgStructureScreen', () => ({}));
vi.mock('./DuesScreen', () => ({}));
vi.mock('./mi1/PayToolsScreen', () => ({}));
vi.mock('./mi1/Mi1FeatureScreen', () => ({}));
vi.mock('./mi1/Mi1AnalyticsScreen', () => ({}));
vi.mock('./mi1/ConnectionSuggestionsPanel', () => ({}));
vi.mock('./mi1/OrganizationIntelligenceScreens', () => ({}));
vi.mock('./mi1/Mi1QaFeatureScreen', () => ({}));
vi.mock('./learning/LearningContentManager', () => ({}));
vi.mock('./learning/LearningLibrarySection', () => ({}));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('./StewardDeskSectionsScreen', () => ({}));
vi.mock('./ContextualPulseCard', () => ({}));
vi.mock('./RightsResumeReading', () => ({}));
vi.mock('./TaskDocumentHandoffProvider', () => ({}));
vi.mock('./WorkFilterPresetsCard', () => ({}));
vi.mock('./CaseRowTopicCards', () => ({}));

import { FeatureScreen } from './FeatureScreen';
import { LiveLivedInScreen } from './LiveLivedInScreens';

let screen: Rendered | null = null;
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
};
const rewards = { summary: { tierName: 'RECORDED REWARDS', totalPoints: 12 }, events: [] };
const event = { id: 'test-event', title: 'Quillmere meeting', startsAt: '2026-12-01T15:00:00Z', eventDate: null, location: 'Hall', eventKind: 'meeting', checkInOffered: false };
const ballot = { id: 'test-ballot', title: 'Quillmere vote', closed: true, closesAt: '2026-11-01T15:00:00Z', receiptCode: null, options: [] };
const cases = [
  { name: 'ballots', node: () => h(FeatureScreen, { featureKey: 'voting' }), read: port.ballots, reply: [ballot], shown: 'Quillmere vote', loading: 'Loading votes', retry: 'Refresh votes' },
  { name: 'events', node: () => h(LiveLivedInScreen, { featureKey: 'events' }), read: port.events, reply: [event], shown: 'Quillmere meeting', loading: 'Loading meetings', retry: 'Try again' },
];

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  port.ballots.mockResolvedValue([ballot]); port.rewards.mockResolvedValue(rewards); port.events.mockResolvedValue([event]);
  port.context.mockResolvedValue({ available: true });
});
afterEach(async () => { await screen?.unmount(); screen = null; port.app.memberLanguage = 'en'; vi.useRealTimers(); setPlatform('ios'); });

describe.each([
  ['en', 'point', 'points', 'log', 'logs'],
  ['es', 'punto', 'puntos', 'registro', 'registros'],
])('record counts in %s', (language, point, points, log, logs) => {
  const occurrences = (label: string) => Array.from(screen!.container.querySelectorAll('span'))
    .filter((node) => node.textContent === label).length;

  it.each([1, 2])('names %i logs correctly in the summary and month', async (count) => {
    port.app.memberLanguage = language;
    port.workload.mockResolvedValueOnce({
      stats: {}, logs: Array.from({ length: count }, (_, index) => ({
        id: `log-${index}`, loggedOn: '2026-11-19', priority: 0, pending: 1, todos: 0, referrals: 0, assistanceRequests: 0, note: null,
      })),
    });
    screen = await render(h(LiveLivedInScreen, { featureKey: 'workload' }));
    expect(occurrences(`${count} ${count === 1 ? log : logs}`)).toBe(2);
  });
});

const votingClose = '2025-07-04T02:15:00Z';
it.each([
  ['ios', 'en', 'Closed Jul 3, 2025, 10:15 PM EDT', true, votingClose],
  ['android', 'es', 'Cerró el 3 jul 2025, 10:15 p. m. EDT', true, votingClose],
  ['ios', 'en', 'Closes Jul 3, 2025, 10:15 PM EDT', false, votingClose],
  ['android', 'es', 'Cierra el 3 jul 2025, 10:15 p. m. EDT', false, votingClose],
  ['ios', 'en', 'Closing time unavailable', false, ''],
] satisfies ['ios' | 'android', 'en' | 'es', string, boolean, string][])('shows Votes on %s in %s with “%s”', async (platform, language, label, closed, closesAt) => {
  const previousPlatform = Platform.OS;
  const previousLanguage = port.app.memberLanguage;
  vi.stubEnv('TZ', 'Asia/Tokyo');
  try {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
    setPlatform(platform);
    port.app.memberLanguage = language;
    port.ballots.mockResolvedValueOnce([{ ...ballot, closed, closesAt }]);

    screen = await render(h(FeatureScreen, { featureKey: 'voting' }));
    expect(screen.container.textContent).toContain(label);
  } finally {
    vi.unstubAllEnvs();
    port.app.memberLanguage = previousLanguage;
    setPlatform(previousPlatform);
  }
});

describe.each<'ios' | 'android'>(['ios', 'android'])('native feature read deadlines on %s', (os) => {
  for (const test of cases) {
    it(`${test.name}: replaces an unanswered read with a working retry and ignores late data`, async () => {
      setPlatform(os);
      const late = deferred(); test.read.mockReturnValueOnce(late.promise);
      screen = await render(test.node());
      expect(screen.container.textContent).toContain(test.loading);
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
      expect(screen.container.textContent).not.toContain(test.loading);
      getExposed(screen.container, test.retry);
      await act(async () => late.resolve(test.reply));
      expect(screen.container.textContent).not.toContain(test.shown);
      await press(getExposed(screen.container, test.retry));
      expect(screen.container.textContent).toContain(test.shown);
    });
    it(`${test.name}: renders a normal reply`, async () => {
      setPlatform(os); screen = await render(test.node());
      expect(screen.container.textContent).toContain(test.shown);
      expect(screen.container.textContent).not.toContain(test.loading);
    });
  }

  it('Meetings bounds the source-context read as part of the same load', async () => {
    setPlatform(os); port.context.mockReturnValueOnce(new Promise(() => {}));
    screen = await render(h(LiveLivedInScreen, { featureKey: 'events', sourceID: 'test-event' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
    getExposed(screen.container, 'Try again');
    expect(screen.container.textContent).not.toContain('Loading meetings');
    await press(getExposed(screen.container, 'Try again'));
    expect(screen.container.textContent).toContain('Quillmere meeting');
  });
});
