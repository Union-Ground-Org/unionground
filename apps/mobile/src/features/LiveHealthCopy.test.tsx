import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { BUSINESS_SAVED_STALE } from '../lib/businessWriteContinuation';
import { syncResumeDraftContext } from '../lib/resumeDraftHolder';
import type { MobileHealthChapter } from '../services/supabase';
import palette from '../theme/palette.json';

// Import the real component normally; native hosts and unrelated feature
// modules are ports. No runtime compilation or dynamic code execution.
const port = vi.hoisted(() => ({
  chapters: [] as MobileHealthChapter[], person: 'member-a', homeChapter: 'chapter-a',
  role: 'admin' as 'admin' | 'advisor' | 'vp',
}));
type Children = React.PropsWithChildren;
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// The form signature pad (#8699) on the live Forms screen draws with react-native-svg.
vi.mock('react-native-svg', () => ({ default: () => null, Polyline: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-id' }));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined, useIsFocused: () => true, useNavigation: () => ({}), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
// The provider syncs the draft holder on every render; the coaching and
// measurement editors hold their typed work there (#9240 pull request C).
vi.mock('../state/AppProvider', async () => {
  const { syncResumeDraftContext } = await import('../lib/resumeDraftHolder');
  return { useApp: () => {
    const app = { mode: 'authenticated', session: { user: { id: port.person }, access_token: 'test-session' }, organizationID: 'org-a',
      dashboard: { member: { chapterID: port.homeChapter } }, chapterMemberships: [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }],
      authorizedRoles: [port.role], chapterRoles: [port.role], organizationRoles: [], chosenStaffRole: port.role, staffRoleChoices: [port.role],
      resumeDraftReads: { dashboard: true, memberships: true, staff: true } };
    syncResumeDraftContext(app);
    return app;
  } };
});
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => null, session?.user?.id ?? 'member-a'),
  recordMobileFeaturePageView: vi.fn(),
  loadMobileHealthPortfolio: vi.fn(async () => port.chapters.map((entry) => ({ ...entry }))),
  addMobileHealthCoaching: vi.fn(async () => undefined),
}));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn() } }));
vi.mock('../services/analyticsPreference', () => ({ gatePageViewRecorder: (fn: unknown) => fn, useProductAnalyticsEnabled: () => false }));
vi.mock('../services/observability', () => ({ captureNativeScreen: vi.fn() }));
vi.mock('../services/ssoRelease', () => ({ useSsoReleased: () => false }));
vi.mock('../services/governance', () => ({}));
vi.mock('../data/useChannels', () => ({}));
vi.mock('../components/ui', async () => {
  const React = await import('react');
  const { View, Text, Pressable } = await import('../testing/reactNativeStandIn');
  const block = ({ children }: Children) => React.createElement(View, null, children);
  return {
  Screen: block, Card: block,
  Heading: ({ children }: Children) => React.createElement(Text, { accessibilityRole: 'header' }, children),
  Body: ({ children }: Children) => React.createElement(Text, null, children),
  StateMessage: ({ title, body }: { title: string; body?: string }) => React.createElement(View, null, React.createElement(Text, null, title), body ? React.createElement(Text, null, body) : null),
  Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => React.createElement(Pressable, { accessibilityLabel: label, onPress, disabled }, React.createElement(Text, null, label)),
};
});
vi.mock('../components/AskCompassButton', () => ({}));
vi.mock('../components/TransactionalAction', () => ({}));
vi.mock('../components/CaseRowPressable', () => ({}));
vi.mock('../components/PressableScale', () => ({}));
vi.mock('../components/ChapterVerificationControls', () => ({}));
vi.mock('../components/NumberFlow', () => ({}));
vi.mock('./LiveAppointmentsFeature', () => ({}));
vi.mock('./LiveLivedInScreens', () => ({}));
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
vi.mock('../components/StaffRolePicker', () => ({}));
vi.mock('./guideLayers/GuideLayers', () => ({}));
vi.mock('./StewardDeskSectionsScreen', () => ({}));

