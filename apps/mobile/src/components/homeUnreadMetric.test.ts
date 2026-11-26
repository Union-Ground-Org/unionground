// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/pulseOpeningPreference', () => ({
  loadPulseOpening: async () => ({ opening: 'week', setupComplete: true }),
  savePulseOpening: async () => ({ opening: 'week', setupComplete: true }),
}));
import type { DemoChannel } from '../data/demoChannels';
import type { WhatMattersStatus } from '../features/home/WhatMattersNow';
import type { StaffDeskNumbersState } from '../features/home/useStaffDeskNumbers';
import { liveStaffDeskEyebrow, type HatKey, type LiveStaffRole } from '../lib/hatFunctions';
import type { HomeTakeover } from '../lib/memberHomeShared';
import type { WhatMattersItem } from '../lib/whatMattersShared';
import type { MemberCase, MemberDashboard } from '../models/member';
import { useSharedDemoVisit } from '../state/useSharedDemoVisit';
import { resolveTheme } from '../theme/tokens';
import HomeScreen from '../../app/(tabs)/home';

const DemoVisitFixture = createContext<ReturnType<typeof useSharedDemoVisit>>(null);

type WhatMattersFixture = {
  enabled: boolean;
  item: WhatMattersItem | null;
  status: WhatMattersStatus;
  retry: () => void;
  now: Date;
};

const fixture = vi.hoisted(() => ({
  dashboard: null as MemberDashboard | null,
  channels: [] as DemoChannel[],
  theme: 'union-ground' as 'union-ground' | 'union-ground-dark',
  push: vi.fn(),
  select: vi.fn(),
  welcome: false,
  session: null as { user: { id: string }; access_token?: string } | null,
  authorizedRoles: [] as LiveStaffRole[],
  chapterRoles: null as LiveStaffRole[] | null,
  whatMatters: {} as WhatMattersFixture,
  liveRanking: false,
  notices: vi.fn(),
  surveys: vi.fn(),
  deskNumbers: null as StaffDeskNumbersState | null,
  error: null as string | null,
  takeover: vi.fn(),
  markBroadcastRead: vi.fn(),
  sampleHat: null as HatKey | null,
  greetingShown: false,
  greetingListener: null as null | ((greeting: 'welcome' | 'welcome-back') => void),
  windowWidth: 390,
  fontScale: 1,
  recruitedYtd: null as number | null,
}));

