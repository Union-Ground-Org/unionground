import * as React from 'react';
import { getItemAsync } from 'expo-secure-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contrastRatio } from '../theme/contrast';
import palette from '../theme/palette.json';
import { featureGroupsForRoles, MEMBER_FEATURE_GROUPS, type HatFunctionGroup } from '../lib/hatFunctions';
import { guidedDestinationGroups, INACTIVE_ONBOARDING_GUIDE, type OnboardingGuide } from '../lib/onboardingGuide';

// Execute the shipped components, replacing only native/context boundaries.
// The tiny hook host rerenders FunctionDeck after its real edit action. Storage
// hydration is deliberately outside this render/action test's scope.
const runtime = vi.hoisted(() => ({
  os: 'ios', pathname: '/home', bottom: 34, hidden: true, reveal: { value: 1 }, awayFromTop: false,
  states: [] as unknown[], cursor: 0, fontScale: 1, effects: [] as (() => unknown)[],
  themeKey: 'union-ground-dark' as keyof typeof palette,
  push: vi.fn((_href: string): void => undefined),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof React>(),
  useMemo: (factory: () => unknown) => factory(),
  // Effects are recorded, not run, so a test can run the ones it checks.
  useEffect: (effect: () => unknown) => { runtime.effects.push(effect); },
  useSyncExternalStore: (_subscribe: () => () => void, getSnapshot: () => unknown) => getSnapshot(),
  useState: (initial: unknown) => {
    const index = runtime.cursor++;
    if (index >= runtime.states.length) runtime.states[index] = initial;
    return [runtime.states[index], (next: unknown) => {
      runtime.states[index] = typeof next === 'function' ? next(runtime.states[index]) : next;
    }];
  },
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return runtime.os; } },
  Animated: { View: 'Animated.View' },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: runtime.fontScale }),
}));
vi.mock('expo-router/unstable-native-tabs', () => ({
  NativeTabs: Object.assign(() => null, {
    Trigger: Object.assign(() => null, { Icon: () => null, Label: () => null, Badge: () => null }),
  }),
}));
vi.mock('expo-router', () => ({ usePathname: () => runtime.pathname, useRouter: () => ({ push: runtime.push }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59, bottom: runtime.bottom, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('../lib/chrome', () => ({
  homeDrawerReveal: runtime.reveal, requestHomeScrollToTop: vi.fn(),
  useDockSuppressed: () => runtime.hidden, useHomeAwayFromTop: () => runtime.awayFromTop,
}));
vi.mock('../lib/screenReader', () => ({ useScreenReader: () => false }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ dashboard: null, mode: 'signedOut', previewHat: null }) }));
vi.mock('../data/useChannels', () => ({
  useChannelStore: () => ({
    subscribe: () => () => undefined,
    getVersion: () => 0,
    // The tab host settles its badge on the store status
    // (BUG-UG-MOBILE-MESSAGES-TAB-BADGE-COUNTS-DIRECT-THREADS-ONLY-20260914).
    status: () => 'ready',
    channels: () => [],
  }),
}));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette[runtime.themeKey] }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), impact: vi.fn() } }));
vi.mock('./PressableScale', () => ({ PressableScale: () => null }));
vi.mock('./ui', () => ({ Body: () => null, SearchField: () => null }));
vi.mock('./Text', () => ({ Text: 'Text', TextInput: 'TextInput' })); // the app's Text, as the react-native stand-in draws it (#8928)

