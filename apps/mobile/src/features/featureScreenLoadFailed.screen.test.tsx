// @vitest-environment jsdom
import { createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { render, type Rendered } from '../testing/reactNativeStandIn';
import { nativeUiText } from '../lib/nativeUiCopy';
import palette from '../theme/palette.json';
import { liveSearchRowsFrom, type LiveSearchIndex } from '../services/memberSearch';

// BUG-UG-LOADING-NEVER-ENDS-AND-NO-RETRY-20261122 (#9459, M1-19):
// every screen opened through /feature/<key> used to say "<Title> is loading"
// for as long as it stayed open when the member workspace failed to load,
// although AppProvider had recorded the failure. The real FeatureScreen runs
// on the shared stand-in (its unrelated features are replaced, as in
// caseRowOpens.screen.test.tsx) and the recovery controls are driven.
const port = vi.hoisted(() => ({
  push: vi.fn(), chapterCases: vi.fn(), activeCases: vi.fn(), deadlines: vi.fn(), caseload: vi.fn(), context: vi.fn(),
  app: {} as Record<string, unknown>,
  searchIndex: vi.fn<() => Promise<LiveSearchIndex>>(),
  buttons: new Map<string, { onPress: () => void; disabled?: boolean; busy?: boolean; variant?: string }>(),
  screens: [] as { onRefresh?: () => void; refreshing?: boolean }[],
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// The form signature pad (#8699) on the live Forms screen draws with react-native-svg.
vi.mock('react-native-svg', () => ({ default: () => null, Polyline: () => null }));
// Screen and Button record their recovery props so the test can drive them.
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return {
    ...ui,
    Screen: ({ children, onRefresh, refreshing }: { children?: ReactNode; onRefresh?: () => void; refreshing?: boolean }) => {
      port.screens.push({ onRefresh, refreshing });
      return h('div', null, children);
    },
    Button: ({ label, onPress, disabled, busy, variant }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean; variant?: string }) => {
      port.buttons.set(label, { onPress, disabled, busy, variant });
      return h('button', { disabled: disabled || busy }, label);
    },
    StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, h('h2', null, title), h('p', null, body), action),
  };
});
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({}), useRouter: () => ({ push: port.push, dismissTo: vi.fn() }), useLocalSearchParams: () => ({}), Redirect: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-id' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => null), getSupabaseClient: () => ({}), loadMobileConnectionReadiness: async () => [] }));
vi.mock('../services/memberSearch', async (original) => ({
  ...(await original() as typeof import('../services/memberSearch')),
  loadLiveSearchIndex: port.searchIndex,
}));
vi.mock('../services/chapterCaseQueue', () => ({ loadChapterCases: port.chapterCases, loadChapterActiveCases: port.activeCases, loadChapterCaseDeadlines: port.deadlines }));
vi.mock('../services/governance', async (original) => ({ ...(await original() as typeof import('../services/governance')), loadMobileOfficerRemovalDetails: async () => new Map() }));
vi.mock('../services/nativeCalendarExport', () => ({ isCalendarExportAvailable: () => false }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../services/analyticsPreference', () => ({ gatePageViewRecorder: (fn: unknown) => fn, useProductAnalyticsEnabled: () => false }));
vi.mock('../services/observability', () => ({ captureNativeScreen: vi.fn() }));
vi.mock('../services/ssoRelease', () => ({ useSsoReleased: () => false }));
vi.mock('../lib/announce', async (original) => ({ ...(await original() as typeof import('../lib/announce')), queueAccessibilityAnnouncement: vi.fn(), useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../lib/screenBack', async (original) => ({ ...(await original() as typeof import('../lib/screenBack')), useScreenBackInterceptor: () => {} }));
vi.mock('../lib/useFeaturePageView', async (original) => ({ ...(await original() as typeof import('../lib/useFeaturePageView')), useFeaturePageView: () => {} }));
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../lib/connectedWorkflows', async (original) => ({ ...(await original() as typeof import('../lib/connectedWorkflows')), connectedWorkflowApi: () => null }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children), useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({ subscribe: () => () => {}, getVersion: () => 0, channels: () => [] }) }));
vi.mock('../components/AskCompassButton', () => ({}));
vi.mock('../components/TransactionalAction', () => ({ useTransactionalAction: () => ({ done: false }) }));
// The steward desk's section rows press through PressableScale; its animation
// props have no stand-in meaning (the stand-in reads only the props it
// knows), so it renders as the stand-in Pressable.
vi.mock('../components/PressableScale', async () => {
  const native = await import('../testing/reactNativeStandIn');
  return { PressableScale: (props: Record<string, unknown>) => h(native.Pressable as never, props) };
});
vi.mock('../components/ChapterVerificationControls', () => ({}));
vi.mock('../components/NumberFlow', () => ({}));
vi.mock('../components/StaffRolePicker', () => ({ StaffRolePicker: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../components/AttachmentPanel', () => ({}));
vi.mock('../components/QuarterlySurveyGate', () => ({}));
vi.mock('./LiveAppointmentsFeature', () => ({}));
vi.mock('./MemberSupportScreen', () => ({}));
vi.mock('./ChapterMembershipsScreen', () => ({}));
vi.mock('./ChapterInvitationsScreen', () => ({}));
vi.mock('./OrgStructureScreen', () => ({}));
vi.mock('./mi1/PayToolsScreen', () => ({}));
vi.mock('./mi1/Mi1FeatureScreen', () => ({}));
vi.mock('./mi1/Mi1AnalyticsScreen', () => ({}));
vi.mock('./mi1/ConnectionSuggestionsPanel', () => ({}));
vi.mock('./mi1/OrganizationIntelligenceScreens', () => ({}));
vi.mock('./mi1/Mi1QaFeatureScreen', () => ({}));
vi.mock('./learning/LearningContentManager', () => ({}));
vi.mock('./learning/LearningLibrarySection', () => ({}));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeOrgStartGuide: () => null }));
// The Work tab's own parts and the steward desk's reads.
vi.mock('./guideLayers/StaffGuides', () => ({ NativeStaffGuides: () => null }));
vi.mock('../components/StaffQuickCapture', () => ({ StaffQuickCapture: () => null }));
vi.mock('../components/WorkWidgets', () => ({ WorkWidgets: () => null }));
vi.mock('../services/memberSwitches', () => ({ useMemberSwitchRead: () => null }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0 }));
vi.mock('../services/stewardDeskSections', () => ({ loadStewardCaseload: port.caseload, loadStewardBroadcasts: vi.fn(), loadStewardFormsForReview: vi.fn(), loadStewardRequests: vi.fn(), reviewStewardForm: vi.fn(), sendChapterBroadcast: vi.fn(), triageStewardRequest: vi.fn() }));
vi.mock('../services/stewardFormReview', () => ({ formatFormSubmittedAt: () => '', loadStewardFormReviewDetail: vi.fn(), stewardFormApprovalBlock: () => null }));
vi.mock('./ContextualPulseCard', () => ({}));
vi.mock('./RightsResumeReading', () => ({}));
vi.mock('./TaskDocumentHandoffProvider', () => ({}));
vi.mock('./WorkFilterPresetsCard', () => ({}));
vi.mock('./CaseRowTopicCards', () => ({}));


import { FeatureScreen } from './FeatureScreen';
import { LiveSearchScreen } from './LiveFeatureScreens';

const LOAD_ERROR = 'Your worker workspace could not be loaded securely. Check your connection and try again.';
const refresh = vi.fn(async (_reason?: string) => undefined);
const base = {
  mode: 'authenticated', session: { user: { id: 'member-a' } }, memberLanguage: 'en', organizationID: 'org-a',
  authorizedRoles: ['member'], chapterRoles: ['member'], organizationRoles: [], staffRoleChoices: [],
  chapterMemberships: [{ chapterID: 'chapter-a', selected: true }],
  captureAuthenticatedSessionGuard: () => () => true,
  dashboard: null, error: null as string | null, refreshing: false, refresh,
};

let screen: Rendered | null = null;
const text = () => screen?.container.textContent ?? '';
beforeEach(() => {
  vi.clearAllMocks();
  port.buttons.clear();
  port.screens.length = 0;
  port.app = { ...base };
});
afterEach(async () => { await screen?.unmount(); screen = null; });

// Member features named in the record; each passes the dashboard gate.
describe.each([['cases', 'My issues'], ['voting', 'Votes'], ['appointments', 'One-on-ones']] as const)('the %s feature without a workspace', (featureKey, title) => {
  it('stays on the loading copy with pull-to-refresh and no Try again while the workspace is still loading', async () => {
    screen = await render(h(FeatureScreen, { featureKey }));
    expect(text()).toContain(`${title} is loading`);
    expect(text()).toContain('Getting your latest information.');
    expect(text()).not.toContain('could not load');
    expect(port.buttons.has('Try again')).toBe(false);
    expect(port.screens.at(-1)?.onRefresh).toBeTypeOf('function');
  });

  it('says the workspace did not load and retries from Try again and from pull-to-refresh', async () => {
    port.app = { ...base, error: LOAD_ERROR };
    screen = await render(h(FeatureScreen, { featureKey }));
    expect(text()).toContain(`${title} could not load`);
    expect(text()).toContain(LOAD_ERROR);
    expect(text()).not.toContain('is loading');
    const retry = port.buttons.get('Try again');
    expect(retry).toMatchObject({ variant: 'secondary', disabled: false, busy: false });
    retry?.onPress();
    expect(refresh).toHaveBeenCalledWith('user-refresh');
    port.screens.at(-1)?.onRefresh?.();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('the failed state of a feature screen', () => {
  it('keeps Try again on screen but inert while a retry is in flight', async () => {
    port.app = { ...base, error: LOAD_ERROR, refreshing: true };
    screen = await render(h(FeatureScreen, { featureKey: 'cases' }));
    expect(text()).toContain('My issues could not load');
    expect(port.buttons.get('Try again')).toMatchObject({ disabled: true, busy: true });
    expect(port.screens.at(-1)?.refreshing).toBe(true);
  });

  it('speaks Spanish when the worker reads the app in Spanish', async () => {
    const t = nativeUiText('es');
    port.app = { ...base, memberLanguage: 'es', error: LOAD_ERROR };
    screen = await render(h(FeatureScreen, { featureKey: 'cases' }));
    expect(text()).toContain(t('{title} could not load', { title: t('My issues') }));
    expect(text()).toContain(t(LOAD_ERROR as never));
    expect(text()).not.toContain(LOAD_ERROR);
    expect(port.buttons.has(t('Try again'))).toBe(true);
  });

  it('shows the screen, not the loading or failed state, once the workspace has loaded', async () => {
    port.app = { ...base, error: null, dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, cases: [] } };
    screen = await render(h(FeatureScreen, { featureKey: 'cases' }));
    expect(text()).not.toContain('is loading');
    expect(text()).not.toContain('could not load');
    expect(port.buttons.has('Try again')).toBe(false);
  });
});

it('relabels a Search meeting when the language changes without reading again', async () => {
  port.searchIndex.mockResolvedValueOnce({
    rows: [
      { id: 'events:meeting', scope: 'events', title: 'Fixture meeting', body: 'Hall', eventDay: '2025-07-03' },
      { id: 'events:holiday', scope: 'events', title: 'Fixture holiday', body: '', eventDay: '2025-07-05' },
    ],
    unavailable: [],
  }).mockRejectedValue(new Error('A second search read would fail'));
  screen = await render(h(LiveSearchScreen));
  expect(port.searchIndex).toHaveBeenCalledTimes(1);
  expect(port.searchIndex).toHaveBeenCalledWith();
  expect(text()).toContain('Jul 3, 2025 · Hall');
  expect(text()).toContain('Jul 5, 2025');

  port.app = { ...base, memberLanguage: 'es' };
  await screen.rerender(h(LiveSearchScreen));
  expect(port.searchIndex).toHaveBeenCalledTimes(1);
  expect(text()).toContain('3 jul 2025 · Hall');
  expect(text()).toContain('5 jul 2025');
  expect(text()).not.toContain('Jul 3, 2025');
  expect(text()).not.toContain('Search didn’t load');
});

it('shows the group closing clock for Search votes and relabels it without another read', async () => {
  vi.stubEnv('TZ', 'Asia/Tokyo');
  try {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
    const rows = liveSearchRowsFrom('ballots', [
      { id: 'open', title: 'Fixture vote', active: true, closes_at: '2025-07-04T02:15:00Z' },
      { id: 'closed', title: 'Closed fixture vote', active: false, closes_at: '2025-07-04T02:15:00Z' },
      { id: 'missing', title: 'Fixture vote without a closing time', active: true, closes_at: null },
    ], Date.parse('2025-07-03T12:00:00Z'));
    port.searchIndex.mockResolvedValueOnce({ rows, unavailable: [] })
      .mockRejectedValue(new Error('A second search read would fail'));

    screen = await render(h(LiveSearchScreen));
    expect(text()).toContain('Closes Jul 3, 2025, 10:15 PM EDT');
    expect(text()).toContain('Closed Jul 3, 2025, 10:15 PM EDT');
    expect(text()).toContain('Votes is open');

    port.app = { ...base, memberLanguage: 'es' };
    await screen.rerender(h(LiveSearchScreen));
    expect(text()).toContain('Cierra el 3 jul 2025, 10:15 p. m. EDT');
    expect(text()).toContain('Cerró el 3 jul 2025, 10:15 p. m. EDT');
    expect(text()).toContain('La votación está abierta');
    expect(text()).not.toContain('Search didn’t load');
    expect(port.searchIndex).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('shows Search vote statuses when the closing time or zone format is unavailable', async () => {
  const DateTimeFormat = Intl.DateTimeFormat;
  const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale, options) {
    if (options?.timeZone === 'America/New_York') throw new RangeError('No group-zone data');
    return new DateTimeFormat(locale, options);
  });
  const status = (title: string) => screen?.container.querySelector(`[role="button"][aria-label="${title}"] span:not([role])`)?.textContent;

  try {
    const rows = liveSearchRowsFrom('ballots', [
      { id: 'missing', title: 'Vote one', active: false, closes_at: null },
      { id: 'unsupported', title: 'Vote two', active: true, closes_at: '2025-07-04T02:15:00Z' },
    ], Date.parse('2025-07-03T12:00:00Z'));
    port.searchIndex.mockResolvedValueOnce({ rows, unavailable: [] });

    screen = await render(h(LiveSearchScreen));
    expect(formatter).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeZone: 'America/New_York' }));
    expect(status('Vote one')).toBe('Closed');
    expect(status('Vote two')).toBe('Votes is open');

    port.app = { ...base, memberLanguage: 'es' };
    await screen.rerender(h(LiveSearchScreen));
    expect(status('Vote one')).toBe('Cerrado');
    expect(status('Vote two')).toBe('La votación está abierta');
    expect(port.searchIndex).toHaveBeenCalledTimes(1);
  } finally {
    formatter.mockRestore();
  }
});