// Render the shipped screen and metric; only native hosts and unrelated
// features are replaced. Clicks exercise the screen's actual route callback.
vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('react-native', () => ({
  Platform: { select: (options: { ios: string }) => options.ios },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  // The pressable keeps its resolved width so the summary reflow test can see it.
  Pressable: ({ children, accessibilityLabel, onPress, style }: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode); accessibilityLabel?: string; onPress?: () => void;
    style?: ((state: { pressed: boolean }) => readonly unknown[]) | readonly unknown[];
  }) => {
    const entries: readonly unknown[] = typeof style === 'function' ? style({ pressed: false }) : style ?? [];
    let width: string | undefined;
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && 'width' in entry && typeof entry.width === 'string') width = entry.width;
    }
    return createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress, 'data-width': width },
      typeof children === 'function' ? children({ pressed: false }) : children);
  },
  useWindowDimensions: () => ({ width: fixture.windowWidth, height: 844, fontScale: fixture.fontScale, scale: 3 }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: fixture.push }), useIsFocused: () => true }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  mode: 'authenticated', dashboard: fixture.dashboard, chapterMemberships: [], session: fixture.session,
  authorizedRoles: fixture.authorizedRoles, chapterRoles: fixture.chapterRoles ?? fixture.authorizedRoles, chosenStaffRole: null, error: fixture.error,
  sampleHat: fixture.sampleHat, sharedDemoVisit: useContext(DemoVisitFixture),
  captureAuthenticatedSessionGuard: () => () => true, refresh: async () => undefined,
}) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground', fixture.theme === 'union-ground-dark') }));
vi.mock('../features/SavedPulseCharts', () => ({ SavedPulseProvider: ({ children }: { children?: ReactNode }) => children, SavedChartSlot: () => null }));
vi.mock('../services/haptics', () => ({ haptics: { select: fixture.select, success: async () => undefined } }));
// The greeting marker lives in expo-secure-store, which needs the native runtime; its own suite covers it.
vi.mock('../services/homeGreeting', () => ({
  readHomeGreeting: async () => 'welcome-back',
  homeGreetingText: (greeting: 'welcome' | 'welcome-back') => (greeting === 'welcome' ? 'Welcome' : 'Welcome back'),
  homeGreetingShown: () => fixture.greetingShown,
  subscribeHomeGreeting: (_userID: string, listener: (greeting: 'welcome' | 'welcome-back') => void) => {
    fixture.greetingListener = listener;
    return () => { fixture.greetingListener = null; };
  },
}));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({
  channels: () => fixture.channels, subscribe: () => () => {}, getVersion: () => 0,
}) }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0, syncHomeHandleRowTop: () => undefined, claimHomeHandleRow: () => () => undefined }));
vi.mock('../components/HomeCarousel', () => ({ HomeCarousel: ({ children }: { children?: ReactNode }) => children }));
vi.mock('../components/NumberFlow', () => ({
  NumberFlow: ({ value, decorative }: { value: string; decorative?: boolean }) =>
    createElement('span', { 'aria-hidden': decorative }, value),
}));
vi.mock('../components/ui', () => {
  const Host = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  // Body keeps the accessible and line-box props it was given so the greeting test can see them.
  const Body = ({ children, accessible, numberOfLines, adjustsFontSizeToFit }: { children?: ReactNode; accessible?: boolean; numberOfLines?: number; adjustsFontSizeToFit?: boolean }) =>
    createElement('div', {
      ...(accessible === undefined ? {} : { 'data-accessible': String(accessible) }),
      ...(numberOfLines === undefined ? {} : { 'data-lines': String(numberOfLines) }),
      ...(adjustsFontSizeToFit ? { 'data-fit': 'true' } : {}),
    }, children);
  const Button = ({ label, onPress }: { label: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, label);
  return { Body, Button, Card: Host, Heading: Host, Notice: Host, Screen: Host, StateMessage: Host };
});
vi.mock('../components/ChapterRail', () => ({ ChapterRail: () => null }));
vi.mock('../features/StewardFinderSheet', () => ({ StewardFinderSheet: () => null }));
vi.mock('../features/home/HomeNudge', () => ({ HomeNudge: () => null }));
vi.mock('../features/NativeLearningPeriod', () => ({ NativeLearningPeriodBanner: () => null }));
vi.mock('../features/learning/LearningHomeCard', () => ({ LearningHomeCard: () => null }));
vi.mock('../services/memberHome', () => ({
  loadMemberHomeTakeover: fixture.takeover,
  markMemberBroadcastRead: fixture.markBroadcastRead,
}));
vi.mock('../services/supabase', () => ({ captureSessionWriter: vi.fn(), markConversationRead: vi.fn() }));
vi.mock('../features/IssueSignalHomeCard', () => ({ IssueSignalHomeCard: () => null }));
vi.mock('../features/LegalAcceptanceCard', () => ({ LegalAcceptanceCard: () => null }));
vi.mock('../components/StaffTwoStepNotice', () => ({ StaffTwoStepNotice: () => null }));
vi.mock('../features/home/useStaffDeskNumbers', () => ({ useStaffDeskNumbers: () => fixture.deskNumbers }));
vi.mock('../features/home/useMemberRecruitedCount', () => ({ useMemberRecruitedCount: () => fixture.recruitedYtd }));
vi.mock('../lib/useEasternCalendarDay', () => ({ useEasternCalendarDay: () => fixture.whatMatters.now }));
vi.mock('../services/memberHomeAttention', () => ({
  loadWhatMattersSwitch: async () => true,
  loadWhatMattersBallots: async () => [],
  loadWhatMattersEvents: async () => [],
  loadWhatMattersTasks: async () => [],
  loadWhatMattersNotices: fixture.notices,
  loadWhatMattersSurveys: fixture.surveys,
}));
vi.mock('../features/home/WhatMattersNow', async (original) => {
  const actual: typeof import('../features/home/WhatMattersNow') = await original();
  return {
    ...actual,
    useWhatMattersNow: (options: Parameters<typeof actual.useWhatMattersNow>[0]) => {
      const whatMatters = actual.useWhatMattersNow(options);
      return fixture.liveRanking ? whatMatters : { ...fixture.whatMatters, rank: () => fixture.whatMatters };
    },
  };
});
vi.mock('../features/home/NavUsage', () => ({ MostUsedRow: () => null, useNativeNavUsage: () => ({ enabled: false }) }));
vi.mock('../features/home/WelcomeBack', () => ({
  WelcomeBackView: () => createElement('p', { 'data-testid': 'welcome-back' }, 'Welcome back view'),
  useNativeWelcomeBack: () => ({ show: fixture.welcome, decided: true, dismiss: () => undefined }),
}));
// BUG-UG-NATIVE-HOME-HIDES-ONBOARDING-GUIDE-20261018: Home reads the
// onboarding guide; the real hook touches SecureStore, which has no host here.
vi.mock('../features/onboardingGuide/useOnboardingGuide', () => ({ useOnboardingGuide: () => ({ guide: { applies: false }, showAll: false, setShowAll: () => undefined }) }));
vi.mock('../features/home/ChoosePasswordNudge', () => ({ ChoosePasswordNudge: () => null }));

let root: Root;
let container: HTMLDivElement;
function HomeWithDemoVisit({ showHome = true }: { showHome?: boolean }) {
  const visit = useSharedDemoVisit('authenticated', fixture.session?.user.id, fixture.sampleHat);
  return createElement(DemoVisitFixture.Provider, { value: visit }, showHome ? createElement(HomeScreen) : null);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.push.mockReset();
  fixture.select.mockReset();
  fixture.channels = [];
  fixture.session = null;
  fixture.authorizedRoles = [];
  fixture.chapterRoles = null;
  fixture.deskNumbers = null;
  fixture.error = null;
  fixture.whatMatters = {
    enabled: false, now: new Date('2026-11-24T12:00:00Z'),
    status: 'ready', item: { kind: 'caught_up', urgency: 'calm', action: null }, retry: vi.fn(),
  };
  fixture.liveRanking = false;
  fixture.notices.mockReset().mockResolvedValue([]);
  fixture.surveys.mockReset().mockResolvedValue([]);
  fixture.takeover.mockReset();
  fixture.markBroadcastRead.mockReset().mockResolvedValue(undefined);
  fixture.sampleHat = null;
  fixture.greetingShown = false;
  fixture.greetingListener = null;
  fixture.windowWidth = 390;
  fixture.fontScale = 1;
  fixture.recruitedYtd = null;
  fixture.dashboard = {
    member: { id: 'member', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Worker', memberSince: 2022, chapterID: null, language: 'en' },
    cases: [], weeklyActions: [], notifications: [], conversations: [],
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Home work cards follow the role in use', () => {
  const takeover: HomeTakeover = {
    enabled: true,
    message: { id: 'm1', conversationId: 'c1', senderName: 'Avery', body: 'Personal committee member message', truncated: false, createdAt: '2026-11-23T12:00:00Z' },
    broadcast: { id: 'b1', title: 'Campaign announcement', body: 'Campaign update', sender: null, truncated: false, publishedAt: '2026-11-23T12:00:00Z', audience: 'chapter' },
  };
  const ownCase: MemberCase = {
    id: 'my-overtime', reference: 'GR-1', title: 'My overtime issue', caseType: 'Grievance',
    step: 'Intake', status: 'active', deadline: '2026-11-25', updatedAt: '2026-11-22T12:00:00Z',
  };
  const roles: LiveStaffRole[] = ['steward', 'coordinator', 'advisor', 'admin', 'vp'];
  const renderUpdates = async (updates = takeover) => {
    fixture.session = { user: { id: 'member' }, access_token: 'fixture-token' };
    fixture.takeover.mockResolvedValue(updates);
    await act(async () => { root.render(createElement(HomeWithDemoVisit)); });
  };
  const membershipSection = () => Array.from(container.querySelectorAll('div'))
    .find((element) => element.textContent === 'Your own membership')?.parentElement;

  it.each(roles)('puts the %s desk first and keeps the personal committee member message below it', async (role) => {
    fixture.authorizedRoles = [role];
    await renderUpdates();

    const content = container.textContent ?? '';
    const desk = liveStaffDeskEyebrow(role);
    expect(content).toContain(desk);
    expect(content).toContain('Campaign announcement');
    expect(membershipSection()?.textContent).toContain('Personal committee member message');
    expect(membershipSection()?.previousElementSibling?.textContent).toContain('Open issues');
    expect(content.indexOf(desk)).toBeLessThan(content.indexOf('Personal committee member message'));
    expect(content.indexOf('Personal committee member message')).toBeLessThan(content.indexOf('Campaign announcement'));
    expect(content).not.toContain('Next up');
    expect(fixture.takeover).toHaveBeenCalledTimes(1);
  });

  const withoutActiveStaffRole: Array<{ account: string; roles: LiveStaffRole[] }> = [
    { account: 'a worker', roles: [] },
    { account: 'a multi-role account before role selection', roles: ['steward', 'coordinator'] },
  ];
  it.each(withoutActiveStaffRole)('shows worker cards for $account', async ({ roles }) => {
    fixture.authorizedRoles = roles;
    await renderUpdates();

    expect(container.textContent).toContain('Personal committee member message');
    expect(container.textContent).toContain('Campaign announcement');
    expect(container.textContent).toContain('Next up');
    expect(container.textContent).not.toContain('COMMITTEE DESK');
  });

  it('keeps an ordinary worker’s issue in the existing Next up slot', async () => {
    fixture.dashboard!.cases = [ownCase];
    await renderUpdates();

    expect(container.textContent).toContain('Next up');
    expect(container.textContent).toContain('My overtime issue');
    expect(container.textContent).not.toContain('Your own membership');
    expect(container.textContent).toContain('Personal committee member message');
  });

  it('keeps worker Home when an active Committee has no campaign scope for the desk', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.chapterRoles = [];
    fixture.dashboard!.cases = [ownCase];
    await renderUpdates();

    expect(container.textContent).toContain('Personal committee member message');
    expect(container.textContent).toContain('Next up');
    expect(container.textContent).not.toContain('Your own membership');
    expect(container.textContent).not.toContain('COMMITTEE DESK');
  });

  it('opens the Committee’s own conversation from the message-only membership section', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.whatMatters.enabled = true;
    fixture.deskNumbers = { status: 'ready', numbers: [{ label: 'Open requests', value: 2 }] };
    await renderUpdates();

    expect(container.textContent).not.toContain('Nothing needs your attention right now.');
    expect(container.textContent).toContain('Open requests');
    expect(container.textContent).not.toContain('Unread messages');
    expect(container.textContent?.match(/Personal committee member message/g)).toHaveLength(1);
    const open = Array.from(membershipSection()?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent === 'Open conversation');
    expect(open).toBeDefined();
    act(() => open?.click());
    expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/conversation/c1');
  });

  it('keeps the refresh notice and failed desk numbers above an urgent membership section', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.error = 'Fixture refresh failure';
    fixture.deskNumbers = { status: 'failed', numbers: [{ label: 'Open requests', value: null }] };
    await renderUpdates();

    const content = container.textContent ?? '';
    const labels = [
      'COMMITTEE DESK', 'We couldn’t refresh your workspace.', 'Open requests',
      'Your desk numbers could not load.', 'Your own membership',
    ];
    for (const label of labels) expect(content).toContain(label);
    expect(labels.map((label) => content.indexOf(label))).toEqual(
      labels.map((label) => content.indexOf(label)).sort((left, right) => left - right),
    );
    expect(membershipSection()?.previousElementSibling?.textContent).toContain('Your desk numbers could not load.');
  });

  it('keeps a committee member’s own alerts and My issues reachable below the desk', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.whatMatters.enabled = true;
    fixture.dashboard!.cases = [
      ownCase,
      { ...ownCase, id: 'my-second', reference: 'GR-2', title: 'My second issue' },
    ];
    await renderUpdates({ ...takeover, message: null });

    const content = container.textContent ?? '';
    const personalSection = membershipSection();
    expect(personalSection).toBeDefined();
    expect(content.indexOf('COMMITTEE DESK')).toBeLessThan(content.indexOf('Your own membership'));
    expect(content.indexOf('Your own membership')).toBeLessThan(content.indexOf('Campaign announcement'));
    expect(content).not.toContain('Nothing needs your attention right now.');
    expect(personalSection?.textContent).toContain('My overtime issue');
    const myCases = Array.from(personalSection?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent === 'My issues');
    expect(myCases).toBeDefined();
    act(() => myCases?.click());
    expect(fixture.push.mock.calls).toEqual([['/feature/cases']]);
  });

  it('uses the Next up issue under the personal heading when What Matters is off', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.dashboard!.cases = [ownCase];
    await renderUpdates({ ...takeover, message: null });

    const content = container.textContent ?? '';
    expect(content.indexOf('Your own membership')).toBeLessThan(content.indexOf('Campaign announcement'));
    expect(membershipSection()?.textContent).toContain('My overtime issue');
    expect(membershipSection()?.textContent).toContain('Due Nov 25');
    expect(membershipSection()?.textContent).not.toContain('Contact the committee');
  });

  it('keeps an active undated personal issue below shared cards without saying caught up', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.whatMatters.enabled = true;
    fixture.dashboard!.cases = [{ ...ownCase, deadline: null }];
    await renderUpdates({ ...takeover, message: null });

    const content = container.textContent ?? '';
    expect(content).not.toContain('Nothing needs your attention right now.');
    expect(content.indexOf('Campaign announcement')).toBeLessThan(content.indexOf('Your own membership'));
    expect(membershipSection()?.textContent).toContain('Review issue');
  });

  it.each([
    { rankedID: 'b1', title: 'Campaign announcement' },
    { rankedID: 'b2', title: 'Other announcement' },
  ])('shows $title once when the ranked broadcast is $rankedID', async ({ rankedID, title }) => {
    fixture.authorizedRoles = ['steward'];
    fixture.whatMatters.enabled = true;
    fixture.whatMatters.item = { kind: 'unread_notice', urgency: 'info', notice: { id: rankedID, title }, unread: 1, action: { kind: 'open_notices' } };
    fixture.dashboard!.cases = [{ ...ownCase, deadline: null }];
    await renderUpdates({ ...takeover, message: null });

    const content = container.textContent ?? '';
    expect(content).toContain('Campaign announcement');
    expect(content.split(title)).toHaveLength(2);
  });

  async function renderRankedBroadcast(demo: boolean) {
    fixture.authorizedRoles = ['steward'];
    fixture.sampleHat = demo ? 'steward' : null;
    fixture.liveRanking = true;
    fixture.dashboard!.cases = [{ ...ownCase, deadline: null }];
    await renderUpdates({ ...takeover, message: null });
  }

  async function markBroadcastRead() {
    const announcement = Array.from(container.querySelectorAll('div'))
      .find((element) => element.textContent === 'Campaign announcement')?.parentElement;
    const markRead = Array.from(announcement?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent === 'Mark read');
    expect(markRead).toBeDefined();
    await act(async () => { markRead?.click(); });
  }

  it.each(['ordinary', 'shared demo'])('ranks the next unread announcement after Mark read (%s account)', async (account) => {
    fixture.notices.mockResolvedValue([
      { id: 'b1', title: 'Campaign announcement', unread: true },
      { id: 'b2', title: 'Second fixture notice', unread: true },
    ]);
    await renderRankedBroadcast(account === 'shared demo');
    expect(container.textContent?.split('Campaign announcement')).toHaveLength(2);
    await markBroadcastRead();
    if (account === 'shared demo') expect(fixture.markBroadcastRead).not.toHaveBeenCalled();
    else expect(fixture.markBroadcastRead).toHaveBeenCalledExactlyOnceWith('member', 'b1');
    expect(container.textContent).not.toContain('Campaign announcement');
    expect(container.textContent).toContain('Second fixture notice');
    expect(fixture.notices).toHaveBeenCalledTimes(1);

    if (account === 'shared demo') {
      await act(async () => { root.render(createElement(HomeWithDemoVisit, { showHome: false })); });
      await act(async () => { root.render(createElement(HomeWithDemoVisit)); });
      expect(fixture.takeover).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toContain('Campaign announcement');
      expect(container.textContent).toContain('Second fixture notice');
      expect(fixture.markBroadcastRead).not.toHaveBeenCalled();
    }
  });

  it('restores the ranked section and shows the next action when its input recovers', async () => {
    fixture.notices.mockResolvedValue([{ id: 'b1', title: 'Campaign announcement', unread: true }]);
    fixture.surveys.mockRejectedValueOnce(new Error('Fixture survey read failed'));
    await renderRankedBroadcast(true);
    await markBroadcastRead();

    expect(container.textContent).not.toContain('Campaign announcement');
    expect(container.textContent).toContain('Could not check what needs your attention');
    expect(container.textContent).not.toContain('Nothing else needs your attention right now.');
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    fixture.surveys.mockResolvedValue([{ id: 's1', title: 'Fixture worker survey', closesAt: null, answered: false }]);
    await act(async () => { retry?.click(); });
    expect(container.textContent).toContain('Fixture worker survey');
    expect(container.textContent).not.toContain('Campaign announcement');
    expect(fixture.markBroadcastRead).not.toHaveBeenCalled();
  });

  const demoHomeWithoutOwnCase: Array<{ hat: HatKey; roles: LiveStaffRole[] }> = [
    { hat: 'member', roles: [] },
    { hat: 'steward', roles: ['steward'] },
  ];

  it.each(demoHomeWithoutOwnCase)('reranks after a shared demo $hat marks read without an own issue', async ({ hat, roles }) => {
    fixture.authorizedRoles = roles;
    fixture.sampleHat = hat;
    fixture.liveRanking = true;
    fixture.notices.mockResolvedValue([
      { id: 'b1', title: 'Campaign announcement', unread: true },
      { id: 'b2', title: 'Second fixture notice', unread: true },
    ]);
    await renderUpdates({ ...takeover, message: null });
    expect(container.textContent?.includes('COMMITTEE DESK')).toBe(roles.includes('steward'));
    expect(membershipSection()).toBeUndefined();
    await markBroadcastRead();

    expect(container.textContent).not.toContain('Campaign announcement');
    expect(container.textContent).toContain('Second fixture notice');
    expect(fixture.notices).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(createElement(HomeWithDemoVisit, { showHome: false })); });
    await act(async () => { root.render(createElement(HomeWithDemoVisit)); });
    expect(container.textContent).not.toContain('Campaign announcement');
    expect(container.textContent).toContain('Second fixture notice');
    expect(fixture.markBroadcastRead).not.toHaveBeenCalled();
  });

  it.each(demoHomeWithoutOwnCase)('reranks an ordinary $hat immediately after the read receipt is sent', async ({ roles }) => {
    fixture.authorizedRoles = roles;
    fixture.liveRanking = true;
    fixture.notices.mockResolvedValue([
      { id: 'b1', title: 'Campaign announcement', unread: true },
      { id: 'b2', title: 'Second fixture notice', unread: true },
    ]);
    await renderUpdates({ ...takeover, message: null });
    await markBroadcastRead();

    expect(fixture.markBroadcastRead).toHaveBeenCalledExactlyOnceWith('member', 'b1');
    expect(container.textContent).not.toContain('Campaign announcement');
    expect(container.textContent).toContain('Second fixture notice');
    expect(fixture.notices).toHaveBeenCalledTimes(1);
  });

  it('does not carry a read mark into another account while Home stays mounted', async () => {
    fixture.liveRanking = true;
    fixture.notices.mockResolvedValue([{ id: 'b1', title: 'Campaign announcement', unread: true }]);
    await renderUpdates({ ...takeover, message: null });
    await markBroadcastRead();

    fixture.session = { user: { id: 'next-member' }, access_token: 'next-fixture-token' };
    fixture.dashboard!.member = { ...fixture.dashboard!.member, id: 'next-member' };
    await act(async () => { root.render(createElement(HomeWithDemoVisit)); });

    expect(fixture.notices).toHaveBeenLastCalledWith('next-member');
    expect(container.textContent?.split('Campaign announcement')).toHaveLength(3);
    expect(fixture.markBroadcastRead).toHaveBeenCalledExactlyOnceWith('member', 'b1');
  });

  it('shows the Spanish status after the last notice is read beside an open personal issue', async () => {
    fixture.dashboard!.member.language = 'es';
    fixture.notices.mockResolvedValue([{ id: 'b1', title: 'Campaign announcement', unread: true }]);
    await renderRankedBroadcast(true);
    expect(container.textContent).not.toContain('Nada más requiere su atención por ahora.');
    await markBroadcastRead();

    expect(container.textContent).not.toContain('Campaign announcement');
    expect(container.textContent).toContain('My overtime issue');
    expect(container.textContent).toContain('Lo que le importa ahora');
    expect(container.textContent).toContain('Nada más requiere su atención por ahora.');
    expect(container.textContent).not.toMatch(/al día|no necesita su atención/i);
    expect(fixture.markBroadcastRead).not.toHaveBeenCalled();

    await act(async () => { root.render(createElement(HomeWithDemoVisit, { showHome: false })); });
    await act(async () => { root.render(createElement(HomeWithDemoVisit)); });
    expect(container.textContent).not.toContain('Campaign announcement');
    expect(container.textContent).toContain('My overtime issue');
    expect(container.textContent).toContain('Nada más requiere su atención por ahora.');
    expect(fixture.notices).toHaveBeenCalledTimes(2);
    expect(fixture.markBroadcastRead).not.toHaveBeenCalled();
  });

  it('shows the English status after the last notice is read beside a personal alert', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.liveRanking = true;
    fixture.notices.mockResolvedValue([{ id: 'b1', title: 'Campaign announcement', unread: true }]);
    await renderUpdates();
    await markBroadcastRead();

    expect(container.textContent).not.toContain('Campaign announcement');
    expect(membershipSection()?.textContent).toContain('Personal committee member message');
    expect(container.textContent).toContain('What matters for you now');
    expect(container.textContent).toContain('Nothing else needs your attention right now.');
    expect(container.textContent).not.toMatch(/all caught up|Nothing needs your attention right now/i);
    expect(fixture.markBroadcastRead).toHaveBeenCalledExactlyOnceWith('member', 'b1');
  });

  it('orders a staff person’s issue cards by the first due date across issue and step deadlines', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.whatMatters.enabled = true;
    fixture.dashboard!.cases = [
      { ...ownCase, title: 'Recent undated issue', updatedAt: '2026-11-24T11:00:00Z', deadline: null },
      { ...ownCase, id: 'later-case', reference: 'GR-2', title: 'Later issue deadline', deadline: '2026-11-26' },
      {
        ...ownCase, id: 'earlier-step', reference: 'GR-3', title: 'Earlier step deadline', deadline: null,
        nextDeadline: { kind: 'step', label: 'Submit evidence', dueOn: '2026-11-25', missed: false, timeZone: 'America/New_York' },
      },
    ];
    await renderUpdates({ ...takeover, message: null });

    const titles = new Set(['Earlier step deadline', 'Later issue deadline', 'Recent undated issue']);
    const displayed = Array.from(membershipSection()?.querySelectorAll('div') ?? [])
      .map((element) => element.textContent).filter((title) => title !== null && titles.has(title));
    expect(displayed).toEqual(['Earlier step deadline', 'Later issue deadline', 'Recent undated issue']);
  });

  it('shows no empty personal issue card for staff with What Matters off and no own issues', async () => {
    fixture.authorizedRoles = ['steward'];
    await renderUpdates({ ...takeover, message: null });

    expect(container.textContent).toContain('COMMITTEE DESK');
    expect(container.textContent).toContain('Campaign announcement');
    expect(container.textContent).not.toContain('No active issue deadlines.');
    expect(membershipSection()).toBeUndefined();
  });

  it('keeps a case-only section below shared cards and allows caught up', async () => {
    fixture.authorizedRoles = ['steward'];
    fixture.whatMatters.enabled = true;
    fixture.dashboard!.cases = [{ ...ownCase, deadline: null, status: 'closed' }];
    await renderUpdates({ ...takeover, message: null });

    const content = container.textContent ?? '';
    expect(content).toContain('Nothing needs your attention right now.');
    expect(content.indexOf('Campaign announcement')).toBeLessThan(content.indexOf('Your own membership'));
    expect(membershipSection()?.textContent).toBe('Your own membershipMy issues');
  });
});

