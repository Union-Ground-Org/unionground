// @vitest-environment jsdom
import { act, createElement, useEffect, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TextStyle, ViewStyle } from 'react-native';

import HomeScreen from '../../../app/(tabs)/home';
import { nativeUiText, type NativeLanguage, type NativeUiKey } from '../../lib/nativeUiCopy';
import { wordFitMultiplier } from '../../lib/wordFit';
import { render, setPlatform } from '../../testing/reactNativeStandIn';

type GridLayoutHandler = (event: { nativeEvent: { layout: { width: number } } }) => void;

const fixture = vi.hoisted(() => ({
  language: 'en' as NativeLanguage,
  width: 402,
  fontScale: 1,
  autoMeasureGrid: true,
  onGridLayout: undefined as GridLayoutHandler | undefined,
  tileStyles: new Map<string, ViewStyle>(),
  labelStyles: new Map<string, { style: TextStyle; allowFontScaling?: boolean }>(),
}));

vi.mock('react-native', async () => {
  const native = await import('../../testing/reactNativeStandIn');
  const flatten = <Style extends object>(style: unknown): Style => Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity) : [style]));
  return {
    ...native,
    StyleSheet: { ...native.StyleSheet, flatten },
    useWindowDimensions: () => ({ width: fixture.width, height: 874, scale: 3, fontScale: fixture.fontScale }),
    View: (props: ComponentProps<typeof native.View>) => {
      const onLayout = props.onLayout as GridLayoutHandler | undefined;
      useEffect(() => {
        if (!onLayout) return;
        fixture.onGridLayout = onLayout;
        if (fixture.autoMeasureGrid) onLayout({ nativeEvent: { layout: { width: fixture.width - 32 } } });
      }, [onLayout]);
      return createElement(native.View, props);
    },
    Pressable: (props: ComponentProps<typeof native.Pressable>) => {
      const style = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
      if (props.accessibilityLabel) fixture.tileStyles.set(props.accessibilityLabel, flatten<ViewStyle>(style));
      return createElement(native.Pressable, props);
    },
    Text: (props: ComponentProps<typeof native.Text> & { allowFontScaling?: boolean }) => {
      if (typeof props.children === 'string') {
        fixture.labelStyles.set(props.children, { style: flatten<TextStyle>(props.style), allowFontScaling: props.allowFontScaling });
      }
      return createElement(native.Text, props);
    },
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useIsFocused: () => false, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../components/ui', () => import('../../testing/uiStandIn'));
vi.mock('../../theme/ThemeProvider', async () => {
  const { defaultThemeKey, resolveTheme } = await import('../../theme/tokens');
  const theme = resolveTheme(defaultThemeKey);
  return { useTheme: () => theme };
});
vi.mock('../../state/AppProvider', () => ({
  useApp: () => ({
    mode: 'authenticated', memberLanguage: fixture.language, chapterMemberships: [], authorizedRoles: [],
    dashboard: {
      member: { id: 'fixture', firstName: 'Avery', initials: 'AM', roleLine: 'Worker' },
      notifications: [], cases: [], conversations: [], weeklyActions: [],
    },
  }),
}));
vi.mock('../../data/useChannels', () => ({
  useChannelStore: () => ({ subscribe: () => () => undefined, getVersion: () => 0, channels: () => [] }),
}));
vi.mock('../../components/ChapterRail', () => ({ ChapterRail: () => null }));
vi.mock('../../components/HomeCarousel', () => ({ HomeCarousel: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../components/HomeHandleRow', () => ({ HomeHandleRow: () => null }));
vi.mock('../../components/NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('../../components/StaffTwoStepNotice', () => ({ StaffTwoStepNotice: () => null }));
vi.mock('../../features/StewardFinderSheet', () => ({ StewardFinderSheet: () => null }));
vi.mock('../../features/NativeLearningPeriod', () => ({ NativeLearningPeriodBanner: () => null }));
vi.mock('../../features/IssueSignalHomeCard', () => ({ IssueSignalHomeCard: () => null }));
vi.mock('../../features/LegalAcceptanceCard', () => ({ LegalAcceptanceCard: () => null }));
vi.mock('../../features/SavedPulseCharts', () => ({ SavedPulseProvider: () => null, SavedChartSlot: () => null }));
vi.mock('../../features/guideLayers/GuideLayers', () => ({ NativeCoachMark: () => null }));
vi.mock('../../features/home/ChoosePasswordNudge', () => ({ ChoosePasswordNudge: () => null }));
vi.mock('../../features/home/HomeNudge', () => ({ HomeNudge: () => null }));
vi.mock('../../features/home/HomeTakeoverCards', () => ({
  HomeTakeoverCards: ({ render }: { render: (updates: { message: null; broadcast: null; broadcastID: null; isBroadcastDismissed: (id: string) => boolean }) => React.ReactNode }) =>
    render({ message: null, broadcast: null, broadcastID: null, isBroadcastDismissed: () => false }),
  HomeTakeoverUpdates: () => null,
}));
vi.mock('../../features/home/StaffDeskHomeCard', () => ({ StaffDeskHomeCard: () => null }));
vi.mock('../../features/home/useStaffDeskNumbers', () => ({ useStaffDeskNumbers: () => null }));
vi.mock('../../features/home/useMemberRecruitedCount', () => ({ useMemberRecruitedCount: () => null }));
vi.mock('../../features/home/WhatMattersNow', () => ({ WhatMattersNowSection: () => null, useWhatMattersNow: () => ({ enabled: false, rank: () => ({ item: null }) }) }));
vi.mock('../../features/home/NavUsage', () => ({ MostUsedRow: () => null, useNativeNavUsage: () => ({ enabled: false }) }));
vi.mock('../../features/home/WelcomeBack', () => ({ WelcomeBackView: () => null, useNativeWelcomeBack: () => ({ show: false, decided: true }) }));
vi.mock('../../features/learning/LearningHomeCard', () => ({ LearningHomeCard: () => null }));
vi.mock('../../features/onboardingGuide/OnboardingGuideCard', () => ({ OnboardingGuideHomeSlot: () => null }));
vi.mock('../../features/onboardingGuide/useOnboardingGuide', () => ({ useOnboardingGuide: () => ({ guide: { applies: false } }) }));
vi.mock('../../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0 }));
vi.mock('../../services/haptics', () => ({ haptics: { impact: vi.fn() } }));
vi.mock('../../services/homeGreeting', () => ({ homeGreetingShown: () => false }));

const quickLabels: readonly NativeUiKey[] = [
  'Activity', 'Messages', 'Ask the Guide', 'My work', 'Union resources', 'Account security', 'Find my committee contact',
];

describe('Home Quick actions at larger system text sizes', () => {
  it.each([
    { os: 'ios', width: 402, fontScale: 1, tileWidth: '48%' },
    { os: 'ios', width: 402, fontScale: 3.571, tileWidth: '100%' },
    { os: 'ios', width: 320, fontScale: 3.571, tileWidth: '100%' },
    { os: 'android', width: 320, fontScale: 2, tileWidth: '100%' },
  ] as const)('sets tile widths and label font sizes on $os at $width pt and $fontScale×', async ({ os, width, fontScale, tileWidth }) => {
    setPlatform(os);
    for (const language of ['en', 'es'] as const) {
      Object.assign(fixture, { language, width, fontScale });
      fixture.tileStyles.clear();
      fixture.labelStyles.clear();
      const screen = await render(<HomeScreen />);
      try {
        const t = nativeUiText(language);
        for (const key of quickLabels) {
          const label = t(key);
          const tile = fixture.tileStyles.get(label);
          const text = fixture.labelStyles.get(label);
          expect(tile?.width, label).toBe(tileWidth);
          expect(tile?.height, label).toBeUndefined();
          expect(tile?.maxHeight, label).toBeUndefined();
          const availableWidth = (width - 32) * Number.parseFloat(tileWidth) / 100 - 24;
          const allowedScale = wordFitMultiplier(label, 15, availableWidth) ?? 1;
          const actualFontSize = (text?.style.fontSize ?? 0) * (text?.allowFontScaling === false ? 1 : fontScale);
          expect(actualFontSize, label).toBeCloseTo(15 * Math.min(fontScale, allowedScale), 3);
        }
      } finally {
        await screen.unmount();
      }
    }
  });

  it('discards the old grid measurement on rotation before a new layout arrives', async () => {
    setPlatform('ios');
    Object.assign(fixture, { language: 'en', width: 402, fontScale: 1, autoMeasureGrid: false, onGridLayout: undefined });
    const screen = await render(<HomeScreen />);
    try {
      const narrowLayout = { nativeEvent: { layout: { width: 196 } } };
      const portraitLayoutHandler = fixture.onGridLayout;
      await act(async () => { portraitLayoutHandler?.(narrowLayout); });
      expect(fixture.tileStyles.get('Activity')?.width).toBe('100%');

      fixture.width = 800;
      await screen.rerender(<HomeScreen />);
      expect(fixture.tileStyles.get('Activity')?.width).toBe('48%');
      await act(async () => { portraitLayoutHandler?.(narrowLayout); });
      expect(fixture.tileStyles.get('Activity')?.width).toBe('48%');

      fixture.width = 402;
      await screen.rerender(<HomeScreen />);
      expect(fixture.tileStyles.get('Activity')?.width).toBe('48%');
      await act(async () => { fixture.onGridLayout?.(narrowLayout); });
      expect(fixture.tileStyles.get('Activity')?.width).toBe('100%');
    } finally {
      fixture.autoMeasureGrid = true;
      fixture.onGridLayout = undefined;
      await screen.unmount();
    }
  });
});
