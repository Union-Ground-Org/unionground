// @vitest-environment jsdom
import { createElement as h, type ComponentProps, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getExposed, press, render, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

const port = vi.hoisted(() => ({ push: vi.fn(), announce: vi.fn(), fontScale: 1, session: { user: { id: 'fixture-member' } } }));
vi.mock('react-native', async () => {
  const rn = await import('../testing/reactNativeStandIn');
  return {
    ...rn,
    AccessibilityInfo: { ...rn.AccessibilityInfo, announceForAccessibility: port.announce },
    useWindowDimensions: () => ({ ...rn.Dimensions.get(), fontScale: port.fontScale }),
    Pressable: (props: ComponentProps<typeof rn.Pressable>) => {
      const style: unknown = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
      const { flexBasis } = rn.StyleSheet.flatten(style) as { flexBasis?: string };
      return h('div', { 'data-flex-basis': flexBasis }, h(rn.Pressable, props));
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children?: ReactNode }) => h('div', null, children),
}));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: port.push, replace: vi.fn(), canGoBack: () => false }),
  useIsFocused: () => true,
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./TopChrome', () => ({ FrostedCapsule: ({ children }: { children?: ReactNode }) => h('div', null, children), withAlpha: (hex: string) => hex }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  mode: 'authenticated', memberLanguage: 'es', session: port.session, authorizedRoles: [], chapterMemberships: [],
  dashboard: { member: { language: 'en' } },
}) }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => ({
  rpc: async () => ({ data: { switches: { 'features.guidance_onboarding.feature_guides': true } }, error: null }),
}) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined }));
vi.mock('../services/nativeFeatureFlag', () => ({}));
vi.mock('../services/memberSwitches', () => ({}));
vi.mock('../services/navUsageStore', () => ({}));
vi.mock('./ChapterLeadershipCard', () => ({ ChapterLeadershipCard: () => null }));
vi.mock('./MemberInvitationCard', () => ({ MemberInvitationCard: () => null }));
vi.mock('./FunctionDeck', () => ({ functionIcons: {} }));
vi.mock('../features/UnionCatalogScreen', () => ({ useUnionCatalogCopy: () => ({ title: 'Directorio', disclaimer: 'Datos públicos', go: 'Ver directorio' }) }));
vi.mock('../features/onboardingGuide/useOnboardingGuide', async () => {
  const { normalizeOnboardingGuide } = await import('../lib/onboardingGuide');
  return { useOnboardingGuide: () => ({
    guide: normalizeOnboardingGuide({
      state: 'ready', applies: true, showHud: true, enrolled: true, stage: 'welcome',
      progressiveDisclosureActive: true, spotlight: 'member-support', badge: 'new_member',
      totalSteps: 4, completedSteps: 2, nextStep: { id: 'fixture-step', title: 'Meet the library team' },
    }),
    loadFailed: false, showAll: false, setShowAll: vi.fn(),
  }) };
});

import { NativeFeatureGuide } from '../features/guideLayers/GuideLayers';
import { MostUsedRow } from '../features/home/NavUsage';

let view: Rendered | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  port.fontScale = 1;
  vi.clearAllMocks();
});

it('renders and announces the optional Account guide in the Spanish profile language', async () => {
  view = await render(h(NativeFeatureGuide, { feature: 'settings' }));
  expect(view.container.textContent).toContain('Guía opcional');
  expect(view.container.textContent).toContain('Elige cómo te contacta Union Ground.');
  expect(view.container.textContent).not.toMatch(/Optional guide|Choose how Union Ground reaches you|Your sign-in is yours alone/);
  expect(getExposed(view.container, 'Entendido')).toBeTruthy();
  expect(port.announce).toHaveBeenCalledWith('Guía para Cuenta.');
});

it('localizes Home shortcuts, widening them at the largest text size and keeping their routes', async () => {
  const row = h(MostUsedRow, { weights: [{ key: 'messages', weight: 8 }, { key: 'compass', weight: 4 }] });
  view = await render(row);
  expect(view.container.textContent).toContain('Más usados');
  expect(view.container.textContent).not.toMatch(/Most used|Ask Compass|Messages/);
  expect(getExposed(view.container, 'Preguntar a la Guía').parentElement?.dataset.flexBasis).toBe('47%');
  port.fontScale = 3.571;
  await view.rerender(h(MostUsedRow, row.props));
  expect(getExposed(view.container, 'Preguntar a la Guía').parentElement?.dataset.flexBasis).toBe('100%');
  const messages = getExposed(view.container, 'Mensajes');
  expect(messages.parentElement?.dataset.flexBasis).toBe('100%');
  await press(messages);
  expect(port.push).toHaveBeenCalledWith('/messages');
  expect(getExposed(view.container, 'Preguntar a la Guía')).toBeTruthy();
});