describe.each(['union-ground', 'union-ground-dark'] as const)('Home unread metric (%s)', (theme) => {
  it.each([0, 1, 20])('labels %i unread inbox items visibly and accessibly and opens Messages', (count) => {
    fixture.theme = theme;
    if (!fixture.dashboard) throw new Error('Missing dashboard fixture');
    // Each unread thread/channel counts once even with several unread messages.
    // A read thread/channel and an unrelated notification must not count.
    fixture.dashboard.conversations = [0, 7].map((unreadCount, index) => ({
      id: `thread-${index}`, title: 'Conversation', initials: 'CO',
      createdAt: '2026-10-17T12:00:00-04:00', updatedAt: '2026-10-17T12:00:00-04:00',
      unreadCount: count === 0 ? 0 : unreadCount, latestMessage: 'Hello',
    }));
    fixture.dashboard.notifications = [{
      id: 'notice', title: 'Activity', body: 'Activity', kind: 'general', readAt: null,
      createdAt: '2026-10-17T12:00:00-04:00',
    }];
    fixture.channels = Array.from({ length: Math.max(1, count) }, (_, index) => ({
      id: `channel-${index}`, name: 'Campaign channel', topic: 'Updates', messages: [],
      unread: index > 0 ? 3 : 0,
    }));
    act(() => root.render(createElement(HomeScreen)));
    const metric = container.querySelector<HTMLButtonElement>(`button[aria-label="${count} Unread messages"]`);
    expect(metric).not.toBeNull();
    expect(metric?.textContent).toBe(`${count}Unread messages`);
    expect(metric?.querySelector('[aria-hidden="true"]')?.textContent).toBe(String(count));
    act(() => metric?.click());
    expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/messages');
    expect(fixture.select).toHaveBeenCalledOnce();
  });
});