const { default: TabLayout } = await import('../../app/(tabs)/_layout');
const { FunctionDeck } = await import('./FunctionDeck');
const { FontScaleRelayout } = await import('./FontScaleRelayout');
type Element = React.ReactElement<{
  children?: React.ReactNode; accessibilityLabel?: string; onPress?: () => void;
  value?: string; onChangeText?: (value: string) => void;
  style?: unknown; name?: string; disableAutomaticContentInsets?: boolean; minimizeBehavior?: string;
}>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return React.isValidElement(node) ? text((node as Element).props.children) : '';
}
function renderDeck(groups: HatFunctionGroup[] = []) {
  runtime.cursor = 0;
  return FunctionDeck({ width: 298.68, height: 852, topPad: 67, bottomPad: 114, groups, onHome: vi.fn(), shortcutScope: 'test' });
}
function control(tree: React.ReactNode, label: string) {
  const result = elements(tree).find(node => node.props.accessibilityLabel === label);
  if (!result) throw new Error(`Missing control: ${label}`);
  return result;
}
beforeEach(() => {
  runtime.os = 'ios'; runtime.pathname = '/home'; runtime.bottom = 34;
  runtime.hidden = true; runtime.states = []; runtime.cursor = 0; runtime.awayFromTop = false; runtime.effects = [];
  runtime.themeKey = 'union-ground-dark'; runtime.fontScale = 1;
  runtime.push.mockClear();
  // Node's JSX transform may use classic React; Expo uses the same element API.
  vi.stubGlobal('React', React);
});
afterEach(() => vi.unstubAllGlobals());

describe('native drawer bottom surface', () => {
  it('does not cover the bottom arc of the full-height iPhone Home scene', () => {
    expect(elements(TabLayout()).filter(node => node.type === 'Animated.View')).toHaveLength(0);
    expect(elements(TabLayout()).find(node => node.props.name === 'home')!.props.disableAutomaticContentInsets).not.toBe(true);
  });
  it.each([
    { bottom: 24, hidden: true }, { bottom: 48, hidden: true },
    { bottom: 24, hidden: false }, { bottom: 48, hidden: false },
  ])('emits the Home-only Android inset opt-out with $bottom-point inset and hidden=$hidden', ({ bottom, hidden }) => {
    runtime.os = 'android'; runtime.bottom = bottom; runtime.hidden = hidden;
    const tree = elements(TabLayout());
    // Removing this option reintroduces Expo's bottom SafeAreaView, shrinking
    // the actual scene above system navigation even when the tabs are hidden.
    expect(tree.find(node => node.props.name === 'home')!.props.disableAutomaticContentInsets).toBe(true);
    // Once the real layers extend underneath system navigation, a filler band
    // would cover their lower corner, recreating the iPhone clipping defect.
    expect(tree.filter(node => node.type === 'Animated.View')).toHaveLength(0);
    // The Union Ground dock is Home, Work, Guide, Campaign, Account;
    // Home remains the only tab with the Android opt-out.
    expect(tree.filter(node => node.props.name).map(node => node.props.name))
      .toEqual(['home', 'work', 'compass', 'campaign', 'account']);
    for (const name of ['work', 'compass', 'campaign', 'account']) {
      expect(tree.find(node => node.props.name === name)!.props.disableAutomaticContentInsets).not.toBe(true);
    }
  });
  it('brings the full iPhone tab bar back when Home returns to its top (#9607)', () => {
    runtime.hidden = false;
    const minimize = () => {
      runtime.cursor = 0;
      return elements(TabLayout()).find(node => node.props.minimizeBehavior)!.props.minimizeBehavior;
    };
    // At rest and while Home scrolls down, iOS condenses the bar on its own.
    expect(minimize()).toBe('onScrollDown');
    runtime.awayFromTop = true;
    expect(minimize()).toBe('onScrollDown');
    // Back at the top the bar is told 'never' for a moment, which expands it;
    // on Main it stayed the lone Home control until that control was tapped.
    runtime.awayFromTop = false;
    expect(minimize()).toBe('never');
    // Scrolling away again condenses it at once.
    runtime.awayFromTop = true;
    expect(minimize()).toBe('onScrollDown');
  });
  it('does not paint drawer chrome over a non-Home tab', () => {
    runtime.os = 'android'; runtime.pathname = '/account';
    expect(elements(TabLayout()).filter(node => node.type === 'Animated.View')).toHaveLength(0);
  });
});

