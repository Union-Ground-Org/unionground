import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contrastRatio } from '../theme/contrast';
import { elevation } from '../theme/elevation';
import { resolveTheme, themeKeys, type ThemeKey } from '../theme/tokens';
import type { LiveStaffRole } from '../lib/hatFunctions';
import type { MemberDashboard } from '../models/member';

// Execute HomeCarousel's actions and state transitions with native boundaries
// replaced. This is offline component evidence, not a VoiceOver device run.
const host = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  window: { width: 390, height: 844, fontScale: 1 },
  app: {
    dashboard: null as MemberDashboard | null, mode: 'live', sessionRestricted: false,
    chosenStaffRole: null as LiveStaffRole | null,
    authorizedRoles: [] as LiveStaffRole[], chapterRoles: [] as LiveStaffRole[], organizationRoles: [] as LiveStaffRole[],
  },
  deskStatus: 'ready',
  readRole: null as LiveStaffRole | null,
  // Home's shared scroll offset and its measured handle row .
  rowTop: 0,
  dockSuppressed: false,
  positionReads: [] as number[],
  offset: { listener: null as ((event: { value: number }) => void) | null },
}));
vi.mock('react', async (original) => ({
  ...await original<typeof React>(),
  useState: <T,>(initial: T) => {
    const index = host.cursor++;
    if (!(index in host.slots)) host.slots[index] = initial;
    // Functional updates run against the stored value, as React runs them.
    return [host.slots[index] as T, (next: T | ((current: T) => T)) => { host.slots[index] = typeof next === 'function' ? (next as (current: T) => T)(host.slots[index] as T) : next; }];
  },
  useRef: <T,>(initial: T) => {
    const index = host.cursor++;
    if (!(index in host.slots)) host.slots[index] = { current: initial };
    return host.slots[index] as { current: T };
  },
  useMemo: <T,>(factory: () => T) => factory(),
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const index = host.cursor++;
    if (!(index in host.slots)) {
      host.slots[index] = true;
      host.effects.push(effect);
    }
  },
  useLayoutEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => number) => snapshot(),
}));
vi.mock('react-native', () => {
  class Value {
    listeners = new Map<string, (event: { value: number }) => void>();
    constructor(public value: number) {}
    addListener(listener: (event: { value: number }) => void) {
      this.listeners.set('listener', listener);
      return 'listener';
    }
    removeListener(id: string) { this.listeners.delete(id); }
    setValue(value: number) {
      this.value = value;
      this.listeners.forEach(listener => listener({ value }));
    }
  }
  return {
    Platform: { OS: 'ios' },
    Animated: { Value, View: 'Animated.View', multiply: () => 0 },
    Easing: { bezier: () => undefined },
    Keyboard: { dismiss: vi.fn() },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 0.5 },
    useWindowDimensions: () => host.window,
  };
});
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-svg', () => ({
  default: () => null, Defs: () => null, LinearGradient: () => null,
  Path: () => null, RadialGradient: () => null, Rect: () => null, Stop: () => null,
}));
vi.mock('../lib/chrome', () => ({
  contentStartInset: (top: number) => top + 28,
  homeScrollOffset: {
    addListener: (listener: (event: { value: number }) => void) => { host.offset.listener = listener; return 'listener'; },
    removeListener: () => undefined,
    interpolate: (config: unknown) => ({ interpolated: config }),
  },
  nativeTabContentInset: () => 12, setDockSuppressed: vi.fn(),
  syncHomeDrawerReveal: vi.fn(), useHomeHandleRowTop: () => host.rowTop,
  readHomeScrollPosition: () => host.positionReads.shift() ?? 0,
  useDockSuppressed: () => host.dockSuppressed,
  useHomeAwayFromTop: () => false,
}));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('../features/home/useStaffDeskNumbers', () => ({ useStaffDeskNumbers: (role: LiveStaffRole | null) => {
  host.readRole = role;
  return role ? { status: host.deskStatus, numbers: [{ label: 'Open issues', value: 163 }] } : null;
} }));
vi.mock('../data/useChannels', () => ({
  useChannelStore: () => ({ subscribe: () => () => undefined, getVersion: () => 0, channels: () => [] }),
}));
vi.mock('../state/AppProvider', () => ({
  useApp: () => host.app,
}));
vi.mock('../features/onboardingGuide/useOnboardingGuide', () => ({
  useOnboardingGuide: () => ({ guide: { progressiveDisclosureActive: false }, showAll: true, setShowAll: vi.fn() }),
}));
vi.mock('../features/onboardingGuide/OnboardingGuideCard', () => ({ GuidedListToggle: () => null }));
vi.mock('../lib/onboardingGuide', () => ({ guidedDestinationGroups: <T,>(groups: T) => groups }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('./FunctionDeck', () => ({ FunctionDeck: () => null }));
vi.mock('./WorkWidgets', () => ({ WorkWidgets: 'WorkWidgets' }));
vi.mock('./TopChrome', () => ({ TopRamp: () => null }));
vi.mock('./ui', () => ({ Body: () => null, Button: () => null, Heading: () => null }));
vi.mock('./Text', () => ({ Text: 'Text', TextInput: 'TextInput' })); // the app's Text, as the react-native stand-in draws it (#8928)

const { HomeCarousel } = await import('./HomeCarousel');
const { haptics } = await import('../services/haptics');
const { FontScaleRelayout } = await import('./FontScaleRelayout');
type Element = React.ReactElement<{
  children?: React.ReactNode; accessibilityLabel?: string; accessibilityRole?: string; testID?: string;
  accessibilityActions?: { name: string; label: string }[];
  accessibilityElementsHidden?: boolean; importantForAccessibility?: string;
  pointerEvents?: string; disabled?: boolean; onPress?: () => void;
  style?: unknown; numberOfLines?: number; maxFontSizeMultiplier?: number; adjustsFontSizeToFit?: boolean;
  staffRole?: LiveStaffRole | null; staffNumbers?: { label: string; value: number | null }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
}>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function render() {
  host.cursor = 0;
  const tree = HomeCarousel({ children: React.createElement('HomeFeed') });
  host.effects.splice(0).forEach(effect => effect());
  return elements(tree);
}
function control(tree: Element[], label: string) {
  const element = tree.find(node => node.props.accessibilityLabel === label);
  if (!element) throw new Error(`Missing control: ${label}`);
  return element;
}
function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}
function visibleText(element: Element): string[] {
  return elements(element.props.children)
    .filter(node => node.type === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''));
}
beforeEach(() => {
  host.slots = []; host.effects = []; host.cursor = 0;
  host.window = { width: 390, height: 844, fontScale: 1 };
  host.app = { dashboard: null, mode: 'live', sessionRestricted: false, chosenStaffRole: null, authorizedRoles: [], chapterRoles: [], organizationRoles: [] };
  host.deskStatus = 'ready'; host.readRole = null;
  host.rowTop = 0; host.offset.listener = null; host.dockSuppressed = false; host.positionReads = [];
  vi.stubGlobal('React', React);
});
afterEach(() => vi.unstubAllGlobals());