// REQ-UG-NATIVE-MEMBER-REFERRAL-CODE-20261111 (#8175): the member's
// own recruited count joins the summary only when the rewards summary returned it.
describe('Home recruited count', () => {
  it('shows no recruited item when the summary returned no count', () => {
    act(() => root.render(createElement(HomeScreen)));
    expect(container.querySelector('button[aria-label$="Recruited this year"]')).toBeNull();
  });

  it.each([0, 3])('shows %i workers recruited this year and opens Contributions', (count) => {
    fixture.recruitedYtd = count;
    act(() => root.render(createElement(HomeScreen)));
    const metric = container.querySelector<HTMLButtonElement>(`button[aria-label="${count} Recruited this year"]`);
    expect(metric).not.toBeNull();
    act(() => metric?.click());
    expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/feature/rewards');
  });
});

// UX-UG-SHOW-ACCOUNT-AVATAR-NATIVE-WELCOME-BACK-HOME-SCREEN-20261013:
// the welcome-back return keeps the same Account control as the ordinary Home.
describe('Home welcome-back return', () => {
  it('renders the Account avatar above the welcome-back view and opens Account', () => {
    fixture.welcome = true;
    try {
      act(() => root.render(createElement(HomeScreen)));
      expect(container.querySelector('[data-testid="welcome-back"]')).not.toBeNull();
      const avatar = container.querySelector<HTMLButtonElement>('button[aria-label="Account"]');
      expect(avatar).not.toBeNull();
      act(() => avatar?.click());
      expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/account');
    } finally {
      fixture.welcome = false;
    }
  });

  it('keeps the same Account avatar on the ordinary Home', () => {
    act(() => root.render(createElement(HomeScreen)));
    expect(container.querySelector('[data-testid="welcome-back"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Account"]')).not.toBeNull();
  });
});