import { FeatureScreen, LiveHealthFeature } from './FeatureScreen';
import { addMobileHealthCoaching, loadMobileHealthPortfolio } from '../services/supabase';
import { haptics } from '../services/haptics';
function component(chapter: MobileHealthChapter) {
  port.chapters.splice(0, port.chapters.length, chapter);
  return LiveHealthFeature;
}
const chapter = (fields: Partial<MobileHealthChapter> = {}): MobileHealthChapter => ({
  chapterId: 'chapter-a', chapterName: 'Quillmere campaign', databaseDate: '2026-11-11',
  measuredOn: null, cohortProtected: true, memberCount: null, score: null,
  drivers: null, trend: [], coaching: [], ...fields,
});
let screen: Rendered | null = null;
// Held editor work lives in the module-level draft holder: no test inherits another's.
afterEach(async () => {
  await screen?.unmount(); screen = null;
  port.person = 'member-a'; port.homeChapter = 'chapter-a'; port.role = 'admin';
  setPlatform('ios'); syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
});

it.each<['advisor' | 'vp', string, string[]]>([
  ['advisor', 'chapter-a', ['Service Coordination', 'Transportation & Facilities', 'Alder Falls Residential']],
  ['vp', 'chapter-b', ['Alder Falls Residential', 'Transportation & Facilities', 'Service Coordination']],
  ['advisor', 'unavailable', ['Transportation & Facilities', 'Service Coordination', 'Alder Falls Residential']],
])('orders the authorized %s portfolio for home campaign %s', async (role, home, expected) => {
  port.role = role;
  port.homeChapter = home;
  port.chapters = [
    chapter({ chapterId: 'transport', chapterName: 'Transportation & Facilities' }),
    chapter({ chapterId: 'chapter-a', chapterName: 'Service Coordination' }),
    chapter({ chapterId: 'chapter-b', chapterName: 'Alder Falls Residential' }),
  ];
  screen = await render(React.createElement(FeatureScreen, { featureKey: role }));
  const names = Array.from(screen.container.querySelectorAll('[role="heading"]'), (heading) => heading.textContent);
  expect(names.filter((name) => port.chapters.some((item) => item.chapterName === name))).toEqual(expected);
});

it('keeps portfolio triage order on the Health portfolio destination', async () => {
  port.role = 'advisor';
  port.chapters = [
    chapter({ chapterId: 'transport', chapterName: 'Transportation & Facilities' }),
    chapter({ chapterId: 'chapter-a', chapterName: 'Service Coordination' }),
  ];
  screen = await render(React.createElement(FeatureScreen, { featureKey: 'chapter-health' }));
  const names = Array.from(screen.container.querySelectorAll('[role="heading"]'), (heading) => heading.textContent);
  expect(names.filter((name) => port.chapters.some((item) => item.chapterName === name))).toEqual([
    'Transportation & Facilities', 'Service Coordination',
  ]);
});