describe('Home drawer accessibility', () => {
  it('clips only the sibling handle plane while the Home feed keeps its full height', () => {
    const tree = render();
    expect(flattenStyle(tree[0]!.props.style).marginBottom).toBe(0);
    const clip = tree.find(node => node.props.testID === 'home-drawer-handle-clip');
    expect(clip).toBeDefined();
    expect(flattenStyle(clip!.props.style)).toMatchObject({ bottom: 95, overflow: 'hidden' });
    const children = elements(clip!.props.children);
    expect(children.some(node => node.type === 'HomeFeed')).toBe(false);
    expect(flattenStyle(children[0]!.props.style).bottom).toBe(-95);
    for (const label of ['Open All tools', 'Open Campaign work']) expect(control(children, label)).toBeDefined();
    expect(tree.some(node => node.type === 'HomeFeed')).toBe(true);
  });

  // iPhone 17e-like: 844pt tall, 34pt home indicator, so the clip ends 95pt
  // above the bottom edge and is 749pt tall. A row at 720pt with 48pt pills
  // reaches 768pt, 19pt past the clip: on Main the lower half of each pill
  // was cut there.
  type Layoutable = Element & { props: { onLayout?: (event: unknown) => void } };
  const layout = (node: Element | undefined, height: number) => (node as Layoutable | undefined)?.props.onLayout?.({ nativeEvent: { layout: { height } } });
  function pillTree(pillHeight: number | null) {
    host.rowTop = 720;
    let tree = render();
    layout(tree.find(node => node.props.testID === 'home-drawer-handle-clip'), 749);
    if (pillHeight !== null) for (const label of ['Open All tools', 'Open Campaign work']) layout(control(tree, label), pillHeight);
    tree = render();
    return tree;
  }
  const columnsOf = (tree: Element[]) => tree.filter(node => node.type === 'Animated.View' && elements(node.props.children).some(child => /^Open (All tools|Campaign work)$/.test(child.props.accessibilityLabel ?? '')));

  it('draws each drawer pill whole or not at all, never cut by the clip above the tab bar (#9607)', () => {
    let tree = pillTree(48);
    expect(columnsOf(tree)).toHaveLength(2);
    for (const column of columnsOf(tree)) {
      // Hidden, not cut: no opacity until the whole pill is inside the clip,
      // and the fade only starts there ( round 1, r2s1), so no frame
      // shows a sliver; a hidden pill takes no tap.
      expect(flattenStyle(column.props.style).opacity).toEqual({ interpolated: { inputRange: [19, 19.5], outputRange: [0, 1], extrapolate: 'clamp' } });
      expect(column.props.pointerEvents).toBe('none');
    }
    // Scrolled 19pt the pills are whole but still at opacity 0; they act and
    // are announced only where the fade ends, at 19.5pt ( split).
    for (const value of [19, 19.49]) {
      host.offset.listener?.({ value });
      tree = render();
      for (const column of columnsOf(tree)) {
        expect(column.props.pointerEvents).toBe('none');
        expect(column.props.importantForAccessibility).toBe('no-hide-descendants');
      }
    }
    vi.mocked(haptics.select).mockClear();
    control(tree, 'Open All tools').props.onPress!();
    expect(haptics.select).not.toHaveBeenCalled();
    host.offset.listener?.({ value: 19.5 });
    tree = render();
    for (const column of columnsOf(tree)) {
      expect(column.props.pointerEvents).toBe('box-none');
      expect(column.props.importantForAccessibility).toBeUndefined();
    }
    control(tree, 'Open All tools').props.onPress!();
    expect(haptics.select).toHaveBeenCalledTimes(1);
    // Back at rest, or pulled down past the top, they hide again.
    for (const value of [0, -40]) {
      host.offset.listener?.({ value });
      tree = render();
      for (const column of columnsOf(tree)) expect(column.props.pointerEvents).toBe('none');
    }
    // A row that fits at rest is whole from the start.
    host.rowTop = 600;
    tree = render();
    for (const column of columnsOf(tree)) expect(column.props.pointerEvents).toBe('box-none');
  });

  it('measures each pill as it is now, so a pill that gets shorter is whole again (#9630 round 1, r2g1)', () => {
    // At a large text size an 80pt pill reaches 64pt below its row: whole
    // from a 35pt scroll.
    let tree = pillTree(80);
    host.offset.listener?.({ value: 30 });
    tree = render();
    for (const column of columnsOf(tree)) expect(column.props.pointerEvents).toBe('none');
    // Back at the default size the pills are 48pt again and fit at 30pt;
    // keeping the tallest height ever measured left them hidden and
    // unpressable here.
    for (const label of ['Open All tools', 'Open Campaign work']) layout(control(tree, label), 48);
    tree = render();
    for (const column of columnsOf(tree)) {
      expect(column.props.pointerEvents).toBe('box-none');
      expect(flattenStyle(column.props.style).opacity).toEqual({ interpolated: { inputRange: [19, 19.5], outputRange: [0, 1], extrapolate: 'clamp' } });
    }
  });

  it('gives each pill its own threshold, so a short pill is not held hidden by a taller one (#9630 split)', () => {
    host.rowTop = 720;
    let tree = render();
    layout(tree.find(node => node.props.testID === 'home-drawer-handle-clip'), 749);
    layout(control(tree, 'Open All tools'), 48);
    layout(control(tree, 'Open Campaign work'), 80);
    tree = render();
    const [features, work] = columnsOf(tree) as [Element, Element];
    // All features (48pt) is whole from 19pt; Work (80pt) reaches 64pt below
    // its row and is whole only from 35pt.
    expect(flattenStyle(features.props.style).opacity).toEqual({ interpolated: { inputRange: [19, 19.5], outputRange: [0, 1], extrapolate: 'clamp' } });
    expect(flattenStyle(work.props.style).opacity).toEqual({ interpolated: { inputRange: [35, 35.5], outputRange: [0, 1], extrapolate: 'clamp' } });
    host.offset.listener?.({ value: 20 });
    tree = render();
    const [featuresAt20, workAt20] = columnsOf(tree) as [Element, Element];
    expect(featuresAt20.props.pointerEvents).toBe('box-none');
    expect(workAt20.props.pointerEvents).toBe('none');
    vi.mocked(haptics.select).mockClear();
    control(tree, 'Open Campaign work').props.onPress!();
    expect(haptics.select).not.toHaveBeenCalled();
    control(tree, 'Open All tools').props.onPress!();
    expect(haptics.select).toHaveBeenCalledTimes(1);
  });

  it('hides a hidden pill from VoiceOver and TalkBack, and its press does nothing (#9630 final, r3g2)', () => {
    let tree = pillTree(48);
    for (const column of columnsOf(tree)) {
      expect(column.props.accessibilityElementsHidden).toBe(true);
      expect(column.props.importantForAccessibility).toBe('no-hide-descendants');
    }
    vi.mocked(haptics.select).mockClear();
    control(tree, 'Open All tools').props.onPress!();
    control(tree, 'Open Campaign work').props.onPress!();
    expect(haptics.select).not.toHaveBeenCalled();
    // Drawn again, the pill is announced and opens its drawer.
    host.offset.listener?.({ value: 19.5 });
    tree = render();
    for (const column of columnsOf(tree)) {
      expect(column.props.accessibilityElementsHidden).toBeUndefined();
      expect(column.props.importantForAccessibility).toBeUndefined();
    }
    control(tree, 'Open All tools').props.onPress!();
    expect(haptics.select).toHaveBeenCalledTimes(1);
  });

  it('waits for fresh measurements after a text size change, never using the old bounds (#9630 final, r3s1)', () => {
    let tree = pillTree(48);
    host.offset.listener?.({ value: 19.5 });
    tree = render();
    for (const column of columnsOf(tree)) expect(column.props.pointerEvents).toBe('box-none');
    // A larger text size: the old clip and pill heights no longer count.
    host.window = { ...host.window, fontScale: 1.4 };
    tree = render();
    for (const column of columnsOf(tree)) {
      expect(flattenStyle(column.props.style).opacity).toBe(0);
      expect(column.props.pointerEvents).toBe('none');
    }
    // Measured again at the new size, they are drawn against the new bounds.
    layout(tree.find(node => node.props.testID === 'home-drawer-handle-clip'), 749);
    for (const label of ['Open All tools', 'Open Campaign work']) layout(control(tree, label), 64);
    tree = render();
    for (const column of columnsOf(tree)) expect(flattenStyle(column.props.style).opacity).toEqual({ interpolated: { inputRange: [27, 27.5], outputRange: [0, 1], extrapolate: 'clamp' } });
  });

  it('takes the clip height across a drawer from Home\'s height, never the old one, and keeps the pills and their views (#9630 final, r4g1; Sol answer 5)', () => {
    // Measured while a drawer was moving: the dock stands down and the clip
    // runs to the bottom edge (844pt, inset 0).
    host.dockSuppressed = true;
    let tree = pillTree(48);
    layout(tree.find(node => node.props.testID === 'home-drawer-handle-clip'), 844);
    const clipBefore = tree.find(node => node.props.testID === 'home-drawer-handle-clip')!;
    // Closed again: the clip is back above the 95pt tab band. Its height is
    // 844 + 0 - 95 = 749 at once, not 844, with no new report and no remount:
    // the pills stay drawn on the same views.
    host.dockSuppressed = false;
    tree = render();
    expect(tree.find(node => node.props.testID === 'home-drawer-handle-clip')!.key).toBe(clipBefore.key);
    for (const column of columnsOf(tree)) expect(flattenStyle(column.props.style).opacity).toEqual({ interpolated: { inputRange: [19, 19.5], outputRange: [0, 1], extrapolate: 'clamp' } });
    host.offset.listener?.({ value: 19.5 });
    tree = render();
    for (const column of columnsOf(tree)) expect(column.props.pointerEvents).toBe('box-none');
  });

  it('draws a pill that fits exactly at rest from the start, as on Main (Sol answer 7)', () => {
    // A 48pt pill on a row at 701pt reaches the 749pt clip line exactly.
    host.rowTop = 701;
    let tree = render();
    layout(tree.find(node => node.props.testID === 'home-drawer-handle-clip'), 749);
    for (const label of ['Open All tools', 'Open Campaign work']) layout(control(tree, label), 48);
    for (const value of [0, -0.25]) {
      host.offset.listener?.({ value });
      tree = render();
      for (const column of columnsOf(tree)) {
        expect(flattenStyle(column.props.style).opacity).toBe(1);
        expect(column.props.pointerEvents).toBe('box-none');
        expect(column.props.importantForAccessibility).toBeUndefined();
      }
    }
  });

  it('draws an unmeasured row centred and whole, as before (the cold-start frame)', () => {
    const tree = render();
    for (const column of columnsOf(tree)) {
      expect(flattenStyle(column.props.style)).toMatchObject({ top: '50%', marginTop: -24 });
      expect(flattenStyle(column.props.style).opacity).toBeUndefined();
      expect(column.props.pointerEvents).toBe('box-none');
    }
  });

  it('reads the live offset at the press, and the position again when the listener attaches (Sol answers 1 and 6)', () => {
    // Home moved to 30pt between the first read (0) and the listener.
    host.positionReads = [0, 30];
    host.rowTop = 720;
    let tree = render();
    layout(tree.find(node => node.props.testID === 'home-drawer-handle-clip'), 749);
    for (const label of ['Open All tools', 'Open Campaign work']) layout(control(tree, label), 48);
    tree = render();
    for (const column of columnsOf(tree)) expect(column.props.pointerEvents).toBe('box-none');
    // Scrolled back to 10pt: the press from the last drawn render does nothing.
    host.offset.listener?.({ value: 10 });
    vi.mocked(haptics.select).mockClear();
    control(tree, 'Open All tools').props.onPress!();
    control(tree, 'Open Campaign work').props.onPress!();
    expect(haptics.select).not.toHaveBeenCalled();
  });

  // React Native's own rule: a view reports onLayout when it mounts or when
  // its frame moves, never because a value in a parent changed. Nothing here
  // calls onLayout for a view that neither mounted nor moved.
  function platformLayout(tree: Element[], seen: { mount?: React.Key | null; clip?: number; pills?: number }, clipHeight: number, pillHeight: number) {
    const clip = tree.find(node => node.props.testID === 'home-drawer-handle-clip')!;
    const mounted = !('mount' in seen) || seen.mount !== clip.key;
    if (mounted || seen.clip !== clipHeight) layout(clip, clipHeight);
    if (mounted || seen.pills !== pillHeight) for (const label of ['Open All tools', 'Open Campaign work']) layout(control(tree, label), pillHeight);
    Object.assign(seen, { mount: clip.key, clip: clipHeight, pills: pillHeight });
  }

  it('brings both pills back after a text size change or a drawer that leaves their frames where they were (#9630 split, part 2)', () => {
    host.rowTop = 720;
    const seen = {};
    const settle = (clipHeight: number) => { platformLayout(render(), seen, clipHeight, 48); return render(); };
    const whole = (tree: Element[]) => columnsOf(tree).every(column => column.props.pointerEvents === 'box-none' && column.props.importantForAccessibility === undefined);
    let tree = settle(749);
    host.offset.listener?.({ value: 19.5 });
    tree = render();
    expect(whole(tree)).toBe(true);
    // A small text size step: the pills stay 48pt tall and the clip does not move.
    const before = tree;
    host.window = { ...host.window, fontScale: 1.1 };
    tree = settle(749);
    expect(whole(tree)).toBe(true);
    // Back to the first size (A, B, A): a late report from the first mount is
    // dropped, though its layout matches again (Sol answer 4).
    host.window = { ...host.window, fontScale: 1 };
    tree = settle(749);
    expect(whole(tree)).toBe(true);
    layout(before.find(node => node.props.testID === 'home-drawer-handle-clip'), 600);
    for (const label of ['Open All tools', 'Open Campaign work']) layout(control(before, label), 120);
    tree = render();
    expect(whole(tree)).toBe(true);
    // A drawer: the dock stands down and the clip runs to the bottom edge,
    // then comes back above the tab band. The pills' frames never move.
    host.dockSuppressed = true;
    tree = settle(844);
    host.dockSuppressed = false;
    tree = settle(749);
    expect(whole(tree)).toBe(true);
    vi.mocked(haptics.select).mockClear();
    control(tree, 'Open Campaign work').props.onPress!();
    expect(haptics.select).toHaveBeenCalledTimes(1);
  });

  it('keeps a measured row hidden until its clip and both pills are measured, so no first frame is cut', () => {
    const tree = pillTree(null);
    for (const column of columnsOf(tree)) {
      expect(flattenStyle(column.props.style).opacity).toBe(0);
      expect(column.props.pointerEvents).toBe('none');
    }
  });

  it.each(['ready', 'loading', 'failed'])('passes the authorized campaign lead reader to Work only when %s', status => {
    host.app = { dashboard: {} as MemberDashboard, mode: 'authenticated', sessionRestricted: false, chosenStaffRole: 'coordinator', authorizedRoles: ['coordinator'], chapterRoles: [], organizationRoles: ['coordinator'] };
    host.deskStatus = status;
    const widget = render().find(node => 'staffNumbers' in node.props);
    expect(host.readRole).toBe('coordinator');
    expect(widget?.props.staffRole).toBe('coordinator');
    expect(widget?.props.staffNumbers).toEqual(status === 'ready' ? [{ label: 'Open issues', value: 163 }] : []);
  });

  it.each(['restricted', 'no-scope', 'signed-out'])('does not read a staff summary for %s sessions', boundary => {
    host.app = { dashboard: {} as MemberDashboard, mode: boundary === 'signed-out' ? 'signed-out' : 'authenticated', sessionRestricted: boundary === 'restricted', chosenStaffRole: 'coordinator', authorizedRoles: ['coordinator'], chapterRoles: [], organizationRoles: boundary === 'no-scope' ? [] : ['coordinator'] };
    const widget = render().find(node => 'staffNumbers' in node.props);
    expect(host.readRole).toBeNull();
    expect(widget?.props.staffRole).toBeNull();
    expect(widget?.props.staffNumbers).toEqual([]);
  });

  it('names navigation neutrally and retains both labelled actions and buttons', () => {
    const tree = render();
    const navigation = control(tree, 'Home navigation');
    expect(navigation.props.accessibilityRole).toBe('summary');
    expect(navigation.props.accessibilityActions).toEqual([
      { name: 'openFeatures', label: 'Open All tools' },
      { name: 'openWork', label: 'Open Campaign work' },
    ]);
    expect(tree.some(node => /swipe/i.test(node.props.accessibilityLabel ?? ''))).toBe(false);
    for (const label of ['Open All tools', 'Open Campaign work']) {
      expect(control(tree, label).props).toMatchObject({ accessibilityRole: 'button', onPress: expect.any(Function) });
    }
  });

  // UX-UG-NATIVE-HOME-DRAWERS-UNLABELED-CHEVRONS-20261018: a sighted
  // member finds each drawer by its words, not by guessing what an edge
  // chevron means; the words sit inside the same 48pt button that opens it.
  it.each([
    { label: 'Open All tools', text: 'All tools' },
    { label: 'Open Campaign work', text: 'Campaign work' },
  ])('$label shows "$text" as visible text inside the 48pt button', ({ label, text }) => {
    const handle = control(render(), label);
    expect(handle.type).toBe('Pressable');
    expect(handle.props.accessibilityRole).toBe('button');
    expect(visibleText(handle)).toEqual([text]);
    const style = flattenStyle(handle.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style.minWidth).toBeGreaterThanOrEqual(48);
    expect(style.flexDirection).toBe('row');
    // The label is painted in the audited secondary pair with its hairline
    // edge, the same recipe as every secondary button in ./ui.
    expect(style.borderWidth).toBe(0.5);
    expect(style).toHaveProperty('backgroundColor');
    expect(style).toHaveProperty('borderColor');
  });

  // Codex P2 on: the two pills are positioned from opposite edges,
  // so without a shared budget the Work label could grow over All features at
  // an accessibility text size. Each handle may take half the row inside the
  // feed inset; the label scales like the hat pill, fits, then truncates.
  it.each([
    { width: 320, fontScale: 3.12, name: 'AX5 on the narrowest phone' },
    { width: 390, fontScale: 3.12, name: 'AX5 at 390pt' },
    { width: 430, fontScale: 1, name: 'default type at 430pt' },
  ])('shares one row budget between the handles ($name)', ({ width, fontScale }) => {
    host.window = { width, height: 844, fontScale };
    const tree = render();
    const budget = Math.floor((width - 16 * 2 - 8) / 2);
    let occupied = 16 * 2 + 8;
    for (const label of ['Open All tools', 'Open Campaign work']) {
      const handle = control(tree, label);
      const style = flattenStyle(handle.props.style);
      expect(style.maxWidth).toBe(budget);
      expect(style.minWidth).toBeLessThanOrEqual(budget);
      occupied += budget;
      const [text] = elements(handle.props.children).filter(node => node.type === 'Text');
      expect(text!.props).toMatchObject({ numberOfLines: 1, maxFontSizeMultiplier: 1.4, ellipsizeMode: 'tail' });
      expect(flattenStyle(text!.props.style).flexShrink).toBe(1);
    }
    expect(occupied).toBeLessThanOrEqual(width);
  });

  it('exposes no drawer close control while Home is at rest', () => {
    expect(render().some(node => node.props.accessibilityLabel === 'Close drawer and return to Home')).toBe(false);
  });

  // BUG-UG-NATIVE-HOME-HANDLE-PILL-LABELS-MISSING-LARGEST-LIGHT-20261103:
  // at the largest size both pills drew only their chevrons. The labels no
  // longer run iOS's fit-to-width pass; they cap at 1.4x and truncate, inside
  // a text box that still holds a letter and an ellipsis at the narrowest
  // width, and they are measured again whenever the text size changes.
  it.each([
    { label: 'Open All tools', text: 'All tools' },
    { label: 'Open Campaign work', text: 'Campaign work' },
  ])('draws "$text" at the largest size on the narrowest phone', ({ label, text }) => {
    host.window = { width: 320, height: 568, fontScale: 3.12 };
    const handle = control(render(), label);
    const style = flattenStyle(handle.props.style);
    const [node] = elements(handle.props.children).filter(element => element.type === 'Text');
    expect(visibleText(handle)).toEqual([text]);
    expect(node!.props).not.toHaveProperty('adjustsFontSizeToFit');
    expect(node!.props).not.toHaveProperty('minimumFontScale');
    const labelStyle = flattenStyle(node!.props.style);
    const drawn = (labelStyle.fontSize as number) * node!.props.maxFontSizeMultiplier!;
    expect(drawn).toBe(21);
    // Pill budget less its padding, chevron and gap: room for "W…" at 21pt.
    const textBox = (style.maxWidth as number) - (style.paddingHorizontal as number) * 2 - 18 - (style.gap as number) - 1;
    expect(textBox).toBeGreaterThanOrEqual(drawn * 2);
  });

  //  gate r1g1: Android draws siblings by elevation before zIndex,
  // and the moving sheet carries the level-3 elevation, so the handle layer
  // must sit above it or both handles vanish under the sheet mid-motion.
  it('keeps both handles above the moving sheet on Android', () => {
    const tree = render();
    const columns = tree.filter(node => node.type === 'Animated.View' && flattenStyle(node.props.style).zIndex === 3);
    expect(columns).toHaveLength(2);
    const sheet = tree.find(node => node.type === 'View' && flattenStyle(node.props.style).zIndex === 2 && 'transform' in flattenStyle(node.props.style));
    expect(sheet).toBeTruthy();
    // At rest the sheet casts nothing; once moving it takes level 3.
    expect(flattenStyle(sheet!.props.style).elevation).toBe(0);
    for (const column of columns) {
      expect(flattenStyle(column.props.style).elevation).toBeGreaterThan(elevation.level3.elevation!);
      expect(column.props.pointerEvents).toBe('box-none');
    }
  });

  it('measures both labels again when the text size changes', () => {
    const keys = (fontScale: number) => {
      host.window = { width: 390, height: 844, fontScale };
      const tree = render();
      return ['Open All tools', 'Open Campaign work'].map(label => elements(control(tree, label).props.children).find(node => node.type === 'Text')!.key);
    };
    const before = keys(1);
    expect(before[0]).toBe('font-scale-1000');
    expect(keys(1)).toEqual(before);
    expect(keys(3.12)).not.toEqual(before);
  });

  //: launched at the largest text size and lowered to the default, the
  // Work drawer's '1 unread' badge and Messages card kept their launch frames.
  // The drawer page sits outside Screen's relayout, so it carries its own.
  it('mounts the Work drawer page again when the text size is lowered', () => {
    const page = (fontScale: number) => {
      host.window = { width: 390, height: 844, fontScale };
      const drawerPage = render().find(node => typeof node.type === 'function' && node.type.name === 'DrawerPage');
      if (!drawerPage) throw new Error('Missing DrawerPage');
      const scroll = (drawerPage.type as (props: object) => Element)(drawerPage.props);
      const [relayout, ...rest] = React.Children.toArray(scroll.props.children).filter(React.isValidElement) as Element[];
      expect(rest).toHaveLength(0);
      expect(relayout!.type).toBe(FontScaleRelayout);
      const mounted = FontScaleRelayout(relayout!.props) as Element;
      // The heading and the drawer's cards are all under the key.
      expect(elements(mounted).some(node => typeof node.type === 'function' && node.type.name === 'Heading')).toBe(true);
      return mounted.key;
    };
    const largest = page(3.571);
    const lowered = page(1);
    expect(lowered).toBe('font-scale-1000');
    expect(lowered).not.toBe(largest);
    expect(page(1)).toBe(lowered);
    expect(page(3.571)).toBe(largest);
  });

  it.each(themeKeys.flatMap((key): [ThemeKey, boolean][] => [[key, false], [key, true]]))('paints the labels at 4.5:1 or more on the pill (%s, dark %s)', (key, dark) => {
    const theme = resolveTheme(key, dark);
    expect(contrastRatio(theme.secondaryForeground, theme.secondary)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the visible labels in sync with the spoken drawer actions', () => {
    const tree = render();
    const actions = control(tree, 'Home navigation').props.accessibilityActions!;
    for (const { label } of actions) {
      const handle = control(tree, label);
      const [text] = visibleText(handle);
      expect(label).toBe(`Open ${text}`);
    }
  });

  it.each([
    { action: 'openFeatures', label: 'Open All tools', drawerIndex: 0 },
    { action: 'openWork', label: 'Open Campaign work', drawerIndex: 1 },
  ])('$action and its button open only the intended drawer and can return Home', ({ action, label, drawerIndex }) => {
    for (const via of ['action', 'button']) {
      const home = render();
      if (via === 'action') control(home, 'Home navigation').props.onAccessibilityAction!({ nativeEvent: { actionName: action } });
      else control(home, label).props.onPress!();
      const opened = render();
      // The pinned drawer wrappers are the two root children after the action
      // target unmounts. Assert exposed state, not an internal hook-slot value.
      const drawers = elements(opened[0]!.props.children).filter(node => node.props.importantForAccessibility === 'auto' && node.props.pointerEvents === 'auto');
      expect(drawers).toHaveLength(2); // selected drawer and Home's close target
      const rootChildren = React.Children.toArray(opened[0]!.props.children).filter(React.isValidElement) as Element[];
      expect(rootChildren[drawerIndex]!.props).toMatchObject({ accessibilityElementsHidden: false, importantForAccessibility: 'auto', pointerEvents: 'auto' });
      expect(rootChildren[1 - drawerIndex]!.props).toMatchObject({ accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', pointerEvents: 'none' });
      expect(opened.some(node => node.props.accessibilityLabel === 'Home navigation')).toBe(false);
      const close = control(opened, 'Close drawer and return to Home');
      expect(close.props.disabled).toBeFalsy();
      close.props.onPress!();
      expect(control(render(), 'Home navigation')).toBeDefined();
    }
  });
});
