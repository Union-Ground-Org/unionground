import * as React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-UG-NATIVE-INVITE-HEADING-UNDER-BACK-ARROW-20261102: the
// invitation and reset-link screens are the one heading-first surface that
// keeps the root Stack's native header, drawn transparent over the scene. On
// the DevTools_Pixel_7_API_36 emulator (420 dpi) the back arrow's ImageButton
// sat at y136 px, 147 px tall, and "Accept your invitation" started at y210 px,
// inside the drawn arrow. This suite follows the shipped route: the header
// height the native stack hands auth/callback reaches Screen, and Screen's
// first line clears both the drawn arrow and its touch target.

const runtime = vi.hoisted(() => ({
  insetsTop: 0,
  headerHeight: undefined as number | undefined,
  params: {} as Record<string, string>,
  headerHeightContext: Symbol('HeaderHeightContext'),
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof React>();
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(current: T) => ({ current }),
    useEffect: () => undefined,
    useReducer: <S,>(_reducer: unknown, initial: S) => [initial, () => undefined] as const,
    useState: <T,>(initial: T) => [initial, () => undefined] as const,
    useContext: (context: unknown) => (context === runtime.headerHeightContext ? runtime.headerHeight : undefined),
  };
});
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { ScrollView: 'ScrollView', View: 'View', event: vi.fn() },
  Platform: { OS: 'android' },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl',
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: runtime.insetsTop, bottom: 24, left: 0, right: 0 }),
}));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: 'ScrollViewMarker' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: vi.fn() }));
vi.mock('../lib/chrome', async () => {
  const geometry = await import('../lib/chromeGeometry');
  return {
    ...geometry,
    homeScrollOffset: {}, resetHomeScrollOffset: vi.fn(), syncHomeAwayFromTop: vi.fn(), useHomeScrollToTopRequests: () => 0,
  };
});
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('./PinnedHeader', () => ({ usePinnedHeaderChrome: () => null, useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('./NumberFlow', () => ({ NumberFlow: 'NumberFlow' }));
vi.mock('./PressableScale', () => ({ PressableScale: 'PressableScale', usePressSpring: () => ({}) }));
vi.mock('./RowHighlight', () => ({ HighlightList: 'HighlightList', HighlightRow: 'HighlightRow' }));
vi.mock('./TopChrome', () => ({ TopRamp: 'TopRamp' }));
vi.mock('./keyboardDismissGesture', () => ({ keyboardDismissModeFor: () => 'on-drag' }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ background: '#fff', primary: '#111' }) }));
// The route's own collaborators: fake link data, no services.
vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  useLocalSearchParams: () => runtime.params,
  useRouter: () => ({ replace: vi.fn(), back: vi.fn(), canGoBack: () => true }),
}));
vi.mock('expo-router/react-navigation', () => ({ HeaderHeightContext: runtime.headerHeightContext }));
vi.mock('./EmailAuthScreen', () => ({ EmailAuthScreen: 'EmailAuthScreen' }));
vi.mock('../services/emailAuth', () => ({ passwordResetRequestAvailable: () => false }));
vi.mock('../services/supabase', () => ({ exchangeAuthCode: vi.fn() }));
vi.mock('../services/lifecycleDiagnostics', () => ({ recordLifecycleEvent: vi.fn() }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ mode: 'signedOut', signOut: vi.fn(), signOutError: null }) }));

const { Screen } = await import('./ui');
const { default: AuthCallbackScreen } = await import('../../app/auth/callback');

type Element = React.ReactElement<{ children?: React.ReactNode; contentContainerStyle?: unknown; nativeHeaderHeight?: number }>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function screenTop(props: Parameters<typeof Screen>[0]): number {
  const scroll = elements(Screen(props)).find((node) => node.type === 'ScrollView');
  const style = [scroll?.props.contentContainerStyle].flat(2) as ({ paddingTop?: number } | undefined)[];
  const top = style.reduce<number | undefined>((found, entry) => entry?.paddingTop ?? found, undefined);
  if (top === undefined) throw new Error('Screen set no top padding');
  return top;
}
// What auth/callback hands the invitation or reset screen, read from the route.
function routeHeaderHeight(params: Record<string, string>): number | undefined {
  runtime.params = params;
  const element = AuthCallbackScreen() as Element;
  expect(element.type).toBe('EmailAuthScreen');
  return element.props.nativeHeaderHeight;
}

const INVITE = { invite: 'A'.repeat(43) };
const RESET = { resetTicket: `t1.${'A'.repeat(16)}.${'B'.repeat(64)}` };