// BUG-UG-NATIVE-HOME-GREETING-LAYOUT-SHIFT-20261020: the greeting line
// is laid out before the device-local read answers, so the name below it never
// moves when the words arrive.
describe('Home greeting line', () => {
  it('holds its place while the greeting read is pending, then fills in without moving the name', () => {
    fixture.session = { user: { id: 'member' } };
    fixture.greetingShown = true;
    act(() => root.render(createElement(HomeScreen)));
    // Body and Heading render as blocks under the harness; the name is the block that reads exactly Sam.
    const name = () => [...container.querySelectorAll('div')].find((node) => node.textContent === 'Sam');
    const intro = name()?.parentElement;
    expect(intro).toBeDefined();
    const line = () => intro?.firstElementChild;
    expect(line()?.textContent).toBe('\u00A0');
    // The blank is not a VoiceOver element while it waits.
    expect(line()?.getAttribute('data-accessible')).toBe('false');
    expect(container.textContent).not.toContain('Welcome back');
    expect(fixture.greetingListener).not.toBeNull();
    const childrenBefore = intro?.childElementCount;
    const nameIndexBefore = [...(intro?.children ?? [])].indexOf(name() as Element);
    act(() => fixture.greetingListener?.('welcome-back'));
    expect(line()?.textContent).toBe('Welcome back');
    expect(line()?.getAttribute('data-accessible')).toBe('true');
    expect(intro?.childElementCount).toBe(childrenBefore);
    expect([...(intro?.children ?? [])].indexOf(name() as Element)).toBe(nameIndexBefore);
  });
});

