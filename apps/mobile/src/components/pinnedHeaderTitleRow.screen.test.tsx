// @vitest-environment jsdom
import { createElement as h, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

// UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115: a pushed screen's
// title sits on one row beside the back control, on iPhone (the frosted circle)
// and Android (the arrow). It is painted once, read before Back, and the
// scene's own heading with the same words is not drawn again.
const port = vi.hoisted(() => ({
  back: vi.fn(),
  replace: vi.fn(),
  canGoBack: true,
  fontScale: 1,
}));
// The shared stand-in drops styles, so this file wraps the hosts the row and
// the page are made of: each records its flattened style (and a scroll view
// its content style) on a plain wrapper, where the tests read the row's real
// position and type size.
vi.mock('react-native', async () => {
  const rn = await import('../testing/reactNativeStandIn');
  type Styled = { style?: unknown; contentContainerStyle?: unknown };
  const styled = <P extends object>(Base: (props: P) => ReturnType<typeof h>) => (props: P & Styled) => h('div', {
    'data-style': JSON.stringify(rn.StyleSheet.flatten(props.style) ?? {}),
    'data-content-style': props.contentContainerStyle === undefined ? undefined : JSON.stringify(rn.StyleSheet.flatten(props.contentContainerStyle)),
  }, h(Base, props));
  const View = styled(rn.View);
  const Text = styled(rn.Text);
  const ScrollView = styled(rn.ScrollView);
  return {
    ...rn,
    View, Text, ScrollView,
    Animated: { ...rn.Animated, View, Text, ScrollView },
    useWindowDimensions: () => ({ ...rn.Dimensions.get(), fontScale: port.fontScale }),
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children?: ReactNode }) => h('div', null, children),
}));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: port.back, replace: port.replace, canGoBack: () => port.canGoBack }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/haptics', () => ({ haptics: { select: async () => undefined } }));
vi.mock('./TopChrome', () => ({
  FrostedCapsule: ({ children }: { children?: ReactNode }) => h('div', { 'data-testid': 'frosted-circle' }, children),
  TopRamp: () => null,
  withAlpha: (hex: string) => hex,
}));

const { PinnedHeaderScreen } = await import('./PinnedHeader');
const { Heading, Screen } = await import('./ui');

let screen: Rendered | null = null;
afterEach(async () => {
  await screen?.unmount();
  screen = null;
  setPlatform('ios');
  port.back.mockReset();
  port.replace.mockReset();
  port.canGoBack = true;
  port.fontScale = 1;
});

type Style = Record<string, unknown>;
const styleOf = (element: Element | null | undefined): Style => JSON.parse(element?.getAttribute('data-style') ?? '{}') as Style;

describe.each([1, 3.571])('tab viewport at text scale %s (K9)', (fontScale) => {
  it.each([false, true])('keeps the iPhone feed full-edge with its top inset in padding, Home=%s', async (home) => {
    port.fontScale = fontScale;
    screen = await render(h(Screen, { tabRoot: true, scrollsTopChrome: home }, h(Heading, null, 'Home')));
    const scroll = screen.container.querySelector('[data-content-style]');
    const viewport = styleOf(scroll);
    const content = JSON.parse(scroll!.getAttribute('data-content-style')!) as { paddingTop: number };
    expect(viewport).toEqual({ marginBottom: 0 });
    expect(content.paddingTop).toBe(90);
  });

  it('retains the Android host-owned scene insets', async () => {
    port.fontScale = fontScale;
    setPlatform('android');
    screen = await render(h(Screen, { tabRoot: true }, h(Heading, null, 'Work')));
    const scroll = screen.container.querySelector('[data-content-style]');
    expect(styleOf(scroll)).toEqual({ marginBottom: 0 });
    expect(JSON.parse(scroll!.getAttribute('data-content-style')!)).toMatchObject({ paddingTop: 90 });
  });
});

// The painted title's own style, and the style of the row that places it.
function paintedTitle(container: Element, words: string): { text: Style; row: Style } {
  const span = [...container.querySelectorAll('span')].find((node) => node.textContent === words && node.closest('[aria-hidden="true"]'));
  const textHost = span?.parentElement;
  const rowHost = textHost?.parentElement?.parentElement;
  return { text: styleOf(textHost), row: styleOf(rowHost) };
}

function paintedCount(container: Element, words: string): number {
  return [...container.querySelectorAll('span')].filter((span) => span.textContent === words).length;
}