describe.each(['ios', 'android'] as const)('chapter-health wording on %s', (os) => {
  it('loads the new person’s bucket when the retained screen stays in the same campaign', async () => {
    setPlatform(os); vi.mocked(loadMobileHealthPortfolio).mockClear();
    screen = await render(React.createElement(component(chapter({ chapterName: 'First portfolio' })), { title: 'Campaign health' }));
    expect(vi.mocked(loadMobileHealthPortfolio)).toHaveBeenCalledTimes(1);
    port.person = 'member-b'; port.chapters.splice(0, port.chapters.length, chapter({ chapterName: 'Second portfolio' }));
    await screen.rerender(React.createElement(LiveHealthFeature, { title: 'Campaign health' }));
    expect(vi.mocked(loadMobileHealthPortfolio)).toHaveBeenCalledTimes(2);
    expect(screen.container.textContent).toContain('Second portfolio');
    expect(screen.container.textContent).not.toContain('First portfolio');
  });

  it('distinguishes no recorded measurement from privacy protection and offers the existing next action', async () => {
    setPlatform(os); screen = await render(React.createElement(component(chapter()), { title: 'Campaign health' }));
    expect(screen.container.textContent).not.toMatch(/six-driver|cohort/i);
    expect(screen.container.textContent).toContain("Scores and comparisons stay hidden when a group does not meet the organization's privacy minimum.");
    expect(screen.container.textContent).toContain('No measurement recorded');
    expect(screen.container.textContent).not.toContain('Hidden for a small group');
    expect(screen.container.textContent).not.toContain('out of 100');
    await press(getExposed(screen.container, 'Record snapshot'));
    getExposed(screen.container, 'Measured date, year month day');
  });
  it('explains a withheld measured score without inventing a number or removing coaching', async () => {
    setPlatform(os); screen = await render(React.createElement(component(chapter({ measuredOn: '2026-11-10' })), { title: 'Campaign health' }));
    expect(screen.container.textContent).toContain('Nov 10, 2026');
    expect(screen.container.textContent).toContain('Hidden for a small group');
    expect(screen.container.textContent).toContain("Scores are hidden because this group does not meet the organization's privacy minimum.");
    expect(screen.container.textContent).not.toContain('fewer than ten');
    expect(screen.container.textContent).not.toContain('No measurement recorded');
    expect(screen.container.textContent).not.toContain('out of 100');
    await press(getExposed(screen.container, 'Add coaching entry'));
    getExposed(screen.container, 'Coaching summary');
  });

  it('distinguishes an unreadable measurement day from an absent measurement', async () => {
    setPlatform(os);
    screen = await render(React.createElement(component(chapter({ measuredOn: '2026-02-30' })), { title: 'Campaign health' }));
    expect(screen.container.textContent).toContain('Date unavailable');
    expect(screen.container.textContent).not.toContain('No measurement recorded');
  });
  // Ledger 690 and 691 (stage 511 on #9429): the reread after a saved entry
  // reports whether it loaded, and only a loaded reread confirms the save with
  // the success haptic; a failed one says the change was saved but not shown.
  async function saveCoachingEntry() {
    await press(getExposed(screen!.container, 'Add coaching entry'));
    await type(getExposed(screen!.container, 'Coaching summary'), 'Weekly committee member check-in held');
    await press(getExposed(screen!.container, 'Save coaching entry'));
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  it('confirms a saved coaching entry with the success haptic once the reread loads', async () => {
    setPlatform(os); screen = await render(React.createElement(component(chapter()), { title: 'Campaign health' }));
    vi.mocked(haptics.success).mockClear(); vi.mocked(addMobileHealthCoaching).mockClear();
    await saveCoachingEntry();
    expect(vi.mocked(addMobileHealthCoaching)).toHaveBeenCalledOnce();
    expect(screen.container.textContent).toContain('The change was saved.');
    expect(screen.container.textContent).not.toContain(BUSINESS_SAVED_STALE);
    expect(vi.mocked(haptics.success)).toHaveBeenCalledOnce();
  });
  it('says a saved coaching entry is not shown yet, with no success haptic, when the reread fails', async () => {
    setPlatform(os); screen = await render(React.createElement(component(chapter()), { title: 'Campaign health' }));
    vi.mocked(haptics.success).mockClear();
    vi.mocked(loadMobileHealthPortfolio).mockRejectedValueOnce(new Error('offline'));
    await saveCoachingEntry();
    expect(screen.container.textContent).toContain(BUSINESS_SAVED_STALE);
    expect(screen.container.textContent).toContain('Campaign health could not be refreshed through your leadership scope.');
    expect(vi.mocked(haptics.success)).not.toHaveBeenCalled();
    getExposed(screen.container, 'Refresh');
  });
  it('preserves measured score scales, dates and the six observed measures', async () => {
    setPlatform(os); screen = await render(React.createElement(component(chapter({ measuredOn: '2026-11-10', cohortProtected: false, memberCount: 50, score: 72,
      drivers: { participation: 90, caseTimeliness: 80, stewardCapacity: 70, trainingCoverage: 60, communicationReach: 50, governanceReadiness: 40 },
    })), { title: 'Campaign health' }));
    getExposed(screen.container, 'Overall score 72 out of 100');
    expect(screen.container.textContent).toContain('Issue response times');
    expect(screen.container.textContent).toContain('Campaign planning');
    expect(screen.container.textContent).toContain('Nov 10, 2026');
    getExposed(screen.container, 'Correct latest snapshot');
    expect(screen.container.textContent).not.toContain('Hidden for a small group');
  });
});