// The retained Android report: 1080 x 2400 px at 420 dpi. The status bar is the
// 136 px above the toolbar; react-native-screens' toolbar is the 56 dp
// ANDROID_DEFAULT_HEADER_HEIGHT the native stack adds the top inset to, and the
// Navigate-up ImageButton fills it (147 px). Its drawn arrow is the 24 dp
// Material navigation icon centred in that button.
const PIXEL_7 = {
  density: 420 / 160,
  statusBarPx: 136,
  toolbarDp: 56,
  upButtonPx: { top: 136, height: 147 },
  arrowDp: 24,
  observedHeadingPx: 210,
};

describe('invitation heading under the retained native header', () => {
  beforeEach(() => {
    runtime.headerHeight = undefined;
    runtime.params = {};
    runtime.insetsTop = 0;
  });

  it('reproduces the Pixel 7 collision on the plain content start line', () => {
    runtime.insetsTop = PIXEL_7.statusBarPx / PIXEL_7.density;
    const top = screenTop({}) * PIXEL_7.density;
    const arrowTop = PIXEL_7.upButtonPx.top + ((PIXEL_7.toolbarDp - PIXEL_7.arrowDp) / 2) * PIXEL_7.density;
    const arrowBottom = arrowTop + PIXEL_7.arrowDp * PIXEL_7.density;
    expect(Math.round(top)).toBe(PIXEL_7.observedHeadingPx);
    expect(top).toBeGreaterThan(arrowTop);
    expect(top).toBeLessThan(arrowBottom);
  });

  it.each([
    ['invitation', INVITE],
    ['reset link', RESET],
  ])('starts the %s heading below the drawn arrow and its touch target on the Pixel 7', (_variant, params) => {
    runtime.insetsTop = PIXEL_7.statusBarPx / PIXEL_7.density;
    // NativeStackView's Android header height: toolbar plus the top inset.
    runtime.headerHeight = PIXEL_7.toolbarDp + runtime.insetsTop;
    const nativeHeaderHeight = routeHeaderHeight(params);
    expect(nativeHeaderHeight).toBe(runtime.headerHeight);
    const top = screenTop({ nativeHeaderHeight }) * PIXEL_7.density;
    expect(top).toBeGreaterThanOrEqual(PIXEL_7.upButtonPx.top + PIXEL_7.upButtonPx.height);
  });

  it.each([
    // getDefaultHeaderHeight for a portrait iPhone: the 44 pt bar under the
    // status bar, which a Dynamic Island inset reports 5 pt and a pixel taller.
    ['Dynamic Island', 62, 44 + 62 - (5 + 1 / 3)],
    ['notch', 47, 44 + 47],
    ['Home button', 20, 44 + 20],
  ])('starts the invitation heading below the iOS %s navigation bar', (_device, safeTop, headerHeight) => {
    runtime.insetsTop = safeTop;
    runtime.headerHeight = headerHeight;
    const top = screenTop({ nativeHeaderHeight: routeHeaderHeight(INVITE) });
    // The bar's back chevron is drawn inside it; the plain start line was not below it.
    expect(safeTop + 28).toBeLessThan(headerHeight);
    expect(top).toBeGreaterThanOrEqual(headerHeight);
  });

  it('leaves surfaces without a native header on the one content start line', () => {
    runtime.insetsTop = 47;
    expect(screenTop({})).toBe(47 + 28);
    // A route whose header is off reports no height above the scene.
    expect(screenTop({ nativeHeaderHeight: 0 })).toBe(47 + 28);
  });

  it('is bound to the shipped Stack options: auth/callback keeps a transparent native header', () => {
    const layout = readFileSync(fileURLToPath(new URL('../../app/_layout.tsx', import.meta.url)), 'utf8');
    expect(layout).toMatch(/<Stack screenOptions=\{\{[^}]*headerTransparent: true/);
    const callback = layout.match(/<Stack\.Screen name="auth\/callback" options=\{\{([^}]*)\}\} \/>/);
    expect(callback?.[1]).toBeDefined();
    expect(callback?.[1]).not.toMatch(/headerShown:\s*false/);
    // The native header is the only one drawn: neither the route nor the
    // invitation screen adds the app-owned PinnedHeader over it.
    for (const source of ['../../app/auth/callback.tsx', './EmailAuthScreen.tsx']) {
      expect(readFileSync(fileURLToPath(new URL(source, import.meta.url)), 'utf8')).not.toMatch(/PinnedHeader/);
    }
  });
});