describe.each<'ios' | 'android'>(['ios', 'android'])('the title row on %s', (os) => {
  it('paints the screen name once, beside Back, and reads it before Back', async () => {
    setPlatform(os);
    screen = await render(h(PinnedHeaderScreen, { screenName: 'Account' },
      h(Screen, null, h(Heading, null, 'Account'), h(Heading, { level: 2 }, 'Profile'))));
    const { container } = screen;
    // The scene's own "Account" heading is gone; the row's copy is the one painted.
    expect(paintedCount(container, 'Account')).toBe(1);
    const painted = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Account');
    expect(painted?.closest('[aria-hidden="true"]')).not.toBeNull();
    // Inside the row the name comes before Back (the scene sits below the row
    // on screen; the frame order across them is pinned in voiceoverQ19).
    const names = exposedNames(container);
    expect(names.filter((name) => name === 'Account')).toHaveLength(1);
    expect(names.indexOf('Account')).toBe(names.indexOf('Back') - 1);
    expect(names).toContain('Profile');
    expect(getExposed(container, 'Account').getAttribute('role')).toBe('header');
    // The platform's own back control: the frosted circle on iPhone, the arrow on Android.
    expect(container.querySelector('[data-testid="frosted-circle"]') !== null).toBe(os === 'ios');
    expect(container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe(os === 'ios' ? 'chevron-back' : 'arrow-back');
  });

  it('keeps Back working, and goes Home when there is nothing to go back to', async () => {
    setPlatform(os);
    screen = await render(h(PinnedHeaderScreen, { title: 'Saved guides and notes' }, h(Screen, null)));
    await press(getExposed(screen.container, 'Back'));
    expect(port.back).toHaveBeenCalledTimes(1);
    await screen.unmount();
    port.canGoBack = false;
    screen = await render(h(PinnedHeaderScreen, { title: 'Saved guides and notes' }, h(Screen, null)));
    await press(getExposed(screen.container, 'Home'));
    expect(port.replace).toHaveBeenCalledWith('/(tabs)/home');
  });

  it('keeps a scene heading whose words differ from the name', async () => {
    setPlatform(os);
    screen = await render(h(PinnedHeaderScreen, { screenName: 'Campaign' },
      h(Screen, null, h(Heading, null, 'North Fork campaign'))));
    expect(paintedCount(screen.container, 'Campaign')).toBe(1);
    const names = exposedNames(screen.container);
    expect(names.indexOf('Campaign')).toBe(names.indexOf('Back') - 1);
    expect(names).toContain('North Fork campaign');
  });

  it('exposes the route test ID on the same node as the accessible heading', async () => {
    setPlatform(os);
    screen = await render(h(PinnedHeaderScreen, { screenName: 'Capítulos', headingTestID: 'public-directory' },
      h(Screen, null, h(Heading, null, 'Encuentra una campaña'))));
    const heading = getExposed(screen.container, 'Capítulos');
    expect(heading.getAttribute('data-testid')).toBe('public-directory');
    expect(screen.container.querySelectorAll('[data-testid="public-directory"]')).toHaveLength(1);
  });
});

// The numbers the row must keep, written out rather than read back from
// chromeGeometry, so a drifted constant or a row drawn at x=0 fails here
// (review of #8944: both mutations survived the first tests).
describe('where the row draws the title', () => {
  // useSafeAreaInsets reports a 62pt top inset (iPhone 17).
  it('starts the title just past the 48pt back target and stops clear of the hat column', async () => {
    screen = await render(h(PinnedHeaderScreen, { title: 'Account' }, h(Screen, null)));
    const { row, text } = paintedTitle(screen.container, 'Account');
    expect(row).toMatchObject({ position: 'absolute', left: 53, right: 68, top: 53 });
    expect(text).toMatchObject({ fontSize: 22, lineHeight: 28, fontWeight: '800' });
  });

  it('starts at the page gutter on a screen with no back control', async () => {
    screen = await render(h(PinnedHeaderScreen, { title: 'Account', onBack: null }, h(Screen, null)));
    expect(paintedTitle(screen.container, 'Account').row).toMatchObject({ left: 16, right: 68 });
    expect(screen.container.querySelector('[aria-label="Back"]')).toBeNull();
  });

  it('stops growing at 1.6 times, font and line together: 35.2 on 44.8 at font scale 2', async () => {
    port.fontScale = 2;
    screen = await render(h(PinnedHeaderScreen, { title: 'Account' }, h(Screen, null)));
    const { text } = paintedTitle(screen.container, 'Account');
    expect(text.fontSize).toBeCloseTo(35.2, 5);
    expect(text.lineHeight).toBeCloseTo(44.8, 5);
  });

  it('backs the row to 56pt below the safe area and starts the page 64pt below it', async () => {
    screen = await render(h(PinnedHeaderScreen, { title: 'Account' }, h(Screen, null)));
    const backing = [...screen.container.querySelectorAll('[data-style]')].map(styleOf)
      .find((style) => style.top === 0 && style.backgroundColor === palette['union-ground'].background && typeof style.height === 'number');
    expect(backing?.height).toBe(62 + 56);
    const page = screen.container.querySelector('[data-content-style]');
    expect(JSON.parse(page?.getAttribute('data-content-style') ?? '{}')).toMatchObject({ paddingTop: 62 + 64 });
  });
});