describe('visible shortcut customization', () => {
  it.each(['chapter', 'organization'])('shows one membership and roles destination for %s administrators', (scope) => {
    const groups = scope === 'chapter' ? featureGroupsForRoles(['admin']) : featureGroupsForRoles([], ['admin']);
    const tree = renderDeck(groups);
    expect(elements(tree).filter((node) => node.props.accessibilityLabel === 'Roles & access')).toHaveLength(1);
    expect(elements(tree).filter((node) => node.props.accessibilityLabel === 'Campaign memberships')).toHaveLength(0);
    control(tree, 'Roles & access').props.onPress!();
    expect(runtime.push).toHaveBeenCalledExactlyOnceWith('/feature/chapter-memberships');
  });

  it('keeps a saved Campaign memberships shortcut and finds the same destination by its former name', async () => {
    const groups = featureGroupsForRoles(['admin']);
    vi.mocked(getItemAsync).mockResolvedValueOnce(JSON.stringify(['chapter-memberships']));
    renderDeck(groups);
    for (const effect of runtime.effects.splice(0)) effect();
    await Promise.resolve();
    control(renderDeck(groups), 'Customize shortcuts').props.onPress!();
    expect(control(renderDeck(groups), 'Remove Roles & access shortcut')).toBeTruthy();
    control(renderDeck(groups), 'Done customizing shortcuts').props.onPress!();
    for (const formerName of ['Campaign memberships', 'Afiliaciones a campañas']) {
      control(renderDeck(groups), 'Search features').props.onChangeText!(formerName);
      const results = renderDeck(groups);
      expect(elements(results).filter((node) => node.props.accessibilityLabel === 'Roles & access')).toHaveLength(1);
      expect(elements(results).filter((node) => node.props.accessibilityLabel === 'Campaign memberships')).toHaveLength(0);
    }
  });

  it.each<{ spotlight: OnboardingGuide['spotlight']; showAll: boolean; expected: string }>([
    { spotlight: 'member-support', showAll: false, expected: '/feature/member-support?source=onboarding' },
    { spotlight: 'member-support', showAll: true, expected: '/feature/member-support?source=onboarding' },
    { spotlight: 'events', showAll: false, expected: '/feature/member-support' },
    { spotlight: null, showAll: false, expected: '/feature/member-support' },
  ])('opens Worker support once from its shortcut and once after unpinning: $spotlight / $showAll', ({ spotlight, showAll, expected }) => {
    const union = MEMBER_FEATURE_GROUPS.find((group) => group.key === 'union')!;
    const sourceGroups = [{ ...union, items: union.items.filter((item) => item.key === 'member-support') }];
    const groups = guidedDestinationGroups(sourceGroups, {
      ...INACTIVE_ONBOARDING_GUIDE, spotlight, progressiveDisclosureActive: spotlight !== null,
    }, showAll);
    const targets = elements(renderDeck(groups)).filter((node) => node.props.accessibilityLabel === 'Worker support');
    expect(targets).toHaveLength(1);
    for (const target of targets) target.props.onPress!();
    control(renderDeck(groups), 'Customize shortcuts').props.onPress!();
    control(renderDeck(groups), 'Remove Worker support shortcut').props.onPress!();
    control(renderDeck(groups), 'Done customizing shortcuts').props.onPress!();
    const unpinned = elements(renderDeck(groups)).filter((node) => node.props.accessibilityLabel === 'Worker support');
    expect(unpinned).toHaveLength(1);
    unpinned[0]!.props.onPress!();
    expect(runtime.push.mock.calls).toEqual([[expected], [expected]]);
    expect(sourceGroups[0]!.items[0]!.href).toBe('/feature/member-support');
  });

  it.each(Object.keys(palette) as (keyof typeof palette)[])('keeps pressed text readable in %s', (key) => {
    runtime.themeKey = key;
    const edit = control(renderDeck(), 'Customize shortcuts');
    const style = Object.assign({}, ...(edit.props.style as (state: { pressed: boolean }) => object[])({ pressed: true })) as { opacity?: number; backgroundColor: string };
    const label = elements(edit.props.children).find(node => node.type === 'Text');
    expect(label).toBeDefined();
    const foreground = Object.assign({}, ...(label!.props.style as object[])).color as string;
    // A Pressable's opacity composites the whole pill over the drawer canvas.
    const composite = (hex: string) => '#' + [1, 3, 5].map(offset => {
      const alpha = style.opacity ?? 1;
      const value = parseInt(hex.slice(offset, offset + 2), 16) * alpha
        + parseInt(palette[key].muted.slice(offset, offset + 2), 16) * (1 - alpha);
      return Math.round(value).toString(16).padStart(2, '0');
    }).join('');
    expect(contrastRatio(composite(style.backgroundColor), composite(foreground))).toBeGreaterThanOrEqual(4.5);
  });
  it('labels the edit action, enters editing, and visibly offers Done to return', () => {
    const edit = control(renderDeck(), 'Customize shortcuts');
    expect(text(edit.props.children)).toContain('Customize');
    edit.props.onPress!();
    const done = control(renderDeck(), 'Done customizing shortcuts');
    expect(text(done.props.children)).toContain('Done');
    done.props.onPress!();
    expect(text(control(renderDeck(), 'Customize shortcuts').props.children)).toContain('Customize');
  });
  it('gives the visible edit label a token-paired surface and full-height touch target', () => {
    const edit = control(renderDeck(), 'Customize shortcuts');
    const styles = (edit.props.style as (state: { pressed: boolean }) => object[])({ pressed: false });
    expect(Object.assign({}, ...styles)).toMatchObject({ minHeight: 48, backgroundColor: palette['union-ground-dark'].secondary });
    const label = elements(edit.props.children).find(node => node.type === 'Text');
    expect(label).toBeDefined();
    expect(Object.assign({}, ...(label!.props.style as object[]))).toMatchObject({ color: palette['union-ground-dark'].secondaryForeground });
  });
});