// BUG-UG-NATIVE-HOME-GREETING-LARGE-TEXT-WRAP-SHIFT-20261021: at 320 pt
// and AX5 "Welcome back" wraps to two lines while the blank holds one, so the
// greeting line keeps one shrink-to-fit line box in every state.
describe('Home greeting line at the largest text sizes', () => {
  const greetings: Array<'welcome' | 'welcome-back'> = ['welcome', 'welcome-back'];
  it.each(greetings)('keeps one line box while pending and after %s arrives', (greeting) => {
    fixture.session = { user: { id: 'member' } };
    fixture.greetingShown = true;
    act(() => root.render(createElement(HomeScreen)));
    const name = () => [...container.querySelectorAll('div')].find((node) => node.textContent === 'Sam');
    const line = () => name()?.parentElement?.firstElementChild;
    expect(line()?.textContent).toBe('\u00A0');
    expect(line()?.getAttribute('data-lines')).toBe('1');
    expect(line()?.getAttribute('data-fit')).toBe('true');
    act(() => fixture.greetingListener?.(greeting));
    expect(line()?.textContent).toBe(greeting === 'welcome' ? 'Welcome' : 'Welcome back');
    expect(line()?.getAttribute('data-lines')).toBe('1');
    expect(line()?.getAttribute('data-fit')).toBe('true');
    // The name's own line is untouched, so it can still wrap at large sizes.
    expect(name()?.getAttribute('data-lines')).toBeNull();
  });
});

