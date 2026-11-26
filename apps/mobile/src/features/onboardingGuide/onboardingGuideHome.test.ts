import { createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../PulseOpeningPreference', () => ({ PulseOpeningPreferenceCard: () => null }));

import type { MemberDashboard } from '../../models/member';
import { INACTIVE_ONBOARDING_GUIDE, ONBOARDING_CHECKLIST_HREF, homeOnboardingGuidePresentation, onboardingEntryCopy, type OnboardingGuide } from '../../lib/onboardingGuide';

// BUG-UG-NATIVE-HOME-HIDES-ONBOARDING-GUIDE-20261018: with the guide
// on, the server suppressed the Home onboarding nudge and the stage card lived
// only on the Union screen, so native Home showed neither. These tests render
// the shipped Home screen (the mobile lane has no React Native renderer, so
// native hosts and unrelated Home features are replaced) with the guide on and
// off, and drive the entry into the checklist.

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};

type ButtonCapture = { onPress: () => void; label: string };

const mocks = vi.hoisted(() => ({
  guide: null as unknown,
  guideLoadFailed: false,
  retryGuide: vi.fn(),
  app: {
    mode: 'authenticated' as 'authenticated' | 'preview',
    previewHat: null as string | null,
    dashboard: null as MemberDashboard | null,
    error: null as string | null,
    refreshing: false,
    refresh: vi.fn(async (_reason?: 'automatic' | 'user-refresh') => undefined),
    chapterMemberships: [] as unknown[],
    sessionRestricted: false,
    session: null,
    authorizedRoles: [] as string[],
    chosenStaffRole: null,
  },
  router: { push: vi.fn((_href: string) => undefined), replace: vi.fn() },
  buttons: [] as ButtonCapture[],
  pressables: [] as { accessibilityLabel?: string; accessibilityRole?: string; onPress?: () => void; minHeight: number | null }[],
  haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

type HostProps = { children?: ReactNode | ((state: { pressed: boolean }) => ReactNode); accessibilityLabel?: string; accessibilityRole?: string; onPress?: () => void; style?: unknown };
type ReactModule = typeof import('react');
vi.mock('../guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('react', async (original) => ({
  ...await original<ReactModule>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => number) => snapshot(),
}));
vi.mock('react-native', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children as ReactNode);
  const flatten = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
  };
  return {
    Platform: { OS: 'ios', select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default },
    View: ({ children, accessibilityLabel, accessibilityRole }: HostProps) => createElement('div', { 'aria-label': accessibilityLabel, role: accessibilityRole }, children as ReactNode),
    ScrollView: Host,
    Text: ({ children }: HostProps) => createElement('span', null, children as ReactNode),
    Pressable: ({ children, accessibilityLabel, accessibilityRole, onPress, style }: HostProps) => {
      const resolved = flatten(typeof style === 'function' ? style({ pressed: false }) : style);
      mocks.pressables.push({ accessibilityLabel, accessibilityRole, onPress, minHeight: typeof resolved.minHeight === 'number' ? resolved.minHeight : null });
      const content = typeof children === 'function' ? children({ pressed: false }) : children;
      return createElement('button', { 'aria-label': accessibilityLabel, role: accessibilityRole }, content);
    },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 3 }),
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => mocks.router, useIsFocused: () => true }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => mocks.app }));
vi.mock('../SavedPulseCharts', () => ({ SavedPulseProvider: ({ children }: { children?: ReactNode }) => children, SavedChartSlot: () => null }));
vi.mock('../../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../../theme/tokens');
  return { useTheme: () => resolveTheme() };
});
vi.mock('../../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0, syncHomeHandleRowTop: () => undefined, claimHomeHandleRow: () => () => undefined }));
vi.mock('../../services/haptics', () => ({ haptics: mocks.haptics }));
// The greeting marker lives in expo-secure-store, which needs the native runtime; its own suite covers it.
vi.mock('../../services/homeGreeting', () => ({ readHomeGreeting: async () => 'welcome-back', homeGreetingText: () => 'Welcome back', homeGreetingShown: () => false, subscribeHomeGreeting: () => () => undefined }));
vi.mock('./useOnboardingGuide', () => ({ useOnboardingGuide: () => ({ guide: mocks.guide, loadFailed: mocks.guideLoadFailed, retry: mocks.retryGuide, showAll: false, setShowAll: () => undefined }) }));
vi.mock('../../components/ChapterRail', () => ({ ChapterRail: () => null }));
vi.mock('../StewardFinderSheet', () => ({ StewardFinderSheet: () => null }));
vi.mock('../NativeLearningPeriod', () => ({ NativeLearningPeriodBanner: () => null }));
vi.mock('../home/HomeNudge', () => ({ HomeNudge: () => createElement('section', { 'data-slot': 'home-nudge' }) }));
vi.mock('../home/ChoosePasswordNudge', () => ({ ChoosePasswordNudge: ({ children }: { children?: ReactNode }) => children }));
vi.mock('../learning/LearningHomeCard', () => ({ LearningHomeCard: () => null }));
vi.mock('../home/HomeTakeoverCards', () => ({
  HomeTakeoverCards: ({ render }: { render: (updates: { message: null; broadcast: null; broadcastID: null; isBroadcastDismissed: (id: string) => boolean }) => React.ReactNode }) =>
    render({ message: null, broadcast: null, broadcastID: null, isBroadcastDismissed: () => false }),
  HomeTakeoverUpdates: () => null,
}));
vi.mock('../IssueSignalHomeCard', () => ({ IssueSignalHomeCard: () => null }));
vi.mock('../LegalAcceptanceCard', () => ({ LegalAcceptanceCard: () => null }));
vi.mock('../../components/StaffTwoStepNotice', () => ({ StaffTwoStepNotice: () => null }));
vi.mock('../home/useStaffDeskNumbers', () => ({ useStaffDeskNumbers: () => null }));
vi.mock('../home/useMemberRecruitedCount', () => ({ useMemberRecruitedCount: () => null }));
vi.mock('../../components/HomeCarousel', () => ({ HomeCarousel: ({ children }: HostProps) => createElement('main', null, children as ReactNode) }));
vi.mock('../home/WhatMattersNow', () => ({ useWhatMattersNow: () => ({ enabled: false, rank: () => ({ item: null }) }), WhatMattersNowSection: () => null }));
vi.mock('../home/NavUsage', () => ({ useNativeNavUsage: () => ({ enabled: false, weights: [] }), MostUsedRow: () => null }));
vi.mock('../home/WelcomeBack', () => ({ useNativeWelcomeBack: () => ({ show: false, decided: true, dismiss: () => undefined }), WelcomeBackView: () => null }));
vi.mock('../../components/NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('../../data/demoChannels', () => ({ channelStore: { subscribe: () => () => undefined, getVersion: () => 0 } }));
vi.mock('../../data/useChannels', () => ({ useChannelStore: () => ({
  channels: () => [], subscribe: () => () => undefined, getVersion: () => 0,
}) }));
vi.mock('../../components/ui', () => {
  const Host = ({ children }: HostProps) => createElement('div', null, children as ReactNode);
  return {
    Button: ({ label, onPress }: ButtonCapture) => {
      mocks.buttons.push({ label, onPress });
      return createElement('button', null, label);
    },
    Screen: Host,
    Card: ({ children }: HostProps) => createElement('article', null, children as ReactNode),
    Body: Host, Heading: Host, Notice: Host,
    StateMessage: ({ title }: { title: string }) => createElement('h2', null, title),
  };
});

import HomeScreen from '../../../app/(tabs)/home';

const DASHBOARD: MemberDashboard = {
  member: { id: 'm1', firstName: 'Dana', fullName: 'Dana Whitfield', initials: 'DW', roleLine: 'Worker', memberSince: null, chapterID: null, language: 'en' },
  notifications: [],
  cases: [],
  conversations: [],
  weeklyActions: [],
};

const ACTIVE_GUIDE: OnboardingGuide = {
  ready: true,
  applies: true,
  onboardingComplete: false,
  progressiveDisclosureActive: true,
  showHud: true,
  featureDrip: true,
  spotlight: 'member-support',
  badge: 'momentum',
  stage: 'activate',
  nextStep: { id: 'step-3', title: 'Read your contract basics' },
  totalSteps: 6,
  completedSteps: 2,
  enrolled: true,
  progressiveNavigationOn: false,
};

function renderHome(): string {
  mocks.buttons.length = 0;
  mocks.pressables.length = 0;
  return renderToStaticMarkup(createElement(HomeScreen));
}

const source = readFileSync(fileURLToPath(new NodeURL('../../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');

describe('native Home onboarding guide (BUG-UG-NATIVE-HOME-HIDES-ONBOARDING-GUIDE-20261018)', () => {
  beforeEach(() => {
    mocks.app.mode = 'authenticated';
    mocks.app.dashboard = DASHBOARD;
    mocks.guide = INACTIVE_ONBOARDING_GUIDE;
    mocks.guideLoadFailed = false;
    mocks.retryGuide.mockClear();
    mocks.router.push.mockClear();
    mocks.haptics.select.mockClear();
  });

  it('shows the guide card with its entry into the checklist when the guide applies with the HUD on', () => {
    mocks.guide = ACTIVE_GUIDE;
    const markup = renderHome();
    expect(markup).toContain('GETTING STARTED');
    expect(markup).toContain('Keep the momentum going');
    expect(markup).toContain('Next step: Read your contract basics');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Onboarding progress"');
    const entry = mocks.buttons.find((button) => button.label === 'Open onboarding');
    expect(entry).toBeDefined();
    entry?.onPress();
    // On Home the card's CTA opens the checklist, not the Rights tab.
    expect(mocks.router.push).toHaveBeenCalledWith(ONBOARDING_CHECKLIST_HREF);
    // The guide takes the nudge slot: HomeNudge stays off the screen.
    expect(markup).not.toContain('data-slot="home-nudge"');
  });

  it('keeps HomeNudge off the screen while the compact entry is shown (feature drip or spotlight alone)', () => {
    mocks.guide = { ...ACTIVE_GUIDE, showHud: false, progressiveDisclosureActive: false, spotlight: 'member-support' };
    const markup = renderHome();
    expect(markup).toContain('Continue onboarding');
    expect(markup).not.toContain('data-slot="home-nudge"');
    expect(homeOnboardingGuidePresentation(mocks.guide as OnboardingGuide)).toBe('entry');
  });

  it('shows a compact 48 pt entry row when the guide applies but the HUD switch is off', () => {
    mocks.guide = { ...ACTIVE_GUIDE, showHud: false };
    const markup = renderHome();
    expect(markup).not.toContain('Keep the momentum going');
    expect(markup).toContain('GETTING STARTED');
    expect(markup).toContain('Continue onboarding');
    expect(markup).toContain('Next step: Read your contract basics.');
    const entry = mocks.pressables.find((item) => item.accessibilityLabel?.startsWith('Continue onboarding.'));
    expect(entry).toBeDefined();
    expect(entry?.accessibilityRole).toBe('button');
    expect(entry?.minHeight).toBe(48);
    entry?.onPress?.();
    expect(mocks.haptics.select).toHaveBeenCalled();
    expect(mocks.router.push).toHaveBeenCalledWith(ONBOARDING_CHECKLIST_HREF);
  });

  it('invites an unenrolled worker to start the checklist', () => {
    mocks.guide = { ...ACTIVE_GUIDE, showHud: false, enrolled: false, stage: 'welcome', completedSteps: 0, nextStep: null };
    const markup = renderHome();
    expect(markup).toContain('Start onboarding');
    expect(markup).toContain('Your organization set up a short checklist to help you get started.');
  });

  // BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018: a failed read
  // takes the guide slot with a retry card instead of leaving Home quiet.
  it('shows a retry card in the guide slot when the guide read failed', () => {
    mocks.guide = INACTIVE_ONBOARDING_GUIDE;
    mocks.guideLoadFailed = true;
    const markup = renderHome();
    expect(markup).toContain('GETTING STARTED');
    expect(markup).toContain('Getting started could not load');
    expect(markup).toContain('Your full list is open. Try again to see your next onboarding step.');
    expect(markup).not.toContain('data-slot="home-nudge"');
    const retry = mocks.buttons.find((button) => button.label === 'Try again');
    expect(retry).toBeDefined();
    retry?.onPress();
    expect(mocks.retryGuide).toHaveBeenCalledTimes(1);
    expect(mocks.haptics.select).toHaveBeenCalled();
  });

  it('renders neither the card nor the entry when no guide applies', () => {
    mocks.guide = INACTIVE_ONBOARDING_GUIDE;
    const markup = renderHome();
    expect(markup).not.toContain('GETTING STARTED');
    expect(markup).not.toContain('onboarding');
    expect(mocks.pressables.some((item) => item.accessibilityLabel?.includes('onboarding'))).toBe(false);
    expect(markup).toContain('data-slot="home-nudge"');
  });

  it('shows nothing and hands the slot back to HomeNudge once onboarding is complete', () => {
    for (const showHud of [false, true]) {
      mocks.guide = { ...ACTIVE_GUIDE, showHud, stage: 'complete', onboardingComplete: true, progressiveDisclosureActive: false, completedSteps: 6 };
      const markup = renderHome();
      expect(markup).not.toContain('GETTING STARTED');
      expect(markup).not.toContain('Onboarding complete');
      expect(markup).toContain('data-slot="home-nudge"');
      expect(homeOnboardingGuidePresentation(mocks.guide as OnboardingGuide)).toBeNull();
    }
    expect(onboardingEntryCopy({ ...ACTIVE_GUIDE, stage: 'complete' })).toBeNull();
    expect(homeOnboardingGuidePresentation({ ...ACTIVE_GUIDE, onboardingComplete: true })).toBeNull();
    expect(homeOnboardingGuidePresentation(ACTIVE_GUIDE)).toBe('card');
  });

  it('keeps the guide off PREVIEW Home', () => {
    mocks.app.mode = 'preview';
    mocks.guide = ACTIVE_GUIDE;
    expect(source).toMatch(/function AuthenticatedHome\(\)[\s\S]*useOnboardingGuide\(\)[\s\S]*<ChoosePasswordNudge>\s*<OnboardingGuideHomeSlot guide=\{guide\} loadFailed=\{loadFailed\} onRetry=\{retry\}>\s*<HomeNudge \/>\s*<\/OnboardingGuideHomeSlot>[\s\S]*?homeOnboardingGuidePresentation\(guide\) === 'card'[\s\S]*?<NativeCoachMark [^>]*\/>[\s\S]*?<\/ChoosePasswordNudge>/);
    // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: the coach
    // mark lives inside the password prompt's wrapper, beside the card it
    // points at, so the prompt displaces both.
    expect(source.match(/<HomeNudge \/>/g)).toHaveLength(1);
    expect(source.match(/<OnboardingGuideHomeSlot/g)).toHaveLength(1);
    expect(source.indexOf('function PrototypeHome()')).toBeLessThan(source.indexOf('function AuthenticatedHome()'));
    expect(source.slice(source.indexOf('function PrototypeHome()'), source.indexOf('function AuthenticatedHome()'))).not.toContain('OnboardingGuide');
  });

  it('spells the entry copy from the guide state', () => {
    expect(onboardingEntryCopy(INACTIVE_ONBOARDING_GUIDE)).toBeNull();
    expect(onboardingEntryCopy({ ...ACTIVE_GUIDE, nextStep: null })).toMatchObject({ body: '4 steps left.', cta: 'Continue onboarding' });
    expect(onboardingEntryCopy({ ...ACTIVE_GUIDE, nextStep: null, completedSteps: 5 })).toMatchObject({ body: '1 step left.' });
    expect(onboardingEntryCopy({ ...ACTIVE_GUIDE, nextStep: null, totalSteps: 0, completedSteps: 0 })).toMatchObject({ body: 'Pick up your checklist where you left off.' });
    expect(onboardingEntryCopy(ACTIVE_GUIDE)?.accessibilityLabel).toBe('Continue onboarding. Next step: Read your contract basics.');
  });
});