// BUG-UG-NATIVE-IOS-PILLS-KEEP-LAUNCH-TEXT-SIZE-FRAME-20261103 (#6976):
// launched at the largest iPhone text size and lowered to the default with the
// app open, the Customize pill kept its 274x145 pt launch frame. The drawer
// sits outside Screen's relayout, so its content now mounts again at a size
// change, and the decrease takes a fresh key like any other change.
describe('text size lowered while the app is open (#6976)', () => {
  // React Native's fontScale at the largest iPhone accessibility size.
  const LARGEST = 3.571;
  function mountedAt(fontScale: number) {
    runtime.fontScale = fontScale;
    const deck = renderDeck(MEMBER_FEATURE_GROUPS);
    const relayout = elements(deck).find(node => node.type === FontScaleRelayout);
    if (!relayout) throw new Error('Missing FontScaleRelayout');
    return { deck, mounted: FontScaleRelayout(relayout.props) as Element };
  }

  it('mounts the Customize pill again when the size drops from the largest to the default', () => {
    const largest = mountedAt(LARGEST).mounted;
    expect(control(largest, 'Customize shortcuts').type).toBe('Pressable');
    const lowered = mountedAt(1).mounted;
    expect(control(lowered, 'Customize shortcuts').type).toBe('Pressable');
    expect(lowered.key).toBe('font-scale-1000');
    expect(lowered.key).not.toBe(largest.key);
    // A re-render at the same size keeps the key, so nothing remounts.
    expect(mountedAt(1).mounted.key).toBe(lowered.key);
  });

  it('keeps an upward change remounting and the whole drawer page under the key', () => {
    const lowered = mountedAt(1);
    const raised = mountedAt(LARGEST);
    expect(raised.mounted.key).not.toBe(lowered.mounted.key);
    // The scroll view stays outside the key; every control inside it is under it.
    const scroll = elements(raised.deck).find(node => node.type === 'ScrollView')!;
    expect(React.Children.toArray(scroll.props.children).filter(React.isValidElement).map(node => node.type)).toEqual([FontScaleRelayout]);
    for (const label of ['Close and return to home', 'Customize shortcuts', 'Search features']) control(raised.mounted, label);
  });

  it('holds the search text above the remount, so a size change keeps it', () => {
    control(mountedAt(LARGEST).mounted, 'Search features').props.onChangeText!('vot');
    expect(control(mountedAt(1).mounted, 'Search features').props.value).toBe('vot');
  });
});