// BUG-UG-NATIVE-HOME-SUMMARY-LABELS-BREAK-MID-WORD-20261103: four
// equal columns at the largest iPhone text size broke every summary label
// inside a word. The row reflows to two columns, then one, and every item
// keeps its value, label and accessible name.
describe('Home worker summary at large text sizes', () => {
  const items = ['0 Open issues', '0 Activity', '0 Unread messages', '0 This week'];
  const widths = () => items.map((label) => container.querySelector(`button[aria-label="${label}"]`)?.getAttribute('data-width'));
  it.each([
    // iPhone 17 (402 pt) at the default size, accessibility-extra-large and the largest size.
    [402, 1, '25%'],
    [402, 2.643, '50%'],
    [402, 3.571, '100%'],
    // Android's largest font scale.
    [412, 2, '50%'],
  ])('at %i pt and font scale %f gives each item %s of the row', (windowWidth, fontScale, width) => {
    fixture.windowWidth = windowWidth;
    fixture.fontScale = fontScale;
    act(() => root.render(createElement(HomeScreen)));
    expect(widths()).toEqual(items.map(() => width));
    for (const label of items) {
      const item = container.querySelector(`button[aria-label="${label}"]`);
      expect(item?.textContent).toBe(label.replace(' ', ''));
    }
  });
});
