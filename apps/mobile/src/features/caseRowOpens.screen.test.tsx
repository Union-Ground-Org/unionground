import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { caseRowAccessibilityLabel } from '../lib/caseRowLine';
import palette from '../theme/palette.json';

// TEST-UG-PHONE-CASE-ROWS-OPEN-EXECUTED-ON-THE-STAND-IN-20261113 (audit
// G205, the unmet half of): a case row opens its case when pressed, in
// the staff case lists (Casework, Case queue, the steward desk caseload and
// the Work tab) and in the member's My cases,
// on iOS and on Android. The screens run on the shared stand-in; the case
// rows are the real CaseRowPressable and the press reaches the real handler.
// Since  Casework and the Case queue are live screens of their own that
// read the chapter's cases through chapterCaseQueue, and the steward desk's
// own "Your cases" rows (DeskFeature) are pressed too.
const port = vi.hoisted(() => ({
  push: vi.fn(), announce: vi.fn(), chapterCases: vi.fn(), activeCases: vi.fn(), deadlines: vi.fn(), caseload: vi.fn(), context: vi.fn(),
  app: {} as Record<string, unknown>,
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// The form signature pad  on the live Forms screen draws with react-native-svg.
vi.mock('react-native-svg', () => ({ default: () => null, Polyline: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, body, action),
    //: pull to refresh as a plain button, so a test can drive it.
    Screen: ({ children, onRefresh }: { children?: ReactNode; onRefresh?: () => void }) => h('div', null, onRefresh ? h('button', { 'data-pull-refresh': true, onClick: onRefresh }) : null, children) };
});
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({}), useRouter: () => ({ push: port.push, dismissTo: vi.fn() }), useLocalSearchParams: () => ({}), Redirect: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-id' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => null), getSupabaseClient: () => ({}), loadMobileConnectionReadiness: async () => [] }));
vi.mock('../services/chapterCaseQueue', () => ({ loadChapterCases: port.chapterCases, loadChapterActiveCases: port.activeCases, loadChapterCaseDeadlines: port.deadlines }));
vi.mock('../services/governance', async (original) => ({ ...(await original() as typeof import('../services/governance')), loadMobileOfficerRemovalDetails: async () => new Map() }));
vi.mock('../services/nativeCalendarExport', () => ({ isCalendarExportAvailable: () => false }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../services/analyticsPreference', () => ({ gatePageViewRecorder: (fn: unknown) => fn, useProductAnalyticsEnabled: () => false }));
vi.mock('../services/observability', () => ({ captureNativeScreen: vi.fn() }));
vi.mock('../services/ssoRelease', () => ({ useSsoReleased: () => false }));
vi.mock('../lib/announce', async (original) => ({ ...(await original() as typeof import('../lib/announce')), queueAccessibilityAnnouncement: vi.fn(), useAccessibilityAnnouncementQueue: () => port.announce }));
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
import WorkScreen from './WorkScreen';

const live = {
  mode: 'authenticated', session: { user: { id: 'member-a' } }, memberLanguage: 'en', organizationID: 'org-a',
  authorizedRoles: ['member'], chapterRoles: ['member'], organizationRoles: [], staffRoleChoices: [],
  chapterMemberships: [{ chapterID: 'chapter-a', selected: true }],
  captureAuthenticatedSessionGuard: () => () => true,
};
const memberCase = {
  id: 'case-member-1', reference: 'GR-2026-41960', title: 'Overtime assignment out of order', deadline: null,
  caseType: 'Pay', step: 'Step 1', status: 'Active', updatedAt: '2026-11-10T14:00:00Z',
};
const chapterCase = { id: 'case-staff-1', reference: 'GR-2026-81524', title: 'Discipline · Arbitration', status: 'active', meta: 'Updated Nov 10, 2026 · 9:00 AM ET' };

let screen: Rendered | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  port.chapterCases.mockResolvedValue([chapterCase]);
  port.activeCases.mockResolvedValue({ rows: [chapterCase], capped: false });
  port.deadlines.mockResolvedValue([]);
  port.caseload.mockResolvedValue({ rows: [{ id: 'case-desk-1', reference: 'GR-2026-55210', title: 'Shift swap refused', status: 'active' }], total: 1, nextCursor: null });
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each(['ios', 'android'] as const)('a pressed issue row opens its issue on %s', (os) => {
  it.each([['Issue work', 'steward', 'steward'], ['Issue queue', 'coordinator', 'coordinator']] as const)('in the staff %s list', async (_list, featureKey, role) => {
    setPlatform(os);
    port.app = { ...live, authorizedRoles: [role], chapterRoles: [role],
      dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, cases: [] } };
    screen = await render(h(FeatureScreen, { featureKey }));
    // The Case queue reads its active cases once the chapter's list is in.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(port.chapterCases).toHaveBeenCalledWith('chapter-a');
    await press(getExposed(screen.container, caseRowAccessibilityLabel(chapterCase.reference, [chapterCase.status, chapterCase.title, chapterCase.meta])));
    expect(port.push).toHaveBeenCalledTimes(1);
    expect(port.push).toHaveBeenCalledWith('/issue/case-staff-1');
  });

  it('in the committee member desk\'s own "Your issues" list', async () => {
    setPlatform(os);
    port.app = { ...live, mode: 'preview', previewHat: 'steward', previewDesk: null, authorizedRoles: ['steward'], chapterRoles: ['steward'],
      dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, cases: [memberCase], conversations: [] } };
    screen = await render(h(FeatureScreen, { featureKey: 'steward' }));
    await press(getExposed(screen.container, caseRowAccessibilityLabel(memberCase.reference, [memberCase.title, 'Pay · Step 1'])));
    expect(port.push).toHaveBeenCalledTimes(1);
    expect(port.push).toHaveBeenCalledWith('/issue/case-member-1');
  });

  it('in the committee member desk caseload', async () => {
    setPlatform(os);
    port.app = { ...live, authorizedRoles: ['steward'], chapterRoles: ['steward'], chosenStaffRole: 'steward',
      dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, cases: [] } };
    screen = await render(h(FeatureScreen, { featureKey: 'steward-caseload' }));
    await act(async () => { await Promise.resolve(); });
    expect(port.caseload).toHaveBeenCalledWith('member-a', null);
    await press(getExposed(screen.container, caseRowAccessibilityLabel('GR-2026-55210', ['Shift swap refused', 'Active'])));
    expect(port.push).toHaveBeenCalledTimes(1);
    expect(port.push).toHaveBeenCalledWith('/issue/case-desk-1');
  });

  it('in the Work tab issue list', async () => {
    setPlatform(os);
    port.app = { ...live, authorizedRoles: ['steward'], chapterRoles: ['steward'], refreshing: false, refresh: vi.fn(),
      dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, cases: [memberCase] } };
    screen = await render(h(WorkScreen));
    await press(getExposed(screen.container, caseRowAccessibilityLabel(memberCase.reference, [memberCase.status, memberCase.title, 'Pay · Step 1'])));
    expect(port.push).toHaveBeenCalledTimes(1);
    expect(port.push).toHaveBeenCalledWith('/issue/case-member-1');
  });

  //  (M3-5): a failed pull to refresh on the Work tab said nothing while
  // the old list stayed. It now says the list may be out of date, read out
  // through the announcement queue; another failure keeps its own words.
  it('says the Work tab list may be out of date after a pull to refresh fails', async () => {
    setPlatform(os);
    const line = 'Some workspace records may be out of date. Refresh to recheck them.';
    const dashboard = { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, cases: [memberCase] };
    const refresh = vi.fn(async () => { port.app = { ...port.app, error: 'Your worker workspace could not be loaded securely. Check your connection and try again.' }; });
    port.app = { ...live, refreshing: false, refresh, error: null, dashboard };
    screen = await render(h(WorkScreen));
    expect(screen.container.textContent).not.toContain(line);
    await act(async () => { (screen!.container.querySelector('[data-pull-refresh]') as HTMLElement).click(); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await screen.rerender(h(WorkScreen));
    expect(screen.container.textContent).toContain(line);
    expect(port.announce).toHaveBeenCalledWith(line);
    port.app = { ...port.app, error: 'The demo is unavailable. Try again.' };
    await screen.rerender(h(WorkScreen));
    expect(screen.container.textContent).toContain('The demo is unavailable. Try again.');
    expect(screen.container.textContent).not.toContain(line);
    port.app = { ...port.app, error: null };
    await screen.rerender(h(WorkScreen));
    expect(screen.container.textContent).not.toContain('The demo is unavailable');
  });

  // The Work tab shows any other failure through
  // the catalogue, and AppProvider's demo sentence had no Spanish entry, so a
  // Spanish reader saw it in English.
  it('says the demo failure in Spanish on the Work tab for a Spanish reader', async () => {
    setPlatform(os);
    const dashboard = { member: { id: 'member-a', chapterID: 'chapter-a', language: 'es' }, cases: [memberCase] };
    port.app = { ...live, memberLanguage: 'es', refreshing: false, refresh: vi.fn(), error: 'The demo is unavailable. Try again.', dashboard };
    screen = await render(h(WorkScreen));
    const spanish = 'La demostración no está disponible. Vuelva a intentarlo.';
    expect(screen.container.textContent).toContain(spanish);
    expect(screen.container.textContent).not.toContain('The demo is unavailable');
    expect(port.announce).toHaveBeenCalledWith(spanish);
  });

  it('in the worker My issues list', async () => {
    setPlatform(os);
    port.app = { ...live, dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, cases: [memberCase] } };
    screen = await render(h(FeatureScreen, { featureKey: 'cases' }));
    await press(getExposed(screen.container, caseRowAccessibilityLabel(memberCase.reference, [memberCase.title, 'Pay · Step 1'])));
    expect(port.push).toHaveBeenCalledTimes(1);
    expect(port.push).toHaveBeenCalledWith('/issue/case-member-1');
  });
});
